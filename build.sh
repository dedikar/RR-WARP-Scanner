#!/usr/bin/env bash
# Build luci-app-warpscan.ipk on Ubuntu/Debian.
#
# The .ipk format for OpenWrt 24.10+ (opkg >= 0.4):
#   single gzip-compressed tar containing:
#     ./debian-binary   ("2.0")
#     ./data.tar.gz     (installed files + dirs)
#     ./control.tar.gz  (./control metadata)
#
# No SDK required - this package is pure scripts/JS (PKGARCH=all).
# Requires: tar, gzip (standard on Ubuntu).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT_DIR/root"
STATE="$ROOT_DIR/version.txt"

# Version scheme: x.y.z-rN, N in 1..99; after r99 bump x.y.z by one and reset to r1.
# ./build.sh            -> auto-increment from version.txt (or start 0.2.0-r1)
# ./build.sh 0.2.5-r12  -> exact version
next_version() {
	local cur="$1" base r a b c
	if [ -z "$cur" ]; then echo "0.2.0-r1"; return; fi
	base="${cur%-r*}"
	r="${cur##*-r}"
	if [ "$r" -lt 99 ] 2>/dev/null; then
		echo "${base}-r$((r+1))"
	else
		IFS='.' read -r a b c <<< "$base"
		echo "${a}.${b}.$((c+1))-r1"
	fi
}

if [ -n "${1:-}" ]; then
	VERSION="$1"
else
	PREV=""
	[ -f "$STATE" ] && PREV=$(cat "$STATE")
	VERSION=$(next_version "$PREV")
fi
PKG="luci-app-warpscan_${VERSION}_all.ipk"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# --- data.tar.gz --------------------------------------------------------
cp -a "$SRC/." "$WORK/pkg/"

# enforce tidy permissions regardless of source filesystem mounts
find "$WORK/pkg" -type f -exec chmod 644 {} +
chmod 755 "$WORK/pkg/usr/libexec/warpscan/"*.sh

tar -czf "$WORK/data.tar.gz" \
	--owner=0 --group=0 \
	-C "$WORK/pkg" .

# --- control.tar.gz ------------------------------------------------------
cat > "$WORK/control" <<EOF
Package: luci-app-warpscan
Version: ${VERSION}
Depends: amneziawg-tools, jq, curl, luci-base, rpcd-mod-ucode
Section: luci
Priority: optional
Maintainer: Warpscan <dev@example.org>
Architecture: all
Installed-Size: 20
Description: WARP endpoint scanner for AmneziaWG. Scan Cloudflare WARP endpoints via kernel AmneziaWG, pick the best and import it into the warp interface. LuCI page under Network -> WARP Scanner.
EOF
tar -czf "$WORK/control.tar.gz" \
	--owner=0 --group=0 \
	-C "$WORK" control

# --- outer archive (debian-binary + data + control) ---------------------
printf '2.0\n' > "$WORK/debian-binary"

mkdir -p "$ROOT_DIR/build"
tar -czf "$ROOT_DIR/build/$PKG" \
	--owner=0 --group=0 \
	-C "$WORK" debian-binary data.tar.gz control.tar.gz

printf '%s\n' "$VERSION" > "$STATE"
echo "Built: build/$PKG"
