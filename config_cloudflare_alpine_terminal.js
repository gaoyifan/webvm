// Alpine terminal image (no GUI). Pinned to 3.23.5: last release where
// python3 execution works under CheerpX 1.3.0 (3.24+ faults on python -c).
const diskImageName = import.meta.env.VITE_ALPINE_DISK_IMAGE || "alpine_terminal_3.23.5.ext2";
const defaultDiskImagePath = `/${diskImageName}`;
const defaultDiskImageUrl = typeof location === "undefined" ? defaultDiskImagePath :
	`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${defaultDiskImagePath}`;

export const diskImageUrl = import.meta.env.VITE_ALPINE_DISK_URL || defaultDiskImageUrl;
export const diskImageType = "cloud";
export const printIntro = true;
export const needsDisplay = false;
export const cmd = "/bin/bash";
export const args = ["--login"];
export const opts = {
	env: ["HOME=/home/user", "TERM=xterm", "USER=user", "SHELL=/bin/bash", "EDITOR=vim", "LANG=C.UTF-8"],
	cwd: "/home/user",
	uid: 1000,
	gid: 1000,
};
