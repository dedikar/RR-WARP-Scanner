#!/bin/sh
# WARP account registration for OpenWrt
# Registers a fresh WARP device. If api.cloudflareclient.com is blocked directly,
# falls back to an existing amneziawg tunnel, and if none works, builds its OWN
# temporary bootstrap tunnel (warpscout keys) to reach the API - no pre-made
# tunnel needed. Writes account to stdout JSON. Only /tmp and the account file
# are written. All diagnostics go to stderr with a [wregister] prefix.

ACCOUNT_FILE="/etc/rrws-account.json"
TUNNEL_IF="warp"
API="https://api.cloudflareclient.com/v0a4005/reg"

# We build our OWN bootstrap tunnel with the FULL obfuscation set
# (Jc/Jmin/Jmax + S1-S4 + H1-H4 + I1, MTU 1280) applied via `amneziawg setconf`
# from a config file - exactly how the RouteRich firmware's TestWarp/TW2
# interfaces are built. This matters: partial junk params (only jc/jmin/jmax/i1
# without S/H, as in r63) crash this kmod with a bad pointer, while the full
# set via setconf is stable (verified: handshake + POST /reg 200, no freeze).
BOOT_PRIV="4OnO86dDLpqJ2U10ODwX3tarx6xlRGLfkmbSBtMgaHg="
BOOT_PEER="bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo="
BOOT_IF="wgregb"
BOOT_IP="172.16.0.3"
BOOT_TABLE="101"
BOOT_PORTS="2408 1701 4500 500"
# candidate endpoints, first tries known-good hosts then walks the warpscout pools.
# NB: endpoints already held by a local interface (e.g. warp uses 162.159.193.1:2408
# on this router) will NOT handshake the bootstrap key, so prefer fresh hosts.
BOOT_HOSTS="188.114.96.3 162.159.192.1 188.114.97.1 8.6.112.2 8.34.70.2 8.34.146.2 8.35.211.2 8.39.125.2 8.39.204.2 8.39.214.2 8.47.69.2 162.159.193.2 162.159.195.2 162.159.197.2 162.159.204.2 188.114.98.2 188.114.99.2 188.114.96.2"

usage() { echo "usage: wregister.sh [-t tunnel_if] [-o file]"; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    -t) TUNNEL_IF="$2"; shift 2;;
    -o) ACCOUNT_FILE="$2"; shift 2;;
    *) usage;;
  esac
done

log() { echo "[wregister] $*" >&2; }

# background-run marker: lets the backend report that a registration is in
# progress (register/renew run detached from the ubus call, see luci.rrws).
MARKER="/tmp/rrws-registering"
touch "$MARKER"
trap 'rm -f "$MARKER"' EXIT

# 1. generate keypair
log "generating amneziawg keypair"
PRIV=$(amneziawg genkey)
[ -n "$PRIV" ] || { log "FATAL: amneziawg genkey returned nothing"; exit 1; }
PUB=$(echo "$PRIV" | amneziawg pubkey)
[ -n "$PUB" ] || { log "FATAL: amneziawg pubkey failed"; exit 1; }

BODY="{\"key\":\"$PUB\",\"install_id\":\"\",\"fcm_token\":\"\",\"tos\":\"2024-06-11T04:00:00.000Z\",\"type\":\"Android\",\"model\":\"\"}"

# curl wrapper that keeps the exit code, http code and stderr separate.
# sets RC, CODE, ERR; response body goes to the given outfile.
probe() { # $1=url  $2=extra curl args  $3=timeout (default 4s)
  RC=0; CODE=""; ERR=""
  local t="${3:-4}"
  # shellcheck disable=SC2086
  curl -s --max-time "$t" $2 -o /dev/null -w '%{http_code}' "$1" > /tmp/wr_probe.code 2> /tmp/wr_probe.err
  RC=$?
  CODE=$(cat /tmp/wr_probe.code 2>/dev/null)
  ERR=$(cat /tmp/wr_probe.err 2>/dev/null)
}

