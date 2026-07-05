#!/usr/bin/env node
// Replays the recorded boot chunk order as serial 128 KiB block reads and
// reports per-block latency, to quantify the boot-profile prewarm.
import { readFileSync } from "node:fs";

const host = process.argv[2] ?? "webvm-disk-worker.d58993771361bc4ff2f5.workers.dev";
const image = "debian_large_20230522_5044875331_2.ext2";
const chunksFile = process.argv[3];

let chunks;
if (chunksFile) {
	chunks = JSON.parse(readFileSync(chunksFile, "utf8"));
} else {
	const stats = await (await fetch(`https://${host}/debug/session?image=${image}`)).json();
	chunks = stats.profile;
	if (!chunks?.length) {
		throw new Error("no profile recorded; pass a chunks JSON file");
	}
}

const ws = new WebSocket(`wss://${host}/${image}`);
ws.binaryType = "arraybuffer";
let resolve;
const next = () => new Promise((r) => (resolve = r));
ws.onmessage = (e) => resolve && resolve(e.data);
const metaPromise = next();
await new Promise((r) => (ws.onopen = r));
await metaPromise;

const latencies = [];
for (const chunk of chunks) {
	const start = chunk * 1048576;
	const t0 = performance.now();
	const p = next();
	ws.send(`${start}-${start + 131071}`);
	await p;
	latencies.push(performance.now() - t0);
}
ws.close();

const sorted = [...latencies].sort((a, b) => a - b);
const sum = latencies.reduce((a, b) => a + b, 0);
const pct = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(0);
console.log(`blocks=${latencies.length} total=${(sum / 1000).toFixed(1)}s mean=${(sum / latencies.length).toFixed(0)}ms p50=${pct(0.5)}ms p90=${pct(0.9)}ms max=${sorted.at(-1).toFixed(0)}ms`);
console.log("first 10:", latencies.slice(0, 10).map((v) => v.toFixed(0)).join(","));
console.log("rest:", latencies.slice(10).map((v) => v.toFixed(0)).join(","));
