import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NeoAskEntry } from '../../../packages/shared/src/types/neo-ask.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { DevicePairingRepository } from '../../../packages/daemon/src/storage/repositories/device-pairing-repository.ts';
import { createLocalSocket, readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const config = { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true };
if (process.argv[2] === '--server') {
  const mode = process.argv[3];

  const entrypoints = {
    production: '../../../packages/cli/src/prod-server.ts',
    embedded: '../../../packages/cli/src/prod-server-embedded.ts',
    development: '../../../packages/cli/src/dev-server.ts',
  };
  assert(mode in entrypoints);
  const module = await import(entrypoints[mode as keyof typeof entrypoints]);
  await (mode === 'development' ? module.startDevServer : module.startProdServer)({ ...config, port: Number(process.argv[4]) });
  writeFileSync(join(run, `${mode}.ready`), 'ready');
  await new Promise(() => {});
}
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const receipts: unknown[] = [];
const app = await createDaemonApp({ config, standalone: true, verbose: false });
let socket: WebSocket | undefined;
let port = app.server.port;
let expected: NeoAskEntry;
async function checkHttp(base: string, mode: string, credential: string) {
  const unpaired = await fetch(`${base}/ask/synthetic.md`);
  const denied = { mode, status: unpaired.status, body: await unpaired.text() };
  receipts.push(denied);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(receipts, null, 2));
  assert.equal(denied.status, 401);
  assert(denied.body.startsWith('Device pairing required'));
  assert(denied.body.includes('hyperneo read'));
  const headers = { authorization: `Bearer ${credential}` };
  const response = await fetch(`${base}/ask/synthetic.md`, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const markdown = await response.text();
  assert(markdown.startsWith(`# ${expected.ask.title}\n`));
  assert(markdown.includes(`Status: ${expected.state}`));
  for (const todo of expected.todos) assert(markdown.includes(`${todo.title} — ${todo.status}`));
  assert(markdown.includes('Which day works?'));
  assert(markdown.includes('- Friday\n- Saturday'));
  assert(markdown.includes('## Outcome\n\nThe itinerary is ready.'));
  assert(!markdown.includes('Private evidence'));
  assert(!markdown.includes('Already answered'));
  const missing = await fetch(`${base}/ask/missing.md`, { headers });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  const agent = readLocalCredential(join(run, 'data/agent-read.credential'), base);
  assert.notEqual(agent, credential);
  const agentHeaders = { authorization: `Bearer ${agent}` };
  const agentCard = await fetch(`${base}/ask/synthetic.md`, { headers: agentHeaders });
  assert.equal(agentCard.status, 200);
  assert.equal(await agentCard.text(), markdown);
  for (const [path, method] of [
    ['/', 'GET'], ['/ws', 'GET'], ['/pair', 'POST'], ['/neo-peer/pair', 'POST'],
    ['/neo-peer/message', 'POST'], ['/hello', 'GET'], ['/assets/main.js', 'GET'],
    ['/ask/synthetic.md', 'POST'], ['/ask/synthetic.md', 'HEAD'], ['/ask/synthetic.md', 'OPTIONS'],
  ]) {
    assert.equal((await fetch(`${base}${path}`, { method, headers: agentHeaders })).status, 401, `${mode} must refuse agent ${method} ${path}`);
  }
  receipts.push({ mode, agentCard: 200, forbiddenRoutes: 10 });
  const ws = await fetch(`${base}/ws`, { headers });
  assert.equal(ws.status, 204);
  writeFileSync(join(run, `evidence/${mode}.md`), markdown);
  receipts.push({ mode, paired: 200, missing: 404, ws: 204, contentType: response.headers.get('content-type') });
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(receipts, null, 2));
}
try {
  await app.spaceRuntimeService?.ready();
  await app.jobProcessor.stop();
  await waitForSdkBodyCopy(app.db.getDatabase());
  assert.notEqual(port, 8399);
  const baseline = await fetch(`http://127.0.0.1:${port}/ask/synthetic.md`);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ status: baseline.status, body: await baseline.text() }, null, 2));
  assert.equal(baseline.status, 401);
  const sessionId = 'neo:10000000-0000-4000-8000-000000000001';
  await app.db.createSession({ id: sessionId, title: 'Synthetic card', workspacePath: run, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const db = app.db.getDatabase();
  db.prepare("INSERT INTO neo_asks (id,session_id,title,request,outcome,created_at,updated_at) VALUES ('synthetic',?,'Plan the visit','','The itinerary is ready.',1,1)").run(sessionId);
  db.prepare("INSERT INTO neo_todos (id,ask_id,position,title,done_when,state,created_at,updated_at) VALUES ('ticket','synthetic',0,'Book tickets','Private evidence','doing',1,1)").run();
  db.prepare("INSERT INTO neo_questions (id,ask_id,text,kind,options,state,created_at) VALUES ('day','synthetic','Which day works?','choice',?,'open',1)").run(JSON.stringify(['Friday', 'Saturday']));
  db.prepare("INSERT INTO neo_questions (id,ask_id,text,kind,state,created_at) VALUES ('old','synthetic','Already answered','reply','answered',1)").run();
  socket = createLocalSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { socket!.onopen = () => done(); socket!.onerror = () => fail(new Error('RPC connection failed')); });
  const result = await new Promise<{ ok: boolean; entry: NeoAskEntry }>((done, fail) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => fail(new Error('Card RPC timed out')), 10_000);
    socket!.onmessage = (event) => {
      const reply = JSON.parse(String(event.data));
      if (reply.requestId !== id) return;
      clearTimeout(timeout);
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    socket!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name: 'neo.ask.read', input: { askId: 'synthetic' } }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  assert.equal(result.ok, true);
  expected = result.entry;
  writeFileSync(join(run, 'evidence/rpc-card.json'), JSON.stringify(expected, null, 2));
  await checkHttp(`http://127.0.0.1:${port}`, 'standalone', await readLocalCredential());
  const { code } = new DevicePairingRepository(db).createCode('human', 'Synthetic browser', true, Date.now());
  const pairing = await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ code, name: 'Synthetic browser' }) });
  assert.equal(pairing.status, 200);
  const cookie = pairing.headers.get('set-cookie')!.split(';')[0];
  const pairedCookie = await fetch(`http://127.0.0.1:${port}/ask/synthetic.md`, { headers: { cookie } });
  assert.equal(pairedCookie.status, 200);
  receipts.push({ cookieGet: 200, credentialInPairingJson: 'credential' in await pairing.json() });
} finally {
  socket?.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ standaloneStopped: true }));
}
for (const mode of ['production', 'embedded', 'development']) {
  if (process.platform === 'darwin') {
    const guard = Bun.spawnSync(['bash', '.claude/skills/verify/resource-check.sh'], { stdout: 'inherit', stderr: 'inherit' });
    assert.equal(guard.exitCode, 0);
  }
  const assetsPath = new URL('../../../packages/cli/src/embedded-assets.ts', import.meta.url).pathname;
  if (mode === 'embedded') {
    assert(!existsSync(assetsPath), 'Do not overwrite an existing generated asset module');
    writeFileSync(assetsPath, 'export const embeddedAssets = new Map(); export const embeddedBuiltinSkills = new Map();');
  }
  const logPath = join(run, `evidence/${mode}.log`);
  const log = Bun.file(logPath);
  const child = Bun.spawn([process.execPath, import.meta.filename, '--server', mode, String(port), run], { stdout: log, stderr: log });
  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null) {
      try { ready = existsSync(join(run, `${mode}.ready`)) && (await fetch(`${base}/ws`)).status === 401; } catch {}
      if (ready) break;
      await Bun.sleep(100);
    }
    assert(ready, `${mode} must start its public listener`);
    const advertised = readFileSync(logPath, 'utf8').match(/(?:Local:\s+|UI:\s+)(http:\/\/\S+)/)?.[1];
    assert(advertised, `${mode} must advertise its local URL`);
    const reader = Bun.spawn([process.execPath, 'packages/cli/main.ts', 'read', `${advertised}/ask/synthetic.md`], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(reader.stdout).text(), new Response(reader.stderr).text(), reader.exited]);
    writeFileSync(join(run, `evidence/${mode}-advertised.json`), JSON.stringify({ advertised, exit, stderr }, null, 2));
    assert.equal(exit, 0, `${mode} advertised card link must work: ${stderr}`);
    assert(stdout.startsWith('# Plan the visit\n'));
    await checkHttp(base, mode, await readLocalCredential());
  } finally {
    child.kill('SIGTERM');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const exit = await child.exited;
    clearTimeout(deadline);
    if (mode === 'embedded') unlinkSync(assetsPath);
    assert.equal(exit, 0, `${mode} must stop cleanly`);
    assert(!readFileSync(logPath, 'utf8').includes('cleanup timed out'));
  }
}
writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ passed: true, receipts, allServersStopped: true, embeddedAssets: 'Synthetic empty build-time assets; real embedded HTTP handler' }, null, 2));
console.log(JSON.stringify({ passed: true, surfaces: ['standalone', 'production', 'embedded', 'development'], allServersStopped: true }));
