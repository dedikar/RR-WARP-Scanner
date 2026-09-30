# Upstream record

- **Base:** https://github.com/vernette/warpscout (branch `master`) — active project
- **Forked through:** https://github.com/niklzz/warpscout-tg, commit `3ad3a643dc8410bc0724fd6dee6c9b4feb754afc`, 2026-09-03
- **License:** MIT (see `LICENSE`)

## What came from where

Verified by diffing this tree against `vernette/warpscout@master` on 2026-09-30. The
only files here that upstream does not have:

| File | Origin |
|---|---|
| `telegram.go` | the `warpscout-tg` fork — its one useful addition |
| `jsonout.go` (+ `_test.go`) | ours — machine-readable JSON report (`-json`) for the ubus backend |
| `progress.go` | ours — atomic progress file (`-progress`) the LuCI page polls |
| `timestamps.go` (+ `_test.go`) | ours — timestamps on engine log lines |

Everything else is upstream's, including `masque.go`, `findsni.go`, `findjunk.go`,
`nest.go`, `socks.go` and `tui.go`. Do not attribute those to the fork: they exist in
the base, and saying otherwise once led to the wrong conclusion that moving onto the
base would be expensive.

## Pending: move onto the base

`warpscout-tg` may be abandoned while `vernette/warpscout` keeps moving, which would
strand us on a dead branch. The move is measured, not estimated: copy the four files
above, repeat the edits listed below, build, run the acceptance test. Hours, not days
— the two trees are otherwise identical.

## Local changes

| File | Change |
|---|---|
| `jsonout.go` | **new** — machine-readable JSON report (`-json`) for the ubus backend |
| `progress.go` | **new** — atomic progress file (`-progress`) the LuCI page polls |
| `timestamps.go` | **new** — prefix every engine log line with a local timestamp |
| `flags.go` | `-json`, `-progress` flags; `-p` default now `defaultProto` |
| `main.go` | `runScanCmd`: JSON/progress wiring, `runScanUI`/`runWithUI` take a `*progressEmitter` |
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
