#!/usr/bin/env bash
# Builds a Debian i386 ext2 root image for WebVM (bullseye/bookworm/trixie).
#
# Debootstrap-based equivalent of the upstream Docker flow
# (dockerfiles/debian_large + .github/workflows/deploy.yml): upstream builds
# an i386 Docker image and copies its filesystem into an ext2 file; this
# script produces the same result without a Docker daemon. Package set
# follows dockerfiles/debian_large, minus packages missing from newer
# releases (lsb-base, isc-dhcp-*; transitional/removed).
#
# Usage: sudo scripts/build-debian-image.sh <release> <output.ext2> [size]
set -euo pipefail

RELEASE=${1:?usage: build-debian-image.sh <release> <output.ext2> [size bytes]}
OUTPUT=${2:?usage: build-debian-image.sh <release> <output.ext2> [size bytes]}
# Newer package sets are a few hundred MiB larger than buster's; 2.4 GB
# leaves ~500 MiB free for apt operations inside the VM.
SIZE=${3:-2400000000}
REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ROOTFS=$(mktemp -d /tmp/webvm-rootfs.XXXXXX)
cleanup() {
	umount "$ROOTFS/proc" "$ROOTFS/dev/pts" "$ROOTFS/dev" 2>/dev/null || true
	rm -rf "$ROOTFS"
}
trap cleanup EXIT

debootstrap --arch=i386 --variant=minbase "$RELEASE" "$ROOTFS" http://deb.debian.org/debian
# mktemp creates the rootfs dir 0700; that mode would become the image's /.
chmod 0755 "$ROOTFS"

# Chroot niceties the Docker daemon provides implicitly: /dev and /proc for
# package postinst scripts (the debootstrap-created /dev nodes are dead when
# the rootfs sits on a nodev mount), and a policy-rc.d that stops them from
# starting services during install.
mount --bind /dev "$ROOTFS/dev"
mount -t devpts devpts "$ROOTFS/dev/pts"
mount -t proc proc "$ROOTFS/proc"
printf '#!/bin/sh\nexit 101\n' > "$ROOTFS/usr/sbin/policy-rc.d"
chmod +x "$ROOTFS/usr/sbin/policy-rc.d"

# lua: bullseye/bookworm ship 5.3, trixie ships 5.4.
case "$RELEASE" in
	bullseye|bookworm) LUA=lua5.3 ;;
	*) LUA=lua5.4 ;;
esac
PACKAGES=(
	apt-utils bsdgames bsdmainutils ca-certificates cowsay cpio cron curl
	dmidecode dmsetup g++ gcc git hexedit ifupdown init locales logrotate
	lshw "$LUA" lynx make nano netbase openssl procps python3
	python3-cryptography python3-jinja2 python3-numpy python3-pandas
	python3-pip python3-scipy python3-six python3-yaml readline-common
	rsyslog ruby sensible-utils ssh sudo systemd systemd-sysv tasksel
	tasksel-data udev vim wget whiptail xxd iptables kmod less
	netcat-openbsd
)
# In debian_large but potentially absent on some release/i386; skipped if so.
BEST_EFFORT=(beef gdbm-l10n luajit nodejs)

chroot "$ROOTFS" apt-get update
# The trailing-dash entries block exim4/bsd-mailx (pulled via Recommends):
# an MTA is dead weight in a browser VM and exim's postinst config check
# fails in this chroot.
DEBIAN_FRONTEND=noninteractive chroot "$ROOTFS" apt-get install -y "${PACKAGES[@]}" \
	exim4-base- exim4-config- exim4-daemon-light- bsd-mailx-
for pkg in "${BEST_EFFORT[@]}"; do
	DEBIAN_FRONTEND=noninteractive chroot "$ROOTFS" apt-get install -y "$pkg" || echo "skipped unavailable package: $pkg"
done
chroot "$ROOTFS" apt-get clean
rm -f "$ROOTFS/usr/sbin/policy-rc.d"