register_curl() { # $1=method  $2=url  $3=extra args  $4=token  $5=data  $6=outfile
  RC=0; CODE=""; ERR=""
  if [ -n "$4" ]; then
    # shellcheck disable=SC2086
    curl -s --max-time 15 $3 -X "$1" "$2" \
      -H "Content-Type: application/json" \
      -H "User-Agent: okhttp/3.12.1" \
      -H "Authorization: Bearer $4" \
      -d "$5" \
      -o "$6" -w '%{http_code}' > "$6.code" 2> "$6.err"
  else
    # shellcheck disable=SC2086
    curl -s --max-time 15 $3 -X "$1" "$2" \
      -H "Content-Type: application/json" \
      -H "User-Agent: okhttp/3.12.1" \
      -d "$5" \
      -o "$6" -w '%{http_code}' > "$6.code" 2> "$6.err"
  fi
  RC=$?
  CODE=$(cat "$6.code" 2>/dev/null)
  ERR=$(cat "$6.err" 2>/dev/null)
}

curl_errmsg() { # $1 = curl exit code
  case "$1" in
    3) echo "URL malformed";;
    5) echo "could not resolve proxy";;
    6) echo "could not resolve host - DNS problem";;
    7) echo "failed to connect - connection refused/blocked";;
    28) echo "operation timed out";;
    47) echo "too many redirects";;
    51) echo "SSL peer certificate problem";;
    56) echo "connection reset by peer";;
    67) echo "login credentials denied";;
    77) echo "error reading CA cert";;
    *) echo "curl error $1";;
  esac
}

# any HTTP answer (200/400/404/...) means we reached Cloudflare; only an empty
# code or a transport failure (000) counts as blocked - same as warpscout
# apiReachable().
api_reachable() { [ -n "$CODE" ] && [ "$CODE" != "000" ]; }

# build our own bootstrap tunnel (warpscout keys) and find a live endpoint.
# leaves interface UP on success, cleaned up by caller. Returns 0 + echoes EP.
#
# The interface is configured with the FULL obfuscation set via `setconf`
# (Jc/Jmin/Jmax + S1-S4 + H1-H4 + I1, same as the firmware's TestWarp/TW2) and
# the endpoint is baked INTO the config file. IMPORTANT: after setconf we must
# NEVER mutate the peer with `amneziawg set ... peer ...` (remove/add/endpoint)
# while junk parameters are active - that trips a bad pointer in this kmod
# (kernel oops verified). To switch endpoints we recreate the interface.
bootstrap_up() {
  log "building bootstrap tunnel on $BOOT_IF (warpscout keys, full obfuscation)"
  log "bootstrap: host list: $BOOT_HOSTS"
  log "bootstrap: port list: $BOOT_PORTS"
  local host port ep hs now tries obfs rc
  tries=0
  obfs="full"
  for host in $BOOT_HOSTS; do
    for port in $BOOT_PORTS; do
      ep="$host:$port"
      tries=$((tries+1))
      log "bootstrap: [$tries] trying $ep (obfuscation=$obfs)"
      # recreate the interface for every candidate endpoint
      local i
      for i in 1 2 3; do
        ip link del $BOOT_IF 2>/dev/null && break
        sleep 1
      done
      modprobe amneziawg 2>/dev/null
      if ! ip link add dev $BOOT_IF type amneziawg 2>/dev/null; then
        log "bootstrap: cannot create interface $BOOT_IF"
        return 1
      fi
      ip link set $BOOT_IF up
      ip link set $BOOT_IF mtu 1280
      ip addr add $BOOT_IP/32 dev $BOOT_IF 2>/dev/null

      # full obfuscation config, endpoint baked in, applied with setconf
      # (exactly how netifd builds TestWarp/TW2).
      cat > /tmp/wr_boot.conf <<EOF
[Interface]
PrivateKey=$BOOT_PRIV
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
I1=<r 2><b 0x858000010001000000000669636c6f756403636f6d0000010001c00c000100010000105a00044d583737>

[Peer]
PublicKey=$BOOT_PEER
AllowedIPs=0.0.0.0/0
Endpoint=$ep
PersistentKeepalive=5
EOF
      amneziawg setconf $BOOT_IF /tmp/wr_boot.conf 2>/tmp/wr_setconf.err
      rc=$?
      rm -f /tmp/wr_boot.conf
      if [ "$rc" -ne 0 ]; then
        # kmods that reject the full junk set: fall back to a plain interface
        log "bootstrap: setconf(full obfuscation) failed rc=$rc, falling back to plain"
        [ -s /tmp/wr_setconf.err ] && log "bootstrap: setconf stderr: $(head -c 300 /tmp/wr_setconf.err)"
        cat > /tmp/wr_boot.conf <<EOF
[Interface]
PrivateKey=$BOOT_PRIV

[Peer]
PublicKey=$BOOT_PEER
AllowedIPs=0.0.0.0/0
Endpoint=$ep
PersistentKeepalive=5
EOF
        amneziawg setconf $BOOT_IF /tmp/wr_boot.conf 2>/tmp/wr_setconf.err
        rc=$?
        rm -f /tmp/wr_boot.conf
        obfs="plain"
        log "bootstrap: setconf(plain) rc=$rc"
        [ -s /tmp/wr_setconf.err ] && log "bootstrap: setconf stderr: $(head -c 300 /tmp/wr_setconf.err)"
      else
        log "bootstrap: setconf(full obfuscation) OK via $ep"
      fi
      rm -f /tmp/wr_setconf.err

      for i in 1 2 3; do
        hs=$(amneziawg show $BOOT_IF latest-handshakes 2>/dev/null | awk -v p="$BOOT_PEER" '$1==p{print $2;exit}')
        now=$(date +%s)
        if [ -n "$hs" ] && [ $((now-hs)) -lt 3 ]; then
          log "bootstrap: handshake OK via $ep (attempt $i/3, age $((now-hs))s)"
          # route only the bootstrap source IP through the tunnel (policy routing
          # so the router's own traffic is untouched)
          ip route add default dev $BOOT_IF table $BOOT_TABLE 2>/tmp/wr_route.err
          rc=$?
          if [ "$rc" -ne 0 ]; then
            log "bootstrap: WARNING ip route add failed rc=$rc: $(head -c 200 /tmp/wr_route.err)"
          fi
          ip rule add from $BOOT_IP/32 lookup $BOOT_TABLE prio 98 2>/tmp/wr_rule.err
          rc=$?
          if [ "$rc" -ne 0 ]; then
            log "bootstrap: WARNING ip rule add failed rc=$rc: $(head -c 200 /tmp/wr_rule.err)"
          fi
          rm -f /tmp/wr_route.err /tmp/wr_rule.err
          # verify the route actually resolves through the tunnel
          got=$(ip route get from $BOOT_IP to 1.1.1.1 2>/dev/null | head -1)
          log "bootstrap: route check: $got"
          log "bootstrap: policy route installed (table $BOOT_TABLE, source $BOOT_IP)"
          return 0
        fi
        log "bootstrap: no handshake via $ep (attempt $i/3, hs=${hs:-none})"
        sleep 1
      done
    done
  done
  log "bootstrap: no endpoint answered (tried $tries endpoints)"
  return 1
}

