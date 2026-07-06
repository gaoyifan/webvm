/**
 * Boot-block prefetch for the CloudDevice disk.
 *
 * The set of 128 KiB blocks CheerpX reads while booting an image is
 * deterministic, and the server ships it as a static asset
 * (/disks/<image>/bootblocks.json, see workers/disk-worker). CheerpX reads
 * those blocks one at a time over the WebSocket, so a cold boot pays
 * ~150 serial round trips. This module loads the list at startup, subtracts
 * the blocks already present in CheerpX's IndexedDB block cache, fetches the
 * missing ones in a few parallel coalesced HTTP range requests, and lets the
 * WebSocket proxy (disk-ws-reconnect.js) answer matching block reads locally.
 *
 * Everything here is best-effort: on any failure lookups return null and the
 * read goes to the server as before.
 */
const BLOCK_BYTES = 131072;
// Merging nearby blocks into one range trades a little wasted transfer for
// fewer requests (gap 2 => ~30 requests / ~1 MiB waste for the Debian boot).
const COALESCE_GAP_BLOCKS = 2;
const MAX_RANGE_BYTES = 8 * 1024 * 1024;
// How long a block read may wait on the bulk fetch before falling back to
// the server.
const LOOKUP_TIMEOUT_MS = 10000;

export function createBootPrefetcher(wsUrl, cacheId) {
	const url = new URL(wsUrl, globalThis.location.href);
	const imageName = decodeURIComponent(url.pathname.slice(1));
	const httpOrigin = `${url.protocol === "ws:" ? "http:" : "https:"}//${url.host}`;
	const diskHttpUrl = `${httpOrigin}/${encodeURIComponent(imageName)}`;

	// blockIndex -> Uint8Array (freed once served).
	const blocks = new Map();
	// blockIndex -> Promise settling when its bulk fetch lands.
	const pending = new Map();
	let imageSize = Infinity;

	// Never rejects; on failure no blocks are registered and every lookup
	// falls through to the server.
	const ready = (async () => {
		const response = await fetch(`${httpOrigin}/disks/${encodeURIComponent(imageName)}/bootblocks.json`);
		if (!response.ok) {
			throw new Error(`no bootblocks.json (${response.status})`);
		}
		const profile = await response.json();
		if (!Array.isArray(profile.blocks) || !Number.isFinite(profile.imageSize)) {
			throw new Error("malformed bootblocks.json");
		}
		imageSize = profile.imageSize;

		const cached = await readCachedBlockIndexes(cacheId, profile);
		const missing = profile.blocks.filter((block) => !cached.has(block)).sort((a, b) => a - b);
		if (missing.length > 0) {
			fetchMissing(missing);
		}
	})().catch(() => {});

	function fetchMissing(missing) {
		for (const range of coalesce(missing)) {
			const startByte = range.first * BLOCK_BYTES;
			const endByte = Math.min((range.last + 1) * BLOCK_BYTES, imageSize) - 1;
			// Never rejects: a failed fetch just leaves its blocks absent and
			// lookups for them fall back to the server.
			const settled = (async () => {
				try {
					const response = await fetch(`${diskHttpUrl}?s=${startByte}&e=${endByte}`);
					if (!response.ok) {
						return;
					}
					const data = new Uint8Array(await response.arrayBuffer());
					for (let block = range.first; block <= range.last; block++) {
						const offset = block * BLOCK_BYTES - startByte;
						if (offset < data.byteLength) {
							blocks.set(block, data.subarray(offset, Math.min(offset + BLOCK_BYTES, data.byteLength)));
						}
					}
				} catch {
					// Blocks stay absent.
				} finally {
					for (let block = range.first; block <= range.last; block++) {
						pending.delete(block);
					}
				}
			})();
			for (let block = range.first; block <= range.last; block++) {
				pending.set(block, settled);
			}
		}
	}

	/**
	 * Returns the bytes for a `<start>-<end>` block request if the prefetch
	 * (already or imminently) covers it, else null. Never rejects.
	 */
	async function lookup(start, end) {
		try {
			await ready;
			const effectiveEnd = Math.min(end, imageSize - 1);
			const firstBlock = Math.floor(start / BLOCK_BYTES);
			const lastBlock = Math.floor(effectiveEnd / BLOCK_BYTES);
			for (let block = firstBlock; block <= lastBlock; block++) {
				if (!blocks.has(block) && !pending.has(block)) {
					return null;
				}
			}
			const waits = [];
			for (let block = firstBlock; block <= lastBlock; block++) {
				const wait = pending.get(block);
				if (wait) {
					waits.push(wait);
				}
			}
			if (waits.length > 0) {
				await withTimeout(Promise.all(waits), LOOKUP_TIMEOUT_MS);
			}

			const output = new Uint8Array(effectiveEnd - start + 1);
			let produced = 0;
			for (let block = firstBlock; block <= lastBlock; block++) {
				const data = blocks.get(block);
				if (!data) {
					return null;
				}
				const blockStart = block * BLOCK_BYTES;
				const from = Math.max(start, blockStart);
				const to = Math.min(effectiveEnd, blockStart + data.byteLength - 1);
				if (to < from) {
					return null;
				}
				output.set(data.subarray(from - blockStart, to - blockStart + 1), from - start);
				produced += to - from + 1;
			}
			if (produced !== output.byteLength) {
				return null;
			}
			// Served blocks are freed: CheerpX caches everything it reads in
			// its own IndexedDB overlay, so they are never requested twice.
			for (let block = firstBlock; block <= lastBlock; block++) {
				blocks.delete(block);
			}
			return output.buffer;
		} catch {
			return null;
		}
	}

	return { lookup };
}

