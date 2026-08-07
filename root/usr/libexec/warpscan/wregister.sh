#!/bin/sh
# WARP account registration for OpenWrt
# Registers a fresh WARP device. If api.cloudflareclient.com is blocked directly,
# registers THROUGH an existing amneziawg tunnel interface (like warpscout fallback).
# Writes account to stdout JSON. Read-only on system (only /tmp).

ACCOUNT_FILE="/etc/warpscan-account.json"
TUNNEL_IF="warp"
API="https://api.cloudflareclient.com/v0a4005/reg"

usage() { echo "usage: wregister.sh [-t tunnel_if] [-o file]"; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    -t) TUNNEL_IF="$2"; shift 2;;
    -o) ACCOUNT_FILE="$2"; shift 2;;
    *) usage;;
  esac
done

# 1. generate keypair
PRIV=$(amneziawg genkey)
[ -n "$PRIV" ] || { echo "genkey failed"; exit 1; }
PUB=$(echo "$PRIV" | amneziawg pubkey)

# decide how to reach the API: direct or via tunnel
IFACE_ARG=""
if curl -s -o /dev/null --max-time 4 -w '%{http_code}' "$API/" 2>/dev/null | grep -q '^[24]0'; then
  echo "[wregister] api reachable directly" >&2
else
  IFACE_ARG="--interface $TUNNEL_IF"
  echo "[wregister] direct blocked, using tunnel $TUNNEL_IF" >&2
fi

BODY="{\"key\":\"$PUB\",\"install_id\":\"\",\"fcm_token\":\"\",\"tos\":\"2024-06-11T04:00:00.000Z\",\"type\":\"Android\",\"model\":\"\"}"

# 2. register
REG=$(curl -s --max-time 12 $IFACE_ARG \
  -X POST "$API" \
  -H "Content-Type: application/json" \
  -H "User-Agent: okhttp/3.12.1" \
  -d "$BODY" 2>/dev/null)
[ -n "$REG" ] || { echo "registration request failed (api unreachable even via tunnel)"; exit 1; }

ID=$(echo "$REG" | jq -r '.id' 2>/dev/null)
TOKEN=$(echo "$REG" | jq -r '.token' 2>/dev/null)
[ -n "$ID" ] && [ "$ID" != "null" ] || { echo "bad registration response: $(echo "$REG" | head -c 300)"; exit 1; }

# 3. enable warp
curl -s --max-time 12 $IFACE_ARG \
  -X PATCH "$API/$ID" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "User-Agent: okhttp/3.12.1" \
  -d '{"warp_enabled":true}' > /dev/null 2>&1

PEER=$(echo "$REG" | jq -r '.config.peers[0].public_key')
ADDR=$(echo "$REG" | jq -r '.config.interface.addresses.v4')

echo "$REG" | jq --arg priv "$PRIV" --arg peer "$PEER" --arg addr "$ADDR" \
  '{id: .id, token: .token, private_key: $priv, peer_public_key: $peer, address: $addr, warp_enabled: .warp_enabled}' \
  > "${ACCOUNT_FILE}.tmp" && mv "${ACCOUNT_FILE}.tmp" "$ACCOUNT_FILE"
echo "[wregister] account saved to $ACCOUNT_FILE" >&2
cat "$ACCOUNT_FILE"
exit 0