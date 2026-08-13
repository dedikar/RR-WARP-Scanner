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
# fallback API path (newer version, used by warp-config-generator / llimonix).
# If the primary path answers HTTP 4xx/5xx (not 000 - that means blocked, not
# a bad path), retry the whole registration through this one.
API2="https://api.cloudflareclient.com/v0i1909051800/reg"

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
# I1 masks tried for the bootstrap tunnel, in order. The first is the
# classic iCloud-DNS lookalike used by the firmware; the QUIC ones are
# TLS/ClientHello-shaped masks (from warp-config-generator / llimonix)
# that get through DPI which fingerprints the iCloud first packet.
I1_ICLOUD="<r 2><b 0x858000010001000000000669636c6f756403636f6d0000010001c00c000100010000105a00044d583737>"
I1_QUIC1="<b 0xc10000000114367096bb0fb3f58f3a3fb8aaacd61d63a1c8a40e14f7374b8a62dccba6431716c3abf6f5afbcfb39bd008000047c32e268567c652e6f4db58bff759bc8c5aaca183b87cb4d22938fe7d8dca22a679a79e4d9ee62e4bbb3a380dd78d4e8e48f26b38a1d42d76b371a5a9a0444827a69d1ab5872a85749f65a4104e931740b4dc1e2dd77733fc7fac4f93011cd622f2bb47e85f71992e2d585f8dc765a7a12ddeb879746a267393ad023d267c4bd79f258703e27345155268bd3cc0506ebd72e2e3c6b5b0f005299cd94b67ddabe30389c4f9b5c2d512dcc298c14f14e9b7f931e1dc397926c31fbb7cebfc668349c218672501031ecce151d4cb03c4c660b6c6fe7754e75446cd7de09a8c81030c5f6fb377203f551864f3d83e27de7b86499736cbbb549b2f37f436db1cae0a4ea39930f0534aacdd1e3534bc87877e2afabe959ced261f228d6362e6fd277c88c312d966c8b9f67e4a92e757773db0b0862fb8108d1d8fa262a40a1b4171961f0704c8ba314da2482ac8ed9bd28d4b50f7432d89fd800c25a50c5e2f5c0710544fef5273401116aa0572366d8e49ad758fcb29e6a92912e644dbe227c247cb3417eabfab2db16796b2fba420de3b1dc94e8361f1f324a331ddaf1e626553138860757fd0bf687566108b77b70fb9f8f8962eca599c4a70ed373666961a8cb506b96756d9e28b94122b20f16b54f118c0e603ce0b831efea614ad836df6cf9affbdd09596412547496967da758cec9080295d853b0861670b71d9abde0d562b1a6de82782a5b0c14d297f27283a895abc889a5f6703f0e6eb95f67b2da45f150d0d8ab805612d570c2d5cb6997ac3a7756226c2f5c8982ffbd480c5004b0660a3c9468945efde90864019a2b519458724b55d766e16b0da25c0557c01f3c11ddeb024b62e303640e17fdd57dedb3aeb4a2c1b7c93059f9c1d7118d77caac1cd0f6556e46cbc991c1bb16970273dea833d01e5090d061a0c6d25af2415cd2878af97f6d0e7f1f936247b394ecb9bd484da6be936dee9b0b92dc90101a1b4295e97a9772f2263eb09431995aa173df4ca2abd687d87706f0f93eaa5e13cbe3b574fa3cfe94502ace25265778da6960d561381769c24e0cbd7aac73c16f95ae74ff7ec38124f7c722b9cb151d4b6841343f29be8f35145e1b27021056820fed77003df8554b4155716c8cf6049ef5e318481460a8ce3be7c7bfac695255be84dc491c19e9dedc449dd3471728cd2a3ee51324ccb3eef121e3e08f8e18f0006ea8957371d9f2f739f0b89e4db11e5c6430ada61572e589519fbad4498b460ce6e4407fc2d8f2dd4293a50a0cb8fcaaf35cd9a8cc097e3603fbfa08d9036f52b3e7fcce11b83ad28a4ac12dba0395a0cc871cefd1a2856fffb3f28d82ce35cf80579974778bab13d9b3578d8c75a2d196087a2cd439aff2bb33f2db24ac175fff4ed91d36a4cdbfaf3f83074f03894ea40f17034629890da3efdbb41141b38368ab532209b69f057ddc559c19bc8ae62bf3fd564c9a35d9a83d14a95834a92bae6d9a29ae5e8ece07910d16433e4c6230c9bd7d68b47de0de9843988af6dc88b5301820443bd4d0537778bf6b4c1dd067fcf14b81015f2a67c7f2a28f9cb7e0684d3cb4b1c24d9b343122a086611b489532f1c3a26779da1706c6759d96d8ab>"
I1_QUIC2="<b 0xce000000010897a297ecc34cd6dd000044d0ec2e2e1ea2991f467ace4222129b5a098823784694b4897b9986ae0b7280135fa85e196d9ad980b150122129ce2a9379531b0fd3e871ca5fdb883c369832f730e272d7b8b74f393f9f0fa43f11e510ecb2219a52984410c204cf875585340c62238e14ad04dff382f2c200e0ee22fe743b9c6b8b043121c5710ec289f471c91ee414fca8b8be8419ae8ce7ffc53837f6ade262891895f3f4cecd31bc93ac5599e18e4f01b472362b8056c3172b513051f8322d1062997ef4a383b01706598d08d48c221d30e74c7ce000cdad36b706b1bf9b0607c32ec4b3203a4ee21ab64df336212b9758280803fcab14933b0e7ee1e04a7becce3e2633f4852585c567894a5f9efe9706a151b615856647e8b7dba69ab357b3982f554549bef9256111b2d67afde0b496f16962d4957ff654232aa9e845b61463908309cfd9de0a6abf5f425f577d7e5f6440652aa8da5f73588e82e9470f3b21b27b28c649506ae1a7f5f15b876f56abc4615f49911549b9bb39dd804fde182bd2dcec0c33bad9b138ca07d4a4a1650a2c2686acea05727e2a78962a840ae428f55627516e73c83dd8893b02358e81b524b4d99fda6df52b3a8d7a5291326e7ac9d773c5b43b8444554ef5aea104a738ed650aa979674bbed38da58ac29d87c29d387d80b526065baeb073ce65f075ccb56e47533aef357dceaa8293a523c5f6f790be90e4731123d3c6152a70576e90b4ab5bc5ead01576c68ab633ff7d36dcde2a0b2c68897e1acfc4d6483aaaeb635dd63c96b2b6a7a2bfe042f6aed82e5363aa850aace12ee3b1a93f30d8ab9537df483152a5527faca21efc9981b304f11fc95336f5b9637b174c5a0659e2b22e159a9fed4b8e93047371175b1d6d9cc8ab745f3b2281537d1c75fb9451871864efa5d184c38c185fd203de206751b92620f7c369e031d2041e152040920ac2c5ab5340bfc9d0561176abf10a147287ea90758575ac6a9f5ac9f390d0d5b23ee12af583383d994e22c0cf42383834bcd3ada1b3825a0664d8f3fb678261d57601ddf94a8a68a7c273a18c08aa99c7ad8c6c42eab67718843597ec9930457359dfdfbce024afc2dcf9348579a57d8d3490b2fa99f278f1c37d87dad9b221acd575192ffae1784f8e60ec7cee4068b6b988f0433d96d6a1b1865f4e155e9fe020279f434f3bf1bd117b717b92f6cd1cc9bea7d45978bcc3f24bda631a36910110a6ec06da35f8966c9279d130347594f13e9e07514fa370754d1424c0a1545c5070ef9fb2acd14233e8a50bfc5978b5bdf8bc1714731f798d21e2004117c61f2989dd44f0cf027b27d4019e81ed4b5c31db347c4a3a4d85048d7093cf16753d7b0d15e078f5c7a5205dc2f87e330a1f716738dce1c6180e9d02869b5546f1c4d2748f8c90d9693cba4e0079297d22fd61402dea32ff0eb69ebd65a5d0b687d87e3a8b2c42b648aa723c7c7daf37abcc4bb85caea2ee8f55bec20e913b3324ab8f5c3304f820d42ad1b9f2ffc1a3af9927136b4419e1e579ab4c2ae3c776d293d397d575df181e6cae0a4ada5d67ecea171cca3288d57c7bbdaee3befe745fb7d634f70386d873b90c4d6c6596bb65af68f9e5121e67ebf0d89d3c909ceedfb32ce9575a7758ff080724e1ab5d5f43074ecb53a479af21ed03d7b6899c36631c0166f9d47e5e1d4528a5d3d3f744029c4b1c190cbfbad06f5f83f7ad0429fa9a2719c56ffe3783460e166de2d8>"


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
  # try the different I1 masks in order: the iCloud-DNS one first (firmware
  # default), then the QUIC-shaped ones which fool DPI that fingerprints the
  # iCloud first packet. Switching I1 means recreating the interface, which
  # the host/port loop below already does for every candidate endpoint.
  for i1 in "$I1_ICLOUD" "$I1_QUIC1" "$I1_QUIC2"; do
  I1_CUR="$i1"
  for host in $BOOT_HOSTS; do
    for port in $BOOT_PORTS; do
      ep="$host:$port"
      tries=$((tries+1))
      log "bootstrap: [$tries] trying $ep (obfuscation=$obfs, i1=${I1_CUR:0:20}...)"
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
I1=$I1_CUR

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
  log "bootstrap: no endpoint answered with i1=${I1_CUR:0:20}... (tried $tries endpoints)"
  done
  log "bootstrap: all I1 masks exhausted (tried $tries endpoints)"
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
REGISTER_API="$API"
register_curl POST "$REGISTER_API" "$IFACE_ARG" "" "$BODY" /tmp/wr_reg
log "register: curl_exit=$RC http_code=${CODE:-EMPTY}"
[ -n "$ERR" ] && log "curl stderr: $ERR"
# if the primary API path answered with a non-2xx HTTP code (not 000 - that
# would be a transport block, not a bad path), the endpoint version may have
# been retired: retry once through the newer API2 path.
if [ "$RC" -eq 0 ] && [ "$CODE" != "000" ] && [ "$CODE" != "200" ]; then
  log "register: http $CODE via $REGISTER_API - retrying via $API2"
  register_curl POST "$API2" "$IFACE_ARG" "" "$BODY" /tmp/wr_reg
  log "register(api2): curl_exit=$RC http_code=${CODE:-EMPTY}"
  [ -n "$ERR" ] && log "curl stderr: $ERR"
  REGISTER_API="$API2"
