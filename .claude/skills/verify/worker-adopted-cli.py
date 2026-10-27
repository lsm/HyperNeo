import json, os, subprocess, sys, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

claude, cwd, brief, evidence = sys.argv[1:5]
captures = []
phase = 0
tool_sent = False
command = 'test -n "$HYPERNEO_WORKTREES" && mkdir -p "$HYPERNEO_WORKTREES" && git worktree add --detach "$HYPERNEO_WORKTREES/adopted-probe" HEAD && printf ADOPTED_WORKTREE_CREATED'

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        global tool_sent
        body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or '{}')
        if self.path.endswith('count_tokens'):
            self.send_response(200); self.end_headers(); self.wfile.write(b'{"input_tokens":1}'); return
        main = any(t.get('name') == 'Bash' for t in body.get('tools', []))
        results = [c for m in body.get('messages', []) if m.get('role') == 'user' and isinstance(m.get('content'), list) for c in m['content'] if c.get('type') == 'tool_result']
        success = any(not c.get('is_error') and 'ADOPTED_WORKTREE_CREATED' in json.dumps(c.get('content', '')) for c in results)
        captures.append({'phase': phase, 'main': main, 'location': '## Runtime Location' in json.dumps(body.get('system', '')), 'result': success})
        tool = phase == 1 and main and not tool_sent
        if tool: tool_sent = True
        usage = {'input_tokens': 1, 'output_tokens': 1}
        events = [
            ('message_start', {'type': 'message_start', 'message': {'id': str(uuid.uuid4()), 'type': 'message', 'role': 'assistant', 'model': 'claude-sonnet-4-20250514', 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': usage}}),
            ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'tool_use', 'id': 'probe', 'name': 'Bash', 'input': {}} if tool else {'type': 'text', 'text': ''}}),
            ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps({'command': command, 'timeout': 120000})} if tool else {'type': 'text_delta', 'text': 'done'}}),
            ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
            ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use' if tool else 'end_turn', 'stop_sequence': None}, 'usage': usage}),
            ('message_stop', {'type': 'message_stop'}),
        ]
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        for name, value in events: self.wfile.write(f'event: {name}\ndata: {json.dumps(value)}\n\n'.encode())

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
home = os.path.join(cwd, '..', 'native-home')
os.makedirs(os.path.join(home, '.claude'), exist_ok=True)
with open(os.path.join(home, '.claude', 'settings.json'), 'w') as f:
    json.dump({'apiKeyHelper': 'printf sk-synthetic-loopback-only'}, f)
env = {'HOME': home, 'PATH': '/usr/bin:/bin:/usr/sbin', 'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{server.server_port}', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'GIT_CONFIG_NOSYSTEM': '1'}
session = str(uuid.uuid4())
common = [claude, '-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-4-20250514', '--permission-mode', 'dontAsk', '--tools', 'Bash', '--allowedTools', 'Bash', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
try:
    for phase in range(2):
        extra = ['--session-id', session, '--append-system-prompt', brief] if phase == 0 else ['--resume', session]
        result = subprocess.run(common + extra + ['go'], cwd=cwd, env=env, capture_output=True, text=True, timeout=120)
        with open(os.path.join(evidence, f'adopted-native-{phase}.log'), 'w') as f: f.write(result.stdout + result.stderr)
        assert result.returncode == 0, result.stderr + result.stdout[-2000:]
    assert any(c['phase'] == 0 and c['main'] and c['location'] for c in captures), captures
    assert any(c['phase'] == 1 and c['main'] and c['location'] for c in captures), captures
    assert any(c['phase'] == 1 and c['result'] for c in captures), captures
    print('PASS: native resumed shell uses persisted locations without launcher settings or prompt flags')
finally:
    server.shutdown(); server.server_close(); thread.join()
    with open(os.path.join(evidence, 'adopted-native.json'), 'w') as f:
        json.dump({'captures': captures, 'serverStopped': True, 'desktopUI': 'unverified'}, f, indent=2)