bootstrap_down() {
  ip rule del from $BOOT_IP/32 lookup $BOOT_TABLE prio 98 2>/dev/null
  ip route del default dev $BOOT_IF table $BOOT_TABLE 2>/dev/null
  ip link del $BOOT_IF 2>/dev/null
}

# Opera Proxy fallback (RouteRich feeds): a plain HTTP(S) proxy that tunnels
# out through Opera VPN. Used when the bootstrap tunnel failed (e.g. no
# reachable endpoint under DPI). Install via opkg if missing, start it, wait
# for the listen port and verify the API is reachable through it.
# On success sets OPROXY_ARG for curl and returns 0.
OPROXY_ADDR="127.0.0.1:18080"
OPROXY_PORT="18080"
OPROXY_WAIT=120
opera_up() {
  log "opera: installing/checking opera-proxy"
  if ! command -v opera-proxy >/dev/null 2>&1; then
    log "opera: not installed - opkg install opera-proxy"
    opkg install opera-proxy >/tmp/wr_opera.log 2>&1
    rc=$?
    if [ "$rc" -ne 0 ]; then
      log "opera: opkg install failed rc=$rc"
      opkg update >/tmp/wr_opera.log 2>&1
      log "opera: opkg update rc=$? - retrying install"
      opkg install opera-proxy >>/tmp/wr_opera.log 2>&1
      rc=$?
      [ "$rc" -ne 0 ] && log "opera: install failed again rc=$rc"
    fi
    if [ "$rc" -ne 0 ]; then
      log "opera: tail of opkg log: $(tail -c 400 /tmp/wr_opera.log | tr '\n' ' ')"
      return 1
    fi
    log "opera: installed"
  else
    log "opera: already installed ($(opera-proxy -version 2>/dev/null | head -1))"
  fi
  rm -f /tmp/wr_opera.log

  OPERA_OWN=0
  if netstat -tln 2>/dev/null | grep -q ":$OPROXY_PORT " || \
     (ss -tln 2>/dev/null | grep -q ":$OPROXY_PORT "); then
    log "opera: a proxy already listens on $OPROXY_ADDR - reusing it"
  else
    log "opera: starting temporary opera-proxy (listen $OPROXY_ADDR, wait up to ${OPROXY_WAIT}s)"
    opera-proxy -bind-address "$OPROXY_ADDR" >/tmp/opera.log 2>&1 &
    OPID=$!
    OPERA_OWN=1

    local waited
    waited=0
    while [ "$waited" -lt "$OPROXY_WAIT" ]; do
      if netstat -tln 2>/dev/null | grep -q ":$OPROXY_PORT " || \
         (ss -tln 2>/dev/null | grep -q ":$OPROXY_PORT "); then
        break
      fi
      sleep 1
      waited=$((waited+1))
      if [ $((waited % 15)) -eq 0 ]; then
        log "opera: still waiting for $OPROXY_ADDR (${waited}s)"
      fi
    done
    if ! netstat -tln 2>/dev/null | grep -q ":$OPROXY_PORT " && \
       ! (ss -tln 2>/dev/null | grep -q ":$OPROXY_PORT "); then
      log "opera: proxy did NOT start listening within ${OPROXY_WAIT}s"
      log "opera: tail of opera log: $(tail -c 400 /tmp/opera.log | tr '\n' ' ')"
      kill $OPID 2>/dev/null
      return 1
    fi
    log "opera: proxy listening on $OPROXY_ADDR"
    sleep 2
  fi

  log "opera: probing API through proxy (timeout 15s)"
  probe "$API/" "-x http://$OPROXY_ADDR"
  if api_reachable; then
    log "opera: api reachable via proxy (http $CODE)"
    OPROXY_ARG="-x http://$OPROXY_ADDR"
    return 0
  fi
  log "opera: api NOT reachable via proxy (curl_exit=$RC http=${CODE:-EMPTY})"
  return 1
}

