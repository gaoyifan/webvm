#!/usr/bin/env node
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(rootDir, "workers", "disk-worker");
const assetsDir = path.join(workerDir, "assets");

// Locally built bullseye image (scripts/build-debian-image.sh); for images
// not yet chunked into assets/, point WEBVM_DISK_SOURCE_URL at the .ext2.
const diskImageName = process.env.WEBVM_DISK_IMAGE || "debian_bullseye_20260706_1.ext2";
// Either a wss/https CloudDevice endpoint or a local .ext2 file path.
const diskSource = process.env.WEBVM_DISK_SOURCE_URL || `wss://disks.webvm.io/${diskImageName}`;
const diskSourceIsLocal = !/^(https|wss):/.test(diskSource);
const diskSize = process.env.WEBVM_DISK_SIZE;

await resetAssets();
await run("npm", ["run", "build"], {
	WEBVM_MODE: "cloudflare",
	VITE_WEBVM_DISK_IMAGE: diskImageName,
	...(process.env.ALPINE_DISK_IMAGE ? { VITE_ALPINE_DISK_IMAGE: process.env.ALPINE_DISK_IMAGE } : {}),
});
await fs.cp(path.join(rootDir, "build"), assetsDir, { recursive: true });
await stripExternalReferences();
await writeAssetHeaders();
await run("node", [path.join(rootDir, "scripts", "mirror-cheerpx.mjs")]);
await run("npm", [
	"--prefix",
	workerDir,
	"run",
	"prepare:disk",
	"--",
	diskSourceIsLocal ? "--input" : "--source-url",
	diskSource,
	"--name",
	diskImageName,
], diskSize ? { WEBVM_DISK_SIZE: diskSize } : {});

// Secondary disk for /alpine-terminal.html (skipped if the image file is absent).
const alpineImageName = process.env.ALPINE_DISK_IMAGE || "alpine_terminal_3.23.5.ext2";
const alpineSource = process.env.ALPINE_DISK_SOURCE_URL || "/home/yifan/alpine-build/alpine_terminal_3.23.5.ext2";
if (alpineSource !== diskSource && (await fs.stat(alpineSource).catch(() => null))) {
	await run("npm", [
		"--prefix",
		workerDir,
		"run",
		"prepare:disk",
		"--",
		"--input",
		alpineSource,
		"--name",
		alpineImageName,
	]);
}

async function resetAssets() {
	// Clear built frontend files but keep the (large, immutable) disk chunks;
	// prepare:disk skips chunks that already exist.
	await fs.mkdir(assetsDir, { recursive: true });
	for (const entry of await fs.readdir(assetsDir)) {
		if (entry === "disks") {
			continue;
		}
		await fs.rm(path.join(assetsDir, entry), { recursive: true, force: true });
	}
	await fs.writeFile(path.join(assetsDir, ".gitkeep"), "");
}

/**
 * The deployed site must be fully self-hosted: strip the analytics script
 * (it posts to plausible.leaningtech.com) and the Google Fonts preconnect
 * hints from every built HTML page.
 */
async function stripExternalReferences() {
	for (const entry of await fs.readdir(assetsDir, { recursive: true })) {
		if (!entry.endsWith(".html")) {
			continue;
		}
		const file = path.join(assetsDir, entry);
		const html = await fs.readFile(file, "utf8");
		const stripped = html
			.replace(/^\s*<script data-domain="webvm\.io"[^>]*><\/script>\n?/m, "")
			.replace(/^\s*<link rel="preconnect"[^>]*>\n?/gm, "");
		if (stripped !== html) {
			await fs.writeFile(file, stripped);
		}
	}
}

async function writeAssetHeaders() {
	// CheerpX needs cross-origin isolation (SharedArrayBuffer). Static assets
	// are served without invoking the Worker, so the headers must come from
	// the _headers file. Boot bundles have versioned filenames, so they can
	// be cached forever.
	const headers = [
		"/*",
		"  Cross-Origin-Embedder-Policy: require-corp",
		"  Cross-Origin-Opener-Policy: same-origin",
		"  Cross-Origin-Resource-Policy: cross-origin",
		"/disks/:image/bundles/:bundle",
		"  Cache-Control: public, max-age=31536000, immutable",
		"",
	].join("\n");
	await fs.writeFile(path.join(assetsDir, "_headers"), headers);
}

function run(command, args, env = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: rootDir,
			env: { ...process.env, ...env },
			stdio: "inherit",
		});
		child.on("exit", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
			}
		});
		child.on("error", reject);
	});
}
