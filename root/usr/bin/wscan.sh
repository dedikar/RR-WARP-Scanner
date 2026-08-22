#!/bin/sh
# RRWS for OpenWrt - scan WARP endpoints via kernel AmneziaWG
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
# full WARP UDP port list, used only by the discovery phase when the common
# ones are blocked (see guidelines). Never swept exhaustively per host.
ALL_PORTS="2408 500 854 859 864 878 880 890 891 894 903 908 928 934 939 942 943 945 946 955 968 987 988 1002 1010 1014 1018 1070 1074 1180 1387 1701 1843 2371 2506 3138 3476 3581 3854 4177 4198 4233 4500 5279 5956 7103 7152 7156 7281 7559 8319 8742 8854 8886"
HOSTS_MAX=500
HS_SWEEP=3        # per-port handshake wait during sweep phase
JOBS=1            # parallel worker interfaces (wgscan0..wgscanN-1)
ACCOUNT="/etc/rrws-account.json"
OUT="/tmp/wscan_result.txt"
TUN_PING_C=5      # echo burst size inside the tunnel (for TUN PING / LOSS)
TEAR_RUN=2        # trailing lost echoes >= this => endpoint marked "torn down"

usage() { echo "usage: wscan.sh [-w iface] [-n N] [-t sec] [-j N] [-p ports] [-o file] [-f] [-D] [-P N] [-x 'subnet ...'] [-e 'NODE ...']" >&2; exit 1; }
FULL=0
DISCOVER=0
DISCOVER_HOSTS=5
EXCLUDE=""
EXCLUDE_NODES=""
while [ $# -gt 0 ]; do
  case "$1" in
    -w) IF_WARP="$2"; shift 2;;
    -n) HOSTS_MAX="$2"; shift 2;;
    -t) HS_SWEEP="$2"; shift 2;;
    -j) JOBS="$2"; shift 2;;
    -p) PORTS="$2"; shift 2;;
    -o) OUT="$2"; shift 2;;
    -f) FULL=1; shift 1;;
    -D) DISCOVER=1; shift 1;;
    -P) DISCOVER_HOSTS="$2"; shift 2;;
    -x) EXCLUDE="$2"; shift 2;;
    -e) EXCLUDE_NODES="$2"; shift 2;;
    *) usage;;
  esac
done
[ "$DISCOVER_HOSTS" -ge 1 ] 2>/dev/null || DISCOVER_HOSTS=5
[ "$DISCOVER_HOSTS" -gt 10 ] && DISCOVER_HOSTS=10
[ "$JOBS" -ge 1 ] 2>/dev/null || JOBS=1
[ "$JOBS" -gt 50 ] && JOBS=50

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

# Full obfuscation set for the scan interfaces. Applied via setconf (NOT
# `amneziawg set`): on this kmod mutating a live obfuscated interface (peer
# remove/add/endpoint) crashes the box (kernel oops), and non-obfuscated
# tunnels are torn down by DPI right after handshake (rx=0, so trace_meta and
# any data never flow). Building the whole [Interface]+[Peer] with the endpoint
# baked in and re-creating the interface per endpoint is the only stable way.
WSC_JC="6"; WSC_JMIN="10"; WSC_JMAX="50"
WSC_I1="<r 2><b 0x858000010001000000000669636c6f756403636f6d0000010001c00c000100010000105a00044d583737>"

# create an obfuscated amneziawg interface $IF for endpoint $ep with source
# IP $IPLOCAL, and install policy routing (own table + rule) so traffic from
# $IPLOCAL goes through THIS tunnel only. Endpoint is baked into the config.
# Usage: start_wg_ep IF IPLOCAL TABLE ep   (echoes nothing; returns 0/1)
start_wg_ep() {
  local IF="$1" IPLOCAL="$2" TBL="$3" ep="$4"
  ip link del $IF 2>/dev/null
  modprobe amneziawg 2>/dev/null
  ip link add dev $IF type amneziawg 2>/dev/null || return 1
  ip link set $IF mtu 1280
  ip link set $IF up
  ip addr add $IPLOCAL/32 dev $IF 2>/dev/null
  cat > /tmp/wscan.conf <<EOF
[Interface]
PrivateKey=$PRIV
Jc=$WSC_JC
Jmin=$WSC_JMIN
Jmax=$WSC_JMAX
S1=0
S2=0
S3=0
S4=0
H1=1
H2=2
H3=3
H4=4
I1=$WSC_I1

[Peer]
PublicKey=$PEER
AllowedIPs=0.0.0.0/0
Endpoint=$ep
PersistentKeepalive=5
EOF
  amneziawg setconf $IF /tmp/wscan.conf 2>/dev/null
  local rc=$?
  rm -f /tmp/wscan.conf
  [ "$rc" -ne 0 ] && { ip link del $IF 2>/dev/null; return 1; }
  ip route add default dev $IF table $TBL 2>/dev/null
  ip rule add from $IPLOCAL/32 lookup $TBL prio 98 2>/dev/null
  return 0
}