fi
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
# API version differences: v0a4005 answers flat {id,token,...}, while newer
# v0i1909051800 wraps everything in "result": {...}. (.result // .) picks the
# right object for both so the rest of the script is version-agnostic.
ID=$(echo "$REG" | jq -r '(.result // .).id' 2>/dev/null)
TOKEN=$(echo "$REG" | jq -r '(.result // .).token' 2>/dev/null)
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
register_curl PATCH "$REGISTER_API/$ID" "$IFACE_ARG" "$TOKEN" '{"warp_enabled":true}' /tmp/wr_patch
log "enable warp: curl_exit=$RC http_code=${CODE:-EMPTY}"
[ -n "$ERR" ] && log "curl stderr: $ERR"
if [ "$CODE" != "200" ] && [ "$CODE" != "204" ]; then
  log "note: warp_enabled patch returned ${CODE:-none} - continuing"
fi
rm -f /tmp/wr_patch /tmp/wr_patch.code /tmp/wr_patch.err

PEER=$(echo "$REG" | jq -r '(.result // .).config.peers[0].public_key')
ADDR=$(echo "$REG" | jq -r '(.result // .).config.interface.addresses.v4')
log "peer=$PEER addr=$ADDR"

ENABLED=false
if [ "$CODE" = "200" ] || [ "$CODE" = "204" ]; then
  ENABLED=true
fi

echo "$REG" | jq --arg priv "$PRIV" --arg peer "$PEER" --arg addr "$ADDR" \
  --argjson enabled "$ENABLED" \
  '{id: (.result // .).id, token: (.result // .).token, private_key: $priv, peer_public_key: $peer, address: $addr, warp_enabled: $enabled}' \
  > "${ACCOUNT_FILE}.tmp" && mv "${ACCOUNT_FILE}.tmp" "$ACCOUNT_FILE"
log "account saved to $ACCOUNT_FILE"

# 5. teardown: remove whatever fallback path we used
teardown_path
rm -f /tmp/wr_reg /tmp/wr_reg.code /tmp/wr_reg.err /tmp/wr_probe.code /tmp/wr_probe.err
cat "$ACCOUNT_FILE"
exit 0
