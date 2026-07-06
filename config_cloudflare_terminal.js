const diskImageName = import.meta.env.VITE_WEBVM_DISK_IMAGE || "debian_bullseye_20260706_1.ext2";
const defaultDiskImagePath = `/${diskImageName}`;
const defaultDiskImageUrl = typeof location === "undefined" ? defaultDiskImagePath :
	`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${defaultDiskImagePath}`;

// The Cloudflare Worker endpoint serving the root OS image through CheerpX CloudDevice.
export const diskImageUrl = import.meta.env.VITE_WEBVM_DISK_URL || defaultDiskImageUrl;
// Use the same WebSocket dynamic block loading mode as https://webvm.io.
export const diskImageType = "cloud";
// Print an introduction message about the technology
export const printIntro = true;
// Is a graphical display needed
export const needsDisplay = false;
// Executable full path (Required)
export const cmd = "/bin/bash";
// Arguments, as an array (Required)
export const args = ["--login"];
// Optional extra parameters
export const opts = {
	// Environment variables
	env: ["HOME=/home/user", "TERM=xterm", "USER=user", "SHELL=/bin/bash", "EDITOR=vim", "LANG=en_US.UTF-8", "LC_ALL=C"],
	// Current working directory
	cwd: "/home/user",
	// User id
	uid: 1000,
	// Group id
	gid: 1000
};
