import json, os, subprocess, sys, threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

run, worker = map(Path, sys.argv[1:3])
engine = sys.argv[3] if len(sys.argv) > 3 else 'claude'
outside = run / (engine + '-outside')
outside.mkdir(exist_ok=True)
probe = worker / 'probe.sh'
for name in ['fallback-cache', 'fallback-tmp']: (worker / name).mkdir(exist_ok=True)
probe.write_text(f'''#!/bin/sh
printf inside > inside-{engine}.txt
printf metadata > .git/hyperneo-probe-{engine}
printf cache > "${{XDG_CACHE_HOME:-{worker}/fallback-cache}}/probe-{engine}"
printf "%s" "${{TMPDIR:-{worker}/fallback-tmp}}" > observed-temp-{engine}.txt
printf outside > '{outside}/escaped.txt'
printf 'outside-status=%s\\n' "$?"
printf temp > "${{TMPDIR:-{worker}/fallback-tmp}}/probe-{engine}"
printf 'temp-status=%s\\n' "$?"
''')
protected = [worker / '.git/hyperneo-native-writes.json', worker / '.git/hyperneo-worker-sandbox', worker / '.claude/settings.local.json'] if engine in ['claude', 'sdk'] else []
policy_before = {path: path.read_bytes() for path in protected}
if engine == 'sdk' and sys.platform == 'darwin' and os.environ.get('VERIFY_IMMUTABLE_RUNTIME') != '0':
    with probe.open('a') as script: script.write('mkdir -p "$TMPDIR/flagged"; printf synthetic > "$TMPDIR/flagged/file"; /usr/bin/chflags uchg "$TMPDIR/flagged/file" "$TMPDIR/flagged"; printf "%s" "$?" > observed-flags-sdk.txt\n')
if engine == 'sdk':
    with probe.open('a') as script: script.write('mkdir -p "$TMPDIR/locked"; printf synthetic > "$TMPDIR/locked/file"; chmod 000 "$TMPDIR/locked"\n')
    with probe.open('a') as script: script.write('printf synthetic-report > "$HYPERNEO_HANDOFF_DIR/sandbox-report.txt"\n')
with probe.open('a') as script:
    for path in protected: script.write(f"rm '{path}'\n")
if os.environ.get('VERIFY_LOOPBACK') == '1':
    (worker / 'loopback-probe.py').write_text('''import json, threading, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'worker-loopback-ok')
server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
server.timeout = 5
thread = threading.Thread(target=server.handle_request)
thread.start()
try:
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with client.open(f'http://127.0.0.1:{server.server_port}/probe', timeout=5) as response:
        assert response.read() == b'worker-loopback-ok'
    with open('loopback-observed.json', 'w') as output:
        json.dump({'host': '127.0.0.1', 'port': server.server_port, 'connected': True}, output)
finally:
    thread.join(timeout=6); server.server_close()
''')
    with probe.open('a') as script:
        script.write('/usr/bin/python3 ./loopback-probe.py\nprintf "loopback-status=%s\\n" "$?"\n')
if os.environ.get('VERIFY_SECRET_READ') == '1':
    secret = run / 'home/.ssh/hyperneo-synthetic-secret'
    secret.parent.mkdir(parents=True, exist_ok=True)
    secret.write_text('synthetic-secret-never-real')
    (worker / 'readable-repo-fixture.txt').write_text('synthetic-repo-readable')
    with probe.open('a') as script:
        script.write(f"cat '{secret}' >/dev/null; printf '%s' \"$?\" > secret-read-status-{engine}.txt\n")
        script.write(f"cat readable-repo-fixture.txt > repo-read-result-{engine}.txt\n")