opera_down() {
  # only stop the temporary instance we started ourselves; leave a system
  # service (procd respawn) alone so it keeps running for the user.
  if [ "${OPERA_OWN:-0}" = "1" ] && [ -n "$OPID" ]; then
    kill "$OPID" 2>/dev/null
    sleep 1
    kill -0 "$OPID" 2>/dev/null && kill -9 "$OPID" 2>/dev/null
  fi
  rm -f /tmp/opera.log
}

# teardown whatever fallback path we used (bootstrap tunnel or opera proxy)
teardown_path() {
  case "$IFACE_ARG" in
    "--interface $BOOT_IP")
      bootstrap_down
      log "bootstrap tunnel removed"
      ;;
    -x*)
      opera_down
      log "opera proxy stopped"
      ;;
  esac
}

# human-readable description of the path we are registering through
PATH_DESC=""
path_name() {
  case "$1" in
    "") echo "direct";;
    "--interface $TUNNEL_IF") echo "existing tunnel $TUNNEL_IF";;
    "--interface $BOOT_IP") echo "bootstrap tunnel";;
    -x*) echo "opera proxy $OPROXY_ADDR";;
    *) echo "$1";;
  esac
}

# 2. decide how to reach the API: direct, existing tunnel, or our own bootstrap
IFACE_ARG=""
PATH_OK=0
log "probing API directly: GET $API/ (timeout 4s)"
probe "$API/" ""
if api_reachable; then
  PATH_OK=1
  log "api reachable directly (http $CODE)"
else
  log "direct blocked (curl_exit=$RC http=${CODE:-EMPTY})"
  if ip link show "$TUNNEL_IF" >/dev/null 2>&1; then
    log "trying existing tunnel iface $TUNNEL_IF"
    probe "$API/" "--interface $TUNNEL_IF"
    if api_reachable; then
      PATH_OK=1
      IFACE_ARG="--interface $TUNNEL_IF"
      log "api reachable via $TUNNEL_IF (http $CODE)"
    else
      log "existing tunnel blocked too (curl_exit=$RC http=${CODE:-EMPTY})"
      IFACE_ARG=""
    fi
  else
    log "tunnel iface $TUNNEL_IF does NOT exist"
  fi
  if [ "$PATH_OK" != "1" ]; then
    if bootstrap_up; then
      log "bootstrap: API probe via tunnel (timeout 15s)"
      probe "$API/" "--interface $BOOT_IP" 15
      if api_reachable; then
        log "bootstrap: api reachable via tunnel (http $CODE)"
        PATH_OK=1
        IFACE_ARG="--interface $BOOT_IP"
      else
        log "bootstrap: tunnel up but API NOT reachable (curl_exit=$RC http=${CODE:-EMPTY}) - tearing down"
        bootstrap_down
        IFACE_ARG=""
      fi
    else
      log "bootstrap: FAILED - all candidate endpoints rejected"
    fi
  fi
  if [ "$PATH_OK" != "1" ]; then
    log "falling back to Opera Proxy"
    if opera_up; then
      PATH_OK=1
      IFACE_ARG="$OPROXY_ARG"
    else
      opera_down
    fi
  fi
