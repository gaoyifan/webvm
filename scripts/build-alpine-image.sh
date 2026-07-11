#!/usr/bin/env bash
# Builds a minimal Alpine Linux x86 terminal image for WebVM (no GUI).
#
# CheerpX 1.3.0: python3 execution breaks on Alpine 3.24+; pin 3.23.5
# (see docs/fork-changes.md §7.5). Package set mirrors dockerfiles/debian_mini.
#
# Usage: sudo scripts/build-alpine-image.sh [version] [output.ext2] [size]
#   version defaults to 3.23.5
set -euo pipefail

# A failed cleanup must never expose the host /dev bind mount to rm. A private
# mount namespace also prevents concurrent builds from propagating mounts into
# one another.
if [[ ${WEBVM_PRIVATE_MOUNT_NS_PID:-} != "$$" ]]; then
	exec unshare --mount --propagation private -- env WEBVM_PRIVATE_MOUNT_NS_PID="$$" "$0" "$@"
fi

VERSION=${1:-3.23.5}
OUTPUT=${2:-alpine_terminal_${VERSION}.ext2}
SIZE=${3:-800000000}
REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MAJOR=${VERSION%.*}
ROOTFS=$(mktemp -d /tmp/webvm-alpine-rootfs.XXXXXX)
MOUNTS=()
KEEP_ROOTFS=0
TARBALL="alpine-minirootfs-${VERSION}-x86.tar.gz"
URL="https://dl-cdn.alpinelinux.org/alpine/v${MAJOR}/releases/x86/${TARBALL}"

has_rootfs_mounts() {
	findmnt -rn -o TARGET | awk -v root="$ROOTFS" '
		$0 == root || index($0, root "/") == 1 { found = 1 }
		END { exit !found }
	'
}

cleanup() {
	local status=$?
	local i
	local target
	local unmount_failed=0
	local resolved
	trap - EXIT
	set +e
	for ((i = ${#MOUNTS[@]} - 1; i >= 0; i--)); do
		target=${MOUNTS[i]}
		if mountpoint -q "$target"; then
			if ! umount "$target"; then
				unmount_failed=1
			fi
		fi
	done
	if ((unmount_failed || KEEP_ROOTFS)) || has_rootfs_mounts; then
		printf 'refusing to remove %s: a chroot mount could not be safely removed\n' "$ROOTFS" >&2
		return 1
	fi
	resolved=$(realpath -e -- "$ROOTFS") || return 1
	case "$resolved" in
		/tmp/webvm-alpine-rootfs.*) ;;
		*)
			printf 'refusing to remove unexpected rootfs path: %s\n' "$resolved" >&2
			return 1
			;;
	esac
	rm -rf --one-file-system -- "$resolved"
	return "$status"
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
MOUNTS+=("$ROOTFS/dev")
mount -t devpts devpts "$ROOTFS/dev/pts"
MOUNTS+=("$ROOTFS/dev/pts")
mount -t proc proc "$ROOTFS/proc"
MOUNTS+=("$ROOTFS/proc")
mount --bind /sys "$ROOTFS/sys"
MOUNTS+=("$ROOTFS/sys")

# CLI-only set aligned with dockerfiles/debian_mini (no X11, no desktop).
PACKAGES=(
	bash ca-certificates curl gcc musl-dev less make nano vim openssl
	python3 nodejs ruby netcat-openbsd
)
chroot "$ROOTFS" /sbin/apk add --no-cache "${PACKAGES[@]}"
chroot "$ROOTFS" /sbin/apk add --no-cache luajit 2>/dev/null || echo "skipped: luajit"
rm -rf "$ROOTFS/var/cache/apk"/*

cat > "$ROOTFS/tmp/webvm-sudo.c" <<'EOC'
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

chroot "$ROOTFS" adduser -D -s /bin/bash user
echo "user:password" | chroot "$ROOTFS" chpasswd
echo "root:password" | chroot "$ROOTFS" chpasswd

cp -r "$REPO_DIR/examples" "$ROOTFS/home/user/examples"
chroot "$ROOTFS" chown -R user:user /home/user/examples
chmod -R +x "$ROOTFS/home/user/examples/lua" 2>/dev/null || true

echo webvm > "$ROOTFS/etc/hostname"
printf '127.0.0.1\tlocalhost webvm\n::1\tlocalhost ip6-localhost ip6-loopback\n' > "$ROOTFS/etc/hosts"
printf 'nameserver 8.8.8.8\nnameserver 8.8.4.4\n' > "$ROOTFS/etc/resolv.conf"

for ((i = ${#MOUNTS[@]} - 1; i >= 0; i--)); do
	if mountpoint -q "${MOUNTS[i]}" && ! umount "${MOUNTS[i]}"; then
		KEEP_ROOTFS=1
		exit 1
	fi
done
MOUNTS=()

if has_rootfs_mounts; then
	KEEP_ROOTFS=1
	printf 'refusing to replace %s/dev: a chroot mount is still present\n' "$ROOTFS" >&2
	exit 1
fi
rm -rf --one-file-system -- "${ROOTFS:?}/dev"
mkdir -p "$ROOTFS/dev/pts" "$ROOTFS/dev/shm"
touch "$ROOTFS/dev/console"

rm -f "$OUTPUT"
fallocate -l "$SIZE" "$OUTPUT"
mke2fs -q -t ext2 -E revision=0 -F -d "$ROOTFS" "$OUTPUT"

echo "built $OUTPUT ($(du -h "$OUTPUT" | cut -f1) allocated, $SIZE bytes, Alpine $VERSION)"
