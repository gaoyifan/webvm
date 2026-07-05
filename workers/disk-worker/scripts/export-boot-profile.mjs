#!/usr/bin/env node
/**
 * Exports the boot profile recorded by a deployed DiskSession Durable Object
 * (requires DEBUG_ENDPOINTS=1) into the local assets directory, so the
 * profile ships with the next deploy and is available in every colo.
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
	recordedAt: new Date().toISOString(),
	chunks: stats.profile,
};
await fs.writeFile(path.join(imageDir, "bootprofile.json"), `${JSON.stringify(profile)}\n`);
console.log(`Wrote ${stats.profile.length}-chunk boot profile to assets/disks/${image}/bootprofile.json`);