chroot "$ROOTFS" useradd -m user
echo "user:password" | chroot "$ROOTFS" chpasswd
echo "root:password" | chroot "$ROOTFS" chpasswd
# Root access: post-buster su and sudo hang under CheerpX 1.3.0 — libxcrypt
# crypt() (password verification) and sudo's startup never return, and the
# stuck processes ignore signals. Plain setuid exec is fine (verified via
# ssh-keysign), so ship a minimal setuid wrapper as /usr/local/bin/sudo
# (ahead of /usr/bin/sudo in PATH). It skips option arguments and runs the
# command as root — same trust model as NOPASSWD sudo in a single-user VM.
printf 'Defaults !use_pty\nuser ALL=(ALL) NOPASSWD:ALL\n' > "$ROOTFS/etc/sudoers.d/user"
chmod 0440 "$ROOTFS/etc/sudoers.d/user"
cat > "$ROOTFS/tmp/webvm-sudo.c" <<'EOC'
/* Minimal sudo replacement for WebVM (see build-debian-image.sh). */
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
	int i = 1;
	while (i < argc && argv[i][0] == '-') {
		i++;
	}
	if (setgid(0) != 0 || setuid(0) != 0) {
		perror("webvm-sudo: setuid");
		return 1;
	}
	if (i < argc) {
		execvp(argv[i], argv + i);
		perror(argv[i]);
		return 127;
	}
	execl("/bin/bash", "bash", "-l", (char *)0);
	return 127;
}
EOC
chroot "$ROOTFS" gcc -O2 -o /usr/local/bin/sudo /tmp/webvm-sudo.c
chroot "$ROOTFS" chown root:root /usr/local/bin/sudo
chroot "$ROOTFS" chmod 4755 /usr/local/bin/sudo
rm -f "$ROOTFS/tmp/webvm-sudo.c"
# The default env advertises LANG=en_US.UTF-8; generate it to silence
# setlocale warnings on every shell start.
sed -i 's/^# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' "$ROOTFS/etc/locale.gen"
chroot "$ROOTFS" locale-gen
cp -r "$REPO_DIR/examples" "$ROOTFS/home/user/examples"
chroot "$ROOTFS" chown -R user:user /home/user/examples
chmod -R +x "$ROOTFS/home/user/examples/lua"

echo webvm > "$ROOTFS/etc/hostname"
printf '127.0.0.1\tlocalhost webvm\n::1\tlocalhost ip6-localhost ip6-loopback\n' > "$ROOTFS/etc/hosts"
# Same resolvers as the upstream image; DNS flows through the Tailscale tun.
printf 'nameserver 8.8.8.8\nnameserver 8.8.4.4\n' > "$ROOTFS/etc/resolv.conf"

# Unmount before the filesystem copy: the bind-mounted host /dev must not
# leak into the image.
umount "$ROOTFS/proc" "$ROOTFS/dev/pts" "$ROOTFS/dev"

# CheerpX provides its own virtual /dev; real char-device nodes in the image
# shadow it and block forever when opened (su/sudo hang on /dev/tty). The
# upstream Docker-exported image has no device nodes either (docker cp
# strips them) — just the mount-point dirs and an empty console file.
rm -rf "$ROOTFS/dev"
mkdir -p "$ROOTFS/dev/pts" "$ROOTFS/dev/shm"
touch "$ROOTFS/dev/console"

# Same ext2 parameters as the upstream buster image: revision 0, no
# features (CheerpX's ext2 driver requirement; upstream's `mkfs.ext2 -r 0`).
# mke2fs -d populates the image in userspace, needing no loop mount, and
# unlike a kernel-mounted copy it cannot end up storing xattrs (newer
# releases ship file capabilities on e.g. ping), which would silently
# upgrade the filesystem to revision 1 + ext_attr.
rm -f "$OUTPUT"
fallocate -l "$SIZE" "$OUTPUT"
mke2fs -q -t ext2 -E revision=0 -F -d "$ROOTFS" "$OUTPUT"

echo "built $OUTPUT ($(du -h "$OUTPUT" | cut -f1) allocated, $SIZE bytes)"
