import {State, init} from "./tailscale_tun.js";

export { State };
export async function autoConf({loginUrlCb, dnsIp, stateUpdateCb, netmapUpdateCb, controlUrl, authKey, ipMap}) {
	const { tcpSocket, udpSocket, parseIP, dumpIP, resolve, up, down, login, logout, listeners } = await init();

	const settings = {
		controlUrl: controlUrl,
		dnsIp: dnsIp,
		authKey: authKey,
		exitNodeIp: undefined,
		wantsRunning: true,
		ipMap: ipMap,
	};

	listeners.onstateupdate = (state) => {
		stateUpdateCb(state);
		switch(state)
		{
			case State.NeedsLogin:
			{
				login();
				break;
			}
			case State.Running:
			{
				break;
			}
			case State.Starting:
			{
				break;
			}
			case State.Stopped:
			{
				break;
			}
			case State.NoState:
			{
				up(settings);
				break;
			}
			default:
			{
				console.log(state);
				break;
			}
		}
	};

	
	listeners.onloginurl = (login) => {
		console.log("login url:",login);
		loginUrlCb(login);
	};

	// Fork change: prefer the exit node pinned by the embedder
	// (globalThis.__webvmTsExitNodeIp, served by /net/tailscale.json) over
	// "first online". Tailnets can advertise exit nodes that do not actually
	// forward traffic for this node; the pin is a verified-working one. The
	// pinned peer is matched among all online peers because the netmap's
	// exitNode flag can lag or be absent for this client. Without a pin,
	// keep upstream's behavior (first online flagged exit node).
	listeners.onnetmap = (map) => {
		netmapUpdateCb(map);
		if (settings.exitNodeIp) {
			return;
		}
		const hint = globalThis.__webvmTsExitNodeIp;
		const pick = hint
			? map.peers.find((p) => p.online && p.addresses.includes(hint))
			: map.peers.find((p) => p.online && p.exitNode);
		if (!pick) {
			return;
		}
		settings.exitNodeIp = pick.addresses[0];
		settings.dnsIp = settings.dnsIp || "8.8.8.8";
		console.log("[webvm] tailscale exit node:", settings.exitNodeIp);
		up(settings);
	};

	return {
		tcpSocket,
		udpSocket,
		parseIP,
		dumpIP,
		resolve,
		up: async () => {
			await up(settings);
		},
	}
}

