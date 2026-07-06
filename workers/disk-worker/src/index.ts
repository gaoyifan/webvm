/**
 * WebVM disk backend on Cloudflare Workers.
 *
 * Serves ext2 disk images to CheerpX's CloudDevice over WebSocket, with an
 * HTTP byte-range fallback. Images are stored as fixed-size 1 MiB chunk files
 * in Workers Static Assets and read back through the ASSETS binding.
 *
 * CloudDevice protocol (reverse-engineered from the CheerpX client):
 *  - on connect, the server sends a text message `<size>-<lastModifiedEpochSeconds>`
 *  - the client requests a block with a text message `<start>-<endInclusive>`
 *  - the server answers with one binary message containing those bytes
 *    (truncated at EOF, matching the reference server at disks.webvm.io)
 *  - a 0-byte binary message is a keepalive; a 1-byte one tells the client to
 *    reconnect and resend the current request on a fresh WebSocket
 *  - an empty text message from the client means teardown
 *  - HTTP fallback: GET `<url>?s=<start>&e=<endInclusive>` returns the bytes;
 *    HEAD returns Content-Length/Last-Modified
 *
 * Architecture: the client WebSocket terminates on a Durable Object (one per
 * image and edge colo) using the WebSocket Hibernation API; the edge Worker
 * only forwards the upgrade and serves the HTTP fallback. Two reasons:
 *  - Eyeball sockets held by stateless Worker invocations have no lifetime
 *    guarantee: the runtime load-sheds/evicts them after minutes (observed as
 *    `loadShed` outcomes killing live sessions), and CheerpX never recovers
 *    from an unexpected close. Hibernatable DO sockets are the supported
 *    long-lived pattern and survive DO eviction.
 *  - Each hibernation wake-up is its own invocation with a fresh subrequest
 *    budget, so chunk reads from assets never exhaust the 50-subrequest
 *    budget that a single long WebSocket invocation would get at the edge.
 *
 * The DO keeps an in-memory chunk cache, so warm reads cost one client<->DO
 * round trip. Cold reads (asset fetches, 500-900 ms) are hidden by
 * sequential prefetch behind the current read. Boot reads rarely reach the
 * DO at all: the frontend bulk-loads them from the boot-profile assets.
 */
import { DurableObject } from "cloudflare:workers";

export interface Env {
	ASSETS: Fetcher;
	DISK_SESSIONS: DurableObjectNamespace<DiskSession>;
	MAX_RANGE_BYTES?: string;
	// Secret gating the /debug/* endpoints (`wrangler secret put DEBUG_TOKEN`).
	// Unset = debug endpoints disabled.
	DEBUG_TOKEN?: string;
}

type DiskManifest = {
	name: string;
	size: number;
	chunkSize: number;
	chunks: number;
	source?: string;
	createdAt?: string;
};

type ByteRange = { start: number; end: number };

type SocketAttachment = { imageName: string; recorder: boolean; sawFirst: boolean };

const DEFAULT_MAX_RANGE_BYTES = 8 * 1024 * 1024;
const ASSET_READ_RETRIES = 2;
// CloudDevice reconnect signal: a 1-byte binary message makes the client open
// a fresh WebSocket and resend the current block request.
const RECONNECT_SIGNAL = new Uint8Array([0]);
// In-memory chunk cache. CheerpX reads 128 KiB blocks and chunks are 1 MiB,
// so 7 of 8 sequential block reads are served from memory at the network
// floor. Keep well below the 128 MB isolate limit.
const CHUNK_CACHE_MAX_BYTES = 64 * 1024 * 1024;
// Sequential readahead depth (chunks) behind a client read.
const PREFETCH_CHUNKS = 4;

// Boot profile: the boot read sequence is deterministic for a given image,
// so the DO records the first-touch order of 128 KiB blocks once and
// persists it to DO storage. scripts/export-boot-profile.mjs turns the
// recording into static assets (bootblocks.json + a gzipped bundle of the
// blocks) that the frontend bulk-loads at startup, replacing ~150 serial
// WebSocket round trips during boot.
const BOOT_BLOCK_BYTES = 128 * 1024;
const PROFILE_MAX_ENTRIES = 768;
const PROFILE_PERSIST_EVERY = 16;
// A recorded profile is worth freezing once it covers a plausible boot set.
const PROFILE_COMPLETE_MIN_ENTRIES = 24;
const PROFILE_STORAGE_KEY = "bootProfile";

