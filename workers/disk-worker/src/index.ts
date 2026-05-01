export interface Env {
	ASSETS: Fetcher;
	MAX_RANGE_BYTES?: string;
}

type DiskManifest = {
	name: string;
	size: number;
	chunkSize: number;
	chunks: number;
	source?: string;
	createdAt?: string;
};

const DEFAULT_MAX_RANGE_BYTES = 8 * 1024 * 1024;
const MAX_WS_ASSET_READS_PER_CONNECTION = 45;
const WS_PREFETCH_CHUNKS = 2;
const GLOBAL_CHUNK_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const manifestCache = new Map<string, Promise<DiskManifest>>();
const globalChunkCache = new Map<string, GlobalChunkCacheEntry>();
let globalChunkCacheBytes = 0;

type GlobalChunkCacheEntry = {
	data: Promise<Uint8Array>;
	bytes?: number;
};

type WebSocketReadCache = {
	chunks: Map<number, Promise<Uint8Array>>;
	assetReads: number;
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const imageName = imageNameFromPath(url.pathname);
		if (!imageName) {
			return serveStaticAsset(request, env);
		}

		if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
			return handleWebSocket(request, env, imageName);
		}

		if (request.method === "HEAD") {
			return handleImageHead(request, env, imageName);
		}

		const range = parseHttpRange(request, url);
		if (!range) {
			return new Response("Expected ?s=<start>&e=<end> or Range: bytes=<start>-<end>", {
				status: 400,
				headers: corsHeaders(),
			});
		}

		try {
			const data = await readImageRange(env, request.url, imageName, range.start, range.end);
			return new Response(toArrayBuffer(data), {
				status: 206,
				headers: {
					...corsHeaders(),
					"Accept-Ranges": "bytes",
					"Content-Type": "application/octet-stream",
					"Content-Length": String(data.byteLength),
					"Content-Range": `bytes ${range.start}-${range.end}/*`,
					"Cache-Control": "public, max-age=31536000, immutable",
				},
			});
		} catch (error) {
			return errorResponse(error);
		}
	},
};

async function handleWebSocket(request: Request, env: Env, imageName: string): Promise<Response> {
	const manifest = await readManifest(env, request.url, imageName);
	const pair = new WebSocketPair();
	const [client, server] = Object.values(pair);
	let messageQueue = Promise.resolve();
	const readCache: WebSocketReadCache = {
		chunks: new Map(),
		assetReads: 1,
	};
	server.accept();
	server.send(formatDeviceInfo(manifest));

	server.addEventListener("message", (event) => {
		messageQueue = messageQueue.then(async () => {
			try {
				if (typeof event.data !== "string") {
					throw new Error("Range request must be a text message");
				}
				if (event.data.length === 0) {
					server.close(1000, "client closed");
					return;
				}
				if (readCache.assetReads >= MAX_WS_ASSET_READS_PER_CONNECTION && !rangeIsCached(event.data, manifest, imageName, readCache)) {
					// Cloudflare limits subrequests per Worker invocation. CheerpX
					// treats a one-byte response as a reconnect signal and resends
					// the current block request on the new WebSocket.
					server.send(new Uint8Array([0]));
					server.close(1000, "reconnect");
					return;
				}

				const range = parseRangeText(event.data);
				const data = await readImageRange(env, request.url, imageName, range.start, range.end, manifest, readCache);
				prefetchFollowingChunks(env, request.url, imageName, manifest, range.end, readCache);
				server.send(toArrayBuffer(data));
			} catch (error) {
				server.close(1011, error instanceof Error ? error.message.slice(0, 120) : "disk read failed");
			}
		});
	});

	return new Response(null, { status: 101, webSocket: client });
}

async function handleImageHead(request: Request, env: Env, imageName: string): Promise<Response> {
	try {
		const manifest = await readManifest(env, request.url, imageName);
		return new Response(null, {
			status: 200,
			headers: {
				...corsHeaders(),
				"Accept-Ranges": "bytes",
				"Content-Length": String(manifest.size),
				"Last-Modified": manifestLastModified(manifest).toUTCString(),
				"Cache-Control": "public, max-age=31536000, immutable",
			},
		});
	} catch (error) {
		return errorResponse(error);
	}
}

function imageNameFromPath(pathname: string): string | null {
	const match = pathname.match(/^\/([^/]+\.ext2)$/);
	return match ? decodeURIComponent(match[1]) : null;
}

function parseHttpRange(request: Request, url: URL): { start: number; end: number } | null {
	const start = url.searchParams.get("s");
	const end = url.searchParams.get("e");
	if (start !== null && end !== null) {
		return normalizeRange(Number(start), Number(end));
	}

	const range = request.headers.get("Range");
	const match = range?.match(/^bytes=(\d+)-(\d+)$/);
	if (!match) {
		return null;
	}

	return normalizeRange(Number(match[1]), Number(match[2]));
}

