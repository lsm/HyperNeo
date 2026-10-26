import json, os, subprocess, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
claude, settings, cwd, command = sys.argv[1:5]
requests = []
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or '{}')
        if self.path.endswith('count_tokens'):
            self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(b'{"input_tokens":1}'); return
        requests.append(body); n = len(requests)
        main = any(t.get('name') == 'Bash' for t in body.get('tools', []))
        turn = sum(any(t.get('name') == 'Bash' for t in r.get('tools', [])) for r in requests)
        tool = main and turn == 1
        u = {'input_tokens': 1, 'output_tokens': 1}
        ev = [('message_start', {'type':'message_start','message':{'id':f'm{n}','type':'message','role':'assistant','model':'claude-sonnet-4-20250514','content':[],'stop_reason':None,'stop_sequence':None,'usage':u}}),
              ('content_block_start', {'type':'content_block_start','index':0,'content_block':{'type':'tool_use','id':f'c{n}','name':'Bash','input':{}} if tool else {'type':'text','text':''}}),
              ('content_block_delta', {'type':'content_block_delta','index':0,'delta':{'type':'input_json_delta','partial_json':json.dumps({'command':command,'timeout':120000})} if tool else {'type':'text_delta','text':'done'}}),
              ('content_block_stop', {'type':'content_block_stop','index':0}),
              ('message_delta', {'type':'message_delta','delta':{'stop_reason':'tool_use' if tool else 'end_turn','stop_sequence':None},'usage':u}),
              ('message_stop', {'type':'message_stop'})]
        self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
        for t, d in ev: self.wfile.write(f'event: {t}\ndata: {json.dumps(d)}\n\n'.encode())
s = ThreadingHTTPServer(('127.0.0.1', 0), H); threading.Thread(target=s.serve_forever, daemon=True).start()
home = os.path.join(cwd, '..', 'home'); os.makedirs(home, exist_ok=True)
env = {'HOME': home, 'PATH': '/usr/bin:/bin:/usr/sbin', 'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{s.server_port}', 'ANTHROPIC_API_KEY': 'sk-synthetic-loopback-only', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'GIT_CONFIG_NOSYSTEM': '1'}
env.update({k[4:]: v for k, v in os.environ.items() if k.startswith('EXP_')})
r = subprocess.run([claude, '-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-4-20250514', '--permission-mode', 'dontAsk', '--tools', 'Bash', '--allowedTools', 'Bash', '--settings', settings, '--setting-sources', 'local', 'go'], cwd=cwd, env=env, capture_output=True, text=True, timeout=180)
for line in r.stdout.splitlines():
    m = json.loads(line)
    if m.get('type') == 'user':
        for c in m['message']['content']:
            if c.get('type') == 'tool_result':
                print('TOOL_RESULT:', c['content'] if isinstance(c['content'], str) else json.dumps(c['content'])[:4000])
print('exit', r.returncode); open(os.path.join(cwd,'..','stderr.log'),'w').write(r.stderr)
