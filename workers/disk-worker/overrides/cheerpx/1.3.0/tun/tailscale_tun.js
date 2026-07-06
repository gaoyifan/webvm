import "./wasm_exec.js";

import ipStackAwait from "./ipstack.js";

export const State = {
	NoState: 0,
	InUseOtherUser: 1,
	NeedsLogin: 2,
	NeedsMachineAuth: 3,
	Stopped: 4,
	Starting: 5,
	Running: 6,
};

export async function init() {
	const {IpStack} = await ipStackAwait();
	IpStack.init();

	const listeners = {
		onstateupdate: () => {},
		onnetmap: () => {},
		onloginurl: () => {},
	}

	let ipn = null;
	let localIp = null;
	let dnsIp = null;
	let ipMap = null;

	const lazyRunIpn = async () => {
		// Fork change: the IPN engine is pinned to the CheerpX 1.1.2 build
		// (tailscale v1.76.3), the last one whose up() applies `exitNodeIp`.
		// It exceeds the 25 MiB Workers static asset limit uncompressed, so
		// it is stored gzipped and inflated here (~6 MiB over the wire).
		const wasmUrl = new URL("tailscale.wasm.gz", import.meta.url);
		const go = new self.Go();
		const response = await fetch(wasmUrl);
		const inflated = response.body.pipeThrough(new DecompressionStream("gzip"));
		const bytes = await new Response(inflated).arrayBuffer();
		let {instance} = await WebAssembly.instantiate(bytes, go.importObject);
		go.run(instance);

		// The 1.1.2 newIPN takes a single options argument (unlike 1.3.0's
		// (conf, options)); the conf is consumed by ipn.up() instead. The
		// 1.1.2 default state store is localStorage, which does not exist in
		// the CheerpX worker context (the Go side exits with code 1), so an
		// in-memory store is always provided. State loss on reload is fine:
		// the ephemeral auth key re-registers the node on every boot anyway.
		const memoryState = new Map();
		ipn = newIPN({
			stateStorage: {
				setState(id, value) {
					memoryState.set(id, value);
				},
				getState(id) {
					return memoryState.get(id) || "";
				},
			},
		});

		const setupIpStack = () => {
			ipn.tun.onmessage = function(ev) {
				IpStack.input(ev.data)
			};
			IpStack.output(function(p){
				ipn.tun.postMessage(p, [p.buffer]);
			});
		};
		setupIpStack();

		ipn.run({
			notifyState: (s) => listeners.onstateupdate(s),
			notifyNetMap: (s) => {
				const netMap = JSON.parse(s);
				listeners.onnetmap(netMap);
				const newLocalIp = netMap.self.addresses[0];
				if (localIp != newLocalIp)
				{
					localIp = newLocalIp;
					try{
						IpStack.up({localIp, dnsIp, ipMap});
					}catch(e){
						console.log(e);
						debugger;
					}
				}
			},
			notifyBrowseToURL: (l) => listeners.onloginurl(l),
		});

	};


	return {
		tcpSocket: IpStack.TCPSocket,
		udpSocket: IpStack.UDPSocket,
		parseIP: IpStack.parseIP,
		dumpIP: IpStack.dumpIP,
		resolve: IpStack.resolve,
		up: async (conf) => {
			if (ipn == null) {
				await lazyRunIpn();
			}
			ipn.up(conf);
			localIp = null;
			dnsIp = conf.dnsIp || "127.0.0.53";
			ipMap = conf.ipMap
		},
		down: () => {
			ipn.down();
			IpStack.down();
		},
		login: () => ipn.login(),
		logout: () => ipn.logout(),
		listeners
	};
}
