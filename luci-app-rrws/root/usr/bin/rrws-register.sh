#!/bin/sh
# RRWS registration ladder: standard attempt, then zeroblock, then opera-proxy
# as the last resort. Launched detached by luci.rrws; stdout and stderr land in
# the registration log, so every line here is visible on the page.

BIN=/usr/bin/rrws
ACCOUNT=/etc/rrws-account.json
MARK=/tmp/rrws-state/registering
ZB=127.0.0.2:19999
OP=127.0.0.1:18080
EXTRA="$1"

trap 'rm -f "$MARK"' EXIT

stamp() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(stamp) ladder  $*"; }

listening() { netstat -tln 2>/dev/null | grep -q "$1"; }

# The engine bounds itself; this only guards against a hang.
run_engine() {
	"$BIN" register "$@" &
	epid=$!
	i=0
	while [ "$i" -lt 300 ] && kill -0 "$epid" 2>/dev/null; do
		sleep 1
		i=$((i + 1))
	done
	if kill -0 "$epid" 2>/dev/null; then
		log "engine still running after ${i}s, killing"
		kill "$epid" 2>/dev/null
	fi
	wait "$epid" 2>/dev/null
}

ok() { [ "$1" -eq 0 ] && [ -s "$ACCOUNT" ]; }

log "stage 1: standard registration"
run_engine $EXTRA -a "$ACCOUNT"
rc=$?
if ok "$rc"; then
	log "account registered (standard path)"
	exit 0
fi

if listening "$ZB"; then
	log "stage 2: registering through zeroblock ($ZB)"
	run_engine $EXTRA -x "http://$ZB" -a "$ACCOUNT"
	rc=$?
	if ok "$rc"; then
		log "account registered (zeroblock)"
		exit 0
	fi
else
	log "stage 2: zeroblock not detected on $ZB, skipping"
fi

log "stage 3: opera-proxy as the last resort"
if opkg list-installed 2>/dev/null | grep -q '^opera-proxy'; then
	log "opera-proxy already installed"
else
	log "installing opera-proxy from the feed"
	opkg install opera-proxy || log "opera-proxy install failed"
fi
/etc/init.d/opera-proxy start 2>/dev/null
i=0
while [ "$i" -lt 20 ] && ! listening "$OP"; do
	sleep 1
	i=$((i + 1))
done
if listening "$OP"; then
	log "registering through opera-proxy ($OP)"
	run_engine $EXTRA -x "http://$OP" -a "$ACCOUNT"
	rc=$?
	if ok "$rc"; then
		log "account registered (opera-proxy)"
		exit 0
	fi
else
	log "opera-proxy did not come up on $OP"
fi

log "registration failed: all paths exhausted"
exit 1
