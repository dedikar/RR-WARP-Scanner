"""Restore a router backup made by tests/backup_router.py.

The backup holds the files this package owns on the router, including the WARP
account and the settings - the two things that cannot be rebuilt from source.
It is a safety net for UI and backend changes: if a change breaks the page, this
puts the working version back without re-registering the account or rescanning.

    ROUTER_PASS=... python restore_router.py backup/router-<stamp>
    ROUTER_PASS=... python restore_router.py            # lists what is available

No base64 on the router, so files go over the exec channel as text. The binary
/usr/bin/rrws is deliberately NOT part of this backup: it is reproducible from
source by build.sh, and 3 MB of text through a shell heredoc is a poor trade.
Reinstall the IPK instead if the engine itself is in question.
"""
import os
import sys

from router import connect, run

HERE = os.path.dirname(os.path.abspath(__file__))

# Where each backed-up file belongs on the router.
TARGETS = {
    'rrws-account.json':        '/etc/rrws-account.json',
    'rrws-settings.json':       '/etc/rrws-settings.json',
    'rrws-last-result.json':    '/etc/rrws-last-result.json',
    'menu.d-rrws.json':         '/usr/share/luci/menu.d/rrws.json',
    'acl.d-luci-app-rrws.json': '/usr/share/rpcd/acl.d/luci-app-rrws.json',
    'ucode-luci.rrws':          '/usr/share/rpcd/ucode/luci.rrws',
    'keep.d-luci-app-rrws':     '/lib/upgrade/keep.d/luci-app-rrws',
    'view-scan.js':             '/www/luci-static/resources/view/rrws/scan.js',
}

# Modes matter: rpcd silently ignores a world-writable ucode file, and a
# non-executable keep.d is simply skipped at upgrade time.
MODES = {
    '/usr/share/rpcd/ucode/luci.rrws': '644',
    '/usr/share/luci/menu.d/rrws.json': '644',
    '/usr/share/rpcd/acl.d/luci-app-rrws.json': '644',
    '/lib/upgrade/keep.d/luci-app-rrws': '644',
    '/www/luci-static/resources/view/rrws/scan.js': '644',
    '/etc/rrws-account.json': '600',
    '/etc/rrws-settings.json': '600',
    '/etc/rrws-last-result.json': '600',
}


def pick_backup(argv):
    if len(argv) > 1:
        return argv[1]
    root = os.path.join(HERE, '..', 'backup')
    if not os.path.isdir(root):
        return None
    found = sorted(d for d in os.listdir(root) if d.startswith('router-'))
    if not found:
        return None
    return os.path.join(root, found[-1])


def main():
    target = pick_backup(sys.argv)
    if not target or not os.path.isdir(target):
        print('Нет каталога бэкапа. Доступные:')
        root = os.path.join(HERE, '..', 'backup')
        if os.path.isdir(root):
            for d in sorted(os.listdir(root)):
                print('  ', os.path.join(root, d))
        return 2

    print('Восстанавливаю из %s' % os.path.abspath(target))
    c = connect()
    for name, dest in TARGETS.items():
        src = os.path.join(target, name)
        if not os.path.isfile(src):
            print('  пропуск  %-26s (нет в бэкапе)' % name)
            continue
        with open(src, encoding='utf-8') as fh:
            body = fh.read()
        if not body.strip():
            print('  пропуск  %-26s (пустой)' % name)
            continue
        # A quoted heredoc keeps every character literal - no expansion of the
        # JS and shell syntax these files contain.
        run(c, 'cat > %s << "RRWS_EOF"\n%s\nRRWS_EOF' % (dest, body.rstrip('\n')))
        mode = MODES.get(dest, '644')
        run(c, 'chmod %s %s' % (mode, dest))
        print('  записан  %-26s -> %s (%s)' % (name, dest, mode))

    # rpcd reload rescans /usr/share/rpcd/ucode and keeps LuCI sessions alive;
    # the module and index caches hold the old page JS until they are dropped.
    run(c, '/etc/init.d/rpcd reload 2>/dev/null')
    run(c, 'rm -f /tmp/luci-indexcache* 2>/dev/null; rm -rf /tmp/luci-modulecache 2>/dev/null')
    print()
    print(run(c, 'ubus list | grep -x luci.rrws || echo "luci.rrws НЕ ЗАРЕГИСТРИРОВАН"'))
    print(run(c, 'ubus call luci.rrws version 2>&1'))
    print(run(c, 'ubus call luci.rrws accountStatus 2>&1 | head -4'))
    c.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