function parseRangeText(value: string): { start: number; end: number } {
	const match = value.trim().match(/^(\d+)-(\d+)$/);
	if (!match) {
		throw new Error(`Invalid range: ${value}`);
	}

	return normalizeRange(Number(match[1]), Number(match[2]));
}

function normalizeRange(start: number, end: number): { start: number; end: number } {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
		throw new Error("Invalid byte range");
	}

	return { start, end };
}

async function readImageRange(
	env: Env,
	requestUrl: string,
	imageName: string,
	start: number,
	end: number,
	knownManifest?: DiskManifest,
	readCache?: WebSocketReadCache,
): Promise<Uint8Array> {
	const manifest = knownManifest ?? await readManifest(env, requestUrl, imageName);
	const maxRangeBytes = Number(env.MAX_RANGE_BYTES ?? DEFAULT_MAX_RANGE_BYTES);
	const length = end - start + 1;

	if (start >= manifest.size) {
		throw new Error("Range starts beyond image size");
	}
	if (end >= manifest.size) {
		throw new Error("Range ends beyond image size");
	}
	if (length > maxRangeBytes) {
		throw new Error(`Range is too large: ${length} bytes`);
	}

	const output = new Uint8Array(length);
	let outputOffset = 0;
	let chunkIndex = Math.floor(start / manifest.chunkSize);

	while (outputOffset < output.byteLength) {
		const chunkStart = chunkIndex * manifest.chunkSize;
		const startInChunk = Math.max(0, start - chunkStart);
		const endInChunk = Math.min(manifest.chunkSize - 1, end - chunkStart);
		const slice = readCache ?
			(await readChunkCached(env, requestUrl, imageName, chunkIndex, readCache)).subarray(startInChunk, endInChunk + 1) :
			await readChunkRange(env, requestUrl, imageName, chunkIndex, startInChunk, endInChunk);
		output.set(slice, outputOffset);
		outputOffset += slice.byteLength;
		chunkIndex++;
	}

	return output;
}

async function readManifest(env: Env, requestUrl: string, imageName: string): Promise<DiskManifest> {
	const cached = manifestCache.get(imageName);
	if (cached) {
		return cached;
	}

	const manifestPromise = readManifestFromAssets(env, requestUrl, imageName);
	manifestCache.set(imageName, manifestPromise);
	return manifestPromise;
}

async function readManifestFromAssets(env: Env, requestUrl: string, imageName: string): Promise<DiskManifest> {
	const response = await fetchAsset(env, requestUrl, `/disks/${imageName}/manifest.json`);
	if (!response.ok) {
		throw new Error(`Missing manifest for ${imageName}`);
	}

	const manifest = (await response.json()) as DiskManifest;
	if (!Number.isSafeInteger(manifest.size) || !Number.isSafeInteger(manifest.chunkSize)) {
		throw new Error(`Invalid manifest for ${imageName}`);
	}

	return manifest;
}

async function readChunkRange(
	env: Env,
	requestUrl: string,
	imageName: string,
	chunkIndex: number,
	startInChunk: number,
	endInChunk: number,
): Promise<Uint8Array> {
	const chunkPath = `/disks/${imageName}/chunks/${String(chunkIndex).padStart(6, "0")}.bin`;
	const response = await fetchAsset(env, requestUrl, chunkPath, {
		headers: { Range: `bytes=${startInChunk}-${endInChunk}` },
	});
	if (!response.ok) {
		throw new Error(`Missing disk chunk ${chunkIndex}`);
	}

	const data = new Uint8Array(await response.arrayBuffer());
	const expectedLength = endInChunk - startInChunk + 1;
	if (data.byteLength === expectedLength) {
		return data;
	}

	// Older local dev runtimes may ignore Range on assets. Keep the fallback
	// correct, but production should return only the requested byte slice.
	if (response.status === 200 && data.byteLength > endInChunk) {
		return data.subarray(startInChunk, endInChunk + 1);
	}

	throw new Error(`Unexpected chunk ${chunkIndex} length: ${data.byteLength}`);
}

async function readChunkCached(
	env: Env,
	requestUrl: string,
	imageName: string,
	chunkIndex: number,
	readCache: WebSocketReadCache,
): Promise<Uint8Array> {
	let chunk = readCache.chunks.get(chunkIndex);
	if (!chunk) {
		const cachedChunk = readChunkThroughGlobalCache(env, requestUrl, imageName, chunkIndex);
		if (cachedChunk.assetRead) {
			readCache.assetReads++;
		}
		chunk = cachedChunk.data;
		readCache.chunks.set(chunkIndex, chunk);
	}

	return chunk;
}