# teardown: drop rule/route then interface
teardown_wg() {
  local IF="$1" IPLOCAL="$2" TBL="$3"
  ip rule del from $IPLOCAL/32 lookup $TBL prio 98 2>/dev/null
  ip route del default dev $IF table $TBL 2>/dev/null
  ip link del $IF 2>/dev/null
}

# bring up an obfuscated interface to $ep and wait for a fresh handshake.
# Usage: try_endpoint IF IPLOCAL TABLE ep n last -> 0/1
try_endpoint() {
  local IF="$1" IPLOCAL="$2" TBL="$3" ep="$4" n="$5" last="$6"
  local i hs now
  start_wg_ep "$IF" "$IPLOCAL" "$TBL" "$ep" || return 1
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

# handshake-only probe on a PERSISTENT (non-obfuscated) interface - used by the
# port-discovery phase, which only needs to know whether a UDP port answers a
# handshake (data never needs to flow). Kept non-obfuscated and on a fixed
# interface because discovery sweeps hundreds of (host,port) combos and would
# be too slow to re-create a tunnel each time.
try_hs() {
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

# discover which UDP ports the network lets out. Runs on a throwaway
# interface, tries the common ports first and only sweeps the full list if
# none of them got through (matching warpScout). Sets $PORTS to the working
# set so the actual sweep never re-tries blocked ports on every host.
discover_ports() {
  local PIF="wgprobe" PIPA="$IPBASE.199"
  local host port i last ok=0 ddone=0 dtotal=0 np
  # progress total (worst case): fast-path probe hosts, then 3 fallback ports,
  # then the FULL list per probe host - the sweep walks every port on every
  # probe host until one answers, so done can reach HOSTS*PORTS, not just PORTS.
  np=$(echo $ALL_PORTS | wc -w)
  dtotal=$(( DISCOVER_HOSTS + 3 + DISCOVER_HOSTS * np ))
  dp() { ddone=$((ddone+1)); [ "$ddone" -gt "$dtotal" ] && ddone=$dtotal; echo "discovery:$ddone:$dtotal" > $PROGRESS; }
  # tell the backend we are probing ports, not sweeping hosts yet
  echo "discovery:0:$dtotal" > $PROGRESS
  # make sure any leftover probe interface from a previous run is gone
  for i in 1 2 3; do
    ip link del $PIF 2>/dev/null && break
    sleep 1
  done
  modprobe amneziawg 2>/dev/null
  if ! ip link add dev $PIF type amneziawg 2>/dev/null; then
    log "discovery: cannot create probe interface, using defaults"
    return 1
  fi
  ip link set $PIF up
  ip addr add $PIPA/32 dev $PIF 2>/dev/null
  amneziawg set $PIF listen-port 0 private-key <(echo "$PRIV") peer "$PEER" allowed-ips 0.0.0.0/0 2>/dev/null

  # Fast path: the primary port (2408, first in $PORTS) gets through on any of
  # the first few probe hosts => the network is not filtering UDP traffic, so
  # keep the default port list (no prep-paid sweep). This costs ~2s.
  for host in $(head -n $DISCOVER_HOSTS /tmp/wscan/hosts.txt); do
    [ -n "$host" ] || { dp; continue; }
    if try_hs "$host:2408" 3 0 "$PIF"; then
      ok=1
      log "discovery: $host:2408 works"
      break
    fi
    dp
  done

  if [ "$ok" != "1" ]; then
    # the primary port is blocked; find which ports the network lets out and
    # narrow $PORTS to only those (so the sweep never re-tries blocked ports
    # on every host). Cheap pass first: common fallbacks (1701/4500/500) on
    # all probe hosts, 2 tries each - the usual filtered-network case resolves
    # in seconds instead of sweeping the full list per host.
    local found_ports="" host2 wp
    for port in 1701 4500 500; do
      for host2 in $(head -n $DISCOVER_HOSTS /tmp/wscan/hosts.txt); do
        [ -n "$host2" ] || continue
        if try_hs "$host2:$port" 2 0 "$PIF"; then
          found_ports="$found_ports $port"
          log "discovery: $host2:$port works (fallback)"
          break
        fi
      done
      dp
      [ -n "$found_ports" ] && break
    done
    # Full-list sweep (1 try each) only when 1701/4500/500 were all dead,
    # i.e. a heavily filtered network that answers only an exotic port.
    if [ -z "$found_ports" ]; then
      for host2 in $(head -n $DISCOVER_HOSTS /tmp/wscan/hosts.txt); do
        [ -n "$host2" ] || continue
        for port in $ALL_PORTS; do
          if try_hs "$host2:$port" 1 0 "$PIF"; then
            found_ports="$found_ports $port"
            log "discovery: $host2:$port works (full sweep)"
            dp
            break
          fi
          dp
        done
        [ -n "$found_ports" ] && break
      done
    fi
    if [ -n "$found_ports" ]; then
      PORTS=$(echo $found_ports | tr ' ' '\n' | sort -n | tr '\n' ' ')
      log "discovery: primary blocked, using ports: $PORTS"
    else
      log "discovery: no alternative port answered, keeping defaults: $PORTS"
    fi
  else
    log "discovery: network passes UDP, ports unchanged (${PORTS})"
  fi

  ip link del $PIF 2>/dev/null
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
# survivors it found. Each worker owns interface wgscan$w / IP 172.16.7.(2+w)
# with its own routing table 200+w; tunnels are OBFUSCATED (setconf) and
# re-created per endpoint, because a live obfuscated interface must not be
# mutated and non-obfuscated ones are torn by DPI (no data, no real node).
worker() {
  local w="$1" IF="wgscan$w" IPLOCAL="$IPBASE.$((2+w))" TBL=$((200+w))
  local hostfile="/tmp/wscan/hosts.$w.txt" alivefile="/tmp/wscan/alive.$w.txt"
  local ip ep port hs now last rtt ok meta colo loc count
  last=0
  count=0
  while read ip; do
    [ -z "$ip" ] && continue
    count=$((count+1))
    # shared progress across workers
    echo 1 >> "$SCANNED"
    echo "phase1:$(wc -l < "$SCANNED"):$TOTAL" > $PROGRESS
    for port in $PORTS; do
      if try_endpoint "$IF" "$IPLOCAL" "$TBL" "$ip:$port" "$HS_SWEEP" "$last"; then
        echo "$ip:$port" >> "$alivefile"
        log "alive: $ip:$port (worker $w, host #$count)"
        last=$(amneziawg show $IF latest-handshakes 2>/dev/null | awk -v p="$PEER" '$1==p{print $2;exit}')
        break
      fi
    done
  done < "$hostfile"

  # ---- worker phase 2: honest RTT + meta + in-tunnel probe for its survivors ----
  echo "phase2" > $PROGRESS
  if [ -s "$alivefile" ]; then
    while read ep; do
      [ -z "$ep" ] && continue
      ip=${ep%:*}
      # shared phase-2 progress across workers
      echo 1 >> "$SCANNED2"
      echo "phase2:$(wc -l < "$SCANNED2")" > $PROGRESS
      # latency to the endpoint host, independent of tunnel/TLS
      rtt=$(host_rtt "$ip")
      [ -n "$rtt" ] || continue
      # re-create the obfuscated tunnel to THIS exact endpoint and verify data
      # actually flows (fresh handshake) before reading its node/region.
      if ! try_endpoint "$IF" "$IPLOCAL" "$TBL" "$ep" 3 "$last"; then
        continue
      fi
      last=$(amneziawg show $IF latest-handshakes 2>/dev/null | awk -v p="$PEER" '$1==p{print $2;exit}')
      meta=$(trace_meta "$IPLOCAL")
      if [ -n "$meta" ]; then
        colo=$(echo "$meta" | cut -d'|' -f1)
        loc=$(echo "$meta" | cut -d'|' -f2)
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
  fi

  teardown_wg "$IF" "$IPLOCAL" "$TBL"
}

# host list generator: interleave subnets so the first HOSTS_MAX lines
# cover every pool instead of only the first two (matches warpScout pools).
SUBNETS="8.6.112 8.34.70 8.34.146 8.35.211 8.39.125 8.39.204 8.39.214 8.47.69 162.159.192 162.159.193 162.159.195 162.159.197 162.159.204 188.114.96 188.114.97 188.114.98 188.114.99"
# drop excluded subnets (space-separated, from -x) before generating the list
for ex in $EXCLUDE; do
  SUBNETS=$(echo $SUBNETS | tr ' ' '\n' | grep -v "^${ex}$" | tr '\n' ' ')
done
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

[ -d /tmp/wscan ] || mkdir -p /tmp/wscan
echo $$ > /tmp/wscan/pid
: > "$LOG"
: > "$SCANNED"
: > "$SCANNED2"
: > "$OUT"
: > /tmp/wscan/alive.txt
# clean leftover worker files from previous runs BEFORE discovery: the probe
# phase can take minutes, and stale alive.*.txt would leak the previous run's
# "alive" count into scanStatus while we are still picking ports.
rm -f /tmp/wscan/hosts.*.txt /tmp/wscan/alive.*.txt

# optional smart port discovery; off by default so a plain scan behaves
# exactly as before (fixed port list)
[ "$DISCOVER" = "1" ] && discover_ports

PROGRESS="/tmp/wscan/progress"

# split the host list across workers round-robin
w=0
while read ip; do
  [ -z "$ip" ] && continue
  echo "$ip" >> "/tmp/wscan/hosts.$w.txt"
  w=$(( (w + 1) % JOBS ))
done < /tmp/wscan/hosts.txt

TOTAL=$(wc -l < /tmp/wscan/hosts.txt)
echo "phase1" > $PROGRESS
log "start: $TOTAL hosts, jobs=$JOBS, sweep=$HS_SWEEP s, ports=$PORTS, full=$FULL${EXCLUDE:+ excl=$EXCLUDE}"

# launch workers (only those that actually got hosts: with jobs > hosts the
# round-robin split leaves the trailing workers with no file at all)
w=0
while [ $w -lt $JOBS ]; do
  if [ -s "/tmp/wscan/hosts.$w.txt" ]; then
    worker $w &
  fi
  w=$((w+1))
done
wait

# collect survivors + sort by ping (torn-down endpoints sink to the bottom,
# matching warpScout: they are shown, but never picked as best). Endpoints on
# excluded nodes (e.g. DME) are DROPPED entirely from the result, so they never
# show up in the table or as .conf - the exclusion is global.
cat /tmp/wscan/alive.*.txt 2>/dev/null > /tmp/wscan/alive.txt
ALIVE=$(wc -l < /tmp/wscan/alive.txt)
if [ -s "$OUT" ]; then
  # field order: ep colo loc rtt tun_rtt tun_loss torn (1 = torn down)
  if [ -n "$EXCLUDE_NODES" ]; then
    # drop excluded-node rows (awk $2 = node); keep torn even if on an excluded
    # node is pointless - torn is dropped by applyBest anyway, so filter by node
    # first, then sort the survivors
    awk -v en="$EXCLUDE_NODES" '
      function in_excl(n,  arr, i) {
        split(en, arr, " ");
        for (i in arr) if (arr[i] == n) return 1;
        return 0;
      }
      !in_excl($2) { key=($7=="1"?"1":"0")" "$4" "; print key $0 }' "$OUT" \
      | sort -n | sed 's/^[01] [0-9.]* //' > /tmp/wscan_result_sorted.txt
  else
    awk '{key=($7=="1"?"1":"0")" "$4" "; print key $0}' "$OUT" \
      | sort -n | sed 's/^[01] [0-9.]* //' > /tmp/wscan_result_sorted.txt
  fi
  mv /tmp/wscan_result_sorted.txt "$OUT"
fi
echo "done" > $PROGRESS
log "done: $TOTAL hosts, $ALIVE alive, $(wc -l < $OUT) with meta -> $OUT"
[ -s "$OUT" ] && log "BEST: $(head -1 $OUT)"
echo "done: $TOTAL hosts, $ALIVE alive, $(wc -l < $OUT) with meta -> $OUT"
[ -s "$OUT" ] && echo "BEST: $(head -1 $OUT)"
