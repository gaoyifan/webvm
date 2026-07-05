#!/usr/bin/env bash
# Measures WebVM time-to-prompt in a fresh browser session.
set -euo pipefail

URL="${1:-https://webvm-disk-worker.d58993771361bc4ff2f5.workers.dev/}"
playwright-cli close >/dev/null 2>&1 || true
START=$(date +%s%3N)
playwright-cli open --browser chromium "$URL" >/dev/null 2>&1
for i in $(seq 1 120); do
	if playwright-cli snapshot 2>/dev/null | rg -q 'user@'; then
		NOW=$(date +%s%3N)
		echo "time-to-prompt: $(( (NOW - START) / 1000 )).$(( (NOW - START) % 1000 / 100 ))s"
		exit 0
	fi
	sleep 1
done
echo "TIMEOUT waiting for prompt"
exit 1
