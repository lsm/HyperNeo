from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

RUNNER = Path(sys.argv.pop(1)).resolve()
FAKE = '''#!/usr/bin/python3
import json, os, socket, sys, threading, time
if sys.argv[1:] == ['--version']:
    print('cua-driver 0.44.0')
    sys.exit(0)
assert sys.argv[1] == 'serve'
assert '--embedded' in sys.argv
assert '--parent-liveness-stdio' in sys.argv
path = sys.argv[sys.argv.index('--socket') + 1]
assert not any('API_KEY' in key for key in os.environ)
if '/slow/' in path:
    open(path + '.starting', 'w').close()
    time.sleep(3)
server = socket.socket(socket.AF_UNIX)
server.bind(path)
os.chmod(path, 0o600)
server.listen()
def parent_exit():
    sys.stdin.buffer.read()
    os.unlink(path)
    os._exit(0)
threading.Thread(target=parent_exit, daemon=True).start()
while True:
    client, _ = server.accept()
    with client, client.makefile('rwb') as stream:
        request = json.loads(stream.readline())
        assert request['method'] == 'metadata'
        response = {'ok': True, 'result': {
            'driver_version': '0.44.0', 'contract_version': '0.8.0',
            'tools_list_schema_version': '1', 'capability_version': '1',
            'mcp_protocol_version': '2025-06-18', 'pid': os.getpid(),
            'embedded': True, 'host_bundle_id': 'io.hyperneo.app'}}
        stream.write((json.dumps(response) + '\\n').encode())
        stream.flush()
'''
CODESIGN = '''#!/bin/bash
case "$1:$2" in
 --verify:*)
 [[ "$*" == *'P5R65T296V'* && "$*" == *'identifier "cua-driver"'* ]] || exit 2
 exit 0 ;;
 --display:--verbose=2) echo 'CodeDirectory flags=0x10000(runtime)' ;;
 --display:--entitlements)
 echo '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.automation.apple-events</key><true/><key>com.apple.security.device.screen-capture</key><true/></dict></plist>' ;;
 *) exit 2 ;;
esac
'''


def wait_until(predicate):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError('condition did not become true')


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


