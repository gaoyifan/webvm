#!/usr/bin/env node
/**
 * Protocol-level correctness and performance tests for the WebVM disk worker.
 *
 * Usage:
 *   node scripts/test-disk-endpoint.mjs --url ws://127.0.0.1:8787/<image>.ext2 [--reference <path-or-url>] [--quick]
 *
 * The reference is used to verify payload bytes. It can be a local file path
 * (the original ext2 image) or an HTTP(S) range server. Without a reference,
 * only protocol behavior (not content) is validated.
 */
import { promises as fs } from "node:fs";

const args = parseArgs(process.argv.slice(2));
const wsUrl = args.url ?? "ws://127.0.0.1:8787/debian_large_20230522_5044875331_2.ext2";
const httpUrl = wsUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
const reference = args.reference ?? null;
const quick = "quick" in args;

let failures = 0;
let referenceFile = null;
if (reference && !/^https?:/.test(reference)) {
	referenceFile = await fs.open(reference, "r");
}

// --- discover metadata -------------------------------------------------------
const meta = await withSocket(wsUrl, async (socket) => socket.meta);
const size = meta.size;
console.log(`device info: size=${size} lastModified=${meta.lastModified}`);

const CX_BLOCK = 128 * 1024;
const lastBlockStart = Math.floor((size - 1) / CX_BLOCK) * CX_BLOCK;

// --- correctness: WebSocket --------------------------------------------------
// Note: a 1-byte payload is indistinguishable from the CloudDevice reconnect
// signal. CheerpX never requests 1-byte ranges (it reads 128 KiB blocks), but
// the test client must opt in to receive them as data.
const wsCases = [
	{ name: "first block", start: 0, end: CX_BLOCK - 1 },
	{ name: "sub-block read", start: 4096, end: 8191 },
	{ name: "unaligned range", start: 1048573, end: 1048999 },
	{ name: "chunk boundary span", start: 1048576 - 700, end: 1048576 + 700 },
	{ name: "multi-chunk span (3 MiB)", start: 7 * 1048576 - 1234, end: 10 * 1048576 + 1233 },
	{ name: "single byte", start: 999999, end: 999999, oneByteIsData: true },
	{ name: "last block (EOF clamp)", start: lastBlockStart, end: lastBlockStart + CX_BLOCK - 1 },
	{ name: "last byte", start: size - 1, end: size - 1, oneByteIsData: true },
];

await withSocket(wsUrl, async (socket) => {
	for (const test of wsCases) {
		const expectLength = Math.min(test.end, size - 1) - test.start + 1;
		const data = await socket.request(`${test.start}-${test.end}`, { oneByteIsData: test.oneByteIsData });
		await check(`ws ${test.name}`, data, test.start, expectLength);
	}
});

// --- correctness: WebSocket error handling -----------------------------------
await expectClose("ws malformed range", wsUrl, "banana");
await expectClose("ws inverted range", wsUrl, "100-50");
await expectClose("ws range beyond EOF", wsUrl, `${size}-${size + CX_BLOCK - 1}`);
await expectClose("ws oversized range", wsUrl, `0-${64 * 1024 * 1024}`);

// --- correctness: HTTP fallback ----------------------------------------------
const httpCases = [
	{ name: "query params", url: `${httpUrl}?s=0&e=131071`, start: 0, length: 131072 },
	{ name: "range header", url: httpUrl, headers: { Range: "bytes=524288-655359" }, start: 524288, length: 131072 },
	{ name: "chunk boundary", url: `${httpUrl}?s=${1048576 - 100}&e=${1048576 + 99}`, start: 1048576 - 100, length: 200 },
	{ name: "EOF clamp", url: `${httpUrl}?s=${lastBlockStart}&e=${lastBlockStart + CX_BLOCK - 1}`, start: lastBlockStart, length: size - lastBlockStart },
];

for (const test of httpCases) {
	const response = await fetch(test.url, { headers: test.headers });
	if (!response.ok) {
		fail(`http ${test.name}`, `status ${response.status}`);
		continue;
	}
	const data = new Uint8Array(await response.arrayBuffer());
	await check(`http ${test.name}`, data, test.start, test.length);
}

const headResponse = await fetch(httpUrl, { method: "HEAD" });
const headLength = Number(headResponse.headers.get("content-length"));
if (headResponse.ok && headLength === size) {
	pass("http HEAD metadata");
} else {
	fail("http HEAD metadata", `status=${headResponse.status} content-length=${headLength}`);
}

const badResponse = await fetch(`${httpUrl}?s=${size}&e=${size + 100}`);
if (badResponse.status >= 400) {
	pass("http range beyond EOF rejected");
} else {
	fail("http range beyond EOF rejected", `status ${badResponse.status}`);
}

