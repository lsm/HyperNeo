import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { mkdirSync, existsSync, copyFileSync, chmodSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const dir of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
chmodSync(join(run, 'bin/gh'), 0o755);
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const calls: unknown[] = [];
const cases: { name: string; passed: boolean; error?: string }[] = [];
const endpoint = createServer(async (req, res) => {
  for await (const _chunk of req) {}
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: [{ id: 'swe-2-high' }] }));
});
await new Promise<void>((done) => endpoint.listen(0, '127.0.0.1', done));
const endpointPort = (endpoint.address() as { port: number }).port;
const reservation = createServer();
await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
const port = (reservation.address() as { port: number }).port;
await new Promise<void>((done) => reservation.close(() => done()));
assert(port !== 8399 && endpointPort !== 8399);
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
let socket: WebSocket | undefined;
try {
  await app.spaceRuntimeService.ready();
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { socket!.onopen = () => done(); socket!.onerror = () => fail(new Error('WebSocket failed')); });
  const rpc = (method: string, data: unknown): Promise<any> => new Promise((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error(`${method} timeout`)), 15000);
    socket!.onmessage = ({ data: raw }) => {
      const reply = JSON.parse(String(raw));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer);
      calls.push({ method, data, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    socket!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const invoke = (name: string, input: unknown) => rpc('operation.invoke', { name, input });
  const registry = await rpc('mcp.registry.list', {});
  for (const server of registry.servers ?? []) if (server.enabled) await rpc('mcp.registry.setEnabled', { id: server.id, enabled: false });
  const add = (id: string, models: { id: string; name: string }[]) => rpc('customEndpoints.add', { endpoint: {
    id, name: id, type: 'anthropic-messages', baseUrl: `http://127.0.0.1:${endpointPort}`, models,
  } });
  await add('synthetic', [{ id: 'swe-2-high', name: 'SWE-2 High' }]);
  await rpc('models.list', { forceRefresh: true });
  const start = (model: string, effort?: string) => invoke('work.start', {
    adapter: 'hyperneo', place: { machine: hostname(), folder: join(run, 'workspace'), name: 'Synthetic' },
    title: 'Synthetic target', message: 'Synthetic input', model, ...(effort ? { effort } : {}),
  });
  const check = async (name: string, action: () => Promise<void>) => {
    try { await action(); cases.push({ name, passed: true }); }
    catch (error) { cases.push({ name, passed: false, error: String(error) }); }
  };
  await check('model catalog exposes id/name/provider', async () => {
    const list = await invoke('settings.model.get', {});
    assert(list.availableModels.some((entry: any) => entry.id === 'swe-2-high' && entry.name === 'SWE-2 High' && entry.provider === 'custom:synthetic'));
  });
  await check('unique case-insensitive name starts on its provider', async () => {
    const result = await start('sWe-2 HIGH'); assert.equal(result.ok, true, JSON.stringify(result));
    const session = app.sessionManager.getSessionFromDB(result.value.ref.id)!;
    assert.equal(session.config.model, 'swe-2-high'); assert.equal(session.config.provider, 'custom:synthetic');
  });
  await add('other', [{ id: 'other-high', name: 'SWE-2 High' }]);
  await rpc('models.list', { forceRefresh: true });
  await check('ambiguous name refuses and lists matching ids', async () => {
    const before = app.db.getDatabase().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    const result = await start('SWE-2 High'); assert.equal(result.reason, 'unsupported_model');
    assert.match(result.detail, /swe-2-high/); assert.match(result.detail, /other-high/);
    assert.deepEqual(app.db.getDatabase().prepare('SELECT COUNT(*) AS n FROM sessions').get(), before);
  });
  await check('exact id wins despite duplicate display names', async () => {
    const result = await start('swe-2-high'); assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(app.sessionManager.getSessionFromDB(result.value.ref.id)!.config.provider, 'custom:synthetic');
  });
  await add('same-id', [{ id: 'swe-2-high', name: 'Unique other offer' }]);
  await rpc('models.list', { forceRefresh: true });
  await check('display name retains provider when ids are shared', async () => {
    const result = await start('Unique other offer'); assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(app.sessionManager.getSessionFromDB(result.value.ref.id)!.config.provider, 'custom:same-id');
  });
  await check('effort applies to HyperNeo before its input is handed off', async () => {
    const result = await start('swe-2-high', 'high'); assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value.effort, 'high');
    const id = result.value.ref.id;
    assert.equal(app.sessionManager.getSessionFromDB(id)!.config.thinkingLevel, 'think24k');
    assert.equal((await rpc('session.thinking.get', { sessionId: id })).thinkingLevel, 'think24k');
    assert(result.value.receipt.inputId);
  });
  assert(cases.every((item) => item.passed), JSON.stringify(cases));
} finally {
  socket?.close();
  await app.cleanup();
  endpoint.closeAllConnections();
  await new Promise<void>((done) => endpoint.close(() => done()));
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ port, endpointPort, cases, calls, resourcesClosed: true }, null, 2));
}
console.log(`PASS ${run}/evidence/observed.json`);
