#!/usr/bin/env python3
"""Run the real smoke with a competing writer whenever fixtures overlap boot."""

import os
from pathlib import Path
import shutil
import shlex
import socket
import sqlite3
import subprocess
import sys
import tempfile


def shim():
    args = sys.argv[2:]
    path = os.environ.get('SMOKE_DB_PATH')
    sql = args[-1] if args else ''
    writer = None
    if not (path and args[0] == 'eval' and 'INSERT INTO message_search_content' in sql):
        os.execv(os.environ['SMOKE_REAL_DENO'], [os.environ['SMOKE_REAL_DENO'], *args])
    if path and args[0] == 'eval' and 'INSERT INTO message_search_content' in sql:
        try:
            connection = socket.create_connection(
                ('127.0.0.1', int(os.environ['DENO_SMOKE_PORT'])), timeout=1
            )
        except OSError:
            print('[fixture-isolation] daemon stopped before fixture writes', flush=True)
        else:
            connection.close()
            writer = sqlite3.connect(path, timeout=5)
            writer.execute('BEGIN IMMEDIATE')
            print('[fixture-isolation] competing writer acquired while daemon serves', flush=True)
    try:
        return subprocess.call([os.environ['SMOKE_REAL_DENO'], *args])
    finally:
        if writer:
            writer.rollback()
            writer.close()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--deno-shim':
        return shim()
    repo = Path(__file__).resolve().parents[3]
    deno = shutil.which('deno')
    if not deno:
        raise SystemExit('Deno is required')
    port = os.environ.get('DENO_SMOKE_PORT', '9283')
    if port == '8399':
        raise SystemExit('Refusing live daemon port')
    probe = socket.socket()
    probe.bind(('127.0.0.1', int(port)))
    probe.close()
    with tempfile.TemporaryDirectory(prefix='deno-fixture-isolation-') as run:
        wrapper = Path(run) / 'deno'
        wrapper.write_text(
            '#!/bin/sh\nexport SMOKE_REAL_DENO=' + shlex.quote(deno)
            + '\nexport DENO_SMOKE_PORT=' + shlex.quote(port)
            + '\nexec ' + shlex.quote(shutil.which('python3')) + ' '
            + shlex.quote(str(Path(__file__).resolve())) + ' --deno-shim "$@"\n'
        )
        wrapper.chmod(0o755)
        env = {**os.environ, 'SMOKE_REAL_DENO': deno, 'DENO_SMOKE_PORT': port,
               'PATH': run + os.pathsep + os.environ['PATH']}
        return subprocess.call(['bash', str(repo / 'scripts/deno-smoke.sh')], env=env)


if __name__ == '__main__':
    sys.exit(main())
