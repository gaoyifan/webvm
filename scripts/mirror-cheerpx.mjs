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
import { gzipSync } from "node:zlib";

// 1.3.0 is the newest runtime that can run dpkg/apt: 1.3.5's futex handling
// breaks the child processes dpkg-deb spawns ("The futex facility returned
// an unexpected error code"), making `apt install` fail on any image. The
// trade-off: 1.3.5 fixes the getrandom() hang that trixie's glibc 2.41
// triggers on 1.3.0 (buster's glibc 2.28 getrandom works fine on both).
const CHEERPX_VERSION = "1.3.0";
const UPSTREAM = `https://cxrtnc.leaningtech.com/${CHEERPX_VERSION}`;

// The Tailscale IPN engine is pinned to an older release than the rest of the
// runtime: 1.1.3+ builds (tailscale v1.78.3) dropped support for the
// `exitNodeIp` setting in ipn.up() and only auto-suggest an exit node by DERP
// latency, which on our tailnet picks nodes that do not forward webvm
// traffic. The 1.1.2 build (tailscale v1.76.3) still applies `exitNodeIp`,
// letting the frontend pin the one verified-working exit node. The JS API
// surface consumed by tun/tailscale_tun.js is compatible across both.
const TS_WASM_VERSION = "1.1.2";
// 28.6 MiB raw exceeds the 25 MiB Workers static asset limit, so it is
// stored gzipped (~6.2 MiB) and inflated in the browser by the (overridden)
// tailscale_tun.js via DecompressionStream.
const TS_WASM_ASSET = "tun/tailscale.wasm.gz";

// Everything the 1.3.0 runtime can load at runtime, including the fallback
// engine for browsers without WASM return-call support and the networking
// stack (loaded lazily when networking is enabled). tun/tailscale.wasm is
// intentionally absent: see TS_WASM_VERSION above.
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
];

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(rootDir, "workers", "disk-worker");
const mirrorDir = path.join(workerDir, ".cheerpx-mirror");
const cacheDir = path.join(mirrorDir, CHEERPX_VERSION);
const assetDir = path.join(workerDir, "assets", "cheerpx", CHEERPX_VERSION);

async function download(url, dest) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: ${response.status}`);
	}
	await fs.mkdir(path.dirname(dest), { recursive: true });
	await fs.writeFile(dest, Buffer.from(await response.arrayBuffer()));
}

let downloaded = 0;
for (const file of RUNTIME_FILES) {
	const cached = path.join(cacheDir, file);
	if (await fs.stat(cached).catch(() => null)) {
		continue;
	}
	await download(`${UPSTREAM}/${file}`, cached);
	downloaded++;
}

const tsWasmCached = path.join(mirrorDir, TS_WASM_VERSION, "tun", "tailscale.wasm");
if (!(await fs.stat(tsWasmCached).catch(() => null))) {
	await download(`https://cxrtnc.leaningtech.com/${TS_WASM_VERSION}/tun/tailscale.wasm`, tsWasmCached);
	downloaded++;
}

await fs.rm(assetDir, { recursive: true, force: true });
await fs.mkdir(path.dirname(assetDir), { recursive: true });
await fs.cp(cacheDir, assetDir, { recursive: true });

// Stale cache dirs from before the wasm pin may still carry the 1.3.0 wasm.
await fs.rm(path.join(assetDir, "tun", "tailscale.wasm"), { force: true });
await fs.writeFile(path.join(assetDir, TS_WASM_ASSET), gzipSync(await fs.readFile(tsWasmCached), { level: 9 }));

// Fork patches: files in overrides/ replace their pristine upstream
// counterparts (tailscale_tun_auto.js for exit node pinning,
// tailscale_tun.js for gzipped wasm loading).
const overridesDir = path.join(workerDir, "overrides", "cheerpx", CHEERPX_VERSION);
if (await fs.stat(overridesDir).catch(() => null)) {
	await fs.cp(overridesDir, assetDir, { recursive: true });
}

const label = downloaded > 0 ? `downloaded ${downloaded} file(s)` : "cache hit";
console.log(
	`CheerpX ${CHEERPX_VERSION} mirror (ts wasm ${TS_WASM_VERSION}, ${label}) -> ${path.relative(rootDir, assetDir)}`,
);
