#!/usr/bin/env node
/**
 * Exports the boot profile (first-touch order of 128 KiB blocks) recorded by
 * a deployed DiskSession Durable Object (requires DEBUG_ENDPOINTS=1) into the
 * local assets directory, so it ships with the next deploy:
 *  - bootblocks.json: the block list. The frontend bulk-loads boot blocks
 *    missing from the local cache; the DO prewarms its chunk cache along it.
 *  - bootbundle.bin.gz: the blocks' bytes concatenated in list order and
 *    gzipped (~19.6 MiB -> ~5.5 MiB for the Debian image). A cold boot
 *    downloads this single asset instead of ~30 range requests and inflates
 *    it with the browser-native DecompressionStream.
 *
 * Usage:
 *   node scripts/export-boot-profile.mjs --host <worker-host> --image <image>.ext2
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, constants } from "node:zlib";

const BLOCK_BYTES = 131072;

const args = Object.fromEntries(
	process.argv.slice(2).map((arg, i, all) => (arg.startsWith("--") ? [arg.slice(2), all[i + 1]] : null)).filter(Boolean),
);
const host = args.host;
const image = args.image;
if (!host || !image) {
	console.error("Usage: export-boot-profile.mjs --host <worker-host> --image <image>.ext2");
	process.exit(1);
}

const stats = await (await fetch(`https://${host}/debug/session?image=${encodeURIComponent(image)}`)).json();
if (!stats.profile?.length) {
	console.error("No profile recorded on the server yet. Boot WebVM once, then retry.");
	process.exit(1);
}
const blocks = stats.profile;

const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imageDir = path.join(workerDir, "assets", "disks", image);
const manifest = JSON.parse(await fs.readFile(path.join(imageDir, "manifest.json"), "utf8"));

const bundleRaw = await concatBlocks(imageDir, manifest, blocks);
const bundle = gzipSync(bundleRaw, { level: constants.Z_BEST_COMPRESSION });
// Version the filename so a client can never pair a stale bundle with a
// newer block list (deploys are atomic per file, not across files): a
// mismatched fetch 404s and the client falls back to range requests.
const bundleName = `bootbundle-${Date.now()}.bin.gz`;
for (const entry of await fs.readdir(imageDir)) {
	if (entry.startsWith("bootbundle-")) {
		await fs.rm(path.join(imageDir, entry));
	}
}
await fs.writeFile(path.join(imageDir, bundleName), bundle);

const profile = {
	imageCreatedAt: manifest.createdAt,
	imageSize: manifest.size,
	recordedAt: new Date().toISOString(),
	blockSize: BLOCK_BYTES,
	blocks,
	bundle: bundleName,
	bundleBytes: bundle.byteLength,
};
await fs.writeFile(path.join(imageDir, "bootblocks.json"), `${JSON.stringify(profile)}\n`);
console.log(
	`Wrote ${blocks.length}-block boot profile to assets/disks/${image}/bootblocks.json ` +
		`(bundle ${(bundleRaw.byteLength / 1048576).toFixed(1)} MiB raw, ${(bundle.byteLength / 1048576).toFixed(1)} MiB gzipped)`,
);

/** Reads each boot block from the local chunk assets, EOF-truncated. */
async function concatBlocks(dir, imageManifest, blockList) {
	const parts = [];
	for (const block of blockList) {
		const start = block * BLOCK_BYTES;
		const length = Math.min(BLOCK_BYTES, imageManifest.size - start);
		if (length <= 0) {
			continue;
		}
		const buffer = Buffer.alloc(length);
		let filled = 0;
		while (filled < length) {
			const offset = start + filled;
			const chunkIndex = Math.floor(offset / imageManifest.chunkSize);
			const offsetInChunk = offset % imageManifest.chunkSize;
			const take = Math.min(length - filled, imageManifest.chunkSize - offsetInChunk);
			const chunkFile = path.join(dir, "chunks", `${String(chunkIndex).padStart(6, "0")}.bin`);
			const handle = await fs.open(chunkFile, "r");
			try {
				await handle.read(buffer, filled, take, offsetInChunk);
			} finally {
				await handle.close();
			}
			filled += take;
		}
		parts.push(buffer);
	}
	return Buffer.concat(parts);
}
