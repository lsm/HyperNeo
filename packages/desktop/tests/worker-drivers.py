from concurrent.futures import ThreadPoolExecutor
import ctypes
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

RUNNER = Path(sys.argv.pop(1)).resolve()
FAKE = f'#!{sys.executable}\n' + '''import json, os, socket, sys, time
assert sys.argv[1:3] == ['__private-worker', '--generation'] and sys.argv[4:] == ['--transport-fd=3']
assert 'FIXTURE_PARENT_ONLY' not in os.environ
assert not any('API_KEY' in key for key in os.environ)
generation, home = sys.argv[3], os.environ['HOME']
channel = socket.socket(fileno=3)
assert channel.family == socket.AF_UNIX and channel.type == socket.SOCK_STREAM
open(os.path.join(home, 'd.pid'), 'w').write(str(os.getpid()))
if '/slow/' in home:
    open(os.path.join(home, 'd.starting'), 'w').close()
    while not os.path.exists(os.path.join(home, 'd.release')):
        time.sleep(0.01)
log = open(os.path.join(os.path.dirname(home), 'log-' + os.path.basename(home)), 'a', buffering=1)
with channel.makefile('rwb') as stream:
    for line in stream:
        request = json.loads(line)
        log.write(request['operation'] + '\\n')
        result = {'ready': True, 'pid': os.getpid(), 'metadata': {
            'driver_version': '0.44.0', 'contract_version': '0.8.0'}}
        stream.write((json.dumps({'protocol_version': 1, 'request_id': request['request_id'],
            'generation': generation, 'ok': request['generation'] == generation,
            'completion': 'completed', 'result': result}) + '\\n').encode())
        stream.flush()
log.write('eof\\n')
hold = os.path.join(os.path.dirname(home), 'hold-stop')
if os.path.exists(hold):
    open(os.path.join(home, 'd.stopping'), 'w').close()
    while os.path.exists(hold):
        time.sleep(0.01)
os._exit(0)
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


def foreign_window():
    graphics = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    foundation = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    graphics.CGWindowListCreate.restype = ctypes.c_void_p
    graphics.CGWindowListCreate.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
    foundation.CFArrayGetCount.argtypes = [ctypes.c_void_p]
    foundation.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
    foundation.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
    windows = graphics.CGWindowListCreate(0, 0)
    assert windows and foundation.CFArrayGetCount(windows) > 0, 'no window to borrow'
    return foundation.CFArrayGetValueAtIndex(windows, 0)


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
        self.assertEqual(set(saved), {'pid', 'startedAt'})
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
            wait_until(lambda: bool(list(slow.glob('d-*/d.starting'))))
            stopping = pool.submit(self.call, 'stop')
            try:
                wait_until(lambda: (self.lifecycle() / 'stopped').exists())
                self.assertTrue((self.lifecycle() / 'starting').exists())
            finally:
                next(slow.glob('d-*/d.starting')).with_suffix('.release').touch()
            self.assertFalse(starting.result(timeout=15)['ok'])
            self.assertTrue(stopping.result(timeout=15)['ok'])
        record = json.loads((self.lifecycle() / 'driver.json').read_text())
        self.assertFalse(alive(record['pid']))

    def test_stop_refuses_changed_process_identity(self):
        driver = self.start()
        record = self.lifecycle() / 'driver.json'
        saved = json.loads(record.read_text())
        saved['startedAt']['microseconds'] += 1
        record.write_text(json.dumps(saved))
        self.assertFalse(self.call('status')['ok'])
        result = self.call('stop')
        self.assertFalse(result['ok'], result)
        self.assertEqual(result['error'], 'stop_unconfirmed: driver process identity changed')
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

    def test_refuses_a_symlinked_record_directory(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (self.root / 'desktop/workers').symlink_to(outside, target_is_directory=True)
        result = self.call('start', workDir=str(self.work))
        self.assertFalse(result['ok'], result)
        self.assertFalse(list(outside.iterdir()))
        self.assertFalse(list(self.work.glob('d-*')))

    def test_stale_start_marker_latches_worker_with_an_actionable_error(self):
        directory = self.lifecycle()
        directory.mkdir(parents=True, mode=0o700)
        directory.parent.chmod(0o700)
        (directory / 'starting').mkdir(mode=0o700)
        result = self.call('start', workDir=str(self.work))
        self.assertFalse(result['ok'], result)
        self.assertIn('previous start incomplete', result['error'])
        self.assertTrue((directory / 'stopped').exists())
        self.assertFalse(list(self.work.glob('d-*')))

    def test_stale_pending_file_does_not_stop_a_healthy_driver(self):
        driver = self.start()
        (self.lifecycle() / 'driver.pending').write_text('interrupted publication')
        result = self.call('start', workDir=str(self.work))
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['result']['pid'], driver['pid'])
        self.assertTrue(alive(driver['pid']))

    def test_failed_publication_removes_its_temporary_file(self):
        directory = self.lifecycle()
        directory.mkdir(parents=True, mode=0o700)
        directory.parent.chmod(0o700)
        (directory / 'driver.json').mkdir()
        self.assertFalse(self.call('start', workDir=str(self.work))['ok'])
        self.assertEqual([path.name for path in directory.iterdir()], ['driver.json'])
        (directory / 'driver.json').rmdir()
        self.start()

    def test_stop_accepts_existing_malformed_latch_entries(self):
        for worker, kind in (('worker-a', 'file'), ('worker-b', 'directory')):
            driver = self.start(worker)
            latch = self.lifecycle(worker) / 'stopped'
            if kind == 'file':
                latch.write_text('stop')
                latch.chmod(0o644)
            else:
                latch.mkdir()
            result = self.call('stop', worker)
            self.assertTrue(result['ok'], result)
            self.assertFalse(alive(driver['pid']))
            self.assertFalse(self.call('start', worker, workDir=str(self.work))['ok'])

    def test_stop_confirms_a_driver_that_already_exited(self):
        driver = self.start()
        os.kill(driver['pid'], signal.SIGKILL)
        result = self.call('stop')
        self.assertTrue(result['ok'], result)
        self.assertFalse(alive(driver['pid']))

    def test_latch_at_response_check_stops_the_started_driver(self):
        self.assertTrue(self.call('fixture-latch-on-response')['ok'])
        result = self.call('start', workDir=str(self.work))
        self.assertFalse(result['ok'], result)
        record = json.loads((self.lifecycle() / 'driver.json').read_text())
        self.pids.append(record['pid'])
        self.assertFalse(alive(record['pid']))
        self.assertTrue((self.lifecycle() / 'stopped').exists())
        self.assertEqual(self.call('fixture-slots')['result']['count'], 0)
        self.assertFalse(list(self.work.glob('d-*')))

    def test_status_and_unknown_actions_do_not_create_records(self):
        for worker in ('unknown-a', 'unknown-b'):
            self.assertTrue(self.call('status', worker)['ok'])
            self.assertFalse(self.call('unknown-action', worker)['ok'])
        self.assertFalse((self.root / 'desktop/workers').exists())

    def test_failed_publication_and_cleanup_preserve_incomplete_start(self):
        directory = self.lifecycle()
        directory.mkdir(parents=True, mode=0o700)
        directory.parent.chmod(0o700)
        (directory / 'driver.json').mkdir()
        self.assertTrue(self.call('fixture-fail-start-cleanup')['ok'])
        result = self.call('start', workDir=str(self.work))
        self.assertFalse(result['ok'], result)
        path = next(self.work.glob('d-*/d.pid'))
        pid = int(path.read_text())
        self.pids.append(pid)
        self.assertTrue(alive(pid))
        print(f'combined_failure pid={pid} alive=1 incomplete_marker={int((directory / "starting").exists())}')
        self.assertTrue((directory / 'starting').exists())
        self.assertIn('stop_unconfirmed', result['error'])
        retry = self.call('start', workDir=str(self.work))
        self.assertFalse(retry['ok'], retry)
        self.assertEqual(list(self.work.glob('d-*')), [path.parent])
        self.assertTrue((directory / 'starting').exists())
        print(f'publication_failed=1 cleanup_failed=1 pid={pid} incomplete_marker=1 retry_refused=1')

    def test_two_workers_get_two_drivers_and_two_channels(self):
        first, second = self.start(), self.start('worker-b')
        self.assertNotEqual(first['pid'], second['pid'])
        homes = [path for path in self.work.glob('d-*') if path.is_dir()]
        self.assertEqual(len(homes), 2)
        for home in homes:
            self.assertEqual(home.stat().st_mode & 0o777, 0o700)
            self.assertEqual((home.parent / f'log-{home.name}').read_text(), 'initialize\n')
        self.assertEqual(self.call('status')['result']['pid'], first['pid'])
        self.assertEqual(self.start()['pid'], first['pid'])
        print('drivers=2 distinct_pids=2 distinct_channels=2')

    def test_app_stops_a_workers_driver(self):
        driver, other = self.start(), self.start('worker-b')
        self.assertTrue(self.call('stop')['ok'])
        wait_until(lambda: not alive(driver['pid']))
        self.assertTrue(alive(other['pid']))
        self.assertEqual(self.call('status')['result']['state'], 'stopped')
        print('stopped_pid_gone=1 other_driver_alive=1')

    def test_driver_exits_when_the_app_exits(self):
        driver = self.start()
        self.process.kill()
        self.process.wait(timeout=10)
        wait_until(lambda: not alive(driver['pid']))
        print(f'app_exit={self.process.returncode} driver_pid_gone=1')

    def test_app_shutdown_stops_drivers(self):
        driver = self.start()
        self.process.send_signal(signal.SIGINT)
        self.assertEqual(self.process.wait(timeout=10), 0)
        wait_until(lambda: not alive(driver['pid']))
        self.assertFalse((self.root / 'desktop/control.sock').exists())

    def test_refuses_signature_failure_before_start(self):
        self.codesign.write_text('#!/bin/bash\nexit 1\n')
        self.assertFalse(self.call('start', workDir=str(self.work))['ok'])
        self.assertEqual(self.call('status')['result']['state'], 'stopped')

    def test_refuses_version_mismatch_before_start(self):
        self.binary.write_text(FAKE.replace("'driver_version': '0.44.0'", "'driver_version': '0.0.0'"))
        result = self.call('start', workDir=str(self.work))
        self.assertFalse(result['ok'], result)
        self.assertIn('version', result['error'])
        self.assertFalse([path for path in self.work.glob('d-*') if path.is_dir()])
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
            wait_until(lambda: bool(list(slow.glob('d-*/d.starting'))))
            before = time.monotonic()
            self.assertTrue(self.call('status')['ok'])
            self.assertTrue(self.call('stop')['ok'])
            self.assertFalse(pending.done())
            print(f'other_worker_stop_seconds={time.monotonic() - before:.3f}')
            wait_until(lambda: not alive(driver['pid']))
            marker = next(slow.glob('d-*/d.starting'))
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
        incompatible = FAKE.replace("'driver_version': '0.44.0'", "'driver_version': '0.43.0'")
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
            wait_until(lambda: bool(list(queued.glob('d-*/d.stopping'))))
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
            [str(self.binary), '__private-worker', '--generation', 'g', '--transport-fd=3'],
            env={'HOME': str(self.root), 'PATH': self.path, 'NODE_ENV': 'test',
                 'FIXTURE_PARENT_ONLY': 'scrub-me'},
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('FIXTURE_PARENT_ONLY', result.stderr)

    def test_worker_record_gives_a_same_user_process_no_input_endpoint(self):
        driver = self.start()
        record = json.loads((self.lifecycle() / 'driver.json').read_text())
        self.assertEqual(set(record), {'pid', 'startedAt'})
        self.assertEqual(set(self.call('status')['result']), {'state', 'pid'})
        endpoints = [path for path in self.root.rglob('*') if path.is_socket()]
        self.assertEqual(endpoints, [self.root / 'desktop/control.sock'])
        log = next(self.work.glob('log-d-*'))
        self.assertEqual(log.read_text(), 'initialize\n')
        self.assertTrue(self.call('stop')['ok'])
        wait_until(lambda: not alive(driver['pid']))
        self.assertEqual(log.read_text(), 'initialize\neof\n')
        print('record_keys=pid,startedAt driver_endpoints=0 fixture_exchange=1 stop_closed_channel=1')

    def resolve(self, tool, arguments, instance=None):
        params = dict(tool=tool, arguments=arguments, callId='call-' + tool)
        if instance is not None:
            params['instance'] = instance
        result = self.call('resolve', **params)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['result'].pop('call_id'), 'call-' + tool)
        return result['result']

    def spawn(self, binary):
        child = subprocess.Popen([str(binary), '30'])
        self.addCleanup(child.wait)
        self.addCleanup(child.kill)
        return child.pid

    def test_resolve_verified_process_returns_exact_app_and_class(self):
        pid = self.spawn(Path('/bin/sleep'))
        target = self.resolve('click', {'pid': pid})['value']
        self.assertEqual((target['bundle_id'], target['class']), ('com.apple.sleep', 'pointer'))
        self.assertEqual(target['requirement'], 'identifier "com.apple.sleep" and anchor apple')
        self.assertEqual(target['instance']['pid'], pid)
        again = self.resolve('type_text', {'pid': pid}, target['instance'])['value']
        self.assertEqual((again['bundle_id'], again['class']), ('com.apple.sleep', 'keyboard'))
        launch = self.resolve('launch_app', {'bundle_id': 'com.apple.calculator'})['value']
        self.assertEqual((launch['path'], launch['class']), ('/System/Applications/Calculator.app', 'launch'))

    def test_resolve_refuses_copied_bundle_id(self):
        copy = self.root / 'sleep-copy'
        shutil.copy('/bin/sleep', copy)
        subprocess.run(['/usr/bin/codesign', '-f', '-s', '-', '-i', 'com.apple.sleep', str(copy)],
                       check=True, capture_output=True)
        pid = self.spawn(copy)
        self.assertEqual(self.resolve('click', {'pid': pid}), {'reason': 'target_unverified'})
        self.assertEqual(self.resolve('launch_app', {'bundle_id': 'io.hyperneo.missing'}),
                         {'reason': 'target_unverified'})

    def test_resolve_refuses_recycled_pid(self):
        pid = self.spawn(Path('/bin/sleep'))
        instance = self.resolve('click', {'pid': pid})['value']['instance']
        recycled = dict(instance, startedAt=dict(instance['startedAt'], seconds=instance['startedAt']['seconds'] - 1))
        self.assertEqual(self.resolve('click', {'pid': pid}, recycled), {'reason': 'target_mismatch'})

    def test_resolve_refuses_window_owned_by_another_app(self):
        pid = self.spawn(Path('/bin/sleep'))
        self.assertEqual(self.resolve('click', {'pid': pid, 'window_id': foreign_window()}),
                         {'reason': 'target_mismatch'})
        for window in (-1, 2 ** 32 + 1, '7'):
            self.assertEqual(self.resolve('zoom', {'pid': pid, 'window_id': window}),
                             {'reason': 'target_unverified'})

    def test_resolve_refuses_tools_outside_the_allowlist(self):
        self.assertEqual(self.resolve('kill_app', {'pid': os.getpid()}), {'reason': 'tool_not_allowed'})

    def test_refuses_worker_path_traversal(self):
        self.assertFalse(self.call('start', '../escape', workDir=str(self.work))['ok'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
