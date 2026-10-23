import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
wrapper('claude');
wrapper('script', "process.argv.push('--synthetic-desktop-import');");
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const settings = join(run, 'home/.claude/settings.json');
writeFileSync(settings, '{"permissions":{"defaultMode":"bypassPermissions"}}');
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const originalSettings = digest(settings);
const rcId = crypto.randomUUID();
for (const args of [
  ['claude', '-p', '--session-id', rcId, '-n', 'rc-toggle', '--permission-mode', 'bypassPermissions', '--', 'Existing authorized synthetic RC helper'],
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
    const timer = setTimeout(() => fail(new Error(`${name} timeout`)), 150000);
    ws!.onmessage = event => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer); evidence.push({ name, input, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const task = 'Exact synthetic task: "quotes" 😀\nKeep the complete second line: END';
  const startInput = { adapter: 'claude-desktop', place: { machine: hostname(), folder: join(run, 'workspace'), name: 'Synthetic project' }, title: 'B1 synthetic worker', message: task };
  const started = await rpc<Result<WorkStarted>>('work.start', startInput);
  assert(started.ok, JSON.stringify(started));
  assert.equal(started.value.permissionMode, 'acceptEdits');
  assert.match(started.value.watchHint!, /acceptEdits/);
  assert.equal(started.value.desktopUI?.state, 'ui-unconfirmed');
  assert(started.value.receipt?.inputId);
  const ref = started.value.ref;
  assert.equal(started.value.link, `claude://claude.ai/epitaxy/${ref.id}`);
  const preparations = events().filter(e => e.kind === 'prepare');
  assert(preparations.every(e => !String(e.text).includes(task)));
  assert(events().some(e => e.kind === 'native-send' && e.message === task));
  for (let n = 0; n < 50 && !events().some(e => e.kind === 'rc-request'); n++) await new Promise(r => setTimeout(r, 100));
  assert(events().some(e => e.kind === 'rc-request' && e.mode === 'bypassPermissions'));
  const recordPath = join(scope, `${ref.id}.json`);
  const importedHash = digest(recordPath);
  const follow = 'Exact native follow-up\nRetain this tail too';
  const sent = await rpc<Result<WorkDelivery>>('work.send', { ref, message: follow });
  assert(sent.ok, JSON.stringify(sent));
  assert(sent.value.receipt?.inputId !== started.value.receipt.inputId);
  assert.equal(sent.value.desktopUI?.state, 'ui-unconfirmed');
  const detail = await rpc<Result<WorkDetail>>('work.status', { ref, receipt: sent.value.receipt });
  assert(detail.ok);
  assert.equal(detail.value.permissionMode, 'acceptEdits');
  assert.equal(detail.value.lastReply, `Completed: ${follow}`);
  assert.equal(detail.value.inputEvidence?.transcriptState, 'completed');
  assert.equal(digest(recordPath), importedHash);
  writeFileSync(join(run, 'evidence/fault'), 'waiting');
  assert((await rpc<Result<WorkDelivery>>('work.send', { ref, message: 'Synthetic permission-bound task' })).ok);
  const waiting = await rpc<Result<WorkDetail>>('work.status', { ref });
  assert(waiting.ok);
  assert.equal(waiting.value.status, 'needs_you');
  assert.equal(waiting.value.waitingFor, 'permission prompt');
  assert.equal(waiting.value.permissionMode, 'acceptEdits');
  writeFileSync(join(run, 'evidence/fault'), 'refused');
  const refused = await rpc<Result<WorkDelivery>>('work.send', { ref, message: 'Synthetic refused task' });
  assert(!refused.ok);
  assert.equal(refused.reason, 'not_delivered');
  assert(!events().some(e => e.kind === 'native-send' && e.message === 'Synthetic refused task'));
  writeFileSync(join(run, 'evidence/fault'), 'missing-import');
  const missing = await rpc<Result<WorkStarted>>('work.start', { ...startInput, title: 'Import refusal', message: 'Never run this task headless' });
  assert(!missing.ok);
  assert(!events().some(e => e.kind === 'native-send' && e.message === 'Never run this task headless'));
  assert(!events().some(e => e.kind === 'forbidden-cli'));
  assert(events().filter(e => e.kind === 'relay' && e.helper !== rcId).every(e => e.mode === 'acceptEdits'));
  assert.equal(digest(settings), originalSettings);
  evidence.push({ actualTaskSha256: createHash('sha256').update(task).digest('hex'), nativeRecordUnchanged: true, globalSettingsUnchanged: true, nativePromptsApproved: 0, renderingAndPhone: 'not measured by synthetic fixture', events: events() });
  console.log(`PASS: B1 native-message RPC journey; actual acceptEdits, full task/receipt, follow-up, permission wait, refusal and import failure. ${run}/evidence/observed.json`);
} finally {
  if (ws?.readyState === WebSocket.OPEN) {
    const closed = new Promise<void>(resolve => ws!.addEventListener('close', () => resolve(), { once: true }));
    ws.close();
    await closed;
  }
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
