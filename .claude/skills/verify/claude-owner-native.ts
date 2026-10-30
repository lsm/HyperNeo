import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const repo = resolve(import.meta.dir, '../../..');
const receiverMode = process.argv[2] ?? 'default';
assert(['default', 'auto', 'plan', 'bypassPermissions'].includes(receiverMode));
const { createDaemonApp } = await import(join(repo, 'packages/daemon/src/app.ts'));
const { getConfig } = await import(join(repo, 'packages/daemon/src/config.ts'));
const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.NODE_ENV, 'test');
const engine = process.env.VERIFY_CLAUDE!;
assert(engine.startsWith('/'));
const { openClaudeInbox } = await import(join(repo, 'packages/daemon/src/lib/drivers/claude-inbox.ts'));
const evidence = join(run, 'evidence'), peerDir = join(run, 's'), home = join(run, 'home');
for (const dir of [evidence, peerDir, join(home, '.claude'), join(run, 'workspace')]) mkdirSync(dir, { recursive: true });
chmodSync(peerDir, 0o700);
writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ apiKeyHelper: 'printf synthetic-loopback-only' }));
type NativeEvent = { type?: string; subtype?: string; cause?: string; message_uuid?: string; [key: string]: unknown };
const output: NativeEvent[] = [], receipts: { at: number; messageId: string; status?: string }[] = [], modelRequests: { at: number; url: string; messages: unknown }[] = [];
let stdout = '', stderr = '', stdoutBuffer = '', active = false;
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));
async function until(check: () => boolean, label: string, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error(`Timeout: ${label}; ${stderr.slice(-600)}`); await delay(30); }
}
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (request.url.includes('count_tokens')) return Response.json({ input_tokens: 100 });
  const body = await request.json() as { messages?: unknown };
  modelRequests.push({ at: Date.now(), url: request.url, messages: body.messages });
  active = true; await delay(600);
  const usage = { input_tokens: 10, output_tokens: 10 };
  const events = [
    ['message_start', { type: 'message_start', message: { id: `msg_${modelRequests.length}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-20250514', content: [], stop_reason: null, stop_sequence: null, usage } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SYNTHETIC_REPLY' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }],
    ['message_stop', { type: 'message_stop' }],
  ];
  active = false;
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
} });
assert.notEqual(server.port, 8399);
const sessionId = crypto.randomUUID();
const child = spawn('/bin/sh', ['-c', 'exec "$1" -p --output-format stream-json --input-format stream-json --verbose --permission-mode "$4" --model claude-sonnet-4-20250514 --tools "" --strict-mcp-config --mcp-config \'{"mcpServers":{}}\' --session-id "$3" --messaging-socket-path "$2/$$.sock"', 'native-proof', engine, peerDir, sessionId, receiverMode], {
  cwd: join(run, 'workspace'), env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: join(run, 'tmp'), CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_CODE_TMPDIR: join(run, 'tmp'), NODE_ENV: 'test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS: '700' }, stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdout.on('data', chunk => {
  stdout += chunk; stdoutBuffer += chunk;
  let end; while ((end = stdoutBuffer.indexOf('\n')) >= 0) { const line = stdoutBuffer.slice(0, end); stdoutBuffer = stdoutBuffer.slice(end + 1); try { output.push(JSON.parse(line)); } catch {} }
});
child.stderr.on('data', chunk => stderr += chunk);
const exited = new Promise<number | null>(done => child.once('exit', done));
let inbox: Awaited<ReturnType<typeof openClaudeInbox>> | undefined;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
const rpcReplies: unknown[] = [];
try {
  child.stdin.write(JSON.stringify({ type: 'user', session_id: sessionId, message: { role: 'user', content: 'BOOTSTRAP_SYNTHETIC' }, parent_tool_use_id: null }) + '\n');
  await until(() => output.some(r => r.type === 'result'), 'initial local model turn', 35000);
  const registration = JSON.parse(readFileSync(join(home, '.claude/sessions', `${child.pid}.json`), 'utf8'));
  assert.equal(registration.sessionId, sessionId);
  assert.equal(registration.messagingSocketPath, join(peerDir, `${child.pid}.sock`));
  writeFileSync(join(evidence, 'registration.json'), JSON.stringify(registration, null, 2));
  const target = { sessionId, pid: child.pid!, socketPath: registration.messagingSocketPath, version: registration.version };
  inbox = await openClaudeInbox(peerDir, 'abc123', event => receipts.push({ at: Date.now(), ...event }));
  const mismatch = crypto.randomUUID();
  await inbox.write(target, { messageId: mismatch, inputId: mismatch, text: 'MISMATCH_REAL_NATIVE', fromMode: receiverMode === 'bypassPermissions' ? 'prompting' : 'bypass' });
  await until(() => receipts.some(r => r.messageId === mismatch && r.status === 'expired'), 'native mismatch expiry');
  assert.deepEqual(receipts.filter(r => r.messageId === mismatch).map(r => r.status), ['held', 'expired']);
  assert(output.some(r => r.subtype === 'peer_message_hold' && r.cause === 'mode-mismatch'), 'native stdout should identify hold cause');
  assert(!modelRequests.some(r => JSON.stringify(r.messages).includes('MISMATCH_REAL_NATIVE')));
  writeFileSync(join(run, 'bin/claude'), `#!/usr/bin/env bun\nif (!process.argv.includes('agents')) process.exit(42);\nprocess.stdout.write(JSON.stringify([{sessionId:${JSON.stringify(sessionId)},pid:${child.pid},status:'busy'}]));\n`, { mode: 0o700 });
  writeFileSync(join(run, 'bin/ps'), `#!/bin/sh\nprintf '%s\\n' '${child.pid} 1 ${child.pid} 00:20 claude --permission-mode ${receiverMode}'\n`, { mode: 0o700 });
  for (const name of ['gh', 'open']) writeFileSync(join(run, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  await app.db.createSession({ id: 'synthetic-origin', title: 'Synthetic origin', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  child.stdin.write(JSON.stringify({ type: 'user', session_id: sessionId, message: { role: 'user', content: 'ACTIVE_SYNTHETIC' }, parent_tool_use_id: null }) + '\n');
  await until(() => active, 'model active');
  const reply = await new Promise<import('../../../packages/daemon/src/lib/drivers/types.ts').Result<import('../../../packages/daemon/src/lib/drivers/types.ts').WorkDelivery>>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error('work.send timed out')), 15000);
    ws!.onmessage = event => {
      const response = JSON.parse(String(event.data));
      if (response.id !== id && response.requestId !== id) return;
      clearTimeout(timer); rpcReplies.push(response);
      if (response.error) fail(new Error(JSON.stringify(response.error))); else done(response.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name: 'work.send', input: { ref: { adapter: 'claude-code', id: sessionId }, from: 'session:synthetic-origin', message: 'MATCHING_REAL_NATIVE_ACTIVE' } }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  assert(reply.ok && reply.value.unconfirmed && reply.value.receipt, JSON.stringify(reply));
  await until(() => modelRequests.some(r => JSON.stringify(r.messages).includes('MATCHING_REAL_NATIVE_ACTIVE')), 'RPC message reaches active native model');
  assert(!output.some(r => r.subtype === 'peer_message_hold' && r.message_uuid === reply.value.receipt.inputId));
  console.log(`PASS: real isolated daemon work.send -> installed Claude ${receiverMode} receiver; no hold for matched RPC input, active native model picked it up. Opposite-class control remained held then expired at 700ms.`);
} finally {
  ws?.close(); await app?.cleanup();
  await inbox?.close(); child.stdin.end(); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer);
  server.stop(true);
  writeFileSync(join(evidence, 'stdout.jsonl'), stdout); writeFileSync(join(evidence, 'stderr.log'), stderr);
  writeFileSync(join(evidence, 'observed.json'), JSON.stringify({ receiverMode, rpcReplies, output, receipts, modelRequests, resourcesClosed: true }, null, 2));
}