// --- sequential read soak (subrequest budget) ---------------------------------
if (!quick) {
	const totalBytes = 96 * 1024 * 1024;
	const blocks = totalBytes / CX_BLOCK;
	const started = Date.now();
	let reconnects = 0;
	let bytes = 0;
	let socket = await openSocket(wsUrl);
	for (let i = 0; i < blocks; i++) {
		const start = i * CX_BLOCK;
		const end = Math.min(start + CX_BLOCK - 1, size - 1);
		let data;
		try {
			data = await socket.request(`${start}-${end}`);
		} catch (error) {
			socket.close();
			reconnects++;
			socket = await openSocket(wsUrl);
			data = await socket.request(`${start}-${end}`);
		}
		if (data.reconnected) {
			reconnects++;
		}
		bytes += data.byteLength;
	}
	socket.close();
	const seconds = (Date.now() - started) / 1000;
	const mib = bytes / 1024 / 1024;
	pass(`soak sequential ${mib.toFixed(0)} MiB in ${seconds.toFixed(1)}s (${(mib / seconds).toFixed(1)} MiB/s, ${reconnects} reconnects)`);
}

if (referenceFile) {
	await referenceFile.close();
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

// ------------------------------------------------------------------------------

async function check(name, data, start, expectLength) {
	if (data.byteLength !== expectLength) {
		fail(name, `expected ${expectLength} bytes, got ${data.byteLength}`);
		return;
	}
	if (reference) {
		const expected = await readReference(start, expectLength);
		if (!buffersEqual(data, expected)) {
			fail(name, `payload mismatch at offset ${firstDiff(data, expected)}`);
			return;
		}
	}
	pass(`${name} (${expectLength} bytes)`);
}

async function readReference(start, length) {
	if (referenceFile) {
		const buffer = Buffer.allocUnsafe(length);
		const { bytesRead } = await referenceFile.read(buffer, 0, length, start);
		if (bytesRead !== length) {
			throw new Error(`reference short read at ${start}`);
		}
		return buffer;
	}
	const response = await fetch(`${reference}?s=${start}&e=${start + length - 1}`);
	if (!response.ok) {
		throw new Error(`reference fetch failed: ${response.status}`);
	}
	return new Uint8Array(await response.arrayBuffer());
}

function buffersEqual(a, b) {
	if (a.byteLength !== b.byteLength) return false;
	return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

function firstDiff(a, b) {
	for (let i = 0; i < Math.min(a.byteLength, b.byteLength); i++) {
		if (a[i] !== b[i]) return i;
	}
	return -1;
}

function pass(name) {
	console.log(`PASS ${name}`);
}

function fail(name, message) {
	failures++;
	console.error(`FAIL ${name}: ${message}`);
}

async function expectClose(name, url, payload) {
	try {
		await withSocket(url, async (socket) => {
			try {
				await socket.request(payload, { oneByteIsData: true });
				fail(name, "expected close, got data");
			} catch (error) {
				if (error.closed) {
					pass(`${name} (closed: ${error.reason ?? ""})`);
				} else {
					throw error;
				}
			}
		});
	} catch (error) {
		fail(name, error.message);
	}
}

async function withSocket(url, callback) {
	const socket = await openSocket(url);
	try {
		return await callback(socket);
	} finally {
		socket.close();
	}
}

function openSocket(url) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		ws.binaryType = "arraybuffer";
		let meta = null;
		let pending = null;
		const timeout = setTimeout(() => reject(new Error("metadata timeout")), 30000);

		ws.addEventListener("message", (event) => {
			if (meta === null) {
				clearTimeout(timeout);
				const match = String(event.data).match(/^(\d+)-(\d+)$/);
				if (!match) {
					reject(new Error(`bad device info: ${event.data}`));
					ws.close();
					return;
				}
				meta = { size: Number(match[1]), lastModified: Number(match[2]) };
				resolve(api);
				return;
			}
			if (!pending) {
				return;
			}
			const current = pending;
			const data = new Uint8Array(event.data);
			if (data.byteLength === 0) {
				return; // keepalive
			}
			if (data.byteLength === 1 && !current.oneByteIsData) {
				// reconnect signal: not expected with the DO design
				pending = null;
				clearTimeout(current.timer);
				current.reject(Object.assign(new Error("server sent reconnect signal"), { reconnect: true }));
				return;
			}
			pending = null;
			clearTimeout(current.timer);
			current.resolve(data);
		});
		ws.addEventListener("close", (event) => {
			clearTimeout(timeout);
			if (pending) {
				const current = pending;
				pending = null;
				clearTimeout(current.timer);
				current.reject(Object.assign(new Error(`closed: ${event.code} ${event.reason}`), {
					closed: true,
					code: event.code,
					reason: event.reason,
				}));
			}
		});
		ws.addEventListener("error", () => {
			clearTimeout(timeout);
			reject(new Error("websocket error"));
		});

		const api = {
			get meta() {
				return meta;
			},
			request(text, { oneByteIsData = false } = {}) {
				return new Promise((resolveRequest, rejectRequest) => {
					pending = {
						resolve: resolveRequest,
						reject: rejectRequest,
						oneByteIsData,
						timer: setTimeout(() => {
							pending = null;
							rejectRequest(new Error(`request timeout: ${text}`));
						}, 60000),
					};
					ws.send(text);
				});
			},
			close() {
				try {
					ws.close(1000);
				} catch {}
			},
		};
	});
}

function parseArgs(argv) {
	const parsed = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) {
			throw new Error(`Unexpected argument: ${arg}`);
		}
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) {
			parsed[key] = true;
		} else {
			parsed[key] = next;
			i++;
		}
	}
	return parsed;
}
