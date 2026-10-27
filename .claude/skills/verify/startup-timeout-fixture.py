import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument('evidence', type=Path)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[3]
evidence = args.evidence.resolve()
evidence.mkdir()
subprocess.run(['bash', str(repo / '.claude/skills/verify/resource-check.sh')], check=True)
with tempfile.TemporaryDirectory(prefix='startup-proof-', dir=os.environ.get('TMPDIR', '/private/tmp')) as directory:
    run = Path(directory)
    (run / 'home').mkdir()
    (run / 'tmp').mkdir()
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    assert port != 8399
    environment = {
        'PATH': os.environ['PATH'],
        'HOME': str(run / 'home'),
        'TMPDIR': str(run / 'tmp'),
        'NODE_ENV': 'test',
        'HYPERNEO_DATA_DIR': str(run / 'data'),
        'HYPERNEO_USE_DEV_PROXY': '1',
        'HYPERNEO_TEST_DISABLE_SANDBOX': '1',
        'VERIFY_STARTUP_PROXY_PORT': str(port),
    }
    helper = repo / 'packages/daemon/tests/helpers/mock-api-server.ts'
    code = (
        'const {createMockApiServer}=await import(' + json.dumps(str(helper)) + ');'
        'const server=await createMockApiServer({port:' + str(port) + '});'
        'await server.start();console.log("PROXY_READY");'
        'process.on("SIGTERM",async()=>{await server.stop();process.exit(0);});'
    )
    status = {'exitCode': 1, 'proxyPort': port, 'syntheticSdkProcess': True, 'cleaned': False}
    with (evidence / 'mock.log').open('w') as mock_log:
        proxy = subprocess.Popen(['bun', '-e', code], env=environment, stdout=mock_log, stderr=subprocess.STDOUT)
        tests = None
        try:
            deadline = time.monotonic() + 10
            while 'PROXY_READY' not in (evidence / 'mock.log').read_text():
                assert proxy.poll() is None and time.monotonic() < deadline, 'Owned mock failed to start'
                time.sleep(0.05)
            with (evidence / 'proof.log').open('w') as log:
                tests = subprocess.Popen([
                    'node', 'node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.online.config.ts',
                    'tests/online/convo/startup-timeout-no-retry.test.ts',
                ], cwd=repo / 'packages/daemon', env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                status['exitCode'] = tests.wait(timeout=180)
        finally:
            if tests is not None and tests.poll() is None:
                os.killpg(tests.pid, signal.SIGTERM)
                try:
                    tests.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    os.killpg(tests.pid, signal.SIGKILL)
                    tests.wait()
            proxy.terminate()
            proxy.wait(timeout=10)
            status['cleaned'] = True
            (evidence / 'run-status.json').write_text(json.dumps(status, indent=2))
print(json.dumps(status))
raise SystemExit(status['exitCode'])
