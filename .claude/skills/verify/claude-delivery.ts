import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { Result, WorkDelivery, WorkDetail, WorkStarted } from '../../../packages/daemon/src/lib/drivers/types.ts';

const [portText, runText] = process.argv.slice(2);
const run = resolve(runText);
const port = Number(portText);
assert(Number.isInteger(port) && port > 0 && port < 65536 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert(!existsSync(join(run, 'data')));
for (const dir of ['bin', 'evidence', 'workspace', 'home/.claude']) mkdirSync(join(run, dir), { recursive: true });
const fixture = fileURLToPath(new URL('../../../packages/daemon/tests/fixtures/claude-b1-cli.ts', import.meta.url));
const wrapper = (name: string, setup = '') => writeFileSync(join(run, 'bin', name), `#!/usr/bin/env bun\n${setup}\nawait import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
wrapper('claude', "if (process.argv.includes('--desktop')) process.argv.push('--synthetic-desktop-import');");
if (process.env.VERIFY_HANDOFF_TIMEOUT === '1')
  writeFileSync(join(run, 'bin/script'), '#!/bin/sh\nexec /usr/bin/script "$@"\n', { mode: 0o700 });
else wrapper('script', "process.argv.push('--synthetic-desktop-import');");
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const settings = join(run, 'home/.claude/settings.json');
writeFileSync(settings, '{"permissions":{"defaultMode":"bypassPermissions"}}');
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const originalSettings = digest(settings);
const rcId = crypto.randomUUID();
for (const args of [
  ['claude', '-p', '--session-id', rcId, '-n', 'rc-toggle', '--permission-mode', 'auto', '--', 'Existing authorized synthetic RC helper'],
  ['script', '-q', '/dev/null', 'claude', '--desktop', '--resume', rcId],
]) {
  const result = spawnSync(args[0], args.slice(1), { cwd: join(run, 'workspace'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
const evidence: unknown[] = [];
const events = () => readFileSync(join(run, 'evidence/native-events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
const scope = join(run, 'home/Library/Application Support/Claude/claude-code-sessions/synthetic/account');
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
let ws: WebSocket | undefined;
try {
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connection failed')); });
  const rpc = <T>(name: string, input: unknown) => new Promise<T>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      ws!.removeEventListener('message', receive);
      fail(new Error(`${name} timeout`));
    }, 150000);
    const receive = (event: MessageEvent) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      ws!.removeEventListener('message', receive);
      clearTimeout(timer); evidence.push({ name, input, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    ws!.addEventListener('message', receive);
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const started = await rpc<Result<WorkStarted>>('work.start', { adapter: 'claude-desktop', place: { machine: hostname(), folder: join(run, 'workspace'), name: 'Synthetic delivery project' }, title: 'TEST Desktop delivery worker', message: 'Initial delivery marker' });
  assert(started.ok, JSON.stringify(started));
  const ref = started.value.ref;
  const caller = 'synthetic-delivery-origin';
  await app.db.createSession({ id: caller, title: caller, workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const recordPath = join(scope, `${ref.id}.json`);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const statePath = join(run, 'evidence/native-sessions.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as Array<{ id: string; pid: number }>;
  const target = state.find(s => `local_${s.id}` === ref.id)!;
  const registrations = join(run, 'home/.claude/sessions');
  chmodSync(registrations, 0o700);
  const socketPath = join(registrations, `${target.pid}.sock`);
  const registration = join(registrations, `${target.pid}.json`);
  writeFileSync(registration, JSON.stringify({ ...JSON.parse(readFileSync(registration, 'utf8')), messagingSocketPath: socketPath }));
  const transcript = join(run, 'home/.claude/projects', record.cwd.replace(/[/.]/g, '-'), `${target.id}.jsonl`);
  let changeMode: string | undefined;
  const peer = createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.endsWith('\n')) return;
      const frame = JSON.parse(buffer);
      if (changeMode) {
        writeFileSync(recordPath, JSON.stringify({ ...JSON.parse(readFileSync(recordPath, 'utf8')), permissionMode: changeMode }));
        return;
      }
      appendFileSync(transcript, JSON.stringify({ type: 'user', uuid: frame.uuid, timestamp: new Date().toISOString(), message: frame.message }) + '\n');
      appendFileSync(transcript, JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'Direct completion' }], stop_reason: 'end_turn' } }) + '\n');
    });
  });
  await new Promise<void>(resolve => peer.listen(socketPath, resolve));
  chmodSync(socketPath, 0o600);
  try {
    const before = events().length;
    const direct = await rpc<Result<WorkDelivery>>('work.send', { ref, from: `session:${caller}`, message: 'Confirmed direct marker' });
    assert(direct.ok && direct.value.delivered, JSON.stringify(direct));
    assert.equal(events().slice(before).filter(e => e.kind === 'target-relay' || (e.kind === 'prepare' && (e.args as string[]).includes('desktop-wake'))).length, 0);
    for (const mode of ['auto', 'default', 'acceptEdits', 'bypassPermissions']) {
      writeFileSync(recordPath, JSON.stringify({ ...JSON.parse(readFileSync(recordPath, 'utf8')), permissionMode: mode === 'bypassPermissions' ? 'auto' : 'bypassPermissions' }));
      changeMode = mode;
      const message = `Fresh receiver mode ${mode}`;
      const sent = await rpc<Result<WorkDelivery>>('work.send', { ref, mode: 'steer', from: `session:${caller}`, message });
      assert(sent.ok && sent.value.delivered && sent.value.receipt?.inputId, JSON.stringify(sent));
      const status = await rpc<Result<WorkDetail>>('work.status', { ref, receipt: sent.value.receipt });
      assert(status.ok && status.value.inputEvidence?.transcriptState === 'completed', JSON.stringify(status));
      const relay = events().findLast(e => e.kind === 'target-relay')!;
      assert.equal(relay.mode, mode === 'bypassPermissions' ? mode : 'auto');
      assert.equal(relay.receiverMode, mode);
    }
    changeMode = 'acceptEdits';
    writeFileSync(join(run, 'evidence/fault'), 'refused');
    const failed = await rpc<Result<WorkDelivery>>('work.send', { ref, from: `session:${caller}`, message: 'Both routes refuse marker' });
    assert(!failed.ok && failed.reason === 'not_delivered', JSON.stringify(failed));
    assert.match(failed.detail, /acceptEdits/); assert.match(failed.detail, /held/);
    assert(!readFileSync(transcript, 'utf8').includes('Both routes refuse marker'));
    writeFileSync(join(run, 'evidence/fault'), '');
    changeMode = undefined;
    const latest = JSON.parse(readFileSync(statePath, 'utf8')) as Array<{ id: string; pid: number }>;
    latest.find(s => s.id === target.id)!.pid = 0;
    writeFileSync(statePath, JSON.stringify(latest));
    writeFileSync(recordPath, JSON.stringify({ ...JSON.parse(readFileSync(recordPath, 'utf8')), permissionMode: 'auto' }));
    for (let n = 0; n < 2; n++) {
      const sent = await rpc<Result<WorkDelivery>>('work.send', { ref, from: `session:${caller}`, message: `Stopped headless marker ${n}` });
      assert(sent.ok && sent.value.delivered && sent.value.receipt?.inputId, JSON.stringify(sent));
    }
    const cold = events().filter(e => e.kind === 'headless-turn');
    assert.equal(cold.length, 2); assert(cold.every(e => e.mode === 'auto'));
    assert(!events().some(e => e.kind === 'prepare' && (e.args as string[]).includes('desktop-wake')));
    assert.equal(events().filter(e => e.kind === 'import').length, 2, 'Only RC fixture and original worker import; never warm or replace a helper');
    for (let n = 0; n < 30 && !events().some(e => e.kind === 'rc-request'); n++) await new Promise(resolve => setTimeout(resolve, 100));
    assert(events().some(e => e.kind === 'rc-request' && e.mode === 'auto'));
    assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).remoteControlUserEnabled, true);
    assert.equal(digest(settings), originalSettings);
    evidence.push({ freshModes: ['auto', 'default', 'acceptEdits', 'bypassPermissions'], direct, failed, headlessTurns: cold, autoRemoteControl: true, events: events() });
    console.log(`PASS: direct delivery, fresh-mode retry, double refusal, stopped auto turns and RC auto. ${run}/evidence/observed.json`);
  } finally {
    await new Promise<void>(resolve => peer.close(() => resolve()));
  }
} finally {
  if (ws?.readyState === WebSocket.OPEN) {
    const closed = new Promise<void>(resolve => ws!.addEventListener('close', () => resolve(), { once: true })); ws.close(); await closed;
  }
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