fi

if [ "$PATH_OK" != "1" ]; then
  log "FATAL: no path to the API (direct, existing tunnel, bootstrap, opera all failed)"
  exit 1
fi
log "registering via $(path_name "$IFACE_ARG")"

# 3. register
register_curl POST "$API" "$IFACE_ARG" "" "$BODY" /tmp/wr_reg
log "register: curl_exit=$RC http_code=${CODE:-EMPTY}"
[ -n "$ERR" ] && log "curl stderr: $ERR"
if [ "$RC" -ne 0 ]; then
  log "FATAL: $(curl_errmsg "$RC") via $(path_name "$IFACE_ARG")"
  rm -f /tmp/wr_reg /tmp/wr_reg.code /tmp/wr_reg.err
  teardown_path
  exit 1
fi
REG=$(cat /tmp/wr_reg 2>/dev/null)
if [ -z "$REG" ]; then
  log "FATAL: API returned empty body (http $CODE via $(path_name "$IFACE_ARG"))"
  rm -f /tmp/wr_reg /tmp/wr_reg.code /tmp/wr_reg.err
  teardown_path
  exit 1
fi
if [ "$CODE" != "200" ]; then
  log "FATAL: API answered http $CODE instead of 200"
  log "  body: $(echo "$REG" | head -c 500)"
  rm -f /tmp/wr_reg /tmp/wr_reg.code /tmp/wr_reg.err
  teardown_path
  exit 1
fi
ID=$(echo "$REG" | jq -r '.id' 2>/dev/null)
TOKEN=$(echo "$REG" | jq -r '.token' 2>/dev/null)
if [ -z "$ID" ] || [ "$ID" = "null" ]; then
  log "FATAL: no 'id' in successful registration response"
  log "  body: $(echo "$REG" | head -c 500)"
  rm -f /tmp/wr_reg /tmp/wr_reg.code /tmp/wr_reg.err
  teardown_path
  exit 1
fi
log "register OK: id=${ID%????}**** token present=$([ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] && echo yes || echo no)"

# 4. enable warp
log "PATCH enable warp via $(path_name "$IFACE_ARG") (timeout 15s)"
register_curl PATCH "$API/$ID" "$IFACE_ARG" "$TOKEN" '{"warp_enabled":true}' /tmp/wr_patch
log "enable warp: curl_exit=$RC http_code=${CODE:-EMPTY}"
[ -n "$ERR" ] && log "curl stderr: $ERR"
if [ "$CODE" != "200" ] && [ "$CODE" != "204" ]; then
  log "note: warp_enabled patch returned ${CODE:-none} - continuing"
fi
rm -f /tmp/wr_patch /tmp/wr_patch.code /tmp/wr_patch.err

PEER=$(echo "$REG" | jq -r '.config.peers[0].public_key')
ADDR=$(echo "$REG" | jq -r '.config.interface.addresses.v4')
log "peer=$PEER addr=$ADDR"

ENABLED=false
if [ "$CODE" = "200" ] || [ "$CODE" = "204" ]; then
  ENABLED=true
fi

echo "$REG" | jq --arg priv "$PRIV" --arg peer "$PEER" --arg addr "$ADDR" \
  --argjson enabled "$ENABLED" \
  '{id: .id, token: .token, private_key: $priv, peer_public_key: $peer, address: $addr, warp_enabled: $enabled}' \
  > "${ACCOUNT_FILE}.tmp" && mv "${ACCOUNT_FILE}.tmp" "$ACCOUNT_FILE"
log "account saved to $ACCOUNT_FILE"

# 5. teardown: remove whatever fallback path we used
teardown_path
rm -f /tmp/wr_reg /tmp/wr_reg.code /tmp/wr_reg.err /tmp/wr_probe.code /tmp/wr_probe.err
cat "$ACCOUNT_FILE"
exit 0
