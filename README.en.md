# RR WARP Scanner (luci-app-rrws)

LuCI application for RouteRich routers that scans Cloudflare WARP endpoints
through kernel [AmneziaWG](https://github.com/amnezia-vpn/amneziawg-linux-kernel-module), finds
the fastest ones and produces ready-made `.conf` files for import into a
WARP client.

Scanning runs **right on the router**: a real handshake to every endpoint,
honest ICMP ping, in-tunnel check (TUN PING / LOSS) and "torn down" endpoint
detection. No external computer needed.

The project is a rework of [warpscout](https://github.com/vernette/warpscout)
for RouteRich routers and the LuCI web interface.

## Screenshot

![RR WARP Scanner — interface](.github/assets/rrws-scan.png)

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Discovery Mode](#discovery-mode-smart-port-search)
- [How the scan works](#how-the-scan-works)
- [Result format](#result-format)
- [Files](#files)
- [Building](#building)
- [Limitations and notes](#limitations-and-notes)
- [License](#license)

## Features

- **Two-phase scan** — quick handshake probing (`phase 1`), then an honest
  latency and tunnel check for the survivors (`phase 2`).
- **Parallelism** — up to 50 workers (`wgscan0..N-1`), each with its own
  tunnel, splitting the host list round-robin.
- **Honest ping** — latency to an endpoint is measured by ICMP RTT to the
  host, not through the tunnel/curl.
- **TUN PING / LOSS** — ICMP packet inside the tunnel (to 1.1.1.1) for every
  endpoint: latency, loss and "torn down" detection (DPI cut the tunnel
  mid-burst). Such endpoints are shown but never picked as best.
- **Flexible scan size** — the "Hosts" field from 1 to 4318 (the whole pool):
  quick runs on a few dozen hosts or a full sweep of every subnet.
- **Subnet exclusion** — checkboxes to skip any of the 17 WARP pool subnets
  (e.g. ones that are known dead or unwanted).
- **DME node exclusion** — “Exclude DME node (Moscow)” removes all endpoints
  landing on the Moscow edge node (filtered by DPI inside RU).
- **Smart port-discovery** (optional) — adapts to UDP filtering of the network.
- **WARP account management** — register, re-register, delete right from the
  UI; the account lives in `/etc/rrws-account.json` and survives reboot.
- **Monotonic progress bar**, scan date, persistent results
  (`/etc/rrws-last-result.txt`).
- **Speed test** — `download/upload` via `wgspeed` (`172.16.7.200`,
  obfuscated tunnel `setconf` + `table 102`/`rule prio 98`) over top-N
  working endpoints (`speed.cloudflare.com` with `--resolve` real IP).
- **Backup with standard tools** — the account, settings and last result
  (`/etc/rrws-account.json`, `/etc/rrws-settings.json`,
  `/etc/rrws-last-result.txt`) are included in OpenWrt's regular backup
  (sysupgrade / LuCI Backup) via `/lib/upgrade/keep.d/luci-app-rrws`, so the
  package works with the previous account after a firmware restore.
- **Ready `.conf`** — copy or view the AmneziaWG config for every found
  endpoint, with `Jc/Jmin/Jmax/H1-4/I1` obfuscation.

## Requirements

A RouteRich router running OpenWrt 24.10+ with AmneziaWG support. Package
dependencies:

- `amneziawg-tools`, `kmod-amneziawg`
- `jq`, `curl`
- `luci-base`, `rpcd-mod-ucode`

Installing via `opkg` pulls them in automatically if an AmneziaWG package
repository is configured on the system.

## Installation

Build the package (see "Building") and install it:

```sh
opkg install luci-app-rrws_0.2.1-r39_all.ipk
```

Or via LuCI: **System → Software → Upload Package**.

After installation refresh the page with cache clearing (Ctrl+Shift+R). The
app appears under **Services → RR WARP Scanner**.

## Usage

### Account management

A WARP key is required to scan. If there is no account yet, click
**"Register WARP"**: the script creates it on its own, and if the Cloudflare
API is blocked it tries to reach it through a temporary tunnel, and on
failure — through a local HTTP proxy (the `opera-proxy` package, installed
from RouteRich feeds). "Re-register" (fresh keys) and "Delete account" are
also available.

### Scan parameters

- **Hosts** (whole pool: 4318) — how many endpoints to check.
- **Timeout (sec)** (1–10) — handshake wait per port.
- **Workers** (1–50) — parallel workers.
- **Discovery Mode** + **Probe hosts** — see below.

### Buttons

- **Find tunnels** — start a scan with the selected parameters.
- **Stop** — abort the current scan.
- **Download all .txt** — save all results.
- **Copy .conf / Show .conf** — on every table row: a ready AmneziaWG config
  for that endpoint. Keys, `Address` and obfuscation parameters come from the
  account/`network.warp` interface.

During a scan the buttons are locked and the progress bar is monotonic. The
result is sorted by ping, best first; "torn down" endpoints go last.

## Discovery Mode (smart port search)

The **"Enable Discovery Mode"** option in the UI (the `-D` flag of wscan.sh,
the `discover:1` parameter of scanStart). Before the main scan it checks which
UDP ports the network lets through, so blocked ports are not swept on every
host.

How it works (`discover_ports()` in wscan.sh), on the temporary `wgprobe`
interface:

1. **Fast-path**: the first `N` endpoints of the list are probed on port
   `2408` (primary). If any responds — the network passes UDP, ports stay,
   ~2 sec spent.
2. **Slow-path** (2408 blocked): on the same probe hosts `1701 → 4500 → 500`
   are tried, then, if all are dead, 53 more ports. Working ports found are
   substituted into the scan; blocked ones are not re-checked.

**Probe hosts** (1–10, default 2) — how many endpoints take part in port
probing before the main scan. More is more reliable but slower: every probe
host that does not answer on 2408 runs through the port sweep (up to 53
probes). Fewer (1–2) is faster, but if the first hosts of the list are dead
you can wrongly conclude a port is closed.

Discovery Mode is off by default — the scan behaves as before with the fixed
port list `2408 1701 4500 500`.

## How the scan works

```
scanStart (rpcd/ucode)
  └─ wscan.sh -n N -t T -j J [-f] [-D [-P N]]
       ├─ generate host list (subnet interleaving, full/fast)
       ├─ [discover_ports()]  — port picking
       ├─ worker wgscan0..J-1, each:
       │    phase 1: handshake-sweep over $PORTS → alive-file
       │    phase 2: host_rtt (ICMP) + honest handshake + trace_meta
       │             + tun_probe (TUN PING / LOSS / torn) → wscan_result.txt
       └─ sorting: working by rtt ascending, torn last
scanStatus (polling UI) ← /tmp/wscan/progress
scanResult (UI) ← /tmp/wscan_result.txt (or the saved one when absent)
```

The tunnel exit is captured via `curl https://1.1.1.1/cdn-cgi/trace` inside
the tunnel — the `colo|loc` fields (exit node/country).

## Node (NODE) vs country (COUNTRY)

Each endpoint carries two fields that are easy to confuse:

- **NODE** — the Cloudflare edge node you connect to (the entry point,
  airport code: DME=Moscow, WAW=Warsaw, AMS=Amsterdam, FRA=Frankfurt,
  ARN=Stockholm). It depends on where the endpoint routes from your network.
- **COUNTRY (SEEN AS)** — the country external sites see your traffic coming
  from (the WARP exit). It is set by WARP account routing, **not** by the
  entry node.

**You can connect to Warsaw (WAW) and still "exit" from Russia.** The entry
node and the exit country are different things: the tunnel can enter Warsaw
while Cloudflare routes the traffic out through a Russian node. So "I picked a
WAW RU config and sites still see me as RU" is normal, not a bug.

Then why exclude DME? The entry node affects **DPI filtering**: traffic through
the Moscow node (DME) is filtered inside Russia (some sites do not load), while
foreign nodes (WAW/AMS/FRA/ARN) are not — even when the exit country is still
RU. The "Exclude DME node" option removes that filtered Moscow node so the
endpoints load reliably.

If the goal is for sites to see **not RU**, choosing an endpoint/node will not
help: you need a different entry point (e.g. a VPS abroad).

## Result format

`ip:port  NODE  COUNTRY  rtt  tun_rtt  tun_loss  torn`

Example line:

```
162.159.192.142:2408  AMS  NL  23.1  18.4  0  0
```

| Field | Meaning |
|---|---|
| `ip:port` | endpoint |
| `NODE` | exit node (colo) |
| `COUNTRY` | exit country (loc) |
| `rtt` | ICMP RTT to the endpoint, ms |
| `tun_rtt` | in-tunnel latency (TUN PING), ms |
| `tun_loss` | in-tunnel loss, % |
| `torn` | `1` = tunnel torn down by DPI (never picked as best) |

## Files

### Package (`root/`)

- `root/usr/bin/wscan.sh` — scanner (workers, phases, discovery)
- `root/usr/bin/wregister.sh` — account register/re-register
- `root/usr/bin/wsspeed.sh` — speed test (obfuscated tunnel)
- `root/usr/share/rpcd/ucode/luci.rrws` — rpcd backend (scanStart/Status/Result, account, settings)
- `root/usr/share/rpcd/acl.d/luci-app-rrws.json` — ACL for ubus methods
- `root/usr/share/luci/menu.d/rrws.json` — LuCI menu entry
- `root/www/luci-static/resources/view/rrws/scan.js` — frontend

### On the router (runtime)

- `/etc/rrws-account.json` — WARP account (survives reboot)
- `/etc/rrws-settings.json` — saved UI settings
- `/etc/rrws-last-result.txt` — last result (for history)
- `/tmp/wscan_result.txt` — fresh scan result
- `/tmp/wscan.log`, `/tmp/rrws.rpc.log` — logs
- `/tmp/wscan/` — working files (hosts, alive, progress, percent)

## Building

Version scheme: `x.y.z-rN` (r1..r99 → then bump z, reset r1).

```sh
# plain build.sh — auto-increment version from version.txt
./build.sh

# or an exact version
./build.sh 0.2.1-r39

# result: build/luci-app-rrws_0.2.1-r39_all.ipk
```

`build.sh` runs on Ubuntu/Debian, no SDK needed — the package is
pure-scripted (`PKGARCH=all`). The ipk is built as a gzip tar from
`debian-binary`, `data.tar.gz`, `control.tar.gz` (opkg 0.4+ / OpenWrt 24.10
format).

Or via the OpenWrt SDK:

```sh
# put the package directory into package/ inside the SDK and:
make package/luci-app-rrws/compile
```

## Limitations and notes

- Scanning does not bring up the tunnel on the router — it uses temporary
  `wgscan0..N-1` interfaces and removes them when done.
- Scan interfaces (`wgscan0..N-1`) are brought up obfuscated via
  `amneziawg setconf` (full set `Jc/Jmin/Jmax+S1-S4+H1-H4+I1` with endpoint
  baked in, interface recreated per endpoint — otherwise `kmod-amneziawg`
  oopses). Without it DPI would tear the tunnel right after handshake.
  Generated `.conf` files use the same parameters.
- Script files must stay LF (not CRLF) — otherwise bash/ash on OpenWrt and
  WSL trip over the line endings.
- The `applyBest` backend method writes the best endpoint into
  `network.<iface>_peer` (endpoint_host/port) and runs `network reload` when
  needed.

## License

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platform: OpenWrt 24.10+](https://img.shields.io/badge/platform-OpenWrt%2024.10%2B-green.svg)](#requirements)
[![Protocol: AmneziaWG](https://img.shields.io/badge/protocol-AmneziaWG-orange.svg)](https://github.com/amnezia-vpn/amneziawg-linux-kernel-module)
[![MIT (warpscout)](https://img.shields.io/badge/warpscout-MIT-yellow.svg)](https://github.com/vernette/warpscout)

Apache-2.0.

### Attribution: warpscout (MIT)

This project is a rework of [warpscout](https://github.com/vernette/warpscout)
(https://github.com/vernette/warpscout), Copyright (c) 2026 Nikita S.,
licensed under the MIT License:

> MIT License
>
> Copyright (c) 2026 Nikita S.
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