// ---------------------------------------------------------------------------
// Edge Worker: forwards disk WebSockets to the Durable Object, serves the
// HTTP fallback per-request, and passes everything else to static assets.
// ---------------------------------------------------------------------------

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/debug/")) {
			if (!env.DEBUG_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.DEBUG_TOKEN}`) {
				return new Response("Not found", { status: 404 });
			}
			return handleDebug(request, env, url);
		}

		const imageName = imageNameFromPath(url.pathname);
		if (!imageName) {
			// Only reachable when run_worker_first routes more than the disk
			// endpoints; keep parity with direct asset serving.
			return serveStaticAsset(request, env);
		}

		try {
			if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
				const stub = env.DISK_SESSIONS.getByName(`${imageName}@${coloTag(request)}`);
				return await stub.fetch(request);
			}
			return await handleHttpFallback(request, env, imageName, url);
		} catch (error) {
			return errorResponse(error);
		}
	},
} satisfies ExportedHandler<Env>;

async function handleHttpFallback(request: Request, env: Env, imageName: string, url: URL): Promise<Response> {
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: corsHeaders() });
	}

	const manifest = await readManifest(env, imageName);
	if (request.method === "HEAD") {
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
	}

	const range = parseHttpRange(request, url);
	if (!range) {
		return new Response("Expected ?s=<start>&e=<end> or Range: bytes=<start>-<end>", {
			status: 400,
			headers: corsHeaders(),
		});
	}
	clampRange(range, manifest, Number(env.MAX_RANGE_BYTES ?? DEFAULT_MAX_RANGE_BYTES));

	// Per-request invocation: ranged asset reads, no chunk buffering. The
	// reference server replies 200 with the exact requested bytes.
	const data = await readRangeFromAssets(env, imageName, manifest, range);
	return new Response(data, {
		status: 200,
		headers: {
			...corsHeaders(),
			"Accept-Ranges": "bytes",
			"Content-Type": "application/octet-stream",
			"Content-Length": String(data.byteLength),
			"Last-Modified": manifestLastModified(manifest).toUTCString(),
			"Cache-Control": "public, max-age=31536000, immutable",
		},
	});
}

// ---------------------------------------------------------------------------
// Durable Object: terminates client WebSockets with the Hibernation API.
// One instance per image+colo; holds the chunk cache and the boot profile.
// ---------------------------------------------------------------------------

type CacheEntry = { data: Promise<Uint8Array<ArrayBuffer>>; bytes?: number };

export class DiskSession extends DurableObject<Env> {
	private chunkCache = new Map<number, CacheEntry>();
	private chunkCacheBytes = 0;
	private manifest?: Promise<DiskManifest>;
	private imageName?: string;
	private maxRangeBytes: number;
	// Boot profile state. `profile` is the recorded first-touch order of
	// 128 KiB blocks; `profileIndex` gives O(1) dedup and position lookup.
	private profile: number[] = [];
	private profileIndex = new Map<number, number>();
	private profileComplete = false;
	private profileDirty = 0;
	private profileLoaded?: Promise<void>;
	private recording = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.maxRangeBytes = Number(env.MAX_RANGE_BYTES ?? DEFAULT_MAX_RANGE_BYTES);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}
		const imageName = imageNameFromPath(new URL(request.url).pathname);
		if (!imageName) {
			return new Response("Bad disk path", { status: 400 });
		}
		const manifest = await this.getManifest(imageName);
		await this.loadProfile(imageName, manifest);

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		// Hibernation API: the DO may be evicted while sockets stay connected;
		// each message wakes it as a fresh invocation with its own subrequest
		// budget, so asset reads never exhaust a per-session budget.
		this.ctx.acceptWebSocket(server);
		// Survives hibernation: image name and boot-profile recording state.
		server.serializeAttachment({ imageName, recorder: false, sawFirst: false } satisfies SocketAttachment);
		server.send(`${manifest.size}-${Math.floor(manifestLastModified(manifest).getTime() / 1000)}`);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== "string") {
			return;
		}
		if (message.length === 0) {
			// CheerpX signals teardown (beforeunload) with an empty message.
			ws.close(1000, "client closed");
			return;
		}

		const attachment = ws.deserializeAttachment() as SocketAttachment;
		const before = { ...attachment };

		let manifest: DiskManifest;
		let range: ByteRange;
		try {
			manifest = await this.getManifest(attachment.imageName);
			await this.loadProfile(attachment.imageName, manifest);
			range = parseRangeText(message);
			clampRange(range, manifest, this.maxRangeBytes);
		} catch (error) {
			ws.close(1011, error instanceof Error ? error.message.slice(0, 120) : "bad request");
			return;
		}

		this.recordAccess(attachment, Math.floor(range.start / BOOT_BLOCK_BYTES));
		if (attachment.recorder !== before.recorder || attachment.sawFirst !== before.sawFirst) {
			ws.serializeAttachment(attachment);
		}

		try {
			ws.send(await this.readRange(manifest, range));
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Missing disk data")) {
				ws.close(1011, error.message.slice(0, 120));
				return;
			}
			// Transient failure: tell the client to reopen and resend. The
			// client closes this socket itself (matching the reference server).
			ws.send(RECONNECT_SIGNAL);
			return;
		}

		this.prefetchSequential(manifest, range.end);
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		this.finishRecording(ws.deserializeAttachment() as SocketAttachment | null);
	}

	// ---- disk reads ----------------------------------------------------------

	private async readRange(manifest: DiskManifest, range: ByteRange): Promise<Uint8Array<ArrayBuffer>> {
		const { chunkSize } = manifest;
		const firstChunk = Math.floor(range.start / chunkSize);
		const lastChunk = Math.floor(range.end / chunkSize);

		if (firstChunk === lastChunk) {
			const chunk = await this.readChunk(firstChunk);
			const offset = range.start - firstChunk * chunkSize;
			return chunk.subarray(offset, offset + (range.end - range.start + 1));
		}

		const output = new Uint8Array(range.end - range.start + 1);
		await Promise.all(
			chunkSpans(range, chunkSize, firstChunk, lastChunk).map(async (span) => {
				const chunk = await this.readChunk(span.chunkIndex);
				output.set(chunk.subarray(span.startInChunk, span.endInChunk + 1), span.outputOffset);
			}),
		);
		return output;
	}

	private readChunk(chunkIndex: number): Promise<Uint8Array<ArrayBuffer>> {
		const existing = this.chunkCache.get(chunkIndex);
		if (existing) {
			// LRU refresh.
			this.chunkCache.delete(chunkIndex);
			this.chunkCache.set(chunkIndex, existing);
			return existing.data;
		}

		const entry: CacheEntry = {
			data: readWholeChunk(this.env, this.imageName!, chunkIndex).then(
				(data) => {
					entry.bytes = data.byteLength;
					this.chunkCacheBytes += data.byteLength;
					this.evictChunkCache(chunkIndex);
					return data;
				},
				(error) => {
					// Do not cache failures; the client may retry.
					if (this.chunkCache.get(chunkIndex) === entry) {
						this.chunkCache.delete(chunkIndex);
					}
					throw error;
				},
			),
		};
		this.chunkCache.set(chunkIndex, entry);
		return entry.data;
	}

	private evictChunkCache(pinnedChunk: number): void {
		for (const [chunkIndex, entry] of this.chunkCache) {
			if (this.chunkCacheBytes <= CHUNK_CACHE_MAX_BYTES) {
				break;
			}
			if (chunkIndex === pinnedChunk || entry.bytes === undefined) {
				continue;
			}
			this.chunkCache.delete(chunkIndex);
			this.chunkCacheBytes -= entry.bytes;
		}
	}

	private prefetchSequential(manifest: DiskManifest, rangeEnd: number): void {
		const nextChunk = Math.floor(rangeEnd / manifest.chunkSize) + 1;
		const maxChunk = Math.min(manifest.chunks - 1, nextChunk + PREFETCH_CHUNKS - 1);
		for (let chunkIndex = nextChunk; chunkIndex <= maxChunk; chunkIndex++) {
			void this.readChunk(chunkIndex).catch(() => {});
		}
	}

	private getManifest(imageName: string): Promise<DiskManifest> {
		if (!this.manifest) {
			this.imageName = imageName;
			const manifest = readManifest(this.env, imageName);
			this.manifest = manifest;
			manifest.catch(() => {
				if (this.manifest === manifest) {
					this.manifest = undefined;
				}
			});
		}
		return this.manifest;
	}

	// ---- boot profile --------------------------------------------------------

	private loadProfile(imageName: string, manifest: DiskManifest): Promise<void> {
		if (!this.profileLoaded) {
			this.profileLoaded = this.loadProfileOnce(imageName, manifest).catch(() => {});
		}
		return this.profileLoaded;
	}

	private async loadProfileOnce(imageName: string, manifest: DiskManifest): Promise<void> {
		// Prefer the shipped profile asset: it is available in every colo,
		// unlike DO storage which is local to the DO that recorded it.
		const response = await fetchAsset(this.env, `/disks/${imageName}/bootblocks.json`);
		if (response.ok) {
			const shipped = (await response.json()) as { imageCreatedAt?: string; blocks?: number[] };
			if (shipped.imageCreatedAt === manifest.createdAt && Array.isArray(shipped.blocks)) {
				this.adoptProfile(shipped.blocks, true);
				return;
			}
		} else {
			await response.body?.cancel();
		}

		const stored = await this.ctx.storage.get<{ blocks?: number[]; complete: boolean }>(PROFILE_STORAGE_KEY);
		if (stored?.blocks && this.profile.length === 0) {
			this.adoptProfile(stored.blocks, stored.complete);
		}
	}

	private adoptProfile(blocks: number[], complete: boolean): void {
		this.profile = blocks.slice(0, PROFILE_MAX_ENTRIES);
		this.profileComplete = complete;
		this.profileIndex = new Map(this.profile.map((block, i) => [block, i]));
	}

	private recordAccess(attachment: SocketAttachment, blockIndex: number): void {
		if (this.profileComplete) {
			return;
		}
		if (!attachment.sawFirst) {
			// Record sessions that replay the boot sequence from the start. An
			// incomplete profile (an interrupted recording session) is resumed
			// by any session: the recorded prefix dedupes, new blocks append.
			attachment.sawFirst = true;
			attachment.recorder = blockIndex === 0 || this.profile.length > 0;
		}
		if (!attachment.recorder) {
			return;
		}
		this.recording = true;

		if (this.profileIndex.has(blockIndex)) {
			return;
		}
		this.profile.push(blockIndex);
		this.profileIndex.set(blockIndex, this.profile.length - 1);
		this.profileDirty++;
		if (this.profile.length >= PROFILE_MAX_ENTRIES) {
			this.recording = false;
			this.profileComplete = true;
			this.persistProfile();
			return;
		}
		if (this.profileDirty >= PROFILE_PERSIST_EVERY) {
			this.persistProfile();
		}
	}

	private finishRecording(attachment: SocketAttachment | null): void {
		// The recording session ended: freeze the profile so later sessions
		// stop extending it with non-boot reads.
		if (attachment?.recorder && this.recording) {
			this.recording = false;
			if (this.profile.length >= PROFILE_COMPLETE_MIN_ENTRIES) {
				this.profileComplete = true;
			}
			this.persistProfile();
		} else if (this.profileDirty > 0) {
			this.persistProfile();
		}
	}

	private persistProfile(): void {
		if (this.profile.length === 0) {
			return;
		}
		this.profileDirty = 0;
		void this.ctx.storage
			.put(PROFILE_STORAGE_KEY, { blocks: this.profile, complete: this.profileComplete })
			.catch(() => {});
	}

	// ---- debug RPCs ----------------------------------------------------------

	async debugStats(): Promise<Record<string, unknown>> {
		const imageName = this.ctx.id.name?.split("@")[0];
		if (imageName) {
			await this.loadProfile(imageName, await this.getManifest(imageName)).catch(() => {});
		}
		return {
			profileLength: this.profile.length,
			profileComplete: this.profileComplete,
			cachedChunks: this.chunkCache.size,
			cachedBytes: this.chunkCacheBytes,
			connections: this.ctx.getWebSockets().length,
			profile: this.profile,
		};
	}

	async debugResetProfile(): Promise<void> {
		this.profile = [];
		this.profileIndex.clear();
		this.profileComplete = false;
		this.profileDirty = 0;
		this.recording = false;
		await this.ctx.storage.delete(PROFILE_STORAGE_KEY);
	}

	async debugSetProfile(blocks: number[]): Promise<void> {
		this.adoptProfile(blocks, true);
		this.recording = false;
		this.profileDirty = 0;
		await this.ctx.storage.put(PROFILE_STORAGE_KEY, { blocks: this.profile, complete: true });
	}

	async debugColo(): Promise<string> {
		const response = await fetch("https://www.cloudflare.com/cdn-cgi/trace");
		const text = await response.text();
		return text.match(/^colo=(.+)$/m)?.[1] ?? "unknown";
	}
}

// ---------------------------------------------------------------------------
// Shared disk-read helpers.
// ---------------------------------------------------------------------------

const manifestCache = new Map<string, Promise<DiskManifest>>();

function imageNameFromPath(pathname: string): string | null {
	const match = pathname.match(/^\/([^/]+\.ext2)$/);
	return match ? decodeURIComponent(match[1]) : null;
}

function parseHttpRange(request: Request, url: URL): ByteRange | null {
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

function parseRangeText(value: string): ByteRange {
	const match = value.match(/^(\d+)-(\d+)$/);
	if (!match) {
		throw new Error(`Invalid range: ${value.slice(0, 64)}`);
	}

	return normalizeRange(Number(match[1]), Number(match[2]));
}

function normalizeRange(start: number, end: number): ByteRange {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
		throw new Error("Invalid byte range");
	}

	return { start, end };
}

/**
 * CheerpX block reads are fixed-size and the last block of an image usually
 * extends past EOF. The reference server truncates, so we clamp instead of
 * rejecting; only ranges that start beyond EOF are errors.
 */
function clampRange(range: ByteRange, manifest: DiskManifest, maxRangeBytes: number): void {
	if (range.start >= manifest.size) {
		throw new Error("Range starts beyond image size");
	}
	range.end = Math.min(range.end, manifest.size - 1);
	if (range.end - range.start + 1 > maxRangeBytes) {
		throw new Error(`Range is too large: ${range.end - range.start + 1} bytes`);
	}
}

type ChunkSpan = { chunkIndex: number; startInChunk: number; endInChunk: number; outputOffset: number };

function chunkSpans(range: ByteRange, chunkSize: number, firstChunk: number, lastChunk: number): ChunkSpan[] {
	const spans: ChunkSpan[] = [];
	for (let chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex++) {
		const chunkStart = chunkIndex * chunkSize;
		const startInChunk = Math.max(0, range.start - chunkStart);
		const endInChunk = Math.min(chunkSize - 1, range.end - chunkStart);
		spans.push({ chunkIndex, startInChunk, endInChunk, outputOffset: chunkStart + startInChunk - range.start });
	}
	return spans;
}

function readManifest(env: Env, imageName: string): Promise<DiskManifest> {
	const cached = manifestCache.get(imageName);
	if (cached) {
		return cached;
	}

	const manifestPromise = readManifestFromAssets(env, imageName);
	manifestCache.set(imageName, manifestPromise);
	manifestPromise.catch(() => {
		manifestCache.delete(imageName);
	});
	return manifestPromise;
}

async function readManifestFromAssets(env: Env, imageName: string): Promise<DiskManifest> {
	const response = await fetchAsset(env, `/disks/${imageName}/manifest.json`);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Missing manifest for ${imageName}`);
	}

	const manifest = (await response.json()) as DiskManifest;
	if (
		!Number.isSafeInteger(manifest.size) ||
		!Number.isSafeInteger(manifest.chunkSize) ||
		manifest.size <= 0 ||
		manifest.chunkSize <= 0 ||
		manifest.chunks !== Math.ceil(manifest.size / manifest.chunkSize)
	) {
		throw new Error(`Invalid manifest for ${imageName}`);
	}

	return manifest;
}

