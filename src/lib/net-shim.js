/**
 * Runtime patches for the Tailscale wasm client shipped with CheerpX (we
 * mirror the binary and cannot rebuild it), fixing two URL bugs that leave
 * the browser without a usable DERP relay:
 *
 *  - DERP WebSocket URLs lose the region's custom port: for a relay
 *    configured as el2-chinanet.gaof.net:10000 the client dials
 *    wss://el2-chinanet.gaof.net/derp (:443). Re-add the port from the
 *    host->port map served by /net/tailscale.json.
 *  - netcheck HTTPS probes tack that custom port onto the official
 *    *.tailscale.com relays (which only serve 443), so every official region
 *    times out and looks dead. Strip non-443 ports for *.tailscale.com.
 *
 * Also publishes the pinned exit node IP for tailscale_tun_auto.js: some
 * tailnet exit nodes advertise 0.0.0.0/0 but do not actually forward webvm
 * traffic, so "first online exit node" is not safe.
 */

let derpPorts = {};

export function installNetShims({ derpPorts: ports, exitNodeIp } = {}) {
	derpPorts = ports ?? {};
	if (exitNodeIp) {
		globalThis.__webvmTsExitNodeIp = exitNodeIp;
	}
	installOnce();
}

function rewriteNetUrl(rawUrl) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		return null;
	}
	if (url.hostname.endsWith(".tailscale.com")) {
		if (url.port && url.port !== "443") {
			url.port = "";
			return url.href;
		}
		return null;
	}
	const customPort = derpPorts[url.hostname];
	if (customPort && !url.port) {
		url.port = String(customPort);
		return url.href;
	}
	return null;
}

let installed = false;

function installOnce() {
	if (installed) {
		return;
	}
	installed = true;

	const nativeFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = (input, init) => {
		const target = typeof input === "string" || input instanceof URL ? String(input) : input.url;
		const rewritten = rewriteNetUrl(target);
		if (rewritten === null) {
			return nativeFetch(input, init);
		}
		if (typeof input === "string" || input instanceof URL) {
			return nativeFetch(rewritten, init);
		}
		return nativeFetch(new Request(rewritten, input), init);
	};

	// May already be the disk-reconnect proxy; wrapping composes.
	const NativeWebSocket = globalThis.WebSocket;
	function WebSocketShim(url, protocols) {
		return new NativeWebSocket(rewriteNetUrl(String(url)) ?? url, protocols);
	}
	WebSocketShim.prototype = NativeWebSocket.prototype;
	for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
		WebSocketShim[key] = NativeWebSocket[key];
	}
	globalThis.WebSocket = WebSocketShim;
}
