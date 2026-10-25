import json, os, subprocess, sys, threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

run, worker = map(Path, sys.argv[1:3])
engine = sys.argv[3] if len(sys.argv) > 3 else 'claude'
outside = run / (engine + '-outside')
outside.mkdir(exist_ok=True)
probe = worker / 'probe.sh'
probe.write_text(f'''#!/bin/sh
printf inside > inside-{engine}.txt
printf outside > '{outside}/escaped.txt'
printf 'outside-status=%s\\n' "$?"
printf temp > "$TMPDIR/probe-{engine}"
printf 'temp-status=%s\\n' "$?"
''')
requests = []
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or '{}')
        if self.path.endswith('count_tokens'):
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(b'{"input_tokens":100}'); return
        requests.append(body)
        n = len(requests)
        usage = {'input_tokens': 10, 'output_tokens': 10}
        if engine == 'claude':
            tool = n == 1
            events = [
                ('message_start', {'type': 'message_start', 'message': {'id': f'msg_{n}', 'type': 'message', 'role': 'assistant', 'model': 'claude-sonnet-4-20250514', 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': usage}}),
                ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'tool_use', 'id': f'call_{n}', 'name': 'Bash', 'input': {}} if tool else {'type': 'text', 'text': ''}}),
                ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps({'command': '/bin/sh ./probe.sh'})} if tool else {'type': 'text_delta', 'text': 'Synthetic proof finished.'}}),
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
home = run / (engine + '-home')
home.mkdir(exist_ok=True)
env = {'HOME': str(home), 'PATH': '/usr/bin:/bin:/usr/sbin', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
settings = json.loads((worker / '.claude/settings.local.json').read_text())
if engine == 'claude':
    env.update(settings.get('env', {}))
    env.update({'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{server.server_port}', 'ANTHROPIC_API_KEY': 'sk-synthetic-loopback-only'})
    settings['permissions']['allow'].append('Bash')
    args = [os.environ['VERIFY_CLAUDE'], '--bare', '-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-4-20250514', '--permission-mode', 'dontAsk', '--tools', 'Bash', '--settings', json.dumps(settings), '--setting-sources', '', 'Run the synthetic probe.']
else:
    launch = json.loads((run / 'evidence/codex-launch.json').read_text())
    config = launch['config']
    env.update(config['shell_environment_policy']['set'])
    env['CODEX_HOME'] = str(home)
    args = [os.environ['VERIFY_CODEX'], '--no-daemon', '-a', 'never', '-c', 'model_provider="synthetic"', '-c', 'model_providers.synthetic.name="Synthetic"', '-c', f'model_providers.synthetic.base_url="http://127.0.0.1:{server.server_port}/v1"', '-c', 'model_providers.synthetic.wire_api="responses"', '-c', 'model_providers.synthetic.requires_openai_auth=false', '-c', 'features.shell_snapshot=false']
    for key, value in config.items():
        if isinstance(value, dict):
            for subkey, subvalue in value.items(): args += ['-c', key + '.' + subkey + '=' + json.dumps(subvalue)]
        else: args += ['-c', key + '=' + json.dumps(value)]
    args += ['exec', '-s', launch['sandbox'], '-C', str(worker), '--json', '-m', 'synthetic', 'Run the synthetic probe.']
try:
    result = subprocess.run(args, cwd=worker, env=env, capture_output=True, text=True, timeout=90)
    (run / f'evidence/{engine}-stdout.jsonl').write_text(result.stdout)
    (run / f'evidence/{engine}-stderr.log').write_text(result.stderr)
    observed = {'engine': engine, 'exit': result.returncode, 'requests': len(requests), 'insideAllowed': (worker / f'inside-{engine}.txt').exists(), 'outsideRefused': not (outside / 'escaped.txt').exists(), 'tempAllowed': bool(env.get('TMPDIR')) and (Path(env['TMPDIR']) / f'probe-{engine}').exists()}
    (run / f'evidence/{engine}-observed.json').write_text(json.dumps(observed, indent=2))
    print(json.dumps(observed))
    assert observed['insideAllowed'], result.stderr
    assert observed['outsideRefused'], 'BUG: prepared worker wrote outside its roots'
    assert observed['tempAllowed'], 'Private worker temp write failed'
    assert 'outside-status=1' in result.stdout or 'outside-status=2' in result.stdout, result.stdout
finally:
    server.shutdown(); server.server_close()
