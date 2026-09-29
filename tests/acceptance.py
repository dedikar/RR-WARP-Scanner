"""On-router acceptance test for luci-app-rrwg.

Runs through the same ubus methods the LuCI page uses, so it exercises the whole
path: backend -> engine -> JSON report -> scanResult.

Credentials come from the environment (see tests/router.py); there is no
hard-coded password.
"""
import json
import sys
import time

from router import connect, run

c = connect()

# Narrow the run to one subnet so the acceptance pass stays quick, then go
# through the same ubus calls the page makes.
NARROW = {
    "sample": 12, "timeout": 3, "jobs": 8, "proto": "awg",
    "tg": True, "tun_ping": True,
    "exclude": [
        "8.6.112.0/24", "8.34.70.0/24", "8.34.146.0/24", "8.35.211.0/24",
        "8.39.125.0/24", "8.39.204.0/24", "8.39.214.0/24", "8.47.69.0/24",
        "188.114.96.0/24", "188.114.97.0/24", "188.114.98.0/24",
        "188.114.99.0/24", "162.159.195.0/24",
    ],
}

print(run(c, "ubus call luci.rrwg saveOpts '%s' 2>&1 | head -3" % json.dumps(NARROW)))

print('--- scanStart ---')
print(run(c, 'ubus call luci.rrwg scanStart 2>&1 | head -4'))

print('--- polling scanStatus ---')
last = ''
for n in range(40):
    st = run(c, 'ubus call luci.rrwg scanStatus 2>&1').strip()
    try:
        d = json.loads(st)
        line = 'phase=%s done=%s/%s running=%s' % (
            d.get('phase'), d.get('done'), d.get('total'), d.get('running'))
    except Exception:
        line = st[:120]
    if line != last:
        print('  [%02ds] %s' % (n * 3, line))
        last = line
    if 'running=False' in line.replace(' ', ''):
        break
    time.sleep(3)

print('--- scanResult ---')
res = run(c, 'ubus call luci.rrwg scanResult 2>&1')
try:
    d = json.loads(res)
    print('working=%s probed=%s tg_working=%s' % (
        d.get('working'), d.get('probed'), d.get('tg_working')))
    for x in d.get('endpoints', [])[:14]:
        print('  %-24s %-4s %-3s ping=%-4s tun=%-4s loss=%-4s TG=%s/%s torn=%s' % (
            x.get('endpoint'), x.get('node'), x.get('country'), x.get('ping_ms'),
            x.get('tun_ping_ms'), x.get('loss_pct'),
            x.get('tg_dcs'), x.get('tg_total'), x.get('torn')))
except Exception as ex:
    print('parse error:', ex)
    print(res[:1200])

c.close()
