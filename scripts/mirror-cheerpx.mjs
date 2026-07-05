#!/usr/bin/env node
/**
 * Mirrors the CheerpX runtime from cxrtnc.leaningtech.com into the disk
 * worker's static assets, so the deployed site is fully self-hosted (the
 * browser never leaves the Worker's origin).
 *
 * The file list is the complete published runtime for the pinned version:
 * loader, engine JS/WASM, and the Tailscale networking stack. Downloads are
 * kept in a local cache directory that survives asset resets; the cache is
 * then copied into the assets directory.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHEERPX_VERSION = "1.3.0";
const UPSTREAM = `https://cxrtnc.leaningtech.com/${CHEERPX_VERSION}`;

// Everything the 1.3.0 runtime can load at runtime, including the fallback
// engine for browsers without WASM return-call support and the networking
// stack (loaded lazily when networking is enabled).
const RUNTIME_FILES = [
	"cx.esm.js",
	"cx.js",
	"cx_esm.js",
	"cxbridge.js",
	"cxcore.js",
	"cxcore.wasm",
	"cxcore-no-return-call.js",
	"cxcore-no-return-call.wasm",
	"cheerpOS.js",
	"workerclock.js",
	"tun/direct.js",
	"tun/tailscale_tun_auto.js",
	"tun/tailscale_tun.js",
	"tun/wasm_exec.js",
	"tun/ipstack.js",
	"tun/ipstack.wasm",
	"tun/tailscale.wasm",
];

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(rootDir, "workers", "disk-worker");
const cacheDir = path.join(workerDir, ".cheerpx-mirror", CHEERPX_VERSION);
const assetDir = path.join(workerDir, "assets", "cheerpx", CHEERPX_VERSION);

let downloaded = 0;
for (const file of RUNTIME_FILES) {
	const cached = path.join(cacheDir, file);
	if (await fs.stat(cached).catch(() => null)) {
		continue;
	}
	const response = await fetch(`${UPSTREAM}/${file}`);
	if (!response.ok) {
		throw new Error(`Failed to fetch ${file}: ${response.status}`);
	}
	await fs.mkdir(path.dirname(cached), { recursive: true });
	await fs.writeFile(cached, Buffer.from(await response.arrayBuffer()));
	downloaded++;
}

await fs.rm(assetDir, { recursive: true, force: true });
await fs.mkdir(path.dirname(assetDir), { recursive: true });
await fs.cp(cacheDir, assetDir, { recursive: true });

const label = downloaded > 0 ? `downloaded ${downloaded} file(s)` : "cache hit";
console.log(`CheerpX ${CHEERPX_VERSION} mirror (${label}) -> ${path.relative(rootDir, assetDir)}`);
