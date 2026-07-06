# WebVM Cloudflare Disk Worker

This Worker serves WebVM ext2 disk images through the same `CheerpX.CloudDevice`
WebSocket protocol used by `https://webvm.io`, plus an HTTP byte-range
fallback. It also serves the WebVM frontend itself from Workers Static Assets.

## Architecture

```text
Browser (CheerpX CloudDevice, wrapped by src/lib/disk-ws-reconnect.js)
  │  wss://<worker-host>/<image>.ext2
  ▼
Edge Worker ── forwards the WebSocket upgrade to the Durable Object
  │            answers the HTTP fallback (?s=&e=, Range) per-request
  ▼
DiskSession Durable Object (one per image per colo)
  │            terminates the client WebSocket (Hibernation API)
  │            chunk LRU (64 MiB) + boot-profile prewarm + prefetch
  │  fresh subrequest budget per message
  ▼
Workers Static Assets: /disks/<image>.ext2/chunks/000123.bin (1 MiB each)
```

- **Disk storage**: the image is split into 1 MiB chunk files uploaded as
  Workers Static Assets (free storage/reads, edge-cached, 20k/100k file limit).
- **DO termination**: eyeball WebSockets held by stateless Worker invocations
  have no lifetime guarantee — the runtime load-sheds them after minutes
  (observed as `loadShed` invocation outcomes killing live sessions), and
  CheerpX cannot recover from an unexpected close. Hibernatable DO sockets
  are the supported long-lived pattern: the DO may be evicted while the
  socket stays connected, and each message wakes it with a fresh subrequest
  budget, so asset reads never exhaust the 50-subrequest budget a single
  edge invocation would get. The DO is keyed by image + edge colo, placing
  it in (or near) the caller's colo; where DOs don't run (e.g. NRT → KIX)
  warm reads pay a small backbone hop.
- **Client reconnect wrapper**: `src/lib/disk-ws-reconnect.js` proxies the
  disk WebSocket in the frontend. CheerpX only recovers from the protocol's
  1-byte reconnect signal, never from a socket death, so the wrapper masks
  unexpected disconnects (deploys, DO migrations, network blips):
  transparently reopens the socket, swallows the fresh metadata handshake,
  and replays the in-flight block request.
- **Client boot prefetch**: the set of 128 KiB blocks a boot reads is
  deterministic per image and ships as a static asset (`bootblocks.json`,
  exported with `scripts/export-boot-profile.mjs`). At startup
  `src/lib/disk-boot-prefetch.js` subtracts the blocks already in CheerpX's
  IndexedDB cache and fetches the rest in ~30 coalesced parallel HTTP range
  requests; the WebSocket proxy answers matching block reads locally. This
  replaces ~150 serial WebSocket round trips: measured cold boot drops from
  ~18–20 s to ~5–7 s (time-to-prompt, headless Chromium). Repeat visits skip
  the bulk fetch entirely (the IndexedDB cache already has the blocks).
- **Sequential prefetch**: after each block read the DO prefetches the next
  4 chunks into its cache.
- **Boot-profile prewarm**: cold chunk reads cost 500–900 ms (asset fetch),
  warm reads are client RTT. The DO derives the first-touch chunk order from
  the same boot profile and prewarms its cache along it, staying ≤32 chunks
  ahead of the client's position, so boot reads that do reach the server
  (no bootblocks asset yet, prefetch misses) stay RTT-bound. Without the
  shipped asset the DO records the profile from the first session whose
  reads start at block 0 and persists it to DO storage.
- **Error handling**: transient asset-read failures retry in-process, then
  fall back to the CloudDevice 1-byte reconnect signal. Malformed requests
  close the socket; reads past EOF are truncated exactly like the reference
  server at `disks.webvm.io`. Client-side bulk-fetch failures fall back to
  ordinary WebSocket reads.

Measured against `wss://disks.webvm.io` from the same host: warm serial
128 KiB reads p50 ≈ 120 ms vs 73 ms (the NRT→KIX DO hop; colos with local
DOs stay at the network floor), cold scattered reads ~550 ms vs ~1100 ms.
Boot time-to-prompt ~5–7 s vs ~14 s for webvm.io in the same headless
browser. A 96 MiB sequential soak sustains 1.2 MiB/s with zero reconnects.

