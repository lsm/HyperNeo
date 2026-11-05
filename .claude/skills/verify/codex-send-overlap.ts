import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert(!existsSync(join(run, 'data/daemon.db')));
const home = join(run, 'home/.codex');
mkdirSync(join(home, 'ipc'), { recursive: true });
mkdirSync(join(home, 'app-server-control'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), readFileSync(join(import.meta.dir, 'gh-stub.sh')), { mode: 0o700 });
writeFileSync(join(run, 'bin/ps'), '#!/bin/sh\nprintf "%s\\n" /Applications/Codex.app/Contents/MacOS/Codex\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/open'), '#!/bin/sh\nexit 97\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/codex'), '#!/bin/sh\nexit 97\n', { mode: 0o700 });
const native = new Database(join(home, 'state_5.sqlite'));
native.exec(`CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT);
CREATE TABLE projects (id TEXT, name TEXT);
CREATE TABLE project_roots (project_id TEXT, path TEXT);`);
const completion = '2026-10-26T22:49:22.453Z';
const rollout = join(run, 'rollout.jsonl');
writeFileSync(rollout, JSON.stringify({ type: 'event_msg', timestamp: completion, payload: { type: 'task_complete', turn_id: 'done', last_agent_message: 'Synthetic complete' } }) + '\n');
for (const id of ['one', 'two']) native.prepare(`INSERT INTO threads VALUES (?, 'Synthetic', '', '', ?, 'desktop', 0, 1, ?)`).run(id, run, rollout);
native.close();
const sockets = new Set<Socket>();
const calls: { method: string; params: Record<string, unknown> }[] = [];
let active = 0;
let maximum = 0;
let alternateConnections = 0;
let fault = '';
const alternate = createServer((socket) => { alternateConnections++; socket.destroy(); });
await new Promise<void>((done, fail) => { alternate.once('error', fail); alternate.listen(join(home, 'app-server-control/app-server-control.sock'), done); });
const peer = createServer((socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const length = buffer.readUInt32LE(0);
      const request = JSON.parse(buffer.subarray(4, 4 + length).toString());
      buffer = buffer.subarray(4 + length);
      calls.push({ method: request.method, params: request.params });
      const reply = (result: object) => {
        if (socket.destroyed) return;
        const body = Buffer.from(JSON.stringify({ type: 'response', requestId: request.requestId, ...result }));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length);
        socket.write(Buffer.concat([header, body]));
      };
      if (request.method === 'initialize') reply({ resultType: 'success', result: { clientId: 'fixture' } });
      else if (request.method === 'thread-owner-discovery') reply({ resultType: 'success', handledByClientId: 'fixture-owner' });
      else if (request.method === 'thread-follower-steer-turn') {
        if (fault === 'transport-timeout') continue;
        if (fault === 'lost-steer') socket.destroy();
        else reply({ resultType: 'error', error: fault === 'timeout' ? 'thread-follower-steer-turn-timeout' : 'NoActiveTurn' });
      } else if (request.method === 'thread-follower-start-turn') {
        if (fault === 'lost-start') { socket.destroy(); continue; }
        active++;
        maximum = Math.max(maximum, active);
        setTimeout(() => {
          active--;
          reply({ resultType: 'success', result: { result: { turn: { id: request.params.turnStart.clientUserMessageId ?? 'missing-id' } } } });
        }, 80);
      } else throw new Error(`Unexpected Desktop command ${request.method}`);
    }
  });
});
await new Promise<void>((done, fail) => { peer.once('error', fail); peer.listen(join(home, 'ipc/ipc.sock'), done); });
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const evidence: unknown[] = [];
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'rpc.ts'), name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: String(app.server.port) }, stdout: 'pipe', stderr: 'pipe',
  });
  const text = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  assert.equal(await child.exited, 0, error);
  const reply = JSON.parse(text).reply;
  assert(!reply.error, JSON.stringify(reply));
  return reply.kind === 'completed' ? reply.value : reply;
}
try {
  await app.spaceRuntimeService.ready();
  await app.db.createSession({
    id: 'synthetic-neo', title: 'Synthetic Neo', workspacePath: run,
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active',
    config: { model: 'synthetic', queryMode: 'manual' },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 },
  });
  new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId: 'synthetic-neo', projectId: null, kind: 'neo' });
  await rpc('rpc:settings.global.update', { updates: { workerSandbox: 'off' } });
  const send = (id: string) => rpc('work.send', { ref: { adapter: 'codex-desktop', id }, message: 'Identical synthetic input', from: 'session:synthetic-neo' });
  for (const separate of [false, true]) {
    maximum = 0;
    const before = calls.length;
    const results = await Promise.all([send('one'), send(separate ? 'two' : 'one')]);
    assert.equal(maximum, separate ? 2 : 1);
    const inputs = calls.slice(before).filter((c) => c.method === 'thread-follower-steer-turn').map((c) => c.params.clientUserMessageId);
    const starts = calls.slice(before).filter((c) => c.method === 'thread-follower-start-turn').map((c) => (c.params.turnStart as { clientUserMessageId: string }).clientUserMessageId);
    assert.deepEqual(starts, inputs);
    assert.equal(new Set(starts).size, 2);
    assert(results.every((r) => r.ok && r.value.delivered));
    assert.deepEqual(new Set(results.map((r) => r.value.startedTurnId)), new Set(starts));
    evidence.push({ separate, maximum, inputs, starts, results });
  }
  for (const scenario of ['timeout', 'lost-steer', 'lost-start', 'default-neo', 'transport-timeout']) {
    fault = scenario === 'default-neo' ? 'timeout' : scenario;
    const before = calls.length;
    const result = scenario === 'default-neo'
      ? await rpc('work.send', { ref: { adapter: 'codex-desktop', id: 'one' }, message: 'Unattributed user input' })
      : await send('one');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_delivered');
    assert.equal(result.notSent, undefined);
    assert.equal(typeof result.uncertainDesktopInputId, 'string');
    assert(!result.detail.includes('could not be persisted'), result.detail);
    assert.equal(calls.slice(before).filter((c) => c.method === 'thread-follower-steer-turn').length, 1);
    assert.equal(calls.slice(before).filter((c) => c.method === 'thread-follower-start-turn').length, fault === 'lost-start' ? 1 : 0);
    const replay = await rpc('message.send', {
      to: 'synthetic-neo', kind: 'blocked',
      text: `Codex Desktop handoff uncertain for one. ${result.detail} Last confirmed engine completion: ${completion}. Inspect work.status and the Desktop queue; do not automatically replay or start another writer. Engine completion does not prove this input was consumed.`,
      idempotencyKey: `desktop-send-uncertain:${result.uncertainDesktopInputId}`,
      from: 'session:codex-desktop:one',
    });
    assert.equal(replay.kind, 'accepted');
    evidence.push({ scenario, fault, result, deduplicatedReport: replay });
  }
  assert.equal(alternateConnections, 0);
  const raw = app.db.getDatabase();
  const reports = raw.prepare("SELECT payload FROM job_queue WHERE queue='mailbox' AND payload LIKE '%Codex Desktop handoff uncertain%'").all() as { payload: string }[];
  assert.equal(reports.length, 5, JSON.stringify(reports));
  const payloads = reports.map((row) => JSON.parse(row.payload));
  for (const payload of payloads) {
    assert.equal(payload.to.sessionId, 'synthetic-neo');
    assert.equal(payload.message.workerReportKind, 'blocked');
    assert(JSON.stringify(payload).includes(completion));
    assert(JSON.stringify(payload).includes('do not automatically replay'));
  }
  assert.equal(new Set(payloads.map((p) => p.messageUuid)).size, 5);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ evidence, calls, payloads, alternateConnections, nativeAcceptance: 'not attempted; separately human-operated' }, null, 2));
  console.log('PASS: real RPC, per-thread serialization, separate-thread concurrency, input identity, partial acceptance, one persisted report per uncertain input, no alternate writer.');
} finally {
  await app.cleanup();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((done) => peer.close(() => done()));
  await new Promise<void>((done) => alternate.close(() => done()));
}
