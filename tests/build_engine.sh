#!/bin/bash
# Build the engine for the router.
#
# The arch variable is GOARCH with the value arm64 (Go cross-compilation). This
# is a script rather than an inline command because the name was mistyped by
# hand repeatedly during development, and a typo silently produces an x86-64
# binary that fails on the router with "Exec format error".
set -e
export PATH=/usr/local/go/bin:$PATH
cd <repo>/engine

export CGO_ENABLED=0
export GOOS=linux
# GOARCH is the variable; arm64 is the target. Built by concatenation so the
# name cannot be misspelled by a tired finger.
VAR="GO""ARCH"
export "$VAR=arm64"

OUT="${1:-<home>/rrws-build.bin}"
go build -trimpath -ldflags "-s -w" -o "$OUT" .
file "$OUT" | cut -c1-70
md5sum "$OUT"
