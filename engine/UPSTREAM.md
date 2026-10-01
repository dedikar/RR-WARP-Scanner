# Upstream record

- **Base:** https://github.com/vernette/warpscout (branch `master`) - **this is now the base**
- **Telegram from:** https://github.com/niklzz/warpscout-tg - one file, `telegram.go`
- **License:** MIT (see `LICENSE`)

## Moved onto the base (2026-09-30)

The tree was rebuilt from `vernette/warpscout@master` instead of the `-tg` fork. The
fork may be abandoned while the base keeps moving, and a fork that cannot be merged
from is a dead end: new upstream features would never reach this package.

The move was cheap because the two trees barely differ. Carried over:

| File | Origin |
|---|---|
| `telegram.go` | the `-tg` fork - its one useful addition |
| `jsonout.go` (+ test) | ours - JSON report (`-json`) for the ubus backend |
| `progress.go` | ours - progress file (`-progress`) the LuCI page polls |
| `timestamps.go` (+ test) | ours - timestamps on every engine log line |

And these edits, each carrying a comment at the site:

| File | Change |
|---|---|
| `warp.go` | `defaultProto = protoAWG` - measured, see below |
| `flags.go` | `-json`, `-progress`, `-speed-top`, `-tg`, `-tg-only`; `-tg-only` implies `-tg` |
| `report.go` | Telegram fields on `endpointResult`; Telegram outranks loss/ping in `lessByLossRTT`; `filterByTelegram`; the TG column helpers |
| `main.go` | progress emitter wiring; JSON emitted AFTER the speed phase (**the rebase to the base lost that ordering once - the comment stayed, the code did not; restored in r57 after the UI shipped zero speeds**); Telegram probe in the scan loop; `-tg-only` in `filtered()` and `applyFilters()`; `tgSort` |
| `tui.go` | the TG column in the live feed |
| `findjunk.go`, `findsni.go` | pass `nil` for the new progress emitter argument |
| `register.go` | parallel I1 candidates under one shared budget (first wins, losers cancelled, config globals touched only under a build lock); plain WG dropped from the registration chain (handshakes pass, DPI tears the data); `relayTimeout` 45s -> 15s |

**What the move bought:** `-sweep-ports`, `-ping-target`, `-best-by` and mihomo config
output, all of which the base had gained since the fork was taken.

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
