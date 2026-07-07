#!/usr/bin/env bash
# Deploy an Alpine terminal image and run the E2E compatibility battery.
# Usage: scripts/test-alpine-deploy.sh 3.24.1
set -euo pipefail
VER=${1:?usage: test-alpine-deploy.sh <version e.g. 3.24.1>}
ROOT=/home/yifan/webvm
IMAGE="alpine_terminal_${VER}.ext2"
EXT2="/home/yifan/alpine-build/alpine_${VER}.ext2"
[[ -f "$EXT2" ]] || { echo "missing $EXT2"; exit 1; }

cd "$ROOT"
echo "== deploy $IMAGE =="
WEBVM_DISK_IMAGE="$IMAGE" WEBVM_DISK_SOURCE_URL="$EXT2" node scripts/build-cloudflare-worker.mjs 2>&1 | tail -1
(cd workers/disk-worker && npx wrangler deploy 2>&1 | tail -1)

cat > /tmp/alpine-e2e.mjs <<EOF
async (page) => {
	const ORIGIN = "https://webvm-disk-worker.d58993771361bc4ff2f5.workers.dev";
	const logs = [];
	page.on("console", (msg) => logs.push(msg.text()));
	await page.goto(ORIGIN + "/robots.txt", { waitUntil: "domcontentloaded" }).catch(() => {});
	await page.evaluate(async () => {
		const dbs = await indexedDB.databases();
		await Promise.all(dbs.map((db) => new Promise((res) => {
			const req = indexedDB.deleteDatabase(db.name);
			req.onsuccess = req.onerror = req.onblocked = () => res();
		})));
	});
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Network.clearBrowserCache");
	const t0 = Date.now();
	await page.goto(ORIGIN + "/", { waitUntil: "domcontentloaded" });
	await page.waitForFunction(
		() => /:\\~\$/.test(document.getElementById("console")?.innerText ?? ""),
		{ timeout: 240000 },
	);
	const bootS = ((Date.now() - t0) / 1000).toFixed(1);
	await page.click("#console");
	await page.keyboard.type("cat /etc/os-release | grep VERSION_ID; python3 -c 'import os; print(os.urandom(4).hex())'; echo PY=\$?; sudo whoami; echo SU=\$?; gcc -o /tmp/hw examples/c/helloworld.c && /tmp/hw; echo GCC=\$?; sudo apk update 2>&1 | tail -1; echo APK=\$?");
	await page.keyboard.press("Enter");
	await page.waitForFunction(
		() => /APK=\\d/.test(document.getElementById("console")?.innerText ?? ""),
		{ timeout: 240000 },
	).catch(() => {});
	const text = await page.evaluate(() => document.getElementById("console").innerText);
	const faults = logs.filter((l) => /Fault/i.test(l));
	const tail = text.split("\\n").slice(-10).join("\\n");
	const ok = /PY=0/.test(tail) && /SU=0/.test(tail) && /GCC=0/.test(tail) && /APK=0/.test(tail) && faults.length === 0;
	return "Alpine ${VER} boot " + bootS + "s ok=" + ok + "\\n" + tail + (faults.length ? "\\nFAULTS:" + faults.join("|") : "");
}
EOF

OUT=$(playwright-cli -s=e2e run-code "$(cat /tmp/alpine-e2e.mjs)" 2>&1)
echo "$OUT" | rg "Result" -A5 | head -6
if echo "$OUT" | rg -q 'ok=true'; then
	echo "PASS Alpine $VER"
	exit 0
fi
echo "FAIL Alpine $VER"
exit 2
