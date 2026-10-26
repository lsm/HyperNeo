import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const [source, directory, expectedCommit] = process.argv.slice(2);
const run = resolve(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const part of ['home/.local/bin', 'data', 'tmp', 'bin', 'evidence']) mkdirSync(join(run, part), { recursive: true });
const installed = join(run, 'home/.local/bin/hyperneo');
copyFileSync(resolve(source), installed);
chmodSync(installed, 0o755);
for (const name of ['security', 'gh', 'open', 'ps', 'claude', 'codex'])
  writeFileSync(join(run, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const env = {
  HOME: join(run, 'home'), USERPROFILE: join(run, 'home'),
  PATH: `${join(run, 'bin')}:/usr/bin:/bin:/usr/sbin`, TMPDIR: join(run, 'tmp'),
  NODE_ENV: 'test', HYPERNEO_DATA_DIR: join(run, 'data'),
  HYPERNEO_SESSION_DOOR: join(run, 'data/session-door.sock'), LOG_LEVEL: 'info',
};
const evidence: Record<string, unknown> = { expectedCommit, source: resolve(source), installed, steps: {}, requests: [] };
const save = () => writeFileSync(join(run, 'evidence/steps.json'), JSON.stringify(evidence, null, 2));
const steps = evidence.steps as Record<string, unknown>;
async function cli(args: string[]) {
  const child = Bun.spawn([installed, ...args], { cwd: join(run, 'home'), env, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  try {
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(exit, 0, `${args[0]}: ${err}`);
    return out;
  } finally { clearTimeout(timer); }
}
const requestId = crypto.randomUUID();
const neoReply = 'Release candidate Neo chat is working.';
const requests = evidence.requests as unknown[];
const model = 'claude-haiku-4-5-20251001';
const mock = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path.endsWith('/models')) return Response.json({ data: [{ id: model, type: 'model', display_name: 'Release fixture Haiku', created_at: '2025-10-01T00:00:00Z' }], has_more: false });
  if (req.method === 'HEAD') return new Response(null, { status: 200 });
  const body = await req.json() as { stream?: boolean; tools?: { name: string }[]; messages?: unknown[] };
  if (path.endsWith('/count_tokens')) return Response.json({ input_tokens: 50 });
  const invoke = body.tools?.find(tool => tool.name.endsWith('hyperneo-operations__invoke'));
  const messages = JSON.stringify(body.messages ?? []);
  const publish = !!invoke && messages.includes('RC Neo chat turn') && !messages.includes('rc-publication-tool');
  const block = publish ? { type: 'tool_use', id: 'rc-publication-tool', name: invoke!.name,
    input: { name: 'neo.publication.publish', input: { requestId: 'rc-publication', shortText: neoReply, fullText: neoReply, links: [], replyTo: [requestId] } } }
    : { type: 'text', text: 'Release candidate life-admin session is working.' };
  requests.push({ path, stream: body.stream, tools: body.tools?.length ?? 0, publish });
  const usage = { input_tokens: 100, output_tokens: 20 };
  const message = { id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', model, content: [block], stop_reason: publish ? 'tool_use' : 'end_turn', stop_sequence: null, usage };
  if (!body.stream) return Response.json(message);
  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const start = block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' };
  return new Response([
    event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: start }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } }),
    event('message_stop', { type: 'message_stop' }),
  ].join(''), { headers: { 'content-type': 'text/event-stream' } });
} });
assert.notEqual(mock.port, 8399);
const portProbe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') });
const port = portProbe.port!;
assert.notEqual(port, 8399);
await portProbe.stop(true);
let daemon: ReturnType<typeof Bun.spawn> | undefined;
let socket: WebSocket | undefined;
let logs = '';
try {
  const version = (await cli(['--version'])).trim();
  assert.equal(version, '0.49.0');
  steps.install = { pass: true, version, sha256: createHash('sha256').update(readFileSync(installed)).digest('hex'), method: 'copy candidate into fresh HOME/.local/bin; execute away from checkout' }; save();
  daemon = Bun.spawn([installed, '--host', '127.0.0.1', '--port', String(port), '--db-path', join(run, 'data/daemon.db'), '--workspace', join(run, 'home/HyperNeo')], {
    cwd: join(run, 'home'), env: { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.port}`, HYPERNEO_USE_DEV_PROXY: '0' }, stdout: 'pipe', stderr: 'pipe',
  });
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) logs += new TextDecoder().decode(chunk);
  };
  const draining = Promise.all([consume(daemon.stdout as ReadableStream<Uint8Array>), consume(daemon.stderr as ReadableStream<Uint8Array>)]);
  evidence.port = port;
  const wait = async (label: string, check: () => boolean | Promise<boolean>, timeout = 120000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      assert(daemon!.exitCode === null, `${label}: daemon exited ${daemon!.exitCode}`);
      if (await check()) return;
      await Bun.sleep(250);
    }
    throw new Error(`${label} timed out`);
  };
  await wait('first start', async () => { try { return (await fetch(`http://127.0.0.1:${port}/neo`)).ok; } catch { return false; } });
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { socket!.onopen = () => done(); socket!.onerror = () => fail(new Error('WebSocket failed')); });
  const rpc = (method: string, data: unknown = {}) => new Promise<any>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error(`${method} timeout`)), 120000);
    socket!.onmessage = event => {
      const reply = JSON.parse(String(event.data));
      if ((reply.requestId ?? reply.id) !== id) return;
      clearTimeout(timer); reply.error ? fail(new Error(JSON.stringify(reply.error))) : done(reply.data);
    };
    socket!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const op = (name: string, input: unknown = {}) => rpc('operation.invoke', { name, input });
  const build = await op('system.build');
  assert.equal(build.commit, expectedCommit); assert.equal(build.version, '0.49.0'); assert.equal(build.health, 'ok');
  assert(logs.includes('OAuth refresh scheduler skipped: test daemon without the human login'));
  steps.firstStart = { pass: true, build, served: '/neo HTTP 200', isolated: true }; save();
  await wait('SDK download', () => logs.includes('[SDK] Claude Code binary ready:'), 360000);
  assert(logs.includes('[SDK] Downloading'));
  steps.sdkDownload = { pass: true, excerpts: logs.split('\n').filter(line => line.includes('[SDK]')) }; save();
  const pair = JSON.parse(await cli(['pair', '--name', 'RC isolated client']));
  assert.equal(pair.ok, true); assert.equal(pair.approval, 'approved');
  const claim = await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pair.code, name: 'RC isolated client' }) });
  assert.equal(claim.status, 200);
  const paired = await claim.json() as { deviceId: string; kind: string; credential: string };
  const devices = JSON.parse(await cli(['devices']));
  assert(devices.devices.some((device: { id: string }) => device.id === paired.deviceId));
  steps.pair = { pass: true, approval: pair.approval, claimStatus: claim.status, kind: paired.kind, listed: true, secretsRetained: false }; save();
  const created = await rpc('providers.create', {
    params: { providerId: 'anthropic', displayName: 'RC loopback mock', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 },
    credentials: { apiKey: 'sk-devproxy-test-key' },
  });
  assert.equal(created.success, true);
  const catalog = await rpc('models.list', { forceRefresh: true });
  const lifeModel = catalog.models.find((entry: { provider: string; id: string }) => entry.provider === 'anthropic' && entry.id.includes('haiku'));
  assert(lifeModel, 'fresh model catalog has an Anthropic Haiku model');
  evidence.availableModel = { id: lifeModel.id, provider: lifeModel.provider }; save();
  const registry = await rpc('mcp.registry.list');
  for (const server of registry.servers) await rpc('mcp.registry.setEnabled', { id: server.id, enabled: false });
  const opened = await op('neo.open'); assert(opened.sessionId);
  evidence.neoSession = opened.sessionId;
  const sent = await op('neo.message.send', { sessionId: opened.sessionId, requestId, content: 'RC Neo chat turn: confirm this isolated candidate can answer. Do not touch external systems.' });
  assert.equal(sent.ok, true);
  await wait('Neo visible reply', async () => JSON.stringify(await op('neo.publication.read', { conversationId: opened.sessionId.slice(4) })).includes(neoReply), 180000);
  steps.neoChat = { pass: true, received: sent.ok, visibleReply: neoReply, transport: 'real downloaded Claude SDK, loopback scripted model, real publication operation' }; save();
  const life = await op('work.start', { adapter: 'hyperneo', createFolder: true, title: 'RC life admin', message: 'Make a synthetic grocery list for a quiet weekend. Do not contact anyone.', place: { machine: hostname(), folder: join(run, 'home/HyperNeo'), name: 'Life admin' }, model: lifeModel.id });
  evidence.lifeReceipt = life; save();
  assert.equal(life.ok, true);
  const db = new Database(join(run, 'data/daemon.db'), { readonly: true });
  try {
    await wait('life-admin session reply', () => Number((db.prepare("SELECT count(*) AS n FROM sdk_messages WHERE session_id != ? AND message_type = 'assistant'").get(opened.sessionId) as { n: number }).n) > 0, 180000);
    const rows = db.prepare("SELECT id,title,workspace_path FROM sessions WHERE id != ?").all(opened.sessionId);
    steps.lifeAdmin = { pass: true, sessions: rows, assistantObserved: true }; save();
  } finally { db.close(); }
  await wait('embedding worker load', () => logs.includes('Embeddings ready'), 360000);
  steps.embeddings = { pass: true, excerpts: logs.split('\n').filter(line => line.includes('Embeddings ready') || line.includes('Embedding asset checksum verified')) }; save();
  if (process.env.VERIFY_NODE) {
    execFileSync(process.env.VERIFY_NODE, ['.claude/skills/verify/release-candidate-web.mjs', String(port), run], {
      env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH, VERIFY_BROWSER: process.env.VERIFY_BROWSER },
      stdio: 'inherit',
    });
    steps.browser = { pass: true, evidence: 'browser.json and neo-chat.png / life-admin.png' }; save();
  }
  evidence.passed = true;
  socket.close(); socket = undefined;
  daemon.kill('SIGTERM'); await daemon.exited; await draining;
} catch (error) {
  evidence.error = String(error); save(); throw error;
} finally {
  socket?.close();
  if (daemon?.exitCode === null) {
    daemon.kill('SIGTERM');
    const timer = setTimeout(() => daemon!.kill('SIGKILL'), 10000);
    await daemon.exited; clearTimeout(timer);
  }
  await mock.stop(true);
  writeFileSync(join(run, 'evidence/daemon.log'), logs);
  evidence.cleanup = { stopped: true }; save();
}
console.log('PASS: fresh install, first start, SDK download, pair/client claim, Neo visible chat reply and life-admin session');
