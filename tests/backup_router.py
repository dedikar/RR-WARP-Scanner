"""Back up everything this package owns on the router.

Run this before a change that touches the backend or the page, so a bad change
can be undone with tests/restore_router.py instead of re-registering the WARP
account and rescanning for endpoints.

    ROUTER_PASS=... python backup_router.py [destination-dir]

The account and the settings are the point: they cannot be rebuilt from source.
/usr/bin/rrws is not saved (it is reproducible with build.sh and 3 MB through a
shell channel is a bad trade), and neither is /tmp state, which is by design
volatile.
"""
import os
import sys
import time

from router import connect, run

FILES = {
    'rrws-account.json':        '/etc/rrws-account.json',
    'rrws-settings.json':       '/etc/rrws-settings.json',
    'rrws-last-result.json':    '/etc/rrws-last-result.json',
    'menu.d-rrws.json':         '/usr/share/luci/menu.d/rrws.json',
    'acl.d-luci-app-rrws.json': '/usr/share/rpcd/acl.d/luci-app-rrws.json',
    'ucode-luci.rrws':          '/usr/share/rpcd/ucode/luci.rrws',
    'keep.d-luci-app-rrws':     '/lib/upgrade/keep.d/luci-app-rrws',
    'view-scan.js':             '/www/luci-static/resources/view/rrws/scan.js',
    'installed-control.txt':    '/usr/lib/opkg/info/luci-app-rrws.control',
}


def main():
    dest = sys.argv[1] if len(sys.argv) > 1 else \
        os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'backup',
                     'router-%s' % time.strftime('%Y%m%d-%H%M%S'))
    dest = os.path.abspath(dest)
    os.makedirs(dest, exist_ok=True)

    c = connect()
    saved = missing = 0
    for name, path in FILES.items():
        data = run(c, 'cat %s 2>/dev/null' % path)
        if not data.strip():
            print('  нет      %-26s %s' % (name, path))
            missing += 1
            continue
        # Text over the exec channel; the router has no base64. newline='' keeps
        # the router's own LF endings instead of translating them.
        with open(os.path.join(dest, name), 'w', encoding='utf-8', newline='') as fh:
            fh.write(data)
        print('  сохранён %-26s %d байт' % (name, os.path.getsize(os.path.join(dest, name))))
        saved += 1

    with open(os.path.join(dest, 'info.txt'), 'w', encoding='utf-8') as fh:
        fh.write('бэкап: %s\n\n' % time.strftime('%Y-%m-%d %H:%M:%S'))
        fh.write(run(c, 'ubus call luci.rrws version 2>&1'))
        fh.write(run(c, '/usr/bin/rrws version 2>&1'))
        fh.write(run(c, 'opkg list-installed | grep -i rrw'))
        fh.write(run(c, 'df -h /overlay | tail -1'))
        fh.write(run(c, 'ls -la /usr/bin/rrws /etc/rrws-*.json 2>&1'))
    c.close()

    print()
    print('сохранено %d, отсутствует %d' % (saved, missing))
    print('каталог: %s' % dest)
    return 0


if __name__ == '__main__':
    sys.exit(main())
