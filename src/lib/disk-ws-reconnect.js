/**
 * Auto-reconnect for CheerpX CloudDevice disk WebSockets.
 *
 * CheerpX's disk client only recovers from the CloudDevice protocol's 1-byte
 * reconnect signal; it never listens for socket close/error after the initial
 * handshake, so an unexpected disconnect (server deploy, Cloudflare dropping
 * a long-lived connection, network blip) permanently kills the VM's disk.
 *
 * This installs a proxy around WebSocket for same-origin `*.ext2` URLs that
 * masks such disconnects: it transparently reopens the underlying socket,
 * swallows the server's fresh metadata handshake, and replays the in-flight
 * block request. CheerpX sees one uninterrupted socket.
 *
 * Protocol facts this relies on (see workers/disk-worker/src/index.ts):
 *  - on connect the server always sends one text metadata message first
 *  - the client sends one text range request at a time and expects exactly
 *    one binary response (0-byte = keepalive, 1-byte = reconnect signal)
 */
const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 5000;
// Give up masking after ~30 s of failed reconnects and surface the close so
// CheerpX reports a device error instead of hanging forever.
const RECONNECT_MAX_ATTEMPTS = 8;

export function installDiskSocketReconnect() {
	const Native = globalThis.WebSocket;
	if (!Native || Native.__diskReconnectInstalled) {
		return;
	}

	function WebSocketProxy(url, protocols) {
		return isDiskUrl(url) ? createDiskSocket(Native, String(url)) : new Native(url, protocols);
	}
	WebSocketProxy.prototype = Native.prototype;
	for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
		WebSocketProxy[key] = Native[key];
	}
	WebSocketProxy.__diskReconnectInstalled = true;
	globalThis.WebSocket = WebSocketProxy;
}

function isDiskUrl(url) {
	try {
		return new URL(url, globalThis.location.href).pathname.endsWith(".ext2");
	} catch {
		return false;
	}
}

function createDiskSocket(Native, url) {
	const facade = {
		url,
		bufferedAmount: 0,
		extensions: "",
		protocol: "",
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
	};

	let binaryType = "blob";
	Object.defineProperty(facade, "binaryType", {
		get: () => binaryType,
		set(value) {
			binaryType = value;
			if (underlying) {
				underlying.binaryType = value;
			}
		},
	});

	let underlying = null;
	// True once CheerpX has received the initial metadata message; from then
	// on disconnects are masked and handled here instead of surfacing.
	let established = false;
	// The block request currently awaiting its binary response, if any.
	let inflightRequest = null;
	let clientClosed = false;
	let awaitingMeta = true;
	let attempts = 0;
	let reconnectTimer = 0;

	const listeners = { open: [], message: [], error: [], close: [] };

	function dispatch(type, event) {
		const handler = facade["on" + type];
		if (typeof handler === "function") {
			try {
				handler.call(facade, event);
			} catch (error) {
				console.error("disk socket handler failed", error);
			}
		}
		for (const listener of listeners[type] ?? []) {
			try {
				listener.call(facade, event);
			} catch (error) {
				console.error("disk socket listener failed", error);
			}
		}
	}

	function connect() {
		const ws = new Native(url);
		underlying = ws;
		awaitingMeta = true;
		ws.binaryType = binaryType;

		ws.addEventListener("open", (event) => {
			if (ws !== underlying) {
				return;
			}
			// Reconnects are invisible: CheerpX already saw the open event.
			if (!established) {
				dispatch("open", event);
			}
		});

		ws.addEventListener("message", (event) => {
			if (ws !== underlying) {
				return;
			}
			if (awaitingMeta && typeof event.data === "string") {
				awaitingMeta = false;
				attempts = 0;
				if (established) {
					// Fresh handshake of a masked reconnect: swallow the
					// metadata and replay the interrupted request.
					if (inflightRequest !== null) {
						ws.send(inflightRequest);
					}
					return;
				}
				established = true;
				dispatch("message", event);
				return;
			}
			if (typeof event.data !== "string") {
				const size = event.data.byteLength ?? event.data.size ?? 0;
				// A real response settles the in-flight request; so does the
				// 1-byte reconnect signal (CheerpX abandons this socket and
				// resends on a fresh one). 0-byte keepalives settle nothing.
				if (size >= 1) {
					inflightRequest = null;
				}
			}
			dispatch("message", event);
		});

		const onDrop = (event) => {
			if (ws !== underlying) {
				return;
			}
			underlying = null;
			if (clientClosed || !established) {
				// Initial connect failures surface to CheerpX so its own
				// HTTP fallback can kick in; post-close events are moot.
				dispatch(event.type === "error" ? "error" : "close", event);
				return;
			}
			scheduleReconnect();
		};
		ws.addEventListener("close", onDrop);
		ws.addEventListener("error", (event) => {
			// An error on a live connection is always followed by close;
			// only surface errors that abort the initial connect.
			if (ws === underlying && !established && !clientClosed) {
				onDrop(event);
			}
		});
	}

	function scheduleReconnect() {
		if (clientClosed || reconnectTimer) {
			return;
		}
		if (attempts >= RECONNECT_MAX_ATTEMPTS) {
			clientClosed = true;
			dispatch("close", new CloseEvent("close", { code: 1006, reason: "disk reconnect failed", wasClean: false }));
			return;
		}
		const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempts, RECONNECT_MAX_DELAY_MS);
		attempts++;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = 0;
			if (!clientClosed) {
				connect();
			}
		}, delay);
	}

	facade.send = (data) => {
		if (clientClosed) {
			return;
		}
		if (typeof data === "string" && data.length > 0) {
			inflightRequest = data;
		}
		if (underlying && underlying.readyState === Native.OPEN && !awaitingMeta) {
			underlying.send(data);
		} else if (underlying === null) {
			// Socket died while idle (nothing was in flight to detect it):
			// reconnect now; the request replays after the fresh handshake.
			scheduleReconnect();
		}
		// Requests sent while connecting/handshaking replay via
		// inflightRequest once the metadata arrives.
	};

	facade.close = (code, reason) => {
		clientClosed = true;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = 0;
		}
		try {
			underlying?.close(code, reason);
		} catch {
			// Already closed.
		}
	};

	facade.addEventListener = (type, listener) => {
		if (listeners[type] && typeof listener === "function") {
			listeners[type].push(listener);
		}
	};

	facade.removeEventListener = (type, listener) => {
		const queue = listeners[type];
		if (queue) {
			const index = queue.indexOf(listener);
			if (index >= 0) {
				queue.splice(index, 1);
			}
		}
	};

	Object.defineProperty(facade, "readyState", {
		get() {
			if (clientClosed) {
				return Native.CLOSED;
			}
			if (established) {
				// Mask reconnects: the facade stays OPEN so CheerpX keeps
				// using it; sends during a gap replay after the handshake.
				return Native.OPEN;
			}
			return underlying ? underlying.readyState : Native.CONNECTING;
		},
	});

	connect();
	return facade;
}
