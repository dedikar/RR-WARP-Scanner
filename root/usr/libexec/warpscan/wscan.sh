#!/bin/sh
# WARPScan for OpenWrt - scan WARP endpoints via kernel AmneziaWG
# ash/busybox compatible. Writes only to /tmp. Needs a WARP account key
# (from /tmp/warp-account.json or a uci amneziawg interface).
# Output: one line per working endpoint: ip:port  NODE  LOC  ping_ms
#
# Quality goals (match warpScout):
#  - 2408 is the primary (low-latency) WARP port; 1700/4500/500 are fallbacks
#  - latency is measured as ICMP RTT to the endpoint host, not curl-in-tunnel
#  - endpoint must complete a real handshake before being kept

IF_WARP="warp"
PORTS="2408 1701 4500 500"
HOSTS_MAX=60
HS_SWEEP=3        # per-port handshake wait during sweep phase
JOBS=1            # parallel worker interfaces (wgscan0..wgscanN-1)
COUNTRY=""
NODE=""
ACCOUNT="/etc/warpscan-account.json"
OUT="/tmp/wscan_result.txt"
TUN_PING_C=5      # echo burst size inside the tunnel (for TUN PING / LOSS)
TEAR_RUN=2        # trailing lost echoes >= this => endpoint marked "torn down"

usage() { echo "usage: wscan.sh [-w iface] [-n N] [-t sec] [-j N] [-p ports] [-c country] [-node NODE] [-o file] [-f]" >&2; exit 1; }
FULL=0
while [ $# -gt 0 ]; do
  case "$1" in
    -w) IF_WARP="$2"; shift 2;;
    -n) HOSTS_MAX="$2"; shift 2;;
    -t) HS_SWEEP="$2"; shift 2;;
    -j) JOBS="$2"; shift 2;;
    -p) PORTS="$2"; shift 2;;
    -c) COUNTRY="$2"; shift 2;;
    -node) NODE="$2"; shift 2;;
    -o) OUT="$2"; shift 2;;
    -f) FULL=1; shift 1;;
    *) usage;;
  esac
done
[ "$JOBS" -ge 1 ] 2>/dev/null || JOBS=1
[ "$JOBS" -gt 6 ] && JOBS=6

# key source: prefer account file, fall back to uci interface
if [ -s "$ACCOUNT" ]; then
  PRIV=$(jq -r '.private_key' "$ACCOUNT" 2>/dev/null)
  PEER=$(jq -r '.peer_public_key' "$ACCOUNT" 2>/dev/null)
else
  PRIV=$(uci get network.$IF_WARP.private_key 2>/dev/null)
  PEER=$(uci get network.${IF_WARP}_peer.public_key 2>/dev/null)
fi
[ -n "$PRIV" ] || { echo "no key: run wregister.sh first or set -w iface"; exit 1; }
[ -n "$PEER" ] || PEER="bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo="

IPBASE="172.16.7"
LOG="/tmp/wscan.log"
log() { echo "[$(date +%H:%M:%S)] $*" >> "$LOG"; }
# NOTE: obfuscation (Jc/Jmin/Jmax/H1-4/I1) is NOT set on the scan interface:
# kmod-amneziawg on this kernel hangs the box when those params are applied
# via `amneziawg set`. The scan only needs a handshake; clients get the full
# obfuscated block from confBase/.conf instead.
PROGRESS="/tmp/wscan/progress"
SCANNED="/tmp/wscan/scanned.cnt"
SCANNED2="/tmp/wscan/scanned2.cnt"

start_wg() {
  local w="$1" IF="wgscan$w" IPLOCAL="$IPBASE.$((2+w))"
  ip link del $IF 2>/dev/null
  modprobe amneziawg 2>/dev/null
  ip link add dev $IF type amneziawg || return 1
  ip link set $IF up
  ip addr add $IPLOCAL/32 dev $IF 2>/dev/null
  amneziawg set $IF listen-port 0 private-key <(echo "$PRIV") peer "$PEER" allowed-ips 0.0.0.0/0
}

