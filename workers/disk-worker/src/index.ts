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
 * Architecture: the client WebSocket terminates in the edge Worker, which
 * serves blocks from an isolate-wide chunk cache. Cache misses are fetched
 * over a single internal WebSocket from a Durable Object (one per image and
 * colo), which reads chunk assets and keeps a second-level cache plus the
 * recorded boot profile. Two reasons for this split:
 *  - Free-plan Workers get 50 subrequests per invocation, and a WebSocket
 *    session is one invocation. Reading assets from the edge Worker would
 *    exhaust the budget mid-boot; the internal WebSocket costs one subrequest
 *    for the whole session, while the DO gets a fresh budget per message
 *    (WebSocket Hibernation delivers each message as its own invocation).
 *  - DOs do not run in every colo (e.g. edge NRT places its DO in KIX, adding
 *    ~13 ms to every serial block read, which is the difference between us
 *    and the reference server on `apt`-style workloads). Terminating the
 *    client socket at the edge keeps warm reads at the pure network floor.
 *
 * Internal chunk protocol (edge <-> DO):
 *  - edge sends `chunk:<index>` (client-driven) or `chunk:<index>:p` (prefetch,
 *    excluded from boot-profile recording)
 *  - DO answers with a text header `chunk:<index>:<byteLength>` immediately
 *    followed by the payload as binary frames of at most 512 KiB (staying
 *    clearly under the 1 MiB WebSocket message limit); the header and its
 *    frames are sent back-to-back synchronously, so pairs never interleave
 *    even when the DO handles requests concurrently
 *  - DO sends `profile:<json>` after connect: the recorded boot-profile chunk
 *    order, which the edge uses to prewarm its cache along the boot path
 *  - DO sends `error:<index>:<message>` when a chunk read fails
 */
import { DurableObject } from "cloudflare:workers";

