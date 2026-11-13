#!/bin/bash
# Usage: desktop-driver-channel.sh <evidence-dir> <driver-archive.tar.gz>
# Needs APPLE_SIGNING_IDENTITY (name or SHA-1) for a Developer ID Application
# identity of team P5R65T296V. Grants no permissions and sends no input.
set -euo pipefail

evidence="$(mkdir -p "$1" && cd "$1" && pwd)"
archive="$2"
identity="${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY}"
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
desktop="$repo/packages/desktop"
root="$(mktemp -d /tmp/ddc-XXXXXX)"
host_pid=
cleanup() {
    [[ -n "$host_pid" ]] && kill -INT "$host_pid" 2>/dev/null && wait "$host_pid" 2>/dev/null
    rm -rf "$root"
}
trap cleanup EXIT

cargo rustc --locked --quiet --manifest-path "$desktop/tests/driver-host/Cargo.toml" \
    --bin desktop-driver-fixture -- --cfg test
app="$root/Fixture.app/Contents/MacOS"
mkdir -p "$app" "$root/work" "$root/bin"
tar -xzf "$archive" -C "$root" --strip-components 1 '*/cua-driver'
mv "$root/cua-driver" "$app/cua-driver"
bash "$desktop/prepare-cua-driver.sh" --verify "$app/cua-driver"
cp "$desktop/tests/driver-host/target/debug/desktop-driver-fixture" "$app/hyperneo-desktop"
codesign --force --sign "$identity" --timestamp=none --options runtime --identifier cua-driver \
    --entitlements "$desktop/src-tauri/CuaDriverEntitlements.plist" "$app/cua-driver"
codesign --force --sign "$identity" --timestamp=none --options runtime \
    --identifier io.hyperneo.app "$app/hyperneo-desktop"

env -i HOME="$root" PATH=/usr/bin:/bin:/usr/sbin:/sbin NODE_ENV=test \
    "$app/hyperneo-desktop" "$root" "$app/cua-driver" /usr/bin:/bin:/usr/sbin:/sbin \
    > "$evidence/host.log" 2>&1 &
host_pid=$!
for _ in $(seq 100); do grep -q ready "$evidence/host.log" && break; sleep 0.1; done

python3 - "$root" "$app/cua-driver" "$evidence" <<'PY'
import json, os, socket, subprocess, sys, time
root, driver, evidence = sys.argv[1:]
def call(action, **params):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(30)
        client.connect(os.path.join(root, 'desktop/control.sock'))
        client.sendall((json.dumps(dict(action=action, worker='proof', **params)) + '\n').encode())
        with client.makefile('rb') as stream:
            return json.loads(stream.readline())
def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
report = {}
started = call('start', workDir=os.path.join(root, 'work'))
report['start'] = started
assert started['ok'], started
pid = started['result']['pid']
report['record_keys'] = sorted(json.load(open(os.path.join(root, 'desktop/workers/proof/driver.json'))))
report['sockets'] = sorted(os.path.relpath(os.path.join(d, f), root) for d, _, files in os.walk(root)
                           for f in files if os.path.exists(os.path.join(d, f))
                           and __import__('stat').S_ISSOCK(os.lstat(os.path.join(d, f)).st_mode))
attempts = {}
host, inherited = socket.socketpair()
fd = inherited.fileno()
substitute = subprocess.run([driver, '__private-worker', '--generation', 'proof', f'--transport-fd={fd}'],
    pass_fds=[fd],
    env={'HOME': root}, capture_output=True, text=True, timeout=10)
attempts['same_user_parent'] = [substitute.returncode, substitute.stderr.strip()]
for name, args in {'serve': ['serve', '--embedded', '--socket', os.path.join(root, 'raw.sock')],
                   'mcp': ['mcp'], 'version': ['--version']}.items():
    result = subprocess.run([driver, *args], env={'HOME': root}, capture_output=True, text=True,
                            timeout=10, stdin=subprocess.DEVNULL)
    attempts[name] = [result.returncode, result.stderr.strip()]
report['attempts'] = attempts
report['raw_socket_created'] = os.path.exists(os.path.join(root, 'raw.sock'))
report['status'] = call('status')
stopped = call('stop')
report['stop'] = stopped
deadline = time.monotonic() + 5
while alive(pid) and time.monotonic() < deadline:
    time.sleep(0.05)
report['driver_alive_after_stop'] = alive(pid)
json.dump(report, open(os.path.join(evidence, 'desktop-driver-channel.json'), 'w'), indent=2)
assert report['record_keys'] == ['pid', 'startedAt'], report
assert report['sockets'] == ['desktop/control.sock'], report
assert all(code != 0 for code, _ in attempts.values()), report
assert not report['raw_socket_created'] and stopped['ok'] and not report['driver_alive_after_stop'], report
print(json.dumps(report, indent=2))
PY
