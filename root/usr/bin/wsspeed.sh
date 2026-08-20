#!/bin/sh
# RRWS speed test - measure download/upload through the best N WARP endpoints.
# Reads /tmp/wsspeed-src.txt (freshest scan result copied by the backend), takes
# the top N non-torn endpoints, builds a temporary obfuscated tunnel to each one
# (exactly like the bootstrap in wregister.sh: full junk set via setconf + policy
# routing) and runs a download + upload through speed.cloudflare.com.
# Writes only to /tmp.
# Output: one line per endpoint:  ip:port  dl_kbps  ul_kbps

ACCOUNT="/etc/rrws-account.json"
if [ -s /tmp/wsspeed-src.txt ]; then
  SRC="/tmp/wsspeed-src.txt"
else
  SRC="/tmp/wscan_result.txt"
fi
OUT="/tmp/wsspeed_result.txt"
LOG="/tmp/wsspeed.log"
PROGRESS="/tmp/wsspeed/progress"
PIDFILE="/tmp/wsspeed/pid"
IF="wgspeed"
IPLOCAL="172.16.7.200"
TABLE=102
HS_SWEEP=8        # per-endpoint handshake wait (seconds)
DL_BYTES=25000000 # 25 MB download chunk
MAX_TIME=12       # curl cap per measurement
I1="<r 2><b 0x858000010001000000000669636c6f756403636f6d0000010001c00c000100010000105a00044d583737>"

# speed.cloudflare.com must be dialed by its REAL anycast IP, not by the
# WARP FakeIP (198.18.x): through our raw tunnel a request to 198.18.x never
# answers (http 000 / 0 kbit/s). Resolve via an external DNS to get a real
# IPv4 (the router's own resolver returns the FakeIP too), fall back to a
# known-good Cloudflare IP if resolution fails.
SPEED_HOST="speed.cloudflare.com"
SPEED_IP=""
resolve_speed_ip() {
  # nslookup host 1.1.1.1 -> last "Address:" line is an IPv4 answer
  local a
  a=$(nslookup "$SPEED_HOST" 1.1.1.1 2>/dev/null | awk '/^Address: / && $2 !~ /:/ {print $2}' | tail -1)
  if [ -n "$a" ]; then
    SPEED_IP="$a"
  else
    SPEED_IP="104.18.7.198"   # known-working Cloudflare anycast for speed test
  fi
  log "speed server: $SPEED_HOST -> $SPEED_IP"
  return 0
}

# ICMP RTT to the endpoint host (independent of tunnel/TLS)
host_rtt() {
  local ip="$1" ms
  ms=$(ping -c 3 -W 2 -q "$ip" 2>/dev/null | sed -n 's/.*round-trip.*= \([0-9.]*\)\/.*/\1/p' | head -1)
  [ -n "$ms" ] && echo "$ms"
}

log() { echo "[$(date +%H:%M:%S)] $*" >> "$LOG"; }

usage() { echo "usage: wsspeed.sh [-n N] [-t sec] [-o file]" >&2; exit 1; }
N=5
while [ $# -gt 0 ]; do
  case "$1" in
    -n) N="$2"; shift 2;;
    -t) MAX_TIME="$2"; shift 2;;
    -o) OUT="$2"; shift 2;;
    *) usage;;
  esac
done
[ "$N" -ge 1 ] 2>/dev/null || N=5
[ "$N" -gt 40 ] && N=40
# the handshake wait is part of the per-endpoint budget: never let it exceed
# the configured measurement time, otherwise a dead endpoint burns 8s + time
[ "$MAX_TIME" -lt "$HS_SWEEP" ] && HS_SWEEP=$MAX_TIME

[ -s "$ACCOUNT" ] || { echo "no account: run wregister.sh first" >&2; exit 1; }
PRIV=$(jq -r '.private_key' "$ACCOUNT" 2>/dev/null)
PEER=$(jq -r '.peer_public_key' "$ACCOUNT" 2>/dev/null)
[ -n "$PRIV" ] || { echo "no private_key in $ACCOUNT" >&2; exit 1; }
[ -n "$PEER" ] || PEER="bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo="
[ -s "$SRC" ] || { echo "no scan result: run a scan first ($SRC)" >&2; exit 1; }

# resolve the real speed server IP before building any tunnel
resolve_speed_ip

# top N non-torn endpoints (torn flag is field 7, torn already sorted last);
# keep the node (field 2) and country (field 3) so the UI can show where each
# tested endpoint sits (e.g. "WAW RU")
awk '$7 != "1" {print $1, $2, $3}' "$SRC" | head -n "$N" > /tmp/wsspeed.list
TOTAL=$(wc -l < /tmp/wsspeed.list)
if [ "$TOTAL" -lt 1 ]; then
  echo "no working endpoints to test" >&2
  exit 1
fi

[ -d /tmp/wsspeed ] || mkdir -p /tmp/wsspeed
echo $$ > "$PIDFILE"
: > "$LOG"
: > "$OUT"
: > /tmp/wsspeed.upload.bin
head -c 8388608 /dev/urandom > /tmp/wsspeed.upload.bin 2>/dev/null
[ -s /tmp/wsspeed.upload.bin ] || dd if=/dev/urandom of=/tmp/wsspeed.upload.bin bs=4096 count=2048 2>/dev/null