export interface Env {
	ASSETS: Fetcher;
	DISK_SESSIONS: DurableObjectNamespace<DiskSession>;
	MAX_RANGE_BYTES?: string;
	// Set to "1" to expose /debug/* endpoints (unauthenticated; disable in
	// production deployments).
	DEBUG_ENDPOINTS?: string;
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

const DEFAULT_MAX_RANGE_BYTES = 8 * 1024 * 1024;
const ASSET_READ_RETRIES = 2;
// CloudDevice reconnect signal: a 1-byte binary message makes the client open
// a fresh WebSocket and resend the current block request.
const RECONNECT_SIGNAL = new Uint8Array([0]);
// Payload frame size for the internal chunk protocol.
const CHUNK_FRAME_BYTES = 512 * 1024;
// Edge isolate chunk cache. CheerpX reads 128 KiB blocks and chunks are
// 1 MiB, so 7 of 8 sequential block reads are served straight from isolate
// memory at the network floor. Keep well below the 128 MB isolate limit.
const EDGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
// The DO keeps a second-level cache so a fresh isolate (or a second client in
// the colo) skips the asset fetch even when its own cache is cold.
const DO_CACHE_MAX_BYTES = 64 * 1024 * 1024;
// Sequential readahead depth (chunks), driven by the edge on client reads.
const PREFETCH_CHUNKS = 4;
// How long the edge waits for a chunk from the DO before telling the client
// to reconnect.
const CHUNK_WAIT_TIMEOUT_MS = 20_000;

// Boot profile: cold chunk reads cost 500-900 ms (asset fetch) while warm
// reads are pure client RTT (~75 ms), and CheerpX requests blocks serially,
// so scattered cold reads dominate boot and first-command latency. The read
// order is deterministic for a given image, so the DO records the first-touch
// chunk order once and the edge prewarms its cache along that path, staying a
// bounded window ahead of the client's position in it.
//
// The profile ships as a static asset (/disks/<image>/bootprofile.json,
// exported with scripts/export-boot-profile.mjs) so every colo has it from
// the start. Without the asset, the DO records the profile from the first
// session whose reads start at chunk 0 and persists it to DO storage.
const PROFILE_MAX_ENTRIES = 768;
const PROFILE_PERSIST_EVERY = 16;
// A recorded profile is worth freezing once it covers a plausible boot set.
const PROFILE_COMPLETE_MIN_ENTRIES = 24;
const PROFILE_STORAGE_KEY = "bootProfile";
// Prewarm pacing: the internal WebSocket is one TCP stream, so an oversized
// burst of 1 MiB chunks would delay client-requested blocks behind it.
const PREWARM_ON_CONNECT = 8;
const PREWARM_PER_MESSAGE = 4;
const PREWARM_LOOKAHEAD_CHUNKS = 32;

// ---------------------------------------------------------------------------
// Edge Worker: terminates client WebSockets, serves the HTTP fallback, and
// forwards everything else to static assets.
// ---------------------------------------------------------------------------

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/debug/")) {
			if (env.DEBUG_ENDPOINTS !== "1") {
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
				return await openDiskSession(request, env, ctx, imageName);
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
// Edge disk session: client-facing CloudDevice WebSocket.
// ---------------------------------------------------------------------------

async function openDiskSession(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	imageName: string,
): Promise<Response> {
	const manifest = await readManifest(env, imageName);
	const pair = new WebSocketPair();
	const [client, server] = Object.values(pair);
	server.accept();
	const session = new DiskEdgeSession(env, ctx, imageName, manifest, server, coloTag(request));

	server.addEventListener("message", (event) => {
		void session.onClientMessage(event.data);
	});
	server.addEventListener("close", () => session.dispose());
	server.addEventListener("error", () => session.dispose());

	server.send(`${manifest.size}-${Math.floor(manifestLastModified(manifest).getTime() / 1000)}`);
	// Open the chunk link now: the DO answers with the boot profile, which
	// starts prewarming before the client's first read arrives.
	session.connectLink();
	return new Response(null, { status: 101, webSocket: client });
}

class DiskEdgeSession {
	private link?: ChunkLink;
	private profile: number[] = [];
	private profileIndex = new Map<number, number>();
	private prewarmPos = 0;
	private maxRangeBytes: number;
	// Cache key versioned by image creation time: a redeployed image must not
	// be served from another version's cached chunks.
	private cacheName: string;

	constructor(
		private env: Env,
		private ctx: ExecutionContext,
		private imageName: string,
		private manifest: DiskManifest,
		private ws: WebSocket,
		private colo: string,
	) {
		this.maxRangeBytes = Number(env.MAX_RANGE_BYTES ?? DEFAULT_MAX_RANGE_BYTES);
		this.cacheName = `${imageName}@${manifest.createdAt ?? "0"}`;
	}

	async onClientMessage(message: string | ArrayBuffer): Promise<void> {
		let range: ByteRange;
		try {
			if (typeof message !== "string") {
				throw new Error("Range request must be a text message");
			}
			if (message.length === 0) {
				// CheerpX signals teardown (beforeunload) with an empty message.
				this.ws.close(1000, "client closed");
				return;
			}
			range = parseRangeText(message);
			clampRange(range, this.manifest, this.maxRangeBytes);
		} catch (error) {
			this.ws.close(1011, error instanceof Error ? error.message.slice(0, 120) : "bad request");
			return;
		}

		try {
			this.ws.send(await this.readRange(range));
			this.prefetchSequential(range.end);
			this.advancePrewarm(range);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Missing disk data")) {
				this.ws.close(1011, error.message.slice(0, 120));
				return;
			}
			// Transient failure: signal the client to reopen and resend. The
			// client closes this socket itself (matching the reference server).
			try {
				this.ws.send(RECONNECT_SIGNAL);
			} catch {
				this.ws.close(1011, error instanceof Error ? error.message.slice(0, 100) : "disk read failed");
			}
		}
	}

	dispose(): void {
		this.link?.close();
		this.link = undefined;
	}

	connectLink(): void {
		if (!this.link || this.link.closed) {
			this.link = new ChunkLink(this.env, this.imageName, this.colo, (profile) => this.adoptProfile(profile));
			// Keep the invocation alive until the DO upgrade settles; without
			// this the runtime may cancel the pending subrequest as soon as the
			// 101 response is returned to the client.
			this.ctx.waitUntil(this.link.opened());
		}
	}

	private async readRange(range: ByteRange): Promise<Uint8Array<ArrayBuffer>> {
		const { chunkSize } = this.manifest;
		const firstChunk = Math.floor(range.start / chunkSize);
		const lastChunk = Math.floor(range.end / chunkSize);

		if (firstChunk === lastChunk) {
			const chunk = await this.getChunk(firstChunk);
			const offset = range.start - firstChunk * chunkSize;
			return chunk.subarray(offset, offset + (range.end - range.start + 1));
		}

		const output = new Uint8Array(range.end - range.start + 1);
		await Promise.all(
			chunkSpans(range, chunkSize, firstChunk, lastChunk).map(async (span) => {
				const chunk = await this.getChunk(span.chunkIndex);
				output.set(chunk.subarray(span.startInChunk, span.endInChunk + 1), span.outputOffset);
			}),
		);
		return output;
	}

	private async getChunk(chunkIndex: number, prefetch = false): Promise<Uint8Array<ArrayBuffer>> {
		const cached = edgeCacheGet(this.cacheName, chunkIndex);
		if (cached) {
			return cached;
		}
		this.connectLink();
		let data: Uint8Array<ArrayBuffer>;
		try {
			data = await this.link!.request(chunkIndex, prefetch);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Missing disk data")) {
				throw error;
			}
			// The link may have died silently (e.g. idle teardown between boot
			// phases): retry once on a fresh link before failing the client.
			this.link?.close();
			this.link = undefined;
			this.connectLink();
			data = await this.link!.request(chunkIndex, prefetch);
		}
		edgeCachePut(this.cacheName, chunkIndex, data);
		return data;
	}

