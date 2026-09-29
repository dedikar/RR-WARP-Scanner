"""Shared connection helper for the on-router tests.

Credentials are read from the environment, never hard-coded: this repository is
published, and a password committed once stays in the history even after it is
removed from the working tree.

Set them before running, or pass them on the command line:

    Linux/macOS:   ROUTER_HOST=192.0.2.1 ROUTER_USER=root ROUTER_PASS=... python acceptance.py
    Windows (cmd): set ROUTER_HOST=192.0.2.1 && set ROUTER_USER=root && set ROUTER_PASS=... && python acceptance.py
    PowerShell:    $env:ROUTER_HOST='192.0.2.1'; $env:ROUTER_USER='root'; $env:ROUTER_PASS='...'; python acceptance.py

There is deliberately NO default password.
"""
import os
import sys

try:
    import paramiko
except ImportError:
    print('paramiko не установлен: pip install paramiko', file=sys.stderr)
    raise


def _env(name, default=None, required=False):
    v = os.environ.get(name, default)
    if required and not v:
        print('Не задана переменная окружения %s' % name, file=sys.stderr)
        print('Пример: ROUTER_PASS=... python %s' % os.path.basename(sys.argv[0]), file=sys.stderr)
        sys.exit(2)
    return v


def connect(timeout=20):
    """Open an SSH session to the test router using the environment."""
    host = _env('ROUTER_HOST', '192.0.2.1')
    user = _env('ROUTER_USER', 'root')
    password = _env('ROUTER_PASS', required=True)
    port = int(_env('ROUTER_PORT', '22'))

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, port=port, username=user, password=password, timeout=timeout)
    return c


def run(c, cmd, timeout=120):
    """Run a command and return stdout+stderr as text."""
    i, o, e = c.exec_command(cmd, timeout=timeout)
    return o.read().decode('utf-8', 'replace') + e.read().decode('utf-8', 'replace')