# create + configure the probe interface for a given endpoint (full obfuscation
# via setconf, endpoint baked into the config - stable on this kmod under DPI)
start_if() {
  local ep="$1" i
  for i in 1 2 3; do
    ip link del $IF 2>/dev/null && break
    sleep 1
  done
  modprobe amneziawg 2>/dev/null
  ip link add dev $IF type amneziawg || return 1
  ip link set $IF up
  ip link set $IF mtu 1280
  ip addr add $IPLOCAL/32 dev $IF 2>/dev/null
  cat > /tmp/wsspeed.conf <<EOF
[Interface]
PrivateKey=$PRIV
Jc=6
Jmin=10
Jmax=50
S1=0
S2=0
S3=0
S4=0
H1=1
H2=2
H3=3
H4=4
I1=$I1

[Peer]
PublicKey=$PEER
AllowedIPs=0.0.0.0/0
Endpoint=$ep
PersistentKeepalive=5
EOF
  amneziawg setconf $IF /tmp/wsspeed.conf 2>/tmp/wsspeed_setconf.err
  local rc=$?
  rm -f /tmp/wsspeed.conf
  if [ "$rc" -ne 0 ]; then
    log "setconf(full) failed rc=$rc: $(head -c 200 /tmp/wsspeed_setconf.err 2>/dev/null)"
    # fall back to plain config
    cat > /tmp/wsspeed.conf <<EOF
[Interface]
PrivateKey=$PRIV

[Peer]
PublicKey=$PEER
AllowedIPs=0.0.0.0/0
Endpoint=$ep
PersistentKeepalive=5
EOF
    amneziawg setconf $IF /tmp/wsspeed.conf 2>/dev/null
    rc=$?
    rm -f /tmp/wsspeed.conf
    [ "$rc" -ne 0 ] && return 1
  fi
  rm -f /tmp/wsspeed_setconf.err
  # policy routing: force only our source IP through the tunnel
  ip route add default dev $IF table $TABLE 2>/dev/null
  ip rule add from $IPLOCAL/32 lookup $TABLE prio 98 2>/dev/null
  return 0
}

# wait for a fresh handshake, up to HS_SWEEP seconds
wait_hs() {
  local i hs now
  for i in $(seq 1 "$HS_SWEEP"); do
    hs=$(amneziawg show $IF latest-handshakes 2>/dev/null | awk -v p="$PEER" '$1==p{print $2;exit}')
    now=$(date +%s)
    if [ -n "$hs" ] && [ $((now-hs)) -lt 3 ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

teardown() {
  ip rule del from $IPLOCAL/32 lookup $TABLE prio 98 2>/dev/null
  ip route del default dev $IF table $TABLE 2>/dev/null
  ip link del $IF 2>/dev/null
}

i=0
while read ep node loc; do
  [ -z "$ep" ] && continue
  i=$((i+1))
  echo "$i/$TOTAL $ep ($node $loc)" > "$PROGRESS"
  log "test $i/$TOTAL: $ep ($node $loc)"
  ip=${ep%:*}
  rtt=$(host_rtt "$ip")
  [ -n "$rtt" ] || rtt="?"
  if ! start_if "$ep"; then
    log "cannot create interface, skipping $ep"
    echo "$ep $node $loc $rtt 0 0" >> "$OUT"
    continue
  fi
  if ! wait_hs; then
    log "no handshake for $ep, skipping"
    echo "$ep $node $loc $rtt 0 0" >> "$OUT"
    teardown
    continue
  fi
  log "handshake OK for $ep"

  dl=$(curl -s --max-time "$MAX_TIME" --interface $IPLOCAL \
    --resolve "$SPEED_HOST:443:$SPEED_IP" \
    -o /dev/null -w '%{speed_download}' \
    "https://$SPEED_HOST/__down?bytes=$DL_BYTES" 2>/dev/null)
  [ -n "$dl" ] || dl=0
  ul=$(curl -s --max-time "$MAX_TIME" --interface $IPLOCAL \
    --resolve "$SPEED_HOST:443:$SPEED_IP" \
    -o /dev/null -w '%{speed_upload}' -X POST \
    --data-binary @/tmp/wsspeed.upload.bin \
    "https://$SPEED_HOST/__up" 2>/dev/null)
  [ -n "$ul" ] || ul=0
  # bytes/sec -> kbit/s
  dlk=$(awk -v b="$dl" 'BEGIN{printf "%.0f", b*8/1000}')
  ulk=$(awk -v b="$ul" 'BEGIN{printf "%.0f", b*8/1000}')
  log "result $ep ($node $loc) ping=${rtt}ms dl=${dlk} kbit/s ul=${ulk} kbit/s"
  echo "$ep $node $loc $rtt $dlk $ulk" >> "$OUT"
  teardown
done < /tmp/wsspeed.list

teardown
rm -f /tmp/wsspeed.upload.bin
echo "done" > "$PROGRESS"
log "done: $TOTAL endpoints tested -> $OUT"
echo "done: $TOTAL endpoints tested -> $OUT"