	private prefetchSequential(rangeEnd: number): void {
		const nextChunk = Math.floor(rangeEnd / this.manifest.chunkSize) + 1;
		const maxChunk = Math.min(this.manifest.chunks - 1, nextChunk + PREFETCH_CHUNKS - 1);
		for (let chunkIndex = nextChunk; chunkIndex <= maxChunk; chunkIndex++) {
			void this.getChunk(chunkIndex, true).catch(() => {});
		}
	}

	private adoptProfile(profile: number[]): void {
		if (this.profile.length > 0 || profile.length === 0) {
			return;
		}
		this.profile = profile;
		this.profileIndex = new Map(profile.map((chunk, i) => [chunk, i]));
		this.prewarm(PREWARM_ON_CONNECT);
	}

	/**
	 * Keep the edge cache warm along the recorded boot path, staying a bounded
	 * window ahead of the client's current position in it.
	 */
	private advancePrewarm(range: ByteRange): void {
		const pos = this.profileIndex.get(Math.floor(range.start / this.manifest.chunkSize));
		if (pos === undefined) {
			return;
		}
		if (this.prewarmPos < pos + 1) {
			this.prewarmPos = pos + 1;
		}
		const target = Math.min(pos + PREWARM_LOOKAHEAD_CHUNKS, this.profile.length);
		if (this.prewarmPos < target) {
			this.prewarm(PREWARM_PER_MESSAGE, target);
		}
	}

	private prewarm(maxReads: number, targetPos?: number): void {
		const limit = Math.min(targetPos ?? this.prewarmPos + maxReads, this.profile.length);
		let started = 0;
		while (this.prewarmPos < limit && started < maxReads) {
			const chunkIndex = this.profile[this.prewarmPos++];
			if (chunkIndex >= this.manifest.chunks || edgeCacheGet(this.cacheName, chunkIndex)) {
				continue;
			}
			void this.getChunk(chunkIndex, true).catch(() => {});
			started++;
		}
	}
}

// ---------------------------------------------------------------------------
// Edge chunk cache: isolate-wide, shared across sessions of an image.
// ---------------------------------------------------------------------------

type EdgeCacheEntry = { data: Promise<Uint8Array<ArrayBuffer>>; bytes?: number };

const edgeCache = new Map<string, EdgeCacheEntry>();
let edgeCacheBytes = 0;

