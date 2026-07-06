#!/usr/bin/env node
/**
 * Exports the boot profile (first-touch order of 128 KiB blocks) recorded by
 * a deployed DiskSession Durable Object (requires DEBUG_ENDPOINTS=1) into the
 * local assets directory as bootblocks.json, so it ships with the next
 * deploy. The frontend uses it to bulk-load boot blocks missing from the
 * local cache; the DO uses it to prewarm its chunk cache.
 *
 * Usage:
 *   node scripts/export-boot-profile.mjs --host <worker-host> --image <image>.ext2
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imageDir = path.join(workerDir, "assets", "disks", image);
const manifest = JSON.parse(await fs.readFile(path.join(imageDir, "manifest.json"), "utf8"));

const profile = {
	imageCreatedAt: manifest.createdAt,
	imageSize: manifest.size,
	recordedAt: new Date().toISOString(),
	blockSize: 131072,
	blocks: stats.profile,
};
await fs.writeFile(path.join(imageDir, "bootblocks.json"), `${JSON.stringify(profile)}\n`);
console.log(`Wrote ${stats.profile.length}-block boot profile to assets/disks/${image}/bootblocks.json`);
