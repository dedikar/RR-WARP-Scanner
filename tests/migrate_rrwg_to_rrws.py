"""One-off: drop the old luci-app-rrwg package and its leftovers, install luci-app-rrws.

Run once on the test router after the package was renamed. It removes the old
package (which the router still has installed under the name it was built with),
sweeps the state files whose names changed, and installs the new IPK.

    ROUTER_PASS=... python migrate_rrwg_to_rrws.py [path-to.ipk]

Nothing here is needed on a clean install: a fresh router never had rrwg.
"""
import os
import sys

from router import connect, run

IPK = sys.argv[1] if len(sys.argv) > 1 else \
    'build/luci-app-rrws_0.3.1-r20_all.ipk'

# Paths the OLD package created that the new one does not know about: the engine
# binary, the ubus module, the menu/ACL entries, and the state files whose names
# changed. /etc/rrwg-* holds the registered account - it is carried over to the
# new name so the router keeps its WARP identity instead of re-registering.
OLD_PATHS = [
    '/usr/bin/rrwg',
    '/usr/share/rpcd/ucode/luci.rrwg',
    '/usr/share/luci/menu.d/rrwg.json',
    '/usr/share/rpcd/acl.d/luci-app-rrwg.json',
    '/lib/upgrade/keep.d/luci-app-rrwg',
    '/tmp/rrwg_state.json', '/tmp/rrwg_result.json', '/tmp/rrwg.rpc.log',
]

CARRIED_OVER = [
    ('/etc/rrwg-account.json', '/etc/rrws-account.json'),
    ('/etc/rrwg-settings.json', '/etc/rrws-settings.json'),
    ('/etc/rrwg-last-result.json', '/etc/rrws-last-result.json'),
]

c = connect()

print('--- before ---')
print(run(c, 'opkg list-installed | grep -i rrw || echo "(none)"'))

print('--- removing old package ---')
print(run(c, 'opkg remove luci-app-rrwg 2>&1 | tail -5'))

print('--- carrying the account over to the new name ---')
for src, dst in CARRIED_OVER:
    print(run(c, '[ -f %s ] && cp %s %s && echo "%s -> %s" || echo "skip %s"'
                % (src, src, dst, src, dst, src)).strip())

print('--- sweeping leftovers ---')
for p in OLD_PATHS:
    print(run(c, 'rm -rf %s' % p).strip() or p)

# The scan may have left a process and a state directory behind.
print(run(c, 'killall rrwg 2>/dev/null; rm -rf /tmp/rrwg-state /tmp/rrwg; echo swept'))

print('--- installing new package ---')
with open(IPK, 'rb') as fh:
    data = fh.read()
sftp = c.open_sftp()
with sftp.open('/tmp/luci-app-rrws.ipk', 'wb') as remote:
    remote.write(data)
sftp.close()
print('uploaded %d bytes' % len(data))
print(run(c, 'opkg install --force-reinstall /tmp/luci-app-rrws.ipk 2>&1 | tail -8'))

print('--- after ---')
print(run(c, 'opkg list-installed | grep -i rrw || echo "(none)"'))
print(run(c, 'ubus call luci.rrws version 2>&1'))
print(run(c, '/usr/bin/rrws version 2>&1'))
print(run(c, 'logread | grep -i rrws | tail -3'))