function edgeCacheGet(cacheName: string, chunkIndex: number): Promise<Uint8Array<ArrayBuffer>> | undefined {
	const key = `${cacheName}:${chunkIndex}`;
	const entry = edgeCache.get(key);
	if (!entry) {
		return undefined;
	}
	// LRU refresh.
	edgeCache.delete(key);
	edgeCache.set(key, entry);
	return entry.data;
}

function edgeCachePut(cacheName: string, chunkIndex: number, data: Uint8Array<ArrayBuffer>): void {
	const key = `${cacheName}:${chunkIndex}`;
	if (edgeCache.has(key)) {
		return;
	}
	edgeCache.set(key, { data: Promise.resolve(data), bytes: data.byteLength });
	edgeCacheBytes += data.byteLength;
	for (const [candidate, entry] of edgeCache) {
		if (edgeCacheBytes <= EDGE_CACHE_MAX_BYTES) {
			break;
		}
		if (candidate === key || entry.bytes === undefined) {
			continue;
		}
		edgeCache.delete(candidate);
		edgeCacheBytes -= entry.bytes;
	}
}

// ---------------------------------------------------------------------------
// ChunkLink: the edge side of the internal chunk protocol.
// ---------------------------------------------------------------------------

type ChunkWaiter = {
	resolve: (data: Uint8Array<ArrayBuffer>) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

class ChunkLink {
	closed = false;
	private ws?: WebSocket;
	private ready: Promise<WebSocket>;
	private waiters = new Map<number, ChunkWaiter[]>();
	// Reassembly state for the header+frames currently being received.
	private incoming?: { chunkIndex: number; buffer: Uint8Array<ArrayBuffer>; received: number };

	constructor(env: Env, imageName: string, colo: string, onProfile: (profile: number[]) => void) {
		const stub = env.DISK_SESSIONS.getByName(`${imageName}@${colo}`);
		this.ready = stub
			.fetch(`https://do/${encodeURIComponent(imageName)}`, {
				headers: { Upgrade: "websocket" },
			})
			.then((response) => {
				const ws = response.webSocket;
				if (!ws) {
					throw new Error("DO did not upgrade");
				}
				ws.accept();
				// Binary frames must arrive as ArrayBuffer; the default for
				// worker-held sockets is Blob, which reassembly cannot use.
				(ws as WebSocket & { binaryType: string }).binaryType = "arraybuffer";
				ws.addEventListener("message", (event) => this.onMessage(event.data, onProfile));
				ws.addEventListener("close", (event) =>
					this.shutdown(new Error(`chunk link closed (${event.code} ${event.reason})`)),
				);
				ws.addEventListener("error", (event) =>
					this.shutdown(new Error(`chunk link error (${(event as ErrorEvent).message ?? "unknown"})`)),
				);
				this.ws = ws;
				return ws;
			});
		this.ready.catch(() => this.shutdown(new Error("chunk link connect failed")));
	}

	opened(): Promise<void> {
		return this.ready.then(
			() => {},
			() => {},
		);
	}

	async request(chunkIndex: number, prefetch: boolean): Promise<Uint8Array<ArrayBuffer>> {
		if (this.closed) {
			throw new Error("chunk link closed");
		}
		const ws = await this.ready;
		return new Promise((resolve, reject) => {
			const queue = this.waiters.get(chunkIndex);
			const waiter: ChunkWaiter = {
				resolve,
				reject,
				timer: setTimeout(() => {
					this.settle(chunkIndex, undefined, new Error("chunk read timed out"));
				}, CHUNK_WAIT_TIMEOUT_MS),
			};
			if (queue) {
				// Already requested and in flight; just wait for it.
				queue.push(waiter);
				return;
			}
			this.waiters.set(chunkIndex, [waiter]);
			try {
				ws.send(`chunk:${chunkIndex}${prefetch ? ":p" : ""}`);
			} catch (error) {
				// Fail fast on dead sockets instead of waiting for the timeout.
				this.shutdown(error instanceof Error ? error : new Error("chunk link send failed"));
			}
		});
	}

	close(): void {
		this.shutdown(new Error("session closed"));
	}

	private onMessage(data: string | ArrayBuffer, onProfile: (profile: number[]) => void): void {
		if (typeof data === "string") {
			if (data.startsWith("profile:")) {
				try {
					onProfile(JSON.parse(data.slice(8)) as number[]);
				} catch {
					// Ignore malformed profile; prewarm is best-effort.
				}
				return;
			}
			if (data.startsWith("chunk:")) {
				const [, chunkIndex, byteLength] = data.split(":");
				this.incoming = {
					chunkIndex: Number(chunkIndex),
					buffer: new Uint8Array(Number(byteLength)),
					received: 0,
				};
				if (this.incoming.buffer.byteLength === 0) {
					this.settle(this.incoming.chunkIndex, this.incoming.buffer, undefined);
					this.incoming = undefined;
				}
				return;
			}
			if (data.startsWith("error:")) {
				const [, chunkIndex, ...rest] = data.split(":");
				this.settle(Number(chunkIndex), undefined, new Error(rest.join(":") || "chunk read failed"));
				return;
			}
			return;
		}

		// Binary payload frame for the current header.
		const state = this.incoming;
		if (!state) {
			return;
		}
		const frame = new Uint8Array(data);
		state.buffer.set(frame, state.received);
		state.received += frame.byteLength;
		if (state.received >= state.buffer.byteLength) {
			this.incoming = undefined;
			this.settle(state.chunkIndex, state.buffer, undefined);
		}
	}

	private settle(chunkIndex: number, data: Uint8Array<ArrayBuffer> | undefined, error: Error | undefined): void {
		const queue = this.waiters.get(chunkIndex);
		if (!queue) {
			return;
		}
		this.waiters.delete(chunkIndex);
		for (const waiter of queue) {
			clearTimeout(waiter.timer);
			if (data) {
				waiter.resolve(data);
			} else {
				waiter.reject(error ?? new Error("chunk read failed"));
			}
		}
	}

	private shutdown(error: Error): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		for (const chunkIndex of [...this.waiters.keys()]) {
			this.settle(chunkIndex, undefined, error);
		}
		try {
			this.ws?.close();
		} catch {
			// Already closed.
		}
	}
}

