#!/usr/bin/env bash
# Build luci-app-rrws.ipk (OpenWrt 24.10 / opkg) and/or .apk (25.12 / apk-tools).
#
# Unlike the previous shell-only package, this one carries a compiled Go binary,
# so the build has three stages:
#   1. cross-compile engine/ to a static linux/arm64 binary (needs Go in WSL)
#   2. stage the package tree (root/ -> /, htdocs/ -> /www)
#   3. pack the archive(s)
#
# Run from WSL:  ./build.sh [version] [ipk|apk|both]
#
# The .ipk format for opkg >= 0.4 is a single gzip tar holding
#   ./debian-binary ./control.tar.gz ./data.tar.gz
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT_DIR/luci-app-rrws"
ENGINE="$ROOT_DIR/engine"
STATE="$ROOT_DIR/version.txt"
PKG_NAME="luci-app-rrws"
GO_BIN="rrws"
# OpenWrt target: RouteRich is mediatek/filogic, aarch64_cortex-a53.
GOARCH_TARGET="arm64"

# Go is not always on PATH in a bare WSL shell, and WSL interop puts the Windows
if [ -x /usr/local/go/bin/go ]; then
	PATH="/usr/local/go/bin:$PATH"
	export PATH
fi

# Version scheme: x.y.z-rN, N in 1..99; after r99 bump x.y.z and reset to r1.
next_version() {
	local cur="$1" base r a b c
	if [ -z "$cur" ]; then echo "0.3.1-r3"; return; fi
	base="${cur%-r*}"
	r="${cur##*-r}"
	if [ "$r" -lt 99 ] 2>/dev/null; then
		echo "${base}-r$((r+1))"
	else
		IFS='.' read -r a b c <<< "$base"
		echo "${a}.${b}.$((c+1))-r1"
	fi
}

# Argument handling: the format may be given on its own (./build.sh ipk) or with
# a version (./build.sh 0.3.1-r3 ipk). Treating a lone "ipk" as the version
# produced "luci-app-rrws_ipk_all.ipk", so the format is detected first.
if [ -n "${1:-}" ]; then
	case "$1" in
		ipk|apk|both) FMT="$1"; VERSION="" ;;
		*)            FMT="${2:-ipk}"; VERSION="$1" ;;
	esac
else
	FMT="ipk"; VERSION=""
fi
if [ -z "$VERSION" ]; then
	PREV=""
	[ -f "$STATE" ] && PREV=$(cat "$STATE")
	VERSION=$(next_version "$PREV")
fi
case "$FMT" in ipk|apk|both) ;; *) echo "bad format: $FMT (ipk|apk|both)" >&2; exit 1;; esac

echo "==> building $PKG_NAME $VERSION ($FMT)"

# ---------------------------------------------------------------- 1. engine --
if ! command -v go >/dev/null 2>&1; then
	echo "ERROR: go not found. Run this script inside WSL (Go at /usr/local/go/bin)." >&2
	exit 1
fi

