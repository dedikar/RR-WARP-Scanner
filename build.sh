#!/usr/bin/env bash
# Build luci-app-rrws.ipk on Ubuntu/Debian.
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
FMT="${2:-ipk}"   # ipk (opkg/24.x) | apk (apk-tools/25.x) | both
case "$FMT" in ipk|apk|both) ;; *) echo "bad format: $FMT (ipk|apk|both)" >&2; exit 1;; esac
PKG="luci-app-rrws_${VERSION}_all.ipk"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# --- data.tar.gz --------------------------------------------------------
cp -a "$SRC/." "$WORK/pkg/"

# enforce tidy permissions regardless of source filesystem mounts
find "$WORK/pkg" -type f -exec chmod 644 {} +
chmod 755 "$WORK/pkg/usr/bin/"*.sh

# --- .ipk (opkg / OpenWrt 24.x) -----------------------------------------
build_ipk() {
	PKG="luci-app-rrws_${VERSION}_all.ipk"
	tar -czf "$WORK/data.tar.gz" \
		--owner=0 --group=0 \
		-C "$WORK/pkg" .

	cat > "$WORK/control" <<EOF
Package: luci-app-rrws
Version: ${VERSION}
Depends: amneziawg-tools, kmod-amneziawg, jq, curl, luci-base, rpcd-mod-ucode
Section: luci
Priority: optional
Maintainer: RRWS <dev@route-rich.local>
Architecture: all
Installed-Size: 20
Description: RR WARP Scanner (luci-app-rrws) for AmneziaWG. Scan Cloudflare WARP endpoints via kernel AmneziaWG, pick the best and import it into the warp interface. LuCI page under Services -> RR WARP Scanner.
EOF
	# postinst: rpcd must pick up the new ucode object. reload (SIGHUP ->
	# exec_self) re-scans /usr/share/rpcd/ucode/ AND keeps LuCI sessions alive,
	# unlike restart which drops them. Verified on live router (0.2.2).
	cat > "$WORK/postinst" <<'EOF'
#!/bin/sh
[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd reload 2>/dev/null
rm -f /tmp/luci-indexcache* /tmp/luci-modulecache 2>/dev/null
exit 0
EOF
	chmod 755 "$WORK/postinst"
	tar -czf "$WORK/control.tar.gz" \
		--owner=0 --group=0 \
		-C "$WORK" control postinst

	printf '2.0\n' > "$WORK/debian-binary"
	mkdir -p "$ROOT_DIR/build"
	tar -czf "$ROOT_DIR/build/$PKG" \
		--owner=0 --group=0 \
		-C "$WORK" debian-binary data.tar.gz control.tar.gz
	echo "Built: build/$PKG"
}

# --- .apk (apk-tools / OpenWrt 25.12+) ----------------------------------
build_apk() {
	APK_BIN="${APK_BIN:-apk}"
	if ! command -v "$APK_BIN" >/dev/null 2>&1; then
		echo "apk-tools (apk) not found - cannot build .apk" >&2
		exit 1
	fi
	PKG="luci-app-rrws-${VERSION}.apk"
	mkdir -p "$ROOT_DIR/build"
	# post-install script lives OUTSIDE --files tree so it won't be installed
	# as a regular file. reload re-scans ucode and keeps LuCI sessions (unlike
	# restart which drops them).
	APK_SCRIPTS="$WORK/apkscripts"
	mkdir -p "$APK_SCRIPTS"
	cat > "$APK_SCRIPTS/post-install" <<'EOF'
#!/bin/sh
[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd reload 2>/dev/null
rm -f /tmp/luci-indexcache* /tmp/luci-modulecache 2>/dev/null
exit 0
EOF
	# noarch: OpenWrt 25.x architecture for arch-independent packages
	# (ipk used "all"; apk-tools on 25.12 expects "noarch")
	"$APK_BIN" mkpkg \
		--info "name:luci-app-rrws" \
		--info "version:${VERSION}" \
		--info "description:RR WARP Scanner (luci-app-rrws) for AmneziaWG. Scan Cloudflare WARP endpoints via kernel AmneziaWG, pick the best and import it into the warp interface. LuCI page under Services -> RR WARP Scanner." \
		--info "arch:noarch" \
		--info "license:MIT" \
		--info "origin:luci-app-rrws" \
		--info "maintainer:RRWS <dev@routrich.local>" \
		--info "build-time:$(date +%s)" \
		--info "depends:amneziawg-tools" \
		--info "depends:kmod-amneziawg" \
		--info "depends:jq" \
		--info "depends:curl" \
		--info "depends:luci-base" \
		--info "depends:rpcd-mod-ucode" \
		--script "post-install:$APK_SCRIPTS/post-install" \
		--files "$WORK/pkg" \
		--output "$ROOT_DIR/build/$PKG"
	echo "Built: build/$PKG"
}

case "$FMT" in
	ipk)  build_ipk;;
	apk)  build_apk;;
	both) build_ipk; build_apk;;
esac

printf '%s\n' "$VERSION" > "$STATE"