// ---------------------------------------------------------------------------
// Durable Object: chunk server and boot-profile keeper, one per image+colo.
// ---------------------------------------------------------------------------

type DoCacheEntry = { data: Promise<Uint8Array<ArrayBuffer>>; bytes?: number };

export class DiskSession extends DurableObject<Env> {
	private chunkCache = new Map<number, DoCacheEntry>();
	private chunkCacheBytes = 0;
	private manifest?: Promise<DiskManifest>;
	private imageName?: string;
	// Boot profile state. `profile` is the recorded first-touch chunk order;
	// `profileIndex` gives O(1) dedup while recording.
	private profile: number[] = [];
	private profileIndex = new Map<number, number>();
	private profileComplete = false;
	private profileDirty = 0;
	private profileLoaded?: Promise<void>;
	private recording = false;

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}
		const imageName = decodeURIComponent(new URL(request.url).pathname.slice(1));
		const manifest = await this.getManifest(imageName);
		await this.loadProfile(imageName, manifest);

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		// Hibernation API: the DO may be evicted while links stay connected;
		// each message wakes it as a fresh invocation with its own subrequest
		// budget, so chunk fetches never exhaust a shared per-session budget.
		this.ctx.acceptWebSocket(server);
		// Survives hibernation: image name and whether this link may record.
		server.serializeAttachment({ imageName, recorder: false, sawFirst: false });
		server.send(`profile:${JSON.stringify(this.profile)}`);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const attachment = ws.deserializeAttachment() as { imageName: string; recorder: boolean; sawFirst: boolean };
		const before = { ...attachment };
		await this.handleChunkMessage(ws, attachment, message);
		if (attachment.recorder !== before.recorder || attachment.sawFirst !== before.sawFirst) {
			ws.serializeAttachment(attachment);
		}
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		this.finishRecording(ws.deserializeAttachment() as { recorder?: boolean } | null);
	}

	private async handleChunkMessage(
		ws: WebSocket,
		attachment: { imageName: string; recorder: boolean; sawFirst: boolean },
		message: string | ArrayBuffer,
	): Promise<void> {
		if (typeof message !== "string" || !message.startsWith("chunk:")) {
			return;
		}
		const [, indexText, flag] = message.split(":");
		const chunkIndex = Number(indexText);

		let manifest: DiskManifest;
		try {
			manifest = await this.getManifest(attachment.imageName);
			await this.loadProfile(attachment.imageName, manifest);
		} catch (error) {
			ws.send(`error:${chunkIndex}:${error instanceof Error ? error.message.slice(0, 120) : "manifest error"}`);
			return;
		}
		if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= manifest.chunks) {
			ws.send(`error:${chunkIndex}:Missing disk data: chunk out of range`);
			return;
		}

		this.recordAccess(attachment, chunkIndex, flag === "p");

		try {
			const data = await this.readChunk(chunkIndex);
			// Header and payload frames go out back-to-back synchronously, so
			// concurrent handlers cannot interleave a foreign frame between them.
			ws.send(`chunk:${chunkIndex}:${data.byteLength}`);
			for (let offset = 0; offset < data.byteLength; offset += CHUNK_FRAME_BYTES) {
				ws.send(data.subarray(offset, Math.min(offset + CHUNK_FRAME_BYTES, data.byteLength)));
			}
		} catch (error) {
			ws.send(`error:${chunkIndex}:${error instanceof Error ? error.message.slice(0, 120) : "chunk read failed"}`);
		}
	}

	private finishRecording(attachment: { recorder?: boolean } | null): void {
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

	private readChunk(chunkIndex: number): Promise<Uint8Array<ArrayBuffer>> {
		const existing = this.chunkCache.get(chunkIndex);
		if (existing) {
			// LRU refresh.
			this.chunkCache.delete(chunkIndex);
			this.chunkCache.set(chunkIndex, existing);
			return existing.data;
		}

		const entry: DoCacheEntry = {
			data: readWholeChunk(this.env, this.imageName!, chunkIndex).then(
				(data) => {
					entry.bytes = data.byteLength;
					this.chunkCacheBytes += data.byteLength;
					this.evictChunkCache(chunkIndex);
					return data;
				},
				(error) => {
					// Do not cache failures; the edge may retry.
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
			if (this.chunkCacheBytes <= DO_CACHE_MAX_BYTES) {
				break;
			}
			if (chunkIndex === pinnedChunk || entry.bytes === undefined) {
				continue;
			}
			this.chunkCache.delete(chunkIndex);
			this.chunkCacheBytes -= entry.bytes;
		}
	}

	// ---- boot profile ------------------------------------------------------

	private loadProfile(imageName: string, manifest: DiskManifest): Promise<void> {
		if (!this.profileLoaded) {
			this.profileLoaded = this.loadProfileOnce(imageName, manifest).catch(() => {});
		}
		return this.profileLoaded;
	}

	private async loadProfileOnce(imageName: string, manifest: DiskManifest): Promise<void> {
		// Prefer the shipped profile asset: it is available in every colo,
		// unlike DO storage which is local to the DO that recorded it.
		const response = await fetchAsset(this.env, `/disks/${imageName}/bootprofile.json`);
		if (response.ok) {
			const shipped = (await response.json()) as { imageCreatedAt?: string; chunks?: number[] };
			if (shipped.imageCreatedAt === manifest.createdAt && Array.isArray(shipped.chunks)) {
				this.adoptProfile(shipped.chunks, true);
				return;
			}
		} else {
			await response.body?.cancel();
		}

		const stored = await this.ctx.storage.get<{ chunks: number[]; complete: boolean }>(PROFILE_STORAGE_KEY);
		if (stored && this.profile.length === 0) {
			this.adoptProfile(stored.chunks, stored.complete);
		}
	}

	private adoptProfile(chunks: number[], complete: boolean): void {
		this.profile = chunks.slice(0, PROFILE_MAX_ENTRIES);
		this.profileComplete = complete;
		this.profileIndex = new Map(this.profile.map((chunk, i) => [chunk, i]));
	}

	private recordAccess(
		attachment: { imageName: string; recorder: boolean; sawFirst: boolean },
		chunkIndex: number,
		isPrefetch: boolean,
	): void {
		if (this.profileComplete || isPrefetch) {
			return;
		}
		if (!attachment.sawFirst) {
			// Record sessions that replay the boot sequence from the start. An
			// incomplete profile (an interrupted recording session) is resumed
			// by any session: the recorded prefix dedupes, new chunks append.
			attachment.sawFirst = true;
			attachment.recorder = chunkIndex === 0 || this.profile.length > 0;
		}
		if (!attachment.recorder) {
			return;
		}
		this.recording = true;

		if (this.profileIndex.has(chunkIndex)) {
			return;
		}
		this.profile.push(chunkIndex);
		this.profileIndex.set(chunkIndex, this.profile.length - 1);
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

	private persistProfile(): void {
		if (this.profile.length === 0) {
			return;
		}
		this.profileDirty = 0;
		void this.ctx.storage
			.put(PROFILE_STORAGE_KEY, { chunks: this.profile, complete: this.profileComplete })
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

	async debugSetProfile(chunks: number[]): Promise<void> {
		this.adoptProfile(chunks, true);
		this.recording = false;
		this.profileDirty = 0;
		await this.ctx.storage.put(PROFILE_STORAGE_KEY, { chunks: this.profile, complete: true });
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
// Debug endpoints (gated by DEBUG_ENDPOINTS=1).
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

	if (url.pathname === "/debug/chunklink") {
		const imageName = url.searchParams.get("image") ?? "debian_large_20230522_5044875331_2.ext2";
		const start = Number(url.searchParams.get("start") ?? 0);
		const count = Math.min(Number(url.searchParams.get("n") ?? 2), 64);
		const width = Math.max(1, Math.min(Number(url.searchParams.get("c") ?? 4), 16));
		const steps: string[] = [];
		const t0 = Date.now();
		const mark = (step: string) => steps.push(`${step}@${Date.now() - t0}ms`);
		try {
			const link = new ChunkLink(env, imageName, coloTag(request), (profile) => {
				mark(`profile(${profile.length})`);
			});
			await link.opened();
			mark("opened");
			let next = start;
			const worker = async () => {
				while (next < start + count) {
					const chunkIndex = next++;
					const data = await link.request(chunkIndex, false);
					mark(`chunk${chunkIndex}(${data.byteLength})`);
				}
			};
			await Promise.all(Array.from({ length: width }, worker));
			const totalMs = Date.now() - t0;
			link.close();
			return Response.json({
				ok: true,
				totalMs,
				mibPerSec: Number(((count * 1) / (totalMs / 1000)).toFixed(2)),
				steps,
			});
		} catch (error) {
			mark(`error(${error instanceof Error ? error.message : String(error)})`);
			return Response.json({ ok: false, steps });
		}
	}

	if (url.pathname === "/debug/where") {
		const imageName = url.searchParams.get("image") ?? "debian_large_20230522_5044875331_2.ext2";
		const stub = env.DISK_SESSIONS.getByName(`${imageName}@${coloTag(request)}`);
		const t0 = Date.now();
		const doColo = await stub.debugColo();
		return Response.json({ edgeColo: coloTag(request), doColo, rpcMs: Date.now() - t0 });
	}

	if (url.pathname === "/debug/subrequests") {
		// Empirically measures how many asset reads one invocation may perform.
		const target = Math.min(Number(url.searchParams.get("n") ?? 100), 20000);
		let ok = 0;
		try {
			for (let i = 0; i < target; i++) {
				const response = await env.ASSETS.fetch(new Request(new URL(`/?i=${i}`, request.url)));
				await response.body?.cancel();
				if (!response.ok && response.status !== 304) {
					break;
				}
				ok++;
			}
		} catch (error) {
			return Response.json({ ok, error: error instanceof Error ? error.message : String(error) });
		}
		return Response.json({ ok });
	}

	return new Response("Not found", { status: 404 });
}