async function readRangeFromAssets(
	env: Env,
	imageName: string,
	manifest: DiskManifest,
	range: ByteRange,
): Promise<Uint8Array<ArrayBuffer>> {
	const firstChunk = Math.floor(range.start / manifest.chunkSize);
	const lastChunk = Math.floor(range.end / manifest.chunkSize);
	const output = new Uint8Array(range.end - range.start + 1);

	await Promise.all(
		chunkSpans(range, manifest.chunkSize, firstChunk, lastChunk).map(async (span) => {
			const response = await fetchAssetWithRetry(env, chunkPath(imageName, span.chunkIndex), {
				headers: { Range: `bytes=${span.startInChunk}-${span.endInChunk}` },
			});
			let data = new Uint8Array(await response.arrayBuffer());
			const expectedLength = span.endInChunk - span.startInChunk + 1;
			if (data.byteLength !== expectedLength) {
				// Runtimes that ignore Range on assets return the full chunk.
				if (response.status === 200 && data.byteLength > span.endInChunk) {
					data = data.subarray(span.startInChunk, span.endInChunk + 1);
				} else {
					throw new Error(`Unexpected chunk ${span.chunkIndex} length: ${data.byteLength}`);
				}
			}
			output.set(data, span.outputOffset);
		}),
	);
	return output;
}

