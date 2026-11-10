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
FAKE = f'#!{sys.executable}\n' + '''import json, os, socket, sys, threading, time
if sys.argv[1:] == ['--version']:
    print('cua-driver 0.44.0')
    sys.exit(0)
assert sys.argv[1] == 'serve'
assert '--embedded' in sys.argv
assert '--parent-liveness-stdio' in sys.argv
path = sys.argv[sys.argv.index('--socket') + 1]
assert 'FIXTURE_PARENT_ONLY' not in os.environ
assert not any('API_KEY' in key for key in os.environ)
if '/slow/' in path:
    open(path + '.starting', 'w').close()
    while not os.path.exists(path + '.release'):
        time.sleep(0.01)
server = socket.socket(socket.AF_UNIX)
server.bind(path)
os.chmod(path, 0o600)
server.listen()
def parent_exit():
    sys.stdin.buffer.read()
    hold = os.path.join(os.path.dirname(os.path.dirname(path)), 'hold-stop')
    if os.path.exists(hold):
        open(path + '.stopping', 'w').close()
        while os.path.exists(hold):
            time.sleep(0.01)
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
            env={'HOME': str(self.root), 'PATH': self.path, 'NODE_ENV': 'test', 'FIXTURE_PARENT_ONLY': 'scrub-me'},
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

    def lifecycle(self, worker='worker-a'):
        return self.root / 'desktop/workers' / worker

    def test_publishes_protected_record_before_start_returns(self):
        driver = self.start()
        directory = self.lifecycle()
        record = directory / 'driver.json'
        saved = json.loads(record.read_text())
        self.assertEqual(saved['pid'], driver['pid'])
        self.assertEqual(saved['socket'], driver['socket'])
        self.assertGreater(saved['startedAt']['seconds'], 0)
        self.assertGreaterEqual(saved['startedAt']['microseconds'], 0)
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual(record.stat().st_mode & 0o777, 0o600)
        self.assertFalse((directory / 'starting').exists())

    def test_stop_latch_survives_app_restart(self):
        self.start()
        self.assertTrue(self.call('stop')['ok'])
        latch = self.lifecycle() / 'stopped'
        self.assertEqual(latch.stat().st_mode & 0o777, 0o600)
        self.process.send_signal(signal.SIGINT)
        self.assertEqual(self.process.wait(timeout=10), 0)
        self.process.stdout.close()
        self.process.stderr.close()
        self.process = subprocess.Popen(
            [str(RUNNER), str(self.root), str(self.binary), self.path],
            env={'HOME': str(self.root), 'PATH': self.path, 'NODE_ENV': 'test'},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertTrue(select.select([self.process.stdout], [], [], 15)[0])
        self.assertEqual(self.process.stdout.readline().strip(), 'ready')
        result = self.call('start', workDir=str(self.work))
        self.assertFalse(result['ok'], result)
        self.assertIn('stopped', result['error'])

    def test_latch_is_persisted_while_start_is_in_flight(self):
        slow = self.work / 'slow'
        slow.mkdir()
        with ThreadPoolExecutor(max_workers=2) as pool:
            starting = pool.submit(self.call, 'start', workDir=str(slow))
            wait_until(lambda: bool(list(slow.glob('d-*/d.sock.starting'))))
            stopping = pool.submit(self.call, 'stop')
            try:
                wait_until(lambda: (self.lifecycle() / 'stopped').exists())
                self.assertTrue((self.lifecycle() / 'starting').exists())
            finally:
                next(slow.glob('d-*/d.sock.starting')).with_suffix('.release').touch()
            self.assertFalse(starting.result(timeout=15)['ok'])
            self.assertTrue(stopping.result(timeout=15)['ok'])
        record = json.loads((self.lifecycle() / 'driver.json').read_text())
        self.assertFalse(alive(record['pid']))
        self.assertFalse(Path(record['socket']).exists())

    def test_stop_refuses_changed_process_identity(self):
        driver = self.start()
        record = self.lifecycle() / 'driver.json'
        saved = json.loads(record.read_text())
        saved['startedAt']['microseconds'] += 1
        record.write_text(json.dumps(saved))
        self.assertFalse(self.call('status')['ok'])
        result = self.call('stop')
        self.assertFalse(result['ok'], result)
        self.assertIn('stop_unconfirmed', result['error'])
        self.assertTrue(alive(driver['pid']))
        self.assertTrue((self.lifecycle() / 'stopped').exists())

    def test_external_latch_survives_an_unresponsive_app(self):
        driver = self.start()
        self.process.send_signal(signal.SIGSTOP)
        try:
            record = json.loads((self.lifecycle() / 'driver.json').read_text())
            self.assertEqual(record['pid'], driver['pid'])
            with (self.lifecycle() / 'stopped').open('x') as latch:
                os.fchmod(latch.fileno(), 0o600)
                latch.flush()
                os.fsync(latch.fileno())
        finally:
            self.process.send_signal(signal.SIGCONT)
        self.assertFalse(self.call('start', workDir=str(self.work))['ok'])
        self.assertTrue(self.call('stop')['ok'])
        self.assertFalse(alive(driver['pid']))
        self.assertFalse(Path(driver['socket']).exists())

    def test_refuses_a_symlinked_record_directory(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (self.root / 'desktop/workers').symlink_to(outside, target_is_directory=True)
        result = self.call('start', workDir=str(self.work))
        self.assertFalse(result['ok'], result)
        self.assertFalse(list(outside.iterdir()))
        self.assertFalse(list(self.work.glob('d-*')))

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
        second = subprocess.Popen(
            [str(RUNNER), str(self.root), str(self.binary), self.path],
            env={'HOME': str(self.root), 'PATH': self.path, 'NODE_ENV': 'test', 'FIXTURE_PARENT_ONLY': 'scrub-me'},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertTrue(select.select([second.stdout], [], [], 15)[0])
            self.assertEqual(second.stdout.readline().strip(), 'ready')
            self.assertTrue(self.call('status')['ok'])
            second.send_signal(signal.SIGINT)
            second.communicate(timeout=10)
            self.assertEqual(second.returncode, 0)
        finally:
            if second.poll() is None:
                second.kill()
            second.communicate(timeout=10)

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
            self.assertFalse(pending.done())
            print(f'other_worker_stop_seconds={time.monotonic() - before:.3f}')
            wait_until(lambda: not alive(driver['pid']))
            marker = next(slow.glob('d-*/d.sock.starting'))
            marker.with_suffix('.release').touch()
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
            env={'HOME': str(self.root), 'PATH': self.path, 'NODE_ENV': 'test', 'FIXTURE_PARENT_ONLY': 'scrub-me'},
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

    def test_unapproved_same_user_cannot_start_or_get_driver_socket(self):
        self.process.send_signal(signal.SIGINT)
        self.assertEqual(self.process.wait(timeout=10), 0)
        self.process.stdout.close()
        self.process.stderr.close()
        self.process = subprocess.Popen(
            [str(RUNNER), str(self.root), str(self.binary), self.path, 'unapproved'],
            env={'HOME': str(self.root), 'PATH': self.path, 'NODE_ENV': 'test', 'FIXTURE_PARENT_ONLY': 'scrub-me'},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertTrue(select.select([self.process.stdout], [], [], 15)[0])
        self.assertEqual(self.process.stdout.readline().strip(), 'ready')
        result = self.call('start', workDir=str(self.work))
        if result.get('result', {}).get('pid'):
            self.pids.append(result['result']['pid'])
        self.assertFalse(result['ok'], result)
        self.assertIn('authorization', result['error'])
        self.assertFalse(self.call('start', workDir=str(self.work), fixtureEnabled=True)['ok'])
        status = self.call('status')['result']
        self.assertEqual(status['state'], 'unavailable')
        self.assertIsNone(status['socket'])
        self.assertIsNone(status['pid'])
        self.assertFalse(list(self.work.glob('d-*')))

    def test_bind_failure_allows_desktop_setup_to_continue(self):
        base = self.root / ('long-data-directory-' + 'x' * 90)
        base.mkdir()
        self.assertGreaterEqual(len(str(base / 'desktop/control.sock').encode()), 104)
        process = subprocess.Popen(
            [str(RUNNER), str(base), str(self.binary), self.path, 'unapproved'],
            env={'HOME': str(base), 'PATH': self.path, 'NODE_ENV': 'test', 'FIXTURE_PARENT_ONLY': 'scrub-me'},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertTrue(select.select([process.stdout], [], [], 15)[0])
            self.assertEqual(process.stdout.readline().strip(), 'ready')
            process.send_signal(signal.SIGINT)
            _, error = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0)
            self.assertIn('Desktop control unavailable', error)
            self.assertFalse((base / 'desktop/control.sock').exists())
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=10)

    def test_missing_startup_paths_allow_desktop_setup_to_continue(self):
        for mode in ('missing-data', 'missing-binary'):
            with self.subTest(mode=mode):
                base = self.root / mode
                base.mkdir()
                process = subprocess.Popen(
                    [str(RUNNER), str(base), str(self.binary), self.path, mode],
                    env={'HOME': str(base), 'PATH': self.path, 'NODE_ENV': 'test', 'FIXTURE_PARENT_ONLY': 'scrub-me'},
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    self.assertTrue(select.select([process.stdout], [], [], 15)[0])
                    self.assertEqual(process.stdout.readline().strip(), 'ready')
                    process.send_signal(signal.SIGINT)
                    _, error = process.communicate(timeout=10)
                    self.assertEqual(process.returncode, 0)
                    self.assertIn('Desktop control unavailable', error)
                    self.assertFalse((base / 'desktop/control.sock').exists())
                finally:
                    if process.poll() is None:
                        process.kill()
                    process.communicate(timeout=10)

    def test_control_recovers_after_transient_accept_failure(self):
        self.process.send_signal(signal.SIGINT)
        self.assertEqual(self.process.wait(timeout=10), 0)
        self.process.stdout.close()
        self.process.stderr.close()
        self.process = subprocess.Popen(
            [str(RUNNER), str(self.root), str(self.binary), self.path, 'accept-error'],
            env={'HOME': str(self.root), 'PATH': self.path, 'NODE_ENV': 'test', 'FIXTURE_PARENT_ONLY': 'scrub-me'},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertTrue(select.select([self.process.stdout], [], [], 15)[0])
        self.assertEqual(self.process.stdout.readline().strip(), 'ready')
        self.assertTrue(self.call('status')['ok'])
        self.assertTrue(select.select([self.process.stderr], [], [], 2)[0])
        self.assertIn('Desktop control accept failed', self.process.stderr.readline())

    def test_status_and_stop_do_not_allocate_worker_slots(self):
        for index in range(4):
            worker = f'absent-{index}'
            self.assertTrue(self.call('status', worker)['ok'])
            self.assertTrue(self.call('stop', worker)['ok'])
        self.assertEqual(self.call('fixture-slots')['result']['count'], 0)

    def test_failed_start_releases_worker_slot(self):
        incompatible = FAKE.replace("'contract_version': '0.8.0'", "'contract_version': 'invalid'")
        for signature, binary in (('#!/bin/bash\nexit 1\n', FAKE), (CODESIGN, incompatible)):
            with self.subTest(signature=signature == CODESIGN):
                self.codesign.write_text(signature)
                self.binary.write_text(binary)
                self.assertFalse(self.call('start', workDir=str(self.work))['ok'])
                self.assertEqual(self.call('fixture-slots')['result']['count'], 0)
                self.assertFalse(list(self.work.glob('d-*')))

    def test_stopping_worker_releases_its_slot(self):
        self.start()
        self.assertTrue(self.call('stop')['ok'])
        self.assertEqual(self.call('fixture-slots')['result']['count'], 0)

    def test_queued_start_is_refused_after_stop(self):
        queued = self.work / 'queued'
        queued.mkdir()
        hold = queued / 'hold-stop'
        hold.touch()
        first = self.call('start', workDir=str(queued))['result']
        self.pids.append(first['pid'])
        with ThreadPoolExecutor(max_workers=2) as pool:
            stopping = pool.submit(self.call, 'stop')
            wait_until(lambda: bool(list(queued.glob('d-*/d.sock.stopping'))))
            starting = pool.submit(self.call, 'start', workDir=str(queued))
            wait_until(starting.done)
            hold.unlink()
            self.assertTrue(stopping.result(timeout=15)['ok'])
            second = starting.result(timeout=15)
        self.assertFalse(second['ok'], second)
        self.assertFalse(alive(first['pid']))
        self.assertEqual(self.call('status')['result']['state'], 'stopped')
        self.assertTrue(self.call('stop')['ok'])
        self.assertEqual(self.call('fixture-slots')['result']['count'], 0)

    def test_fake_driver_rejects_inherited_parent_environment(self):
        result = subprocess.run(
            [str(self.binary), 'serve', '--embedded', '--parent-liveness-stdio',
             '--socket', str(self.root / 'inherited.sock')],
            env={'HOME': str(self.root), 'PATH': self.path, 'NODE_ENV': 'test',
                 'FIXTURE_PARENT_ONLY': 'scrub-me'},
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('FIXTURE_PARENT_ONLY', result.stderr)

    def test_refuses_worker_path_traversal(self):
        self.assertFalse(self.call('start', '../escape', workDir=str(self.work))['ok'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