## CloudDevice protocol

- On connect the server sends a text message `<size>-<lastModifiedEpochSeconds>`.
- The client requests a block with a text message `<start>-<endInclusive>`.
- The server responds with one binary message containing exactly those bytes
  (truncated at EOF).
- A 0-byte binary message is a keepalive; a 1-byte message tells the client to
  reconnect and resend the pending request on a fresh socket.
- An empty text message means the client is closing (sent on `beforeunload`).
- HTTP fallback: `GET <url>?s=<start>&e=<endInclusive>` (or a
  `Range: bytes=<start>-<end>` header) returns the bytes; `HEAD` returns
  `Content-Length` and `Last-Modified`.

## Prepare Disk Assets

From an existing ext2 image:

```sh
npm install
npm run prepare:disk -- --input ../../custom-disk-images/debian.ext2 --name debian.ext2
```

From the official WebVM cloud disk (size and metadata read over WebSocket):

```sh
npm run prepare:disk -- \
  --source-url wss://disks.webvm.io/debian_large_20230522_5044875331_2.ext2
```

Tune with `WEBVM_DISK_DOWNLOAD_CONCURRENCY`, `WEBVM_DISK_DOWNLOAD_RETRIES`,
and `WEBVM_DISK_ASSET_CHUNK_SIZE`.

## Build the frontend into this Worker

```sh
cd ../..
npm run build:cloudflare-worker   # builds WebVM, copies build/ + _headers into assets/, downloads the disk
cd workers/disk-worker
npm run deploy
```

Or manually:

```sh
cd ../..
WEBVM_MODE=cloudflare npm run build
cp -R build/* workers/disk-worker/assets/
```

The `_headers` file in `assets/` applies the cross-origin isolation headers
(COOP/COEP) required by CheerpX to all statically served files.

## Run Locally

```sh
npm run dev
node scripts/test-disk-endpoint.mjs \
  --url ws://127.0.0.1:8787/<image>.ext2 \
  --reference /path/to/original.ext2 --quick
```

## Test

`scripts/test-disk-endpoint.mjs` runs protocol-level correctness tests
(WebSocket + HTTP fallback: block reads, chunk-boundary spans, EOF clamping,
error cases, byte-exact comparison against a reference copy) and a 96 MiB
sequential soak that verifies throughput and that no reconnects are needed:

```sh
node scripts/test-disk-endpoint.mjs \
  --url wss://<worker-host>/<image>.ext2 \
  --reference /path/to/original.ext2        # omit --quick to include the soak
```

`scripts/replay-boot.mjs` replays the recorded boot chunk order as serial
128 KiB reads and reports latency percentiles. `scripts/measure-boot.sh`
measures browser time-to-prompt with playwright-cli.

With `DEBUG_ENDPOINTS=1` (see `wrangler.jsonc`), the Worker exposes:

- `GET /debug/session?image=<image>` – DO cache/profile stats
- `GET /debug/session?image=<image>&resetProfile` – clear the boot profile
- `POST /debug/session?image=<image>&setProfile` (JSON array of chunk indexes)
- `GET /debug/where` – edge colo vs DO colo and RPC latency

Set `DEBUG_ENDPOINTS` to `"0"` for production.

To ship the currently recorded boot profile as the `bootblocks.json` asset
(enables the client boot prefetch and is available in every colo from the
first boot):

```sh
node scripts/export-boot-profile.mjs --host <worker-host> --image <image>.ext2
npm run deploy
```

## Deploy

```sh
npm run deploy
```

After deployment the WebVM frontend is served at the Worker URL and loads the
disk from the same host (`config_cloudflare_terminal.js` defaults to
`wss://<host>/<image>.ext2`). To point a separately hosted frontend at this
Worker:

```sh
WEBVM_MODE=cloudflare \
VITE_WEBVM_DISK_URL=wss://<worker-host>/<image>.ext2 \
npm run build
```
