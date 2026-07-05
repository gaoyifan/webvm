#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ASSET_CHUNK_SIZE = 1024 * 1024;
const CHUNK_SIZE = parsePositiveInteger(process.env.WEBVM_DISK_ASSET_CHUNK_SIZE, DEFAULT_ASSET_CHUNK_SIZE);
const DEFAULT_DOWNLOAD_CONCURRENCY = 16;
const DEFAULT_DOWNLOAD_RETRIES = 8;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120000;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(scriptDir, "..");
const assetsDir = path.join(workerDir, "assets");
let lastProgressLog = 0;

const args = parseArgs(process.argv.slice(2));

if (!args.input && !args.sourceUrl) {
	fail("Provide --input <disk.ext2> or --source-url <wss-or-https-url>.");
}

if (args.input && args.sourceUrl) {
	fail("Use either --input or --source-url, not both.");
}

const imageName = args.name ?? inferImageName(args.input ?? args.sourceUrl);
if (!imageName.endsWith(".ext2")) {
	fail(`Image name must end with .ext2: ${imageName}`);
}

const imageDir = path.join(assetsDir, "disks", imageName);
const chunksDir = path.join(imageDir, "chunks");

const source = args.input ?? args.sourceUrl;
const remoteInfo = args.input ? null : await resolveRemoteInfo(args.sourceUrl, args.size ?? process.env.WEBVM_DISK_SIZE);
const size = args.input ? (await fs.stat(args.input)).size : remoteInfo.size;
const chunks = Math.ceil(size / CHUNK_SIZE);

if (await isAlreadyPrepared()) {
	console.log(`${imageName} already prepared (${chunks} chunks); skipping download.`);
	process.exit(0);
}

await fs.rm(imageDir, { recursive: true, force: true });
await fs.mkdir(chunksDir, { recursive: true });

if (args.input) {
	await splitLocalFile(args.input, chunksDir, size);
} else {
	await downloadCloudDisk(args.sourceUrl, chunksDir, size);
}

const manifest = {
	name: imageName,
	size,
	chunkSize: CHUNK_SIZE,
	chunks,
	source,
	createdAt: remoteInfo?.lastModified ? new Date(remoteInfo.lastModified * 1000).toISOString() : new Date().toISOString(),
};

await fs.writeFile(path.join(imageDir, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
console.log(`Prepared ${imageName}: ${size} bytes in ${chunks} chunks`);

function parseArgs(argv) {
	const parsed = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) {
			fail(`Unexpected argument: ${arg}`);
		}

		const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
		const value = argv[++i];
		if (!value || value.startsWith("--")) {
			fail(`Missing value for ${arg}`);
		}
		parsed[key] = value;
	}
	return parsed;
}

function inferImageName(value) {
	const pathname = new URL(value, "file:///").pathname;
	return path.basename(pathname);
}

async function isAlreadyPrepared() {
	const manifest = await fs
		.readFile(path.join(imageDir, "manifest.json"), "utf8")
		.then(JSON.parse)
		.catch(() => null);
	if (!manifest || manifest.size !== size || manifest.chunkSize !== CHUNK_SIZE || manifest.source !== source) {
		return false;
	}
	const files = await fs.readdir(chunksDir).catch(() => []);
	return files.filter((name) => name.endsWith(".bin")).length === chunks;
}

async function splitLocalFile(input, chunksDir, size) {
	const file = await fs.open(input, "r");
	try {
		let index = 0;
		let offset = 0;

		while (offset < size) {
			const length = Math.min(CHUNK_SIZE, size - offset);
			const buffer = Buffer.allocUnsafe(length);
			const { bytesRead } = await file.read(buffer, 0, length, offset);
			if (bytesRead !== length) {
				fail(`Unexpected EOF at byte ${offset}`);
			}

			await writeChunk(chunksDir, index, buffer);
			offset += bytesRead;
			index++;
			logProgress(offset, size);
		}
	} finally {
		await file.close();
	}
}

async function downloadCloudDisk(sourceUrl, chunksDir, size) {
	const concurrency = parsePositiveInteger(args.concurrency ?? process.env.WEBVM_DISK_DOWNLOAD_CONCURRENCY, DEFAULT_DOWNLOAD_CONCURRENCY);
	let completedBytes = 0;
	let nextIndex = 0;

	async function worker() {
		while (nextIndex < chunks) {
			const index = nextIndex++;
			const start = index * CHUNK_SIZE;
			const end = Math.min(start + CHUNK_SIZE, size) - 1;
			const data = await downloadChunkWithRetry(sourceUrl, start, end);
			await writeChunk(chunksDir, index, data);
			completedBytes += data.byteLength;
			logProgress(completedBytes, size);
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, chunks) }, () => worker()));
}