async function readWholeChunk(env: Env, imageName: string, chunkIndex: number): Promise<Uint8Array<ArrayBuffer>> {
	const response = await fetchAssetWithRetry(env, chunkPath(imageName, chunkIndex));
	return new Uint8Array(await response.arrayBuffer());
}

async function fetchAssetWithRetry(env: Env, pathname: string, init?: RequestInit): Promise<Response> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= ASSET_READ_RETRIES; attempt++) {
		try {
			const response = await fetchAsset(env, pathname, init);
			if (response.ok || response.status === 206) {
				return response;
			}
			await response.body?.cancel();
			if (response.status === 404) {
				throw new Error(`Missing disk data: ${pathname}`);
			}
			lastError = new Error(`Asset read failed with ${response.status}`);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Missing disk data")) {
				throw error;
			}
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Asset read failed");
}

function chunkPath(imageName: string, chunkIndex: number): string {
	return `/disks/${imageName}/chunks/${String(chunkIndex).padStart(6, "0")}.bin`;
}

function fetchAsset(env: Env, pathname: string, init?: RequestInit): Promise<Response> {
	// Only the pathname matters for the assets binding.
	return env.ASSETS.fetch(new Request(new URL(pathname, "https://assets.local/"), init));
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

function manifestLastModified(manifest: DiskManifest): Date {
	const date = manifest.createdAt ? new Date(manifest.createdAt) : new Date(0);
	return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function coloTag(request: Request): string {
	const cf = (request as Request & { cf?: { colo?: string } }).cf;
	return cf?.colo ?? "default";
}

function corsHeaders(): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
		"Access-Control-Expose-Headers": "Content-Length, Content-Range, Last-Modified",
		"Cross-Origin-Resource-Policy": "cross-origin",
	};
}

