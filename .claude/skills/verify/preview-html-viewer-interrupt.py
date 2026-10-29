import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import time


verify = Path(__file__).resolve().parent
evidence = Path(sys.argv[1]).resolve()
evidence.mkdir()
results = []


def members(group):
    rows = subprocess.check_output(['ps', '-axo', 'pid=,pgid=,stat='], text=True)
    return [int(pid) for pid, pgid, state in (row.split() for row in rows.splitlines())
            if int(pgid) == group and not state.startswith('Z')]


def listening(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.2):
            return True
    except OSError:
        return False


for interrupt in [signal.SIGTERM, signal.SIGINT]:
    case = evidence / interrupt.name
    case.mkdir()
    probes = [socket.socket(), socket.socket()]
    for probe in probes:
        probe.bind(('127.0.0.1', 0))
    ports = [probe.getsockname()[1] for probe in probes]
    for probe in probes:
        probe.close()
    assert 8399 not in ports
    environment = {**os.environ, 'VERIFY_PORT': str(ports[0]),
                   'VERIFY_MOCK_PORT': str(ports[1])}
    observed = {'signal': interrupt.name, 'ports': ports}
    with (case / 'command.log').open('w') as log:
        process = subprocess.Popen(
            ['bash', str(verify / 'preview-html-viewer-check.sh'), str(case / 'saved')],
            env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
        )
        try:
            deadline = time.monotonic() + 120
            while True:
                match = re.search(r'run dir: (.+)', (case / 'command.log').read_text())
                if match:
                    run = Path(match[1])
                    break
                assert process.poll() is None, 'runner exited before readiness'
                assert time.monotonic() < deadline, 'runner readiness timed out'
                time.sleep(0.02)
            owned = [int((run / f'{name}.pid').read_text()) for name in ['daemon', 'mock-api']]
            assert all(os.getpgid(pid) == process.pid for pid in owned)
            assert all(listening(port) for port in ports)
            process.send_signal(interrupt)
            observed['outerExitCode'] = process.wait(timeout=45)
            status = case / 'saved/run-status.json'
            observed['evidenceRetained'] = status.exists()
            observed['childExitCode'] = json.loads(status.read_text())['exitCode'] if status.exists() else None
            deadline = time.monotonic() + 3
            while members(process.pid) and time.monotonic() < deadline:
                time.sleep(0.05)
            observed['remainingOwnedProcesses'] = members(process.pid)
            observed['listenersClosed'] = all(not listening(port) for port in ports)
            observed['temporaryRunRemoved'] = not run.exists()
            assert observed['outerExitCode'] == 128 + interrupt, observed
            assert observed['evidenceRetained'], observed
            assert observed['childExitCode'] in [130, 143], observed
            assert observed['listenersClosed'] and not observed['remainingOwnedProcesses'], observed
            assert observed['temporaryRunRemoved'], observed
        finally:
            (case / 'observed.json').write_text(json.dumps(observed, indent=2) + '\n')
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            time.sleep(0.2)
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
    results.append(observed)
(evidence / 'interrupts.json').write_text(json.dumps({'passed': True, 'cases': results}, indent=2) + '\n')
print(json.dumps({'passed': True, 'cases': results}))