async function downloadChunkWithRetry(sourceUrl, start, end) {
	const retries = parsePositiveInteger(args.retries ?? process.env.WEBVM_DISK_DOWNLOAD_RETRIES, DEFAULT_DOWNLOAD_RETRIES);
	let lastError;

	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			return await downloadChunk(sourceUrl, start, end);
		} catch (error) {
			lastError = error;
			if (attempt === retries) {
				break;
			}
			const delay = Math.min(30000, 1000 * 2 ** (attempt - 1));
			console.warn(`Retrying ${start}-${end} after ${formatError(error)} (${attempt}/${retries})`);
			await sleep(delay);
		}
	}

	throw new Error(`Download failed for ${start}-${end}: ${formatError(lastError)}`);
}

async function downloadChunk(sourceUrl, start, end) {
	const url = new URL(sourceUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:"));
	url.search = new URLSearchParams({ s: String(start), e: String(end) }).toString();

	const response = await fetch(url, {
		headers: { "Connection": "close" },
		signal: AbortSignal.timeout(parsePositiveInteger(process.env.WEBVM_DISK_DOWNLOAD_TIMEOUT_MS, DEFAULT_DOWNLOAD_TIMEOUT_MS)),
	});
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}`);
	}

	const data = new Uint8Array(await response.arrayBuffer());
	if (data.byteLength !== end - start + 1) {
		throw new Error(`unexpected chunk size, got ${data.byteLength}`);
	}

	return data;
}

async function resolveRemoteInfo(sourceUrl, sizeValue) {
	const explicitSize = sizeValue ? parsePositiveInteger(sizeValue) : null;
	if (sourceUrl.startsWith("ws:") || sourceUrl.startsWith("wss:")) {
		const wsInfo = await readWebSocketDiskInfo(sourceUrl);
		if (explicitSize !== null) {
			if (explicitSize > wsInfo.size) {
				console.warn(`Ignoring explicit size ${explicitSize}; WebSocket source reports ${wsInfo.size}`);
				return wsInfo;
			}
			return { ...wsInfo, size: explicitSize };
		}
		return wsInfo;
	}

	if (explicitSize === null) {
		fail("Remote HTTP disk download requires --size <bytes> or WEBVM_DISK_SIZE.");
	}

	return { size: explicitSize, lastModified: Math.floor(Date.now() / 1000) };
}

async function readWebSocketDiskInfo(sourceUrl) {
	const message = await readWebSocketMetadata(sourceUrl);
	const match = String(message).match(/^(\d+)-(\d+)$/);
	if (!match) {
		fail(`Unexpected WebSocket disk metadata: ${String(message)}`);
	}

	return {
		size: parsePositiveInteger(match[1]),
		lastModified: parsePositiveInteger(match[2]),
	};
}

function readWebSocketMetadata(sourceUrl) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(sourceUrl);
		let settled = false;
		const timeout = setTimeout(() => {
			settled = true;
			ws.close();
			reject(new Error("WebSocket metadata timed out"));
		}, parsePositiveInteger(process.env.WEBVM_DISK_DOWNLOAD_TIMEOUT_MS, DEFAULT_DOWNLOAD_TIMEOUT_MS));

		ws.addEventListener("message", event => {
			settled = true;
			clearTimeout(timeout);
			ws.close();
			resolve(event.data);
		}, { once: true });
		ws.addEventListener("error", () => {
			settled = true;
			clearTimeout(timeout);
			reject(new Error("WebSocket request failed"));
		}, { once: true });
		ws.addEventListener("close", () => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			reject(new Error("WebSocket closed before metadata"));
		}, { once: true });
	});
}

function parsePositiveInteger(value, fallback) {
	if (value === undefined || value === null || value === "") {
		return fallback;
	}

	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		fail(`Expected a positive integer, got: ${value}`);
	}

	return parsed;
}

async function writeChunk(chunksDir, index, data) {
	const name = `${String(index).padStart(6, "0")}.bin`;
	await fs.writeFile(path.join(chunksDir, name), data);
}

function logProgress(done, total) {
	if (done !== total && done - lastProgressLog < 16 * 1024 * 1024) {
		return;
	}
	lastProgressLog = done;
	const percent = ((done / total) * 100).toFixed(1);
	process.stdout.write(`\r${done}/${total} bytes (${percent}%)`);
	if (done === total) {
		process.stdout.write("\n");
	}
}

function formatError(error) {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
	console.error(message);
	process.exit(1);
}
