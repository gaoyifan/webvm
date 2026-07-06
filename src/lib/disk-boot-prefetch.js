/**
 * Boot-block prefetch for the CloudDevice disk.
 *
 * The set of 128 KiB blocks CheerpX reads while booting an image is
 * deterministic, and the server ships it as a static asset
 * (/disks/<image>/bootblocks.json, see workers/disk-worker). CheerpX reads
 * those blocks one at a time over the WebSocket, so a cold boot pays
 * ~150 serial round trips. This module loads the list at startup, subtracts
 * the blocks already present in CheerpX's IndexedDB block cache, bulk-fetches
 * the missing ones, and lets the WebSocket proxy (disk-ws-reconnect.js)
 * answer matching block reads locally.
 *
 * Two bulk paths, picked by transfer size:
 *  - mostly-cold cache: one request for the gzipped boot bundle (the blocks
 *    concatenated in first-touch order, ~29% of raw), inflated incrementally
 *    with DecompressionStream so each block is served as soon as its bytes
 *    arrive
 *  - mostly-warm cache: a few parallel coalesced HTTP range requests for
 *    just the missing blocks
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
		if (missing.length === 0) {
			return;
		}
		// The bundle always transfers all blocks compressed; ranges transfer
		// only the missing blocks but raw. Pick whichever moves fewer bytes.
		const bundleUsable =
			typeof profile.bundle === "string" &&
			Number.isFinite(profile.bundleBytes) &&
			typeof DecompressionStream === "function";
		if (bundleUsable && missing.length * BLOCK_BYTES > profile.bundleBytes) {
			fetchBundle(profile, missing);
		} else {
			fetchMissing(missing);
		}
	})().catch(() => {});

	/**
	 * Downloads the gzipped boot bundle (all profile blocks concatenated in
	 * list order) and registers blocks incrementally as the stream inflates,
	 * so early boot reads are served before the download finishes. On any
	 * failure the still-missing blocks fall back to range requests.
	 */
	function fetchBundle(profile, missing) {
		const resolvers = new Map();
		for (const block of missing) {
			let resolve;
			const settled = new Promise((r) => {
				resolve = r;
			});
			resolvers.set(block, resolve);
			pending.set(block, settled);
		}
		const finishBlock = (block, data) => {
			const resolve = resolvers.get(block);
			if (!resolve) {
				return; // Already cached in IDB; the client never asks for it.
			}
			blocks.set(block, data);
			resolvers.delete(block);
			pending.delete(block);
			resolve();
		};

		(async () => {
			try {
				const response = await fetch(`${httpOrigin}/disks/${encodeURIComponent(imageName)}/${profile.bundle}`);
				if (!response.ok || !response.body) {
					throw new Error(`no bundle (${response.status})`);
				}
				for await (const { block, data } of inflatedBlocks(response.body, profile, imageSize)) {
					finishBlock(block, data);
					if (resolvers.size === 0) {
						break; // Remaining bundle bytes only cover cached blocks.
					}
				}
			} catch {
				// Fall through: unresolved blocks are refetched below.
			}
			const rest = [...resolvers.keys()].sort((a, b) => a - b);
			if (rest.length > 0) {
				// Register the range fallback before waking waiters so an
				// in-flight lookup finds the new pending entry when it
				// re-checks, instead of missing to the server.
				fetchMissing(rest);
			}
			for (const [block, resolve] of resolvers) {
				resolvers.delete(block);
				resolve();
			}
		})();
	}

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
			// Loop: when the bundle download fails mid-boot its blocks are
			// handed over to freshly registered range fetches, so a settled
			// wait may leave a block pending again under a new promise.
			for (;;) {
				const waits = [];
				for (let block = firstBlock; block <= lastBlock; block++) {
					const wait = pending.get(block);
					if (wait) {
						waits.push(wait);
					}
				}
				if (waits.length === 0) {
					break;
				}
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

/**
 * Async generator over a boot-bundle response body: inflates it and yields
 * `{ block, data }` for every profile block, in bundle (= first-touch) order,
 * as soon as its bytes are available. A truncated stream simply ends early.
 */
async function* inflatedBlocks(body, profile, imageSize) {
	// Sniff the gzip magic instead of trusting headers: depending on how the
	// asset host serves .gz files the body may arrive still-compressed or
	// already inflated by the browser.
	const { head, stream } = await peekStream(body, 2);
	if (head.byteLength < 2) {
		return;
	}
	const inflated = head[0] === 0x1f && head[1] === 0x8b ? stream.pipeThrough(new DecompressionStream("gzip")) : stream;

	const reader = inflated.getReader();
	try {
		let index = 0;
		let current = null;
		let filled = 0;
		while (index < profile.blocks.length) {
			const { done, value } = await reader.read();
			if (done) {
				return;
			}
			let offset = 0;
			while (offset < value.byteLength && index < profile.blocks.length) {
				if (!current) {
					current = new Uint8Array(Math.min(BLOCK_BYTES, imageSize - profile.blocks[index] * BLOCK_BYTES));
					filled = 0;
				}
				const take = Math.min(current.byteLength - filled, value.byteLength - offset);
				current.set(value.subarray(offset, offset + take), filled);
				filled += take;
				offset += take;
				if (filled === current.byteLength) {
					yield { block: profile.blocks[index], data: current };
					current = null;
					index += 1;
				}
			}
		}
	} finally {
		reader.cancel().catch(() => {});
	}
}

/** Reads at least `bytes` from a stream, returning them plus an equivalent unconsumed stream. */
async function peekStream(body, bytes) {
	const reader = body.getReader();
	const chunks = [];
	let total = 0;
	while (total < bytes) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		chunks.push(value);
		total += value.byteLength;
	}
	const head = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		head.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const stream = new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(chunk);
			}
		},
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) {
				controller.close();
			} else {
				controller.enqueue(value);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return { head, stream };
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
