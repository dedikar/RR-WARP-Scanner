# Upstream fork record

- **Source:** https://github.com/niklzz/warpscout-tg
- **Commit:** `3ad3a643dc8410bc0724fd6dee6c9b4feb754afc`
- **Commit date:** 2026-09-03
- **License:** MIT (see `LICENSE`)
- **Base project:** fork of https://github.com/vernette/warpscout

## Why this fork exists

The router build drives this engine from a LuCI page instead of a terminal, so the
changes are additive and deliberately small. Everything else stays upstream-shaped so
future upstream commits can be merged by hand.

## Local changes

| File | Change |
|---|---|
| `jsonout.go` | **new** — machine-readable JSON report (`-json`) for the ubus backend |
| `progress.go` | **new** — atomic progress file (`-progress`) the LuCI page polls |
| `flags.go` | `-json`, `-progress` flags; `-p` default now `defaultProto` |
| `main.go` | `runScanCmd`: JSON/progress wiring, `runScanUI`/`runWithUI` take a `*progressWriter` |
| `warp.go` | `defaultProto = protoAWG` (see comment there — measured, not stylistic) |

## The `-p awg` default

Upstream ships `-p wg` because it targets unrestricted hosts. On the router's network
plain WireGuard handshakes come up and then pass **no data** — DPI tears them down
mid-stream. Measured 2026-09-29 on the target router, same `/24`, same account:

| proto | working | torn | Telegram |
|---|---|---|---|
| `wg` | 5/12 | all, 90-100% loss | 0 with any DC |
| `awg` | **12/12** | none | **4 with 5/5 DCs** |

So `defaultProto` is `awg`. Reverting it would ship an app that finds nothing.

## Rebuilding this fork

The binary is cross-compiled in WSL, statically, with no cgo:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o rrws .
```

`build.sh` in the repository root does this and packs the result into the ipk/apk.