function readChunkThroughGlobalCache(
	env: Env,
	requestUrl: string,
	imageName: string,
	chunkIndex: number,
): { data: Promise<Uint8Array>; assetRead: boolean } {
	const key = cacheKey(imageName, chunkIndex);
	const existing = globalChunkCache.get(key);
	if (existing) {
		globalChunkCache.delete(key);
		globalChunkCache.set(key, existing);
		return { data: existing.data, assetRead: false };
	}

	const entry: GlobalChunkCacheEntry = {
		data: readWholeChunk(env, requestUrl, imageName, chunkIndex).then((data) => {
			entry.bytes = data.byteLength;
			globalChunkCacheBytes += data.byteLength;
			evictGlobalChunkCache(key);
			return data;
		}, (error) => {
			globalChunkCache.delete(key);
			throw error;
		}),
	};
	globalChunkCache.set(key, entry);
	return { data: entry.data, assetRead: true };
}

function evictGlobalChunkCache(pinnedKey: string) {
	for (const [key, entry] of globalChunkCache) {
		if (globalChunkCacheBytes <= GLOBAL_CHUNK_CACHE_MAX_BYTES) {
			break;
		}
		if (key === pinnedKey || entry.bytes === undefined) {
			continue;
		}
		globalChunkCache.delete(key);
		globalChunkCacheBytes -= entry.bytes;
	}
}

async function readWholeChunk(env: Env, requestUrl: string, imageName: string, chunkIndex: number): Promise<Uint8Array> {
	const chunkPath = `/disks/${imageName}/chunks/${String(chunkIndex).padStart(6, "0")}.bin`;
	const response = await fetchAsset(env, requestUrl, chunkPath);
	if (!response.ok) {
		throw new Error(`Missing disk chunk ${chunkIndex}`);
	}

	return new Uint8Array(await response.arrayBuffer());
}

function prefetchFollowingChunks(
	env: Env,
	requestUrl: string,
	imageName: string,
	manifest: DiskManifest,
	rangeEnd: number,
	readCache: WebSocketReadCache,
) {
	const nextChunk = Math.floor(rangeEnd / manifest.chunkSize) + 1;
	const maxChunk = Math.min(manifest.chunks - 1, nextChunk + WS_PREFETCH_CHUNKS - 1);
	for (let chunkIndex = nextChunk; chunkIndex <= maxChunk; chunkIndex++) {
		if (readCache.assetReads >= MAX_WS_ASSET_READS_PER_CONNECTION || readCache.chunks.has(chunkIndex)) {
			break;
		}
		const cachedChunk = readChunkThroughGlobalCache(env, requestUrl, imageName, chunkIndex);
		if (cachedChunk.assetRead) {
			readCache.assetReads++;
		}
		readCache.chunks.set(chunkIndex, cachedChunk.data);
	}
}

function rangeIsCached(rangeText: string, manifest: DiskManifest, imageName: string, readCache: WebSocketReadCache): boolean {
	try {
		const range = parseRangeText(rangeText);
		const firstChunk = Math.floor(range.start / manifest.chunkSize);
		const lastChunk = Math.floor(range.end / manifest.chunkSize);
		for (let chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex++) {
			if (!readCache.chunks.has(chunkIndex) && !globalChunkCache.has(cacheKey(imageName, chunkIndex))) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

function cacheKey(imageName: string, chunkIndex: number): string {
	return `${imageName}:${chunkIndex}`;
}

function fetchAsset(env: Env, requestUrl: string, pathname: string, init?: RequestInit): Promise<Response> {
	const assetUrl = new URL(pathname, requestUrl);
	return env.ASSETS.fetch(new Request(assetUrl, init));
}

function errorResponse(error: unknown): Response {
	const message = error instanceof Error ? error.message : "disk read failed";
	return new Response(message, {
		status: message.includes("Missing") ? 404 : 416,
		headers: corsHeaders(),
	});
}

async function serveStaticAsset(request: Request, env: Env): Promise<Response> {
	const response = await env.ASSETS.fetch(request);
	const headers = new Headers(response.headers);
	headers.set("Cross-Origin-Embedder-Policy", "require-corp");
	headers.set("Cross-Origin-Opener-Policy", "same-origin");
	headers.set("Cross-Origin-Resource-Policy", "cross-origin");

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(data.byteLength);
	new Uint8Array(buffer).set(data);
	return buffer;
}

function formatDeviceInfo(manifest: DiskManifest): string {
	return `${manifest.size}-${Math.floor(manifestLastModified(manifest).getTime() / 1000)}`;
}

function manifestLastModified(manifest: DiskManifest): Date {
	const date = manifest.createdAt ? new Date(manifest.createdAt) : new Date(0);
	return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function corsHeaders(): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": "*",
		"Cross-Origin-Resource-Policy": "cross-origin",
	};
}