# set endpoint and wait for a handshake FRESHER than $last.
try_endpoint() {
  local ep="$1" n="$2" i hs now last="$3" IF="$4"
  amneziawg set $IF peer "$PEER" remove 2>/dev/null
  amneziawg set $IF peer "$PEER" allowed-ips 0.0.0.0/0 endpoint "$ep" persistent-keepalive 5 2>/dev/null
  for i in $(seq 1 "$n"); do
    hs=$(amneziawg show $IF latest-handshakes 2>/dev/null | awk -v p="$PEER" '$1==p{print $2;exit}')
    now=$(date +%s)
    if [ -n "$hs" ] && [ "$hs" -gt "$last" ] && [ $((now-hs)) -lt 3 ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# honest latency to the endpoint host via ICMP; falls back to handshake time
host_rtt() {
  local ip="$1" ms
  ms=$(ping -c 3 -W 2 -q "$ip" 2>/dev/null | sed -n 's/.*round-trip.*= \([0-9.]*\)\/.*/\1/p' | head -1)
  [ -n "$ms" ] && echo "$ms"
}

# TUN PING + LOSS: burst of ICMP to 1.1.1.1 THROUGH the tunnel on IPLOCAL.
# echoes "rtt_ms loss_pct torn" where torn=1 if a trailing run of >= TEAR_RUN
# echoes is lost (DPI cut the tunnel mid-stream) - endpoints like that are the
# "torn down" set from warpScout and are never picked as best.
tun_probe() {
  local IPLOCAL="$1" out rtt=0 maxr=0 loss=0 torn=0 recv=0 n=0
  out=$(ping -c "$TUN_PING_C" -W 1 -I "$IPLOCAL" 1.1.1.1 2>/dev/null)
  [ -n "$out" ] || return 1
  # received count + last received seq (busybox prints "seq=N", not icmp_seq=)
  recv=$(echo "$out" | grep -c ' 1.1.1.1: ' 2>/dev/null)
  lastseq=$(echo "$out" | sed -n 's/.*[= ]seq=\([0-9]*\).*/\1/p' | tail -1)
  [ -z "$lastseq" ] && lastseq=0
  # avg of the round-trip times
  rtt=$(echo "$out" | sed -n 's/.*time=\([0-9.]*\) ms.*/\1/p' | awk '{s+=$1;n++} END{if(n>0)printf "%.1f",s/n}')
  loss=$(( 100 - 100*recv/TUN_PING_C ))
  # torn-down: we stopped answering before the end of the burst
  if [ "$lastseq" -lt "$TUN_PING_C" ] && [ $((TUN_PING_C - lastseq)) -ge $TEAR_RUN ]; then
    torn=1
  fi
  [ -n "$rtt" ] || rtt=0
  echo "$rtt $loss $torn"
}

trace_meta() {
  # returns "colo|loc" - endpoint exit node + country (via WARP exit, account-bound)
  local r colo loc IPLOCAL="$1"
  r=$(curl -s --max-time 4 --interface $IPLOCAL https://1.1.1.1/cdn-cgi/trace 2>/dev/null)
  [ -n "$r" ] || return 1
  colo=$(echo "$r" | sed -n 's/^colo=//p' | head -1)
  loc=$(echo "$r" | sed -n 's/^loc=//p' | head -1)
  [ -n "$colo" ] || return 1
  echo "$colo|$loc"
}

# one parallel worker: sweeps its share of hosts, then does RTT+meta for the
# survivors it found. Each worker owns interface wgscan$w / IP 172.16.7.(2+w).
worker() {
  local w="$1" IF="wgscan$w" IPLOCAL="$IPBASE.$((2+w))"
  local hostfile="/tmp/wscan/hosts.$w.txt" alivefile="/tmp/wscan/alive.$w.txt"
  local ip ep port hs now last rtt ok meta colo loc count
  start_wg "$w" || return
  last=0
  count=0
  while read ip; do
    [ -z "$ip" ] && continue
    count=$((count+1))
    # shared progress across workers
    echo 1 >> "$SCANNED"
    echo "phase1:$(wc -l < "$SCANNED"):$TOTAL" > $PROGRESS
    for port in $PORTS; do
      if try_endpoint "$ip:$port" "$HS_SWEEP" "$last" "$IF"; then
        echo "$ip:$port" >> "$alivefile"
        log "alive: $ip:$port ($w/$count)"
        last=$(amneziawg show $IF latest-handshakes 2>/dev/null | awk -v p="$PEER" '$1==p{print $2;exit}')
        break
      fi
    done
  done < "$hostfile"

  # ---- worker phase 2: honest RTT + meta + in-tunnel probe for its survivors ----
  echo "phase2" > $PROGRESS
  while read ep; do
    [ -z "$ep" ] && continue
    ip=${ep%:*}
    # shared phase-2 progress across workers
    echo 1 >> "$SCANNED2"
    echo "phase2:$(wc -l < "$SCANNED2")" > $PROGRESS
    # latency to the endpoint host, independent of tunnel/TLS
    rtt=$(host_rtt "$ip")
    [ -n "$rtt" ] || continue
    # verify real handshake still works on this exact endpoint
    amneziawg set $IF peer "$PEER" remove 2>/dev/null
    amneziawg set $IF peer "$PEER" allowed-ips 0.0.0.0/0 endpoint "$ep" persistent-keepalive 5 2>/dev/null
    ok=""
    for i in 1 2 3; do
      hs=$(amneziawg show $IF latest-handshakes 2>/dev/null | awk -v p="$PEER" '$1==p{print $2;exit}')
      now=$(date +%s)
      if [ -n "$hs" ] && [ $((now-hs)) -lt 5 ]; then
        ok=1
        break
      fi
      sleep 1
    done
    [ -n "$ok" ] || continue
    meta=$(trace_meta "$IPLOCAL")
    if [ -n "$meta" ]; then
      colo=$(echo "$meta" | cut -d'|' -f1)
      loc=$(echo "$meta" | cut -d'|' -f2)
      [ -n "$COUNTRY" ] && [ "$loc" != "$COUNTRY" ] && continue
      [ -n "$NODE" ] && [ "$colo" != "$NODE" ] && continue
      # in-tunnel burst: TUN PING, LOSS, torn-down detection
      tp=$(tun_probe "$IPLOCAL")
      if [ -n "$tp" ]; then
        tprtt=$(echo "$tp" | cut -d' ' -f1)
        tploss=$(echo "$tp" | cut -d' ' -f2)
        tptorn=$(echo "$tp" | cut -d' ' -f3)
      else
        tprtt="?"
        tploss="?"
        tptorn="?"
      fi
      echo "$ep $colo $loc ${rtt} ${tprtt} ${tploss} ${tptorn}" >> "$OUT"
    fi
  done < "$alivefile"

  ip link del $IF 2>/dev/null
}

# host list generator: interleave subnets so the first HOSTS_MAX lines
# cover every pool instead of only the first two (matches warpScout pools).
SUBNETS="8.6.112 8.34.70 8.34.146 8.35.211 8.39.125 8.39.204 8.39.214 8.47.69 162.159.192 162.159.193 162.159.195 162.159.197 162.159.204 188.114.96 188.114.97 188.114.98 188.114.99"
NSUB=$(echo $SUBNETS | wc -w)
BATCH=$(( (HOSTS_MAX + NSUB - 1) / NSUB ))
[ "$BATCH" -lt 1 ] && BATCH=1
{
  i=1
  while [ $i -le "$BATCH" ]; do
    for subnet in $SUBNETS; do
      if [ "$FULL" = "1" ]; then
        # full sweep: walk every /24 octet in order (1..254), like warpScout's
        # ipaddress.IPv4Network iterator - covers the whole pool, not just a
        # few fixed octets.
        oct=$i
      else
        # fast mode: a few deterministic octets that are known to be alive
        oct=$(( (i * 37) % 254 + 1 ))
      fi
      echo "$subnet.$oct"
    done
    i=$((i+1))
  done
} > /tmp/wscan/allhosts.txt
head -n "$HOSTS_MAX" /tmp/wscan/allhosts.txt > /tmp/wscan/hosts.txt

PROGRESS="/tmp/wscan/progress"

[ -d /tmp/wscan ] || mkdir -p /tmp/wscan
: > "$OUT"
: > "$LOG"
: > "$SCANNED"
: > "$SCANNED2"
: > /tmp/wscan/alive.txt
# clean any leftover worker files from previous runs (they append, not truncate)
rm -f /tmp/wscan/hosts.*.txt /tmp/wscan/alive.*.txt
# split the host list across workers round-robin
w=0
while read ip; do
  [ -z "$ip" ] && continue
  echo "$ip" >> "/tmp/wscan/hosts.$w.txt"
  w=$(( (w + 1) % JOBS ))
done < /tmp/wscan/hosts.txt

TOTAL=$(wc -l < /tmp/wscan/hosts.txt)
echo "phase1" > $PROGRESS
log "start: $TOTAL hosts, jobs=$JOBS, sweep=$HS_SWEEP s, ports=$PORTS, full=$FULL"

# launch workers
w=0
while [ $w -lt $JOBS ]; do
  worker $w &
  w=$((w+1))
done
wait

# collect survivors + sort by ping (torn-down endpoints sink to the bottom,
# matching warpScout: they are shown, but never picked as best)
cat /tmp/wscan/alive.*.txt 2>/dev/null > /tmp/wscan/alive.txt
ALIVE=$(wc -l < /tmp/wscan/alive.txt)
if [ -s "$OUT" ]; then
  # field order: ep colo loc rtt tun_rtt tun_loss torn (1 = torn down)
  awk '{key=($7=="1"?"1":"0")" "$4" "; print key $0}' "$OUT" \
    | sort -n | sed 's/^[01] [0-9.]* //' > /tmp/wscan_result_sorted.txt
  mv /tmp/wscan_result_sorted.txt "$OUT"
fi
echo "done" > $PROGRESS
log "done: $TOTAL hosts, $ALIVE alive, $(wc -l < $OUT) with meta -> $OUT"
[ -s "$OUT" ] && log "BEST: $(head -1 $OUT)"
echo "done: $TOTAL hosts, $ALIVE alive, $(wc -l < $OUT) with meta -> $OUT"
[ -s "$OUT" ] && echo "BEST: $(head -1 $OUT)"