# Refuse a Windows toolchain outright: it produces a binary that traps on the
# router, and the failure is silent at build time.
GO_BIN_PATH=$(command -v go)
case "$GO_BIN_PATH" in
	/mnt/*|*.exe)
		echo "ERROR: resolved '$GO_BIN_PATH' - that is the Windows Go toolchain." >&2
		echo "       It cross-compiles but the result dies with SIGILL on this router." >&2
		echo "       Run with the Linux toolchain first on PATH:" >&2
		echo "         PATH=/usr/local/go/bin:\$PATH ./build.sh $VERSION $FMT" >&2
		exit 1
		;;
esac
echo "    toolchain: $("$GO_BIN_PATH" version) at $GO_BIN_PATH"

# Source files arrive from a Windows mount with CRLF and 0777; a CRLF in a Go
# file is a syntax error at the very first line.
find "$ENGINE" -name '*.go' -type f -exec sed -i 's/\r$//' {} +

BIN_PATH="$ROOT_DIR/build/$GO_BIN-$GOARCH_TARGET"
mkdir -p "$ROOT_DIR/build"
echo "    cross-compiling engine -> linux/$GOARCH_TARGET (static, no cgo)"
(
	cd "$ENGINE"
	CGO_ENABLED=0 GOOS=linux GOARCH=$GOARCH_TARGET GOARM64=v8.0 \
		go build -trimpath -ldflags "-s -w -X main.version=$VERSION" \
		-o "$BIN_PATH" .
)

BIN_SIZE=$(stat -c%s "$BIN_PATH")
echo "    binary: $BIN_SIZE bytes ($((BIN_SIZE / 1024 / 1024)) MB)"
# ELF sanity: the trap that motivated this check is a binary that builds and
# links cleanly yet dies on the router. Flagging the file type here makes a
# wrong-toolchain build obvious in the log.
if command -v file >/dev/null 2>&1; then
	echo "    type: $(file -b "$BIN_PATH")"
fi

# ---------------------------------------------------------- 1b. pack (UPX) ---
#
# UPX runs HERE, on the plain binary, and not on the finished .ipk: the ipk is a
# gzip tar, and gzipping an already-gzipped payload saves nothing. Measured on
# the r23 build: 12,648,610 -> 3,251,756 bytes packed, and after the archive's
# own gzip the engine went 4,698,789 -> 3,251,243 - about 1.4 MB off a 4.8 MB
# download.
#
# --lzma over the default: it is the smaller of the two on this binary and the
# unpack cost lands on a 2-core router, where a scan takes minutes anyway.
#
# A packed binary must still be proven to run, not just to build: UPX injects a
# decompressor that executes before main(), and a bad pack fails at runtime. This
# build was verified on the target router with a full scan through userspace
# tunnels (12/12 endpoints, Telegram probed, no panic), so the risk here is a
# future UPX release rather than this one.
#
# UPX is optional: without it the build still works and just ships the fatter
# binary. Set NO_UPX=1 to skip it deliberately.
if [ "${NO_UPX:-0}" = "1" ]; then
	echo "    upx: skipped (NO_UPX=1)"
elif command -v upx >/dev/null 2>&1; then
	BIN_PLAIN="$BIN_PATH.plain"
	if mv "$BIN_PATH" "$BIN_PLAIN" && upx --best --lzma -q -o "$BIN_PATH" "$BIN_PLAIN"; then
		PACKED_SIZE=$(stat -c%s "$BIN_PATH")
		echo "    upx: $BIN_SIZE -> $PACKED_SIZE bytes ($((BIN_SIZE / 1024 / 1024)) -> $((PACKED_SIZE / 1024 / 1024)) MB)"
		rm -f "$BIN_PLAIN"
		BIN_SIZE="$PACKED_SIZE"
	else
		# A failed pack must not leave a half-written binary in place: restore
		# the working one and continue unpacked.
		echo "WARNING: upx failed - shipping the unpacked binary" >&2
		mv -f "$BIN_PLAIN" "$BIN_PATH"
	fi
else
	echo "    upx: not installed - shipping the unpacked binary (apt install upx-ucl)"
fi

# The router has ~46 MB free on /overlay; a binary past this budget will not fit
# comfortably alongside the rest of the system.
if [ "$BIN_SIZE" -gt 26214400 ]; then
	echo "WARNING: binary exceeds the 25 MB budget - check /overlay free space" >&2
fi

# ------------------------------------------------------------- 2. package ----
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cp -a "$SRC/root/." "$WORK/pkg/"
mkdir -p "$WORK/pkg/www"
cp -a "$SRC/htdocs/." "$WORK/pkg/www/"

# The compiled engine lands in /usr/bin next to the LuCI helper scripts. It is
# installed AFTER the CRLF pass below so that sed never touches it - see there.
mkdir -p "$WORK/pkg/usr/bin"

# Strip CRLF from the shipped TEXT files only. The binary must never go through
# sed: an ELF carries arbitrary 0x0D bytes, sed deletes each of them, and the
# result is a file 279 bytes short that traps with SIGILL on the router while
# still looking like a valid, correctly sized build. That cost an afternoon.
find "$WORK/pkg" -type f \( -name '*.sh' -o -name '*.ucode' -o -name '*.js' -o -name '*.json' \) \
	-exec sed -i 's/\r$//' {} \+ 2>/dev/null || true

install -m 755 "$BIN_PATH" "$WORK/pkg/usr/bin/$GO_BIN"

find "$WORK/pkg" -type d -exec chmod 755 {} +
find "$WORK/pkg" -type f -exec chmod 644 {} +
# rpcd silently ignores a world-writable ucode file, so these are explicit:
[ -f "$WORK/pkg/usr/share/rpcd/ucode/luci.rrws" ] && chmod 644 "$WORK/pkg/usr/share/rpcd/ucode/luci.rrws"
[ -f "$WORK/pkg/usr/bin/$GO_BIN" ] && chmod 755 "$WORK/pkg/usr/bin/$GO_BIN"
find "$WORK/pkg/usr/bin" -name '*.sh' -exec chmod 755 {} + 2>/dev/null || true
[ -f "$WORK/pkg/etc/uci-defaults/99_rrws" ] && chmod 755 "$WORK/pkg/etc/uci-defaults/99_rrws"

# every installable path relative to the package root, for Installed-Size
INSTALLED_KB=$(( $(du -sk "$WORK/pkg" | cut -f1) ))
INSTALLED_SIZE=$(( INSTALLED_KB * 1024 ))

# The engine is userspace-only (gVisor netstack), so the kernel module and the
# awg tools the old package pulled in are gone. curl/jq are gone too - the JSON
# path replaced them.
DEPENDS="libc, ca-certificates, luci-base, rpcd-mod-ucode"

DESC="RR WARP Scanner (luci-app-rrws). Scans Cloudflare WARP endpoints from the router using a userspace AmneziaWG engine, ranks them by latency and real Telegram reachability, and imports the best into a WARP interface. LuCI page under Services -> RR WARP Scanner."

# ---------------------------------------------------------------- 3. ipk -----
build_ipk() {
	local OUT="$ROOT_DIR/build/${PKG_NAME}_${VERSION}_all.ipk"
	tar -czf "$WORK/data.tar.gz" --owner=0 --group=0 --numeric-owner -C "$WORK/pkg" .

	cat > "$WORK/control" <<EOF
Package: ${PKG_NAME}
Version: ${VERSION}
Depends: ${DEPENDS}
Section: luci
Priority: optional
Maintainer: RRWS <dev@route-rich.local>
Architecture: all
Installed-Size: ${INSTALLED_SIZE}
Description: ${DESC}
EOF

	# rpcd reload (SIGHUP -> exec_self) re-scans /usr/share/rpcd/ucode/ and keeps
	# LuCI sessions alive, unlike restart which drops them.
	cat > "$WORK/postinst" <<'EOF'
#!/bin/sh
[ -n "$IPKG_INSTROOT" ] && exit 0
[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd reload 2>/dev/null
rm -f /tmp/luci-indexcache* 2>/dev/null
rm -rf /tmp/luci-modulecache 2>/dev/null

# Architecture self-check, logged where a person will actually look on a foreign
# router (logread). The package is mostly scripts and is therefore marked "all",
# while the engine it carries is an aarch64 binary: on any other CPU the install
# succeeds, the file lands, and the engine dies with "Exec format error" at the
# first scan - which looks exactly like "the package does nothing".
ARCH_LOCAL=$(sed -n "s/^DISTRIB_ARCH='\(.*\)'/\1/p" /etc/openwrt_release 2>/dev/null)
ENGINE_WORKS=no
if [ -x /usr/bin/rrws ]; then
	/usr/bin/rrws version >/dev/null 2>&1 && ENGINE_WORKS=yes
fi
logger -t rrws "installed: router arch ${ARCH_LOCAL:-unknown}, engine runs: $ENGINE_WORKS"
if [ "$ENGINE_WORKS" != yes ]; then
	logger -t rrws "WARNING: engine does not run on this architecture; package built for aarch64_cortex-a53"
	logger -t rrws "  check manually: /usr/bin/rrws version"
	logger -t rrws "  free on /overlay: $(df -h /overlay 2>/dev/null | tail -1)"
fi
exit 0
EOF
	chmod 755 "$WORK/postinst"

	cat > "$WORK/prerm" <<'EOF'
#!/bin/sh
[ -n "$IPKG_INSTROOT" ] && exit 0
# Leave no scan process behind: a running engine holds a tunnel open and keeps
# the binary busy, which makes the file busy on removal.
if [ -x /usr/bin/rrws ]; then
	[ -f /tmp/rrws/pid ] && kill -TERM "$(cat /tmp/rrws/pid 2>/dev/null)" 2>/dev/null
	killall rrws 2>/dev/null
fi
rm -f /tmp/rrws/pid /tmp/rrws/progress
exit 0
EOF
	chmod 755 "$WORK/prerm"

	tar -czf "$WORK/control.tar.gz" --owner=0 --group=0 --numeric-owner -C "$WORK" control postinst prerm
	printf '2.0\n' > "$WORK/debian-binary"
	tar -czf "$OUT" --owner=0 --group=0 --numeric-owner -C "$WORK" debian-binary data.tar.gz control.tar.gz
	echo "BUILT: $OUT"
	ls -la "$OUT"
}

# ---------------------------------------------------------------- 3. apk -----
build_apk() {
	local APK_BIN="${APK_BIN:-apk}" OUT="$ROOT_DIR/build/${PKG_NAME}-${VERSION}.apk"
	if ! command -v "$APK_BIN" >/dev/null 2>&1; then
		echo "apk-tools (apk) not found - skipping .apk" >&2
		return 0
	fi
	local SCRIPTS="$WORK/apkscripts"
	mkdir -p "$SCRIPTS"
	cat > "$SCRIPTS/post-install" <<'EOF'
#!/bin/sh
[ -n "$IPKG_INSTROOT" ] && exit 0
[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd reload 2>/dev/null
rm -f /tmp/luci-indexcache* 2>/dev/null
rm -rf /tmp/luci-modulecache 2>/dev/null
exit 0
EOF
	cat > "$SCRIPTS/pre-deinstall" <<'EOF'
#!/bin/sh
killall rrws 2>/dev/null
rm -f /tmp/rrws/pid /tmp/rrws/progress
exit 0
EOF
	chmod 755 "$SCRIPTS/post-install" "$SCRIPTS/pre-deinstall"

	"$APK_BIN" mkpkg \
		--info "name:${PKG_NAME}" \
		--info "version:${VERSION}" \
		--info "arch:noarch" \
		--info "description:${DESC}" \
		--info "license:Apache-2.0" \
		--info "origin:${PKG_NAME}" \
		--info "build-time:$(date +%s)" \
		--info "depends:libc" \
		--info "depends:ca-certificates" \
		--info "depends:luci-base" \
		--info "depends:rpcd-mod-ucode" \
		--script "post-install:$SCRIPTS/post-install" \
		--script "pre-deinstall:$SCRIPTS/pre-deinstall" \
		--files "$WORK/pkg" \
		--output "$OUT"
	echo "BUILT: $OUT"
	ls -la "$OUT"
}

case "$FMT" in
	ipk)  build_ipk;;
	apk)  build_apk;;
	both) build_ipk; build_apk;;
esac

printf '%s\n' "$VERSION" > "$STATE"
echo "==> done: $VERSION"
