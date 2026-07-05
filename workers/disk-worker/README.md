# WebVM Cloudflare Disk Worker

This Worker serves WebVM ext2 disk images through the same `CheerpX.CloudDevice`
WebSocket protocol used by `https://webvm.io`, plus an HTTP byte-range
fallback. It also serves the WebVM frontend itself from Workers Static Assets.

## Architecture

```text
Browser (CheerpX CloudDevice)
  │  wss://<worker-host>/<image>.ext2
  ▼
Edge Worker ── terminates the client WebSocket in the user's colo
  │            serves blocks from an isolate-wide chunk LRU (64 MiB)
  │            also answers the HTTP fallback (?s=&e=, Range) directly
  │  one internal WebSocket per session (cache misses only)
  ▼
DiskSession Durable Object (one per image per colo)
  │            second-level chunk LRU (64 MiB) + boot profile
  │  WebSocket Hibernation API (fresh subrequest budget per message)
  ▼
Workers Static Assets: /disks/<image>.ext2/chunks/000123.bin (1 MiB each)
```

- **Disk storage**: the image is split into 1 MiB chunk files uploaded as
  Workers Static Assets (free storage/reads, edge-cached, 20k/100k file limit).
- **Edge termination**: the client socket terminates in the edge Worker, so
  warm block reads are answered at the pure network floor. Durable Objects do
  not run in every colo (an NRT client gets a KIX DO, ~+13 ms per read, which
  is the difference to the reference server on `apt`-style serial workloads).
- **Internal chunk link**: on a cache miss the edge fetches the whole 1 MiB
  chunk from the DO over a single internal WebSocket (`chunk:<index>` →
  `chunk:<index>:<len>` + ≤512 KiB binary frames). The link costs one
  subrequest for the whole session, so the edge Worker's 50-subrequest budget
  is never exhausted, and the client never sees a reconnect.
- **Why a DO behind the edge**: asset reads must happen somewhere with a
  renewable budget. With WebSocket Hibernation each incoming message is its
  own invocation with fresh limits, so the DO can serve any number of chunk
  fetches over one link. Its cache also survives edge isolate turnover and is
  shared by all sessions in the colo.
- **Sequential prefetch**: after each block read the edge prefetches the next
  4 chunks through the same link.
- **Boot-profile prewarm**: cold chunk reads cost 500–900 ms, warm reads are
  client RTT (~75 ms). The boot read order is deterministic per image, so the
  DO records the first-touch chunk order once (persisted to DO storage) and
  sends it to the edge on link connect; the edge prewarms its cache along the
  profile, staying ≤32 chunks ahead of the client's position. A profile can
  also be shipped globally as a static asset (`bootprofile.json`, exported
  with `scripts/export-boot-profile.mjs`), which every colo sees immediately.
- **Error handling**: transient asset-read failures retry in-process, the
  edge retries a dead link once with a fresh one, then falls back to the
  CloudDevice 1-byte reconnect signal. Malformed requests close the socket;
  reads past EOF are truncated exactly like the reference server at
  `disks.webvm.io`.

Measured against `wss://disks.webvm.io` from the same host: warm serial
128 KiB reads p50 ≈ 74 ms vs 73 ms (was ~87 ms with the client socket
terminating in the DO), cold scattered reads ~550 ms vs ~1100 ms, boot and
`apt list` at parity in paired browser runs.

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
- `GET /debug/chunklink?start=<chunk>&n=<count>&c=<concurrency>` – exercise
  the internal edge→DO chunk link and report per-chunk timings
- `GET /debug/where` – edge colo vs DO colo and RPC latency
- `GET /debug/subrequests?n=<count>` – measure the per-invocation subrequest
  budget empirically

Set `DEBUG_ENDPOINTS` to `"0"` for production.

To ship the currently recorded boot profile as a static asset (available in
every colo from the first boot):

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