class WorkerDrivers(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='dh-', dir='/tmp')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.work = self.root / 'work'
        self.work.mkdir()
        self.binary = self.root / 'Fixture.app/Contents/MacOS/cua-driver'
        self.binary.parent.mkdir(parents=True)
        self.binary.write_text(FAKE)
        self.binary.chmod(0o700)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.codesign = self.bin / 'codesign'
        self.codesign.write_text(CODESIGN)
        self.codesign.chmod(0o700)
        self.path = str(self.bin) + ':/usr/bin:/bin:/usr/sbin:/sbin'
        self.process = subprocess.Popen(
            [str(RUNNER), str(self.root), str(self.binary), self.path],
            env={'HOME': str(self.root), 'PATH': self.path, 'NODE_ENV': 'test'},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.cleanup)
        ready = select.select([self.process.stdout], [], [], 15)[0]
        self.assertTrue(ready, 'fixture app did not start')
        self.assertEqual(self.process.stdout.readline().strip(), 'ready')
        self.pids = []

    def cleanup(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGINT)
            self.assertEqual(self.process.wait(timeout=10), 0)
        self.process.stdout.close()
        self.process.stderr.close()
        for pid in getattr(self, 'pids', []):
            if alive(pid):
                os.kill(pid, signal.SIGKILL)

    def call(self, action, worker='worker-a', **params):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(20)
            client.connect(str(self.root / 'desktop/control.sock'))
            client.sendall((json.dumps(dict(action=action, worker=worker, **params)) + '\n').encode())
            with client.makefile('rb') as stream:
                return json.loads(stream.readline())

    def start(self, worker='worker-a'):
        result = self.call('start', worker, workDir=str(self.work))
        self.assertTrue(result['ok'], result)
        self.pids.append(result['result']['pid'])
        print(json.dumps(dict(worker=worker, **result['result'])))
        return result['result']

    def test_two_workers_get_two_drivers_and_two_sockets(self):
        first, second = self.start(), self.start('worker-b')
        self.assertNotEqual(first['pid'], second['pid'])
        self.assertNotEqual(first['socket'], second['socket'])
        for driver in (first, second):
            path = Path(driver['socket'])
            self.assertTrue(path.is_socket())
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(path.parent.parent, self.work)
        self.assertEqual(self.call('status')['result']['pid'], first['pid'])
        self.assertEqual(self.start()['pid'], first['pid'])
        print(f'drivers=2 distinct_pids=2 distinct_sockets=2')

    def test_app_stops_a_workers_driver(self):
        driver, other = self.start(), self.start('worker-b')
        self.assertTrue(self.call('stop')['ok'])
        wait_until(lambda: not alive(driver['pid']))
        self.assertFalse(Path(driver['socket']).exists())
        self.assertTrue(alive(other['pid']))
        self.assertEqual(self.call('status')['result']['state'], 'stopped')
        print('stopped_pid_gone=1 stopped_socket_gone=1 other_driver_alive=1')

    def test_driver_exits_when_the_app_exits(self):
        driver = self.start()
        self.process.kill()
        self.process.wait(timeout=10)
        wait_until(lambda: not alive(driver['pid']))
        self.assertFalse(Path(driver['socket']).exists())
        print(f'app_exit={self.process.returncode} driver_pid_gone=1 driver_socket_gone=1')

    def test_app_shutdown_stops_drivers(self):
        driver = self.start()
        self.process.send_signal(signal.SIGINT)
        self.assertEqual(self.process.wait(timeout=10), 0)
        wait_until(lambda: not alive(driver['pid']))
        self.assertFalse(Path(driver['socket']).exists())
        self.assertFalse((self.root / 'desktop/control.sock').exists())

    def test_refuses_signature_failure_before_start(self):
        self.codesign.write_text('#!/bin/bash\nexit 1\n')
        self.assertFalse(self.call('start', workDir=str(self.work))['ok'])
        self.assertEqual(self.call('status')['result']['state'], 'stopped')

    def test_refuses_version_mismatch_before_start(self):
        self.binary.write_text(FAKE.replace('cua-driver 0.44.0', 'cua-driver 0.0.0'))
        self.assertFalse(self.call('start', workDir=str(self.work))['ok'])
        self.assertEqual(self.call('status')['result']['state'], 'stopped')

    def test_revalidates_signature_on_repeated_start(self):
        driver = self.start()
        self.codesign.write_text('#!/bin/bash\nexit 1\n')
        self.assertFalse(self.call('start', workDir=str(self.work))['ok'])
        self.assertTrue(alive(driver['pid']))

    def test_refuses_missing_entitlement(self):
        self.codesign.write_text(CODESIGN.replace(
            '<key>com.apple.security.device.screen-capture</key><true/>', ''))
        self.assertFalse(self.call('start', workDir=str(self.work))['ok'])

    def test_refuses_second_app_without_removing_endpoint(self):
        second = subprocess.run(
            [str(RUNNER), str(self.root), str(self.binary), self.path],
            env={'HOME': str(self.root), 'PATH': self.path, 'NODE_ENV': 'test'},
            capture_output=True, timeout=10)
        self.assertEqual(second.returncode, 0)
        self.assertTrue(self.call('status')['ok'])

    def test_slow_worker_start_does_not_delay_another_workers_stop(self):
        driver = self.start()
        slow = self.work / 'slow'
        slow.mkdir()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.call, 'start', 'slow-worker', workDir=str(slow))
            wait_until(lambda: bool(list(slow.glob('d-*/d.sock.starting'))))
            before = time.monotonic()
            self.assertTrue(self.call('status')['ok'])
            self.assertTrue(self.call('stop')['ok'])
            self.assertLess(time.monotonic() - before, 2)
            wait_until(lambda: not alive(driver['pid']))
            result = pending.result(timeout=15)
            self.assertTrue(result['ok'], result)
            self.pids.append(result['result']['pid'])

    def test_recovers_control_endpoint_after_app_crash(self):
        self.process.kill()
        self.process.wait(timeout=10)
        self.process.stdout.close()
        self.process.stderr.close()
        self.process = subprocess.Popen(
            [str(RUNNER), str(self.root), str(self.binary), self.path],
            env={'HOME': str(self.root), 'PATH': self.path, 'NODE_ENV': 'test'},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertTrue(select.select([self.process.stdout], [], [], 15)[0])
        self.assertEqual(self.process.stdout.readline().strip(), 'ready')
        self.start()

    def test_rejects_oversize_frame_and_keeps_serving(self):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(10)
            client.connect(str(self.root / 'desktop/control.sock'))
            client.sendall(b'x' * 16384)
            self.assertEqual(client.recv(1), b'')
        self.assertTrue(self.call('status')['ok'])

    def test_refuses_worker_path_traversal(self):
        self.assertFalse(self.call('start', '../escape', workDir=str(self.work))['ok'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