requests = []
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'synthetic-network-ok')
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or '{}')
        if self.path.endswith('count_tokens'):
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(b'{"input_tokens":100}'); return
        requests.append(body)
        n = len(requests)
        if engine in ['sdk', 'codex-app-server']: (run / f'evidence/{engine}-requests.json').write_text(json.dumps(requests, indent=2))
        usage = {'input_tokens': 10, 'output_tokens': 10}
        if engine in ['claude', 'sdk']:
            main = any(t.get('name') == 'Bash' for t in body.get('tools', []))
            turn = sum(any(t.get('name') == 'Bash' for t in r.get('tools', [])) for r in requests)
            publish = engine == 'sdk' and main and turn == 2
            tool = (main and turn == 1) or publish
            tool_name = next((t['name'] for t in body.get('tools', []) if t.get('name', '').endswith('__invoke')), 'mcp__hyperneo-operations__invoke') if publish else 'Bash'
            tool_input = {'name': 'handoff.publish', 'input': {'name': 'sandbox-report.txt'}} if publish else {'command': '/bin/sh ./probe.sh'}
            events = [
                ('message_start', {'type': 'message_start', 'message': {'id': f'msg_{n}', 'type': 'message', 'role': 'assistant', 'model': 'claude-sonnet-4-20250514', 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': usage}}),
                ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'tool_use', 'id': f'call_{n}', 'name': tool_name, 'input': {}} if tool else {'type': 'text', 'text': ''}}),
                ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(tool_input)} if tool else {'type': 'text_delta', 'text': 'Synthetic proof finished.'}}),
                ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use' if tool else 'end_turn', 'stop_sequence': None}, 'usage': usage}),
                ('message_stop', {'type': 'message_stop'})]
        else:
            names = [t.get('name') for t in body.get('tools', [])]
            name = next((name for name in ['exec_command', 'shell_command', 'shell'] if name in names), 'exec_command')
            args = {'cmd': '/bin/sh ./probe.sh', 'yield_time_ms': 10000, 'max_output_tokens': 3000} if name == 'exec_command' else {'command': '/bin/sh ./probe.sh'}
            item = {'type': 'function_call', 'id': 'fc_probe', 'call_id': 'call_probe', 'name': name, 'arguments': json.dumps(args), 'status': 'completed'} if n == 1 else {'type': 'message', 'id': 'msg_probe', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'Synthetic proof finished.', 'annotations': []}], 'status': 'completed'}
            response = {'id': f'resp_{n}', 'object': 'response', 'created_at': 1, 'status': 'completed', 'model': 'synthetic', 'output': [item], 'usage': {**usage, 'total_tokens': 20}}
            events = [(typ, {'type': typ, 'sequence_number': i, **data}) for i, (typ, data) in enumerate([
                ('response.created', {'response': {**response, 'status': 'in_progress', 'output': []}}),
                ('response.output_item.added', {'output_index': 0, 'item': item}),
                ('response.output_item.done', {'output_index': 0, 'item': item}),
                ('response.completed', {'response': response})])]
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        for typ, data in events: self.wfile.write(f'event: {typ}\ndata: {json.dumps(data)}\n\n'.encode())
server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
with probe.open('a') as script: script.write(f"curl --proxy \"${{http_proxy:-$HTTP_PROXY}}\" --noproxy '' -fsS http://127.0.0.1:{server.server_port}/probe > network-{engine}.txt\n")
if engine in ['sdk', 'codex-app-server']:
    import time
    (run / f'evidence/{engine}-port').write_text(str(server.server_port))
    try:
        while not (run / f'{engine}-finish').exists(): time.sleep(0.1)
        (run / f'evidence/{engine}-requests.json').write_text(json.dumps(requests, indent=2))
    finally:
        server.shutdown(); server.server_close()
    sys.exit(0)
