#!/usr/bin/env node
/**
 * Cold-boot timing for Alpine terminal images on the deployed worker.
 * Usage:
 *   node scripts/benchmark-alpine-boot.mjs 3.20.10 3.22.5 3.23.5
 * Env:
 *   BENCH_ORIGIN   worker URL (default: cloudflare worker)
 *   BENCH_RUNS     cold boots per version (default: 3)
 *   BENCH_ROUTE    /alpine-terminal.html or / (default: alpine-terminal)
 */
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const globalNodeModules = execFileSync("npm", ["root", "--global"], { encoding: "utf8" }).trim();
const playwrightUrl = pathToFileURL(path.join(
	globalNodeModules,
	"@playwright",
	"cli",
	"node_modules",
	"playwright",
	"index.mjs",
));
const { chromium } = await import(playwrightUrl);

const rootDir = process.env.WEBVM_ROOT
	|| path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = "/home/yifan/alpine-build";
const ORIGIN = process.env.BENCH_ORIGIN
	|| "https://webvm-disk-worker.d58993771361bc4ff2f5.workers.dev";
const RUNS = Number(process.env.BENCH_RUNS || 3);
const ROUTE = process.env.BENCH_ROUTE || "/alpine-terminal.html";
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS || 60_000);
const versions = process.argv.slice(2);
if (!versions.length) {
	console.error("usage: benchmark-alpine-boot.mjs <ver> [ver ...]");
	process.exit(1);
}

const results = [];

for (const ver of versions) {
	const imageName = `alpine_terminal_${ver}.ext2`;
	const ext2 = path.join(buildDir, imageName);
	if (!(await fs.stat(ext2).catch(() => null))) {
		console.error(`skip ${ver}: missing ${ext2}`);
		continue;
	}

	console.log(`\n=== ${ver}: prepare + deploy ===`);
	await runDeploy(ext2, imageName);

	const browser = await chromium.launch({
		headless: true,
		args: ["--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"],
	});
	const times = [];
	let failures = 0;
	try {
		for (let i = 0; i < RUNS; i++) {
			try {
				const bootS = await measureColdBoot(browser, `${ver}#${i + 1}`);
				times.push(bootS);
				console.log(`  run ${i + 1}: ${bootS.toFixed(2)}s`);
			} catch (error) {
				failures++;
				console.log(`  run ${i + 1}: FAILED (${error.message})`);
			}
		}
	} finally {
		await browser.close();
	}
	const sorted = [...times].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length
		? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2)
		: null;
	const mean = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
	results.push({ ver, times, failures, median, mean, imageName });
}

console.log("\n=== Summary (cold boot to :~$) ===");
console.log("version | median | mean | runs");
for (const r of [...results].sort((a, b) => (a.median ?? Infinity) - (b.median ?? Infinity))) {
	console.log(
		r.median == null
			? `${r.ver.padEnd(8)} | no successful runs | failures=${r.failures}`
			: `${r.ver.padEnd(8)} | ${r.median.toFixed(2)}s | ${r.mean.toFixed(2)}s | ${r.times.map((t) => t.toFixed(1)).join(", ")} | failures=${r.failures}`,
	);
}
const successful = results.filter((result) => result.median != null);
if (successful.length) {
	const best = [...successful].sort((a, b) => a.median - b.median)[0];
	console.log(`\nFastest: Alpine ${best.ver} (median ${best.median.toFixed(2)}s)`);
}
const outputPath = path.join(buildDir, "boot-benchmark-results.json");
await fs.writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`);
console.log(`Results: ${outputPath}`);

async function runDeploy(ext2, imageName) {
	const imageDir = path.join(rootDir, "workers", "disk-worker", "assets", "disks", imageName);
	const stat = await fs.stat(ext2);
	const manifest = await fs.readFile(path.join(imageDir, "manifest.json"), "utf8")
		.then(JSON.parse)
		.catch(() => null);
	if (!manifest || manifest.size !== stat.size) {
		await fs.rm(imageDir, { recursive: true, force: true });
		await run("npm", ["run", "prepare:disk", "--", "--input", ext2, "--name", imageName], {
			cwd: path.join(rootDir, "workers", "disk-worker"),
		});
	}
	await run("node", [path.join(rootDir, "scripts", "build-cloudflare-worker.mjs")], {
		env: {
			ALPINE_DISK_SOURCE_URL: ext2,
			ALPINE_DISK_IMAGE: imageName,
		},
	});
	await run("npx", ["wrangler", "deploy"], { cwd: path.join(rootDir, "workers", "disk-worker") });
}

async function measureColdBoot(browser, label) {
	const context = await browser.newContext();
	const page = await context.newPage();
	const diagnostics = [];
	page.on("console", (message) => {
		if (message.type() === "error" || /fault/i.test(message.text())) {
			diagnostics.push(message.text());
		}
	});
	try {
		await page.goto(`${ORIGIN}/robots.txt`, { waitUntil: "domcontentloaded", timeout: 60_000 });
		await page.evaluate(async () => {
			for (const db of await indexedDB.databases()) {
				await new Promise((res) => {
					const req = indexedDB.deleteDatabase(db.name);
					req.onsuccess = req.onerror = req.onblocked = () => res();
				});
			}
		});
		const cdp = await page.context().newCDPSession(page);
		await cdp.send("Network.clearBrowserCache");

		const t0 = Date.now();
		await page.goto(`${ORIGIN}${ROUTE}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
		await page.waitForFunction(
			() => /:\~\$/.test(document.getElementById("console")?.innerText ?? ""),
			undefined,
			{ timeout: TIMEOUT_MS },
		);
		return (Date.now() - t0) / 1000;
	} catch (error) {
		const tail = await page.locator("#console").innerText().catch(() => "");
		error.message = `${label}: ${error.message}; console=${diagnostics.join(" | ")}; tail=${tail.slice(-500)}`;
		throw error;
	} finally {
		await context.close();
	}
}

function run(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd: opts.cwd || rootDir,
			stdio: "inherit",
			env: { ...process.env, ...opts.env },
		});
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
	});
}
