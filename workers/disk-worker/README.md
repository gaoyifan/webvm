# WebVM Cloudflare Disk Worker

This Worker serves WebVM ext2 disk blocks through the same `CheerpX.CloudDevice`
mode used by `https://webvm.io`.

The disk image is stored as 1 MiB Workers Static Assets chunks by default:

```text
assets/disks/<image>.ext2/manifest.json
assets/disks/<image>.ext2/chunks/000000.bin
assets/disks/<image>.ext2/chunks/000001.bin
```

## Cloudflare Workers Builds

When this repository is connected through Cloudflare Workers Builds, configure:

```sh
# Build command, from the repository root
npm run build:cloudflare-worker

# Deploy command
cd workers/disk-worker && npx wrangler deploy
```

The root build command downloads the configured disk image in Cloudflare's build
environment, splits it into 1 MiB chunks, and copies the frontend `build/`
output into this Worker's assets directory. The downloader retries transient
range failures from the source disk server; tune it with
`WEBVM_DISK_DOWNLOAD_CONCURRENCY` and `WEBVM_DISK_DOWNLOAD_RETRIES`.
For WebSocket sources, the build reads metadata from WebSocket and downloads
chunks through HTTP ranges.
`WEBVM_DISK_ASSET_CHUNK_SIZE` can be used to choose a different deployed asset
chunk size.

## Prepare Disk Assets

From an existing ext2 image:

```sh
npm install
npm run prepare:disk -- --input ../../custom-disk-images/debian.ext2 --name debian.ext2
```

From the official WebVM cloud disk HTTPS fallback:

```sh
npm install
npm run prepare:disk -- \
  --source-url wss://disks.webvm.io/debian_large_20230522_5044875331_2.ext2 \
  --size 5044875331
```

Remote downloads require the exact image size because the cloud fallback endpoint
serves byte ranges but does not expose a public manifest.

## Run Locally

```sh
npm run dev
```

Check the HTTP fallback path:

```sh
curl -i "http://127.0.0.1:8787/debian.ext2?s=0&e=131071" -o /tmp/block.bin
```

Check the WebSocket path with any client that can send a text message:

```text
0-131071
```

The Worker returns the requested bytes as a binary WebSocket message.

## Deploy

```sh
npm run deploy
```

After deployment, build WebVM with the Worker URL:

```sh
WEBVM_MODE=cloudflare \
VITE_WEBVM_DISK_URL=wss://<worker-host>/debian.ext2 \
npm run build
```

To serve the WebVM frontend and disk blocks from the same Worker, build WebVM
without `VITE_WEBVM_DISK_URL` and copy the static output into this Worker's
assets directory before deployment:

```sh
cd ../..
WEBVM_MODE=cloudflare npm run build
cp -R build/* workers/disk-worker/assets/
cd workers/disk-worker
npm run deploy
```