home = run / (engine + '-home')
home.mkdir(exist_ok=True)
env = {'HOME': str(home), 'PATH': '/usr/bin:/bin:/usr/sbin', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
settings = json.loads((worker / '.claude/settings.local.json').read_text()) if engine == 'claude' else {}
if engine == 'claude':
    expected_env = settings.get('env', {})
    env.update({'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{server.server_port}', 'ANTHROPIC_API_KEY': 'sk-synthetic-loopback-only'})
    args = [os.environ['VERIFY_CLAUDE'], '-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-4-20250514', '--permission-mode', 'dontAsk', '--tools', 'Bash', '--allowedTools', 'Bash', '--settings', str(worker / '.claude/settings.local.json'), '--setting-sources', 'local', 'Run the synthetic probe.']
else:
    launch = json.loads((run / 'evidence/codex-launch.json').read_text())
    config = launch['config']
    expected_env = config['shell_environment_policy']['set']
    env['CODEX_HOME'] = str(home)
    args = [os.environ['VERIFY_CODEX'], '--no-daemon', '-a', 'never', '-c', 'model_provider="synthetic"', '-c', 'model_providers.synthetic.name="Synthetic"', '-c', f'model_providers.synthetic.base_url="http://127.0.0.1:{server.server_port}/v1"', '-c', 'model_providers.synthetic.wire_api="responses"', '-c', 'model_providers.synthetic.requires_openai_auth=false', '-c', 'features.shell_snapshot=false']
    def overrides(value, path=()):
        for key, child in value.items():
            nested = (*path, key)
            if isinstance(child, dict): yield from overrides(child, nested)
            else: yield '.'.join(json.dumps(part) for part in nested) + '=' + json.dumps(child)
    for override in overrides(config): args += ['-c', override]
    args += ['-c', 'default_permissions=' + json.dumps(launch['permissions'])]
    args += ['exec', '-C', str(worker), '--json', '-m', 'synthetic', 'Run the synthetic probe.']
try:
    result = subprocess.run(args, cwd=worker, env=env, capture_output=True, text=True, timeout=90)
    (run / f'evidence/{engine}-stdout.jsonl').write_text(result.stdout)
    (run / f'evidence/{engine}-stderr.log').write_text(result.stderr)
    if os.environ.get('VERIFY_SECRET_READ') == '1':
        assert (worker / f'secret-read-status-{engine}.txt').read_text() != '0', 'BUG: synthetic secret readable'
        assert (worker / f'repo-read-result-{engine}.txt').read_text() == 'synthetic-repo-readable', 'BUG: repository read denied'
    observed = {'engine': engine, 'exit': result.returncode, 'requests': len(requests), 'insideAllowed': (worker / f'inside-{engine}.txt').exists(), 'gitAllowed': (worker / f'.git/hyperneo-probe-{engine}').exists(), 'cacheAllowed': bool(expected_env.get('XDG_CACHE_HOME')) and (Path(expected_env['XDG_CACHE_HOME']) / f'probe-{engine}').exists(), 'outsideRefused': not (outside / 'escaped.txt').exists(), 'tempPath': (worker / f'observed-temp-{engine}.txt').read_text() if (worker / f'observed-temp-{engine}.txt').exists() else '', 'tempAllowed': bool(expected_env.get('TMPDIR')) and (worker / f'observed-temp-{engine}.txt').exists() and Path((worker / f'observed-temp-{engine}.txt').read_text()).is_relative_to(Path(expected_env['TMPDIR'])) and (Path((worker / f'observed-temp-{engine}.txt').read_text()) / f'probe-{engine}').exists()}
    observed['policyIntact'] = all(path.exists() and path.read_bytes() == contents for path, contents in policy_before.items())
    observed['networkAllowed'] = (worker / f'network-{engine}.txt').read_text() == 'synthetic-network-ok'
    (run / f'evidence/{engine}-observed.json').write_text(json.dumps(observed, indent=2))
    if os.environ.get('VERIFY_LOOPBACK') == '1':
        local = worker / 'loopback-observed.json'
        observed['localServer'] = json.loads(local.read_text()) if local.exists() else None
        (run / f'evidence/{engine}-observed.json').write_text(json.dumps(observed, indent=2))
        assert observed['localServer'] and observed['localServer']['connected'], 'Worker could not listen on loopback and connect to its server'
    print(json.dumps(observed))
    observed['networkAllowed'] = (worker / f'network-{engine}.txt').read_text() == 'synthetic-network-ok'
    assert observed['policyIntact'], 'BUG: worker removed its sandbox gate or settings'
    assert observed['networkAllowed'], 'Sandbox network probe failed'
    assert observed['insideAllowed'], result.stderr
    assert observed['gitAllowed'], 'Private Git metadata write failed'
    assert observed['cacheAllowed'], 'Private cache write failed'
    assert observed['outsideRefused'], 'BUG: prepared worker wrote outside its roots'
    assert observed['tempAllowed'], 'Private worker temp write failed'
    assert 'outside-status=1' in result.stdout or 'outside-status=2' in result.stdout, result.stdout
finally:
    server.shutdown(); server.server_close()