function coalesce(sortedBlocks) {
	const ranges = [];
	let first = sortedBlocks[0];
	let last = sortedBlocks[0];
	for (const block of sortedBlocks.slice(1)) {
		const fits = (block - first + 1) * BLOCK_BYTES <= MAX_RANGE_BYTES;
		if (block - last - 1 <= COALESCE_GAP_BLOCKS && fits) {
			last = block;
			continue;
		}
		ranges.push({ first, last });
		first = last = block;
	}
	ranges.push({ first, last });
	return ranges;
}

/**
 * Lists the block indexes already present in CheerpX's IndexedDB block cache
 * (an IDBDevice filesystem with one file per 128 KiB block, plus a meta file
 * recording the device size and mtime). Only trusted when the meta file
 * matches the current image: CheerpX discards stale caches itself.
 */
async function readCachedBlockIndexes(cacheId, profile) {
	const empty = new Set();
	if (!cacheId || typeof indexedDB === "undefined" || !indexedDB.databases) {
		return empty;
	}
	const dbName = `cjFS_/${cacheId}/`;
	try {
		const databases = await indexedDB.databases();
		if (!databases.some((db) => db.name === dbName)) {
			return empty;
		}
		// The database exists: open without a version so this never creates
		// or upgrades it out from under CheerpX.
		const db = await new Promise((resolve, reject) => {
			const request = indexedDB.open(dbName);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			if (!db.objectStoreNames.contains("files")) {
				return empty;
			}
			const keys = await new Promise((resolve, reject) => {
				const request = db.transaction("files", "readonly").objectStore("files").getAllKeys();
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const epoch = Math.floor(new Date(profile.imageCreatedAt).getTime() / 1000);
			if (!keys.includes(`/meta_${profile.imageSize}-${epoch}`)) {
				return empty;
			}
			const cached = new Set();
			for (const key of keys) {
				if (/^\/\d+$/.test(key)) {
					cached.add(Number(key.slice(1)));
				}
			}
			return cached;
		} finally {
			db.close();
		}
	} catch {
		return empty;
	}
}

function withTimeout(promise, ms) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("prefetch timeout")), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