// ---------------------------------------------------------------------------
// Debug endpoints (gated by the DEBUG_TOKEN secret).
// ---------------------------------------------------------------------------

async function handleDebug(request: Request, env: Env, url: URL): Promise<Response> {
	if (url.pathname === "/debug/session") {
		const imageName = url.searchParams.get("image");
		if (!imageName) {
			return new Response("Expected ?image=<name>", { status: 400 });
		}
		const stub = env.DISK_SESSIONS.getByName(`${imageName}@${coloTag(request)}`);
		if (url.searchParams.has("resetProfile")) {
			await stub.debugResetProfile();
		}
		if (request.method === "POST" && url.searchParams.has("setProfile")) {
			await stub.debugSetProfile((await request.json()) as number[]);
		}
		return Response.json(await stub.debugStats());
	}

	if (url.pathname === "/debug/where") {
		const imageName = url.searchParams.get("image") ?? "debian_large_20230522_5044875331_2.ext2";
		const stub = env.DISK_SESSIONS.getByName(`${imageName}@${coloTag(request)}`);
		const t0 = Date.now();
		const doColo = await stub.debugColo();
		return Response.json({ edgeColo: coloTag(request), doColo, rpcMs: Date.now() - t0 });
	}

	return new Response("Not found", { status: 404 });
}
