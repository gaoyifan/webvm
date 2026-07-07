const diskImageName = import.meta.env.VITE_WEBVM_DISK_IMAGE || "alpine_terminal_3.22.5.ext2";
const defaultDiskImagePath = `/${diskImageName}`;
const defaultDiskImageUrl = typeof location === "undefined" ? defaultDiskImagePath :
	`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${defaultDiskImagePath}`;

export const diskImageUrl = import.meta.env.VITE_WEBVM_DISK_URL || defaultDiskImageUrl;
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
