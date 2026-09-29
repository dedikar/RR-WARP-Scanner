"""Worker-count benchmark for the router.

Measures how scan time and system load change with the number of parallel
tunnels, so the UI cap is based on a number rather than a guess. The result is
recorded in the README's "Потоки (замерено)" table.

Credentials come from the environment (see tests/router.py).

    ROUTER_PASS=... python bench_jobs.py
"""
import json
import shlex
import time

from router import connect, run

# Workload held constant across runs: one subnet removed from the pool, a fixed
# host count, Telegram and the speed phase off, so the worker count is the only
# variable. Run on the full pool instead by clearing `exclude`.
EXCLUDE = [
    "162.159.192.0/24", "162.159.195.0/24",
    "188.114.96.0/24", "188.114.97.0/24",
    "188.114.98.0/24", "188.114.99.0/24",
    "8.6.112.0/24", "8.34.146.0/24", "8.35.211.0/24",
    "8.39.125.0/24", "8.39.204.0/24", "8.39.214.0/24", "8.47.69.0/24",
]
SAMPLE = 120
JOBS = [8, 32, 64, 128, 192, 256]


def measure(c, jobs):
    payload = json.dumps({
        "exclude": EXCLUDE, "sample": SAMPLE, "timeout": 3, "jobs": jobs,
        "tg": False, "tun_ping": True, "speed": False, "port": 0,
    })
    run(c, 'ubus call luci.rrwg saveOpts %s >/dev/null 2>&1' % shlex.quote(payload))
    run(c, 'rm -f /tmp/rrwg-state/pid /tmp/rrwg-state/progress /tmp/rrwg_result.json')
    time.sleep(1)

    t0 = time.time()
    run(c, 'ubus call luci.rrwg scanStart >/dev/null 2>&1')

    peak = 0.0
    min_free = 10 ** 9
    while time.time() - t0 < 500:
        time.sleep(3)
        if run(c, 'cat /tmp/rrwg-state/progress 2>/dev/null').strip() == 'done':
            break
        try:
            peak = max(peak, float(run(c, 'cut -d" " -f1 /proc/loadavg').strip()))
        except ValueError:
            pass
        try:
            min_free = min(min_free, int(run(c, "free | awk '/Mem:/{print $4}'").strip()))
        except ValueError:
            pass

    elapsed = time.time() - t0
    try:
        working = json.loads(run(c, 'cat /tmp/rrwg_result.json'))['working']
    except Exception:
        working = -1
    return elapsed, working, peak, min_free


c = connect()
print('%-7s %-9s %-9s %-11s %s' % ('jobs', 'time', 'working', 'peak_load', 'free_min'))
for j in JOBS:
    sec, w, peak, free = measure(c, j)
    print('%-7d %-9s %-9d %-11.2f %sKB' % (j, '%.1fs' % sec, w, peak, free))
    time.sleep(5)
c.close()
