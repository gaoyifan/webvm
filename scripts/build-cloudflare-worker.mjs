#!/usr/bin/env node
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(rootDir, "workers", "disk-worker");
const assetsDir = path.join(workerDir, "assets");

const diskImageName = process.env.WEBVM_DISK_IMAGE || "debian_large_20230522_5044875331_2.ext2";
const diskSourceUrl = process.env.WEBVM_DISK_SOURCE_URL || `wss://disks.webvm.io/${diskImageName}`;
const diskSize = process.env.WEBVM_DISK_SIZE;

await resetAssets();
await run("npm", ["run", "build"], {
	WEBVM_MODE: "cloudflare",
	VITE_WEBVM_DISK_IMAGE: diskImageName,
});
await fs.cp(path.join(rootDir, "build"), assetsDir, { recursive: true });
await run("npm", [
	"--prefix",
	workerDir,
	"run",
	"prepare:disk",
	"--",
	"--source-url",
	diskSourceUrl,
	"--name",
	diskImageName,
], diskSize ? { WEBVM_DISK_SIZE: diskSize } : {});

async function resetAssets() {
	await fs.rm(assetsDir, { recursive: true, force: true });
	await fs.mkdir(assetsDir, { recursive: true });
	await fs.writeFile(path.join(assetsDir, ".gitkeep"), "");
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
