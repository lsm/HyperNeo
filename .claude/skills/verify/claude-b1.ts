import { strict as assert } from 'node:assert';
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
  const task = 'Exact synthetic task: "quotes" 😀\nKeep the complete second line: END';
  const startInput = { adapter: 'claude-desktop', place: { machine: hostname(), folder: join(run, 'workspace'), name: 'Synthetic project' }, title: 'B1 synthetic worker', message: task };
  if (process.env.VERIFY_HANDOFF_TIMEOUT === '1') startInput.place.name = 'workspace';
  const started = await rpc<Result<WorkStarted>>('work.start', startInput);
  assert(started.ok, JSON.stringify(started));
  assert.deepEqual(started.value.place, startInput.place);
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
  if (process.env.VERIFY_QUEUED_DELIVERY === '1') {
    const { NeoAskTodoRepository } = await import('../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts');
    const { NeoTodoSessionRepository } = await import('../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts');
    const { createNeoTodoRunner } = await import('../../../packages/daemon/src/lib/neo/todo-runner.ts');
    const store = new NeoAskTodoRepository(app.db.getDatabase());
    const sessions = new NeoTodoSessionRepository(app.db.getDatabase());
    const now = Date.now();
    store.openAsk({ id: 'synthetic-queued-ask', projectId: null, sessionId: 'neo', originMessageId: 'synthetic-input', title: 'Synthetic delivery', request: 'Synthetic queued delivery', createdAt: now });
    const todo = store.addTodo('synthetic-queued-todo', 'synthetic-queued-ask', { title: 'Synthetic queued task', doneWhen: 'Synthetic task completes', check: null, instruction: 'Synthetic delayed task', named: null }, now);
    sessions.create(todo.id, { verb: 'send', ref });
    const runner = createNeoTodoRunner({ store, sessions, invoke: async (_caller, name, input) => ({ kind: 'completed', value: await rpc(name, input) }) as import('../../../packages/daemon/src/lib/operations/invoke.ts').OperationOutcome, packs: () => [], tell: async () => {}, changed: () => {} });
    writeFileSync(join(run, 'evidence/fault'), 'queued');
    const began = Date.now();
    await runner.start(todo.id);
    const dispatch = sessions.inputs.list(todo.id)[0];
    assert(dispatch.outcome && 'receipt' in dispatch.outcome && dispatch.outcome.receipt, JSON.stringify(dispatch));
    const receipt = dispatch.outcome.receipt;
    assert.equal(store.getTodo(todo.id)?.state, 'doing');
    assert(!('failure' in dispatch.outcome));
    const pending = await rpc<Result<WorkDetail>>('work.status', { ref, receipt });
    assert(pending.ok && pending.value.inputEvidence?.state === 'pending', JSON.stringify(pending));
    await new Promise(resolve => setTimeout(resolve, Math.max(0, dispatch.deadlineAt - Date.now() + 50)));
    const elapsed = Date.now() - began;
    assert(elapsed >= 30_000);
    await runner.refresh((message, error) => { throw new Error(`${message}: ${error}`); });
    assert.equal(store.getTodo(todo.id)?.state, 'doing');
    const latePending = await rpc<Result<WorkDetail>>('work.status', { ref, receipt });
    assert(latePending.ok && latePending.value.inputEvidence?.state === 'pending');
    const queued = events().findLast(e => e.kind === 'native-queued')!;
    const targetRecord = JSON.parse(readFileSync(recordPath, 'utf8'));
    const targetTranscript = join(run, 'home/.claude/projects', targetRecord.cwd.replace(/[/.]/g, '-'), `${targetRecord.cliSessionId}.jsonl`);
    const inputId = crypto.randomUUID();
    appendFileSync(targetTranscript, JSON.stringify({ type: 'user', uuid: inputId, timestamp: new Date().toISOString(), message: { content: `<cross-session-message from="local_${queued.helper}" name="desktop-wake">\n${queued.message}\n</cross-session-message>` } }) + '\n');
    const accepted = await rpc<Result<WorkDetail>>('work.status', { ref, receipt });
    assert(accepted.ok && accepted.value.inputEvidence?.transcriptState === 'accepted', JSON.stringify(accepted));
    appendFileSync(targetTranscript, JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'Synthetic delayed completion' }], stop_reason: 'end_turn' } }) + '\n');
    const confirmed = await rpc<Result<WorkDetail>>('work.status', { ref, receipt });
    assert(confirmed.ok && confirmed.value.inputEvidence?.state === 'observed' && confirmed.value.inputEvidence.transcriptState === 'completed', JSON.stringify(confirmed));
    evidence.push({ queuedDelivery: { elapsed, dispatch, todo: store.getTodo(todo.id), pending, latePending, accepted, confirmed } });
    writeFileSync(join(run, 'evidence/fault'), '');
  }
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
  const nativeSessions = JSON.parse(readFileSync(join(run, 'evidence/native-sessions.json'), 'utf8')) as Array<{ id: string; pid: number }>;
  const targetPid = nativeSessions.find(s => `local_${s.id}` === ref.id)!.pid;
  const registration = join(run, 'home/.claude/sessions', `${targetPid}.json`);
  const registrationBytes = readFileSync(registration, 'utf8');
  for (const entrypoint of ['cli', 'unknown-owner']) {
    writeFileSync(registration, JSON.stringify({ ...JSON.parse(registrationBytes), entrypoint }));
    const before = events().length;
    const refusedOwner = await rpc<Result<WorkDelivery>>('work.send', { ref, message: `Refuse ${entrypoint} ownership` });
    assert(!refusedOwner.ok, `Native delivery bypassed ${entrypoint} target owner`);
    assert.equal(refusedOwner.reason, 'unreachable');
    assert.equal(events().length, before);
    writeFileSync(registration, registrationBytes);
  }
  const stopped = JSON.parse(readFileSync(join(run, 'evidence/native-sessions.json'), 'utf8')) as Array<{ id: string; title: string; pid: number }>;
  for (const helper of stopped.filter(s => s.title === 'desktop-wake')) helper.pid = 0;
  writeFileSync(join(run, 'evidence/native-sessions.json'), JSON.stringify(stopped));
  const helperPreparationsBefore = events().filter(e => e.kind === 'prepare' && (e.args as string[]).includes('desktop-wake')).length;
  const helperImportsBefore = events().filter(e => e.kind === 'import').length;
  writeFileSync(join(run, 'evidence/fault'), 'slow-helper');
  const concurrent = await Promise.all([
    rpc<Result<WorkDelivery>>('work.send', { ref, message: 'Concurrent native send ONE' }),
    rpc<Result<WorkDelivery>>('work.send', { ref, mode: 'steer', message: 'Concurrent native steer TWO' }),
  ]);
  assert(concurrent.every(result => result.ok), JSON.stringify(concurrent));
  const helperPreparationsAfter = events().filter(e => e.kind === 'prepare' && (e.args as string[]).includes('desktop-wake')).length;
  assert.equal(helperPreparationsAfter - helperPreparationsBefore, 0);
  assert.equal(events().filter(e => e.kind === 'import').length - helperImportsBefore, 1);
  assert(concurrent[0].ok && concurrent[1].ok && concurrent[0].value.receipt!.inputId !== concurrent[1].value.receipt!.inputId);
  evidence.push({ concurrentNativeMessages: concurrent, newHelpers: helperPreparationsAfter - helperPreparationsBefore });
  writeFileSync(join(run, 'evidence/fault'), '');
  if (process.env.VERIFY_STALE_HELPER === '1') {
    const statePath = join(run, 'evidence/native-sessions.json');
    const stopHelpers = () => {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as Array<{ id: string; title: string; pid: number }>;
      const ids = state.filter(s => s.title === 'desktop-wake').map(s => s.id);
      for (const s of state) if (ids.includes(s.id)) s.pid = 0;
      writeFileSync(statePath, JSON.stringify(state));
      writeFileSync(join(run, 'evidence/blocked-imports.json'), JSON.stringify(ids));
      return ids;
    };
    const preparations = () => events().filter(e => e.kind === 'prepare' && (e.args as string[]).includes('desktop-wake')).length;
    const staleIds = stopHelpers();
    const before = preparations();
    const recovered = await rpc<Result<WorkDelivery>>('work.send', { ref, message: 'Stale helper replacement delivers this exact marker' });
    assert(recovered.ok, JSON.stringify(recovered));
    assert(recovered.value.receipt?.inputId);
    assert.equal(preparations() - before, 1);
    const delivered = events().findLast(e => e.kind === 'native-send')!;
    assert(!staleIds.includes(String(delivered.helper)));
    const status = await rpc<Result<WorkDetail>>('work.status', { ref, receipt: recovered.value.receipt });
    assert(status.ok && status.value.lastReply === 'Completed: Stale helper replacement delivers this exact marker');
    stopHelpers();
    writeFileSync(join(run, 'evidence/fault'), 'dead-helpers');
    const beforeFailure = preparations();
    const failed = await rpc<Result<WorkDelivery>>('work.send', { ref, message: 'Never delivered with two dead helpers' });
    assert(!failed.ok && failed.reason === 'not_delivered', JSON.stringify(failed));
    assert.match(failed.detail, /Claude Code Desktop did not open desktop-wake/);
    assert.equal(preparations() - beforeFailure, 1);
    assert(!events().some(e => e.kind === 'native-send' && e.message === 'Never delivered with two dead helpers'));
    evidence.push({ staleHelperRecovery: recovered, targetStatus: status, failedReplacement: failed, replacementsPerSend: 1 });
    writeFileSync(join(run, 'evidence/fault'), '');
  }
  const humanId = crypto.randomUUID();
  for (const args of [
    ['claude', '-p', '--session-id', humanId, '-n', 'Synthetic human-created session', '--permission-mode', 'acceptEdits', '--', 'Synthetic human opening message'],
    ['script', '-q', '/dev/null', 'claude', '--desktop', '--resume', humanId],
  ]) {
    const result = spawnSync(args[0], args.slice(1), { cwd: join(run, 'workspace'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const humanTranscript = join(run, 'home/.claude/projects', join(run, 'workspace').replace(/[/.]/g, '-'), `${humanId}.jsonl`);
  writeFileSync(humanTranscript, readFileSync(humanTranscript, 'utf8').replace('"entrypoint":"sdk-cli"', '"entrypoint":"claude-desktop"'));
  const humanRecord = join(scope, `local_${humanId}.json`);
  const humanRecordHash = digest(humanRecord);
  const humanSessions = JSON.parse(readFileSync(join(run, 'evidence/native-sessions.json'), 'utf8')) as Array<{ id: string; pid: number }>;
  humanSessions.find(s => s.id === humanId)!.pid = 0;
  writeFileSync(join(run, 'evidence/native-sessions.json'), JSON.stringify(humanSessions));
  const nativeHuman = await rpc<Result<WorkDelivery>>('work.send', { ref: { adapter: 'claude-desktop', id: `local_${humanId}` }, message: 'Explicit native message to synthetic human-created session' });
  assert(nativeHuman.ok, JSON.stringify(nativeHuman));
  assert(nativeHuman.value.receipt?.inputId);
  assert.equal(digest(humanRecord), humanRecordHash);
  assert.equal(JSON.parse(readFileSync(humanRecord, 'utf8')).permissionMode, 'acceptEdits');
  evidence.push({ explicitNativeSendToSyntheticHumanOrigin: nativeHuman, permissionAndRecordUnchanged: true });
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
  const recoveryTitle = 'Wake refusal recovery';
  const wakeRefused = await rpc<Result<WorkStarted>>('work.start', { ...startInput, title: recoveryTitle, message: 'Refused initial task must retain its imported identity' });
  assert(!wakeRefused.ok, JSON.stringify(wakeRefused));
  const importedRecovery = events().findLast(e => e.kind === 'prepare' && (e.args as string[]).includes(recoveryTitle))!;
  const recoveryRef = { adapter: 'claude-desktop', id: `local_${importedRecovery.id}` };
  assert(wakeRefused.detail.includes(JSON.stringify(recoveryRef)), wakeRefused.detail);
  assert(wakeRefused.detail.includes(`claude://claude.ai/epitaxy/${recoveryRef.id}`), wakeRefused.detail);
  assert.match(wakeRefused.detail, /delivery may still arrive/);
  const recovery = await rpc<Result<WorkDetail>>('work.status', { ref: recoveryRef });
  assert(recovery.ok, JSON.stringify(recovery));
  assert(!events().some(e => e.kind === 'native-send' && e.message === 'Refused initial task must retain its imported identity'));
  evidence.push({ importedWakeRefusal: wakeRefused, recoveryStatus: recovery });
  writeFileSync(join(run, 'evidence/fault'), 'missing-import');
  const missing = await rpc<Result<WorkStarted>>('work.start', { ...startInput, title: 'Import refusal', message: 'Never run this task headless' });
  assert(!missing.ok);
  assert(!events().some(e => e.kind === 'native-send' && e.message === 'Never run this task headless'));
  assert(!events().some(e => e.kind === 'forbidden-cli'));
  if (process.env.VERIFY_HANDOFF_TIMEOUT === '1') {
    writeFileSync(join(run, 'evidence/fault'), 'hanging-import');
    const began = Date.now();
    const hung = await rpc<Result<WorkStarted>>('work.start', { ...startInput, title: 'Hanging handoff', message: 'Never dispatch during hung handoff' });
    assert(!hung.ok);
    assert.match(hung.detail, /Desktop handoff failed/);
    const elapsed = Date.now() - began;
    assert(elapsed >= 120000 && elapsed < 130000, `handoff deadline ${elapsed} ms`);
    const hangingPid = Number(readFileSync(join(run, 'evidence/hanging-import.pid'), 'utf8'));
    let childState = '';
    for (let poll = 0; poll < 20; poll++) {
      childState = spawnSync('ps', ['-o', 'stat=', '-p', String(hangingPid)], { encoding: 'utf8' }).stdout.trim();
      if (!childState || childState.startsWith('Z')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(!childState || childState.startsWith('Z'), `owned PTY child ${hangingPid} survived in ${childState}`);
    evidence.push({ actualPtyChild: hangingPid, childState: childState || 'absent', checkedBeforeFixtureCleanup: true });
    evidence.push({ hangingHandoff: hung, elapsed, noTaskDispatched: !events().some(e => e.kind === 'native-send' && e.message === 'Never dispatch during hung handoff') });
  }
  assert(events().filter(e => e.kind === 'relay' && e.helper !== rcId).every(e => e.mode === 'acceptEdits'));
  assert.equal(digest(settings), originalSettings);
  evidence.push({ actualTaskSha256: createHash('sha256').update(task).digest('hex'), nativeRecordUnchanged: true, globalSettingsUnchanged: true, nativePromptsApproved: 0, renderingAndPhone: 'not measured by synthetic fixture', events: events() });
  console.log(`PASS: B1 native-message RPC journey; actual acceptEdits, full task/receipt, follow-up, permission wait, refusal and import failure. ${run}/evidence/observed.json`);
} finally {
  const hangingPid = join(run, 'evidence/hanging-import.pid');
  if (existsSync(hangingPid)) {
    try { process.kill(Number(readFileSync(hangingPid, 'utf8')), 'SIGTERM'); } catch {}
  }
  if (ws?.readyState === WebSocket.OPEN) {
    const closed = new Promise<void>(resolve => ws!.addEventListener('close', () => resolve(), { once: true }));
    ws.close();
    await closed;
  }
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
