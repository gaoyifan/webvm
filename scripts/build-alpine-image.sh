#!/usr/bin/env bash
# Builds an Alpine Linux x86 (i386) ext2 terminal image for WebVM.
#
# Starts from the official alpine-minirootfs tarball (no Docker), installs a
# mini package set similar to dockerfiles/debian_mini, and packs revision-0
# ext2 the same way as build-debian-image.sh.
#
# Usage: sudo scripts/build-alpine-image.sh <version> <output.ext2> [size]
#   version: e.g. 3.22.5 (must match a published minirootfs tag)
set -euo pipefail

VERSION=${1:?usage: build-alpine-image.sh <version> <output.ext2> [size bytes]}
OUTPUT=${2:?usage: build-alpine-image.sh <version> <output.ext2> [size bytes]}
SIZE=${3:-1200000000}
REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MAJOR=${VERSION%.*}  # 3.22.5 -> 3.22
ROOTFS=$(mktemp -d /tmp/webvm-alpine-rootfs.XXXXXX)
TARBALL="alpine-minirootfs-${VERSION}-x86.tar.gz"
URL="https://dl-cdn.alpinelinux.org/alpine/v${MAJOR}/releases/x86/${TARBALL}"

cleanup() {
	umount "$ROOTFS/sys" "$ROOTFS/proc" "$ROOTFS/dev/pts" "$ROOTFS/dev" 2>/dev/null || true
	rm -rf "$ROOTFS"
}
trap cleanup EXIT

curl -fsSL "$URL" | tar -xzf - -C "$ROOTFS"
chmod 0755 "$ROOTFS"

cat > "$ROOTFS/etc/apk/repositories" <<EOF
https://dl-cdn.alpinelinux.org/alpine/v${MAJOR}/main
https://dl-cdn.alpinelinux.org/alpine/v${MAJOR}/community
EOF
cp /etc/resolv.conf "$ROOTFS/etc/resolv.conf"

mount --bind /dev "$ROOTFS/dev"
mount -t devpts devpts "$ROOTFS/dev/pts"
mount -t proc proc "$ROOTFS/proc"
mount --bind /sys "$ROOTFS/sys"

PACKAGES=(
	bash ca-certificates curl gcc g++ git make nano vim less openssl
	python3 py3-pip nodejs ruby netcat-openbsd
)
BEST_EFFORT=(luajit lua5.4 cowsay)

chroot "$ROOTFS" /sbin/apk add --no-cache "${PACKAGES[@]}"
for pkg in "${BEST_EFFORT[@]}"; do
	chroot "$ROOTFS" /sbin/apk add --no-cache "$pkg" || echo "skipped unavailable package: $pkg"
done
chroot "$ROOTFS" /sbin/apk cache clean 2>/dev/null || rm -rf "$ROOTFS/var/cache/apk"/*

chroot "$ROOTFS" adduser -D -s /bin/bash user
echo "user:password" | chroot "$ROOTFS" chpasswd
echo "root:password" | chroot "$ROOTFS" chpasswd

# Same setuid sudo wrapper as the Debian images (musl su may still hang).
cat > "$ROOTFS/tmp/webvm-sudo.c" <<'EOC'
/* Minimal sudo replacement for WebVM (see build-alpine-image.sh). */
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

cp -r "$REPO_DIR/examples" "$ROOTFS/home/user/examples"
chroot "$ROOTFS" chown -R user:user /home/user/examples
chmod -R +x "$ROOTFS/home/user/examples/lua" 2>/dev/null || true

echo webvm > "$ROOTFS/etc/hostname"
printf '127.0.0.1\tlocalhost webvm\n::1\tlocalhost ip6-localhost ip6-loopback\n' > "$ROOTFS/etc/hosts"
printf 'nameserver 8.8.8.8\nnameserver 8.8.4.4\n' > "$ROOTFS/etc/resolv.conf"

umount "$ROOTFS/sys" "$ROOTFS/proc" "$ROOTFS/dev/pts" "$ROOTFS/dev"

rm -rf "$ROOTFS/dev"
mkdir -p "$ROOTFS/dev/pts" "$ROOTFS/dev/shm"
touch "$ROOTFS/dev/console"

rm -f "$OUTPUT"
fallocate -l "$SIZE" "$OUTPUT"
mke2fs -q -t ext2 -E revision=0 -F -d "$ROOTFS" "$OUTPUT"

echo "built $OUTPUT ($(du -h "$OUTPUT" | cut -f1) allocated, $SIZE bytes, Alpine $VERSION)"
