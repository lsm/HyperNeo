import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const id = '00000000-0000-4000-8000-000000000001';
const projects = join(run, 'home/.claude/projects/-fixture');
const desktop = join(run, 'home/Library/Application Support/Claude/claude-code-sessions/fixture/account');
for (const dir of [projects, desktop, join(run, 'home/.claude/sessions'), join(run, 'evidence')]) mkdirSync(dir, { recursive: true });
const at = new Date().toISOString();
const rows = [
  { type: 'user', uuid: 'in', timestamp: at, cwd: '/fixture', message: { content: 'Fix it' } },
  { type: 'assistant', uuid: 'wrap', timestamp: at, message: { id: 'wrap', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Fixed.', ask: 'Ship it?', actions: [{ label: 'Yes' }, { label: 'Not now' }] } }] } },
  { type: 'user', uuid: 'result', timestamp: at, message: { content: [{ type: 'tool_result', content: 'ok' }] } },
  { type: 'assistant', uuid: 'closing', timestamp: at, message: { id: 'closing', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Closing message.' }] } },
];
const path = join(projects, `${id}.jsonl`);
writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
writeFileSync(join(run, 'home/.claude/sessions/41001.json'), JSON.stringify({ sessionId: id, pid: 41001, procStart: 1, entrypoint: 'claude-desktop', version: 'fixture' }));
writeFileSync(join(desktop, 'local_fixture.json'), JSON.stringify({ sessionId: 'local_fixture', cliSessionId: id, cwd: '/fixture', title: 'fixture', lastActivityAt: Date.now() }));
writeFileSync(join(run, 'bin/claude'), `#!/bin/sh\n[ "$1" = agents ] && [ "$2" = --json ] || exit 2\nprintf '%s\\n' '${JSON.stringify([{ sessionId: id, pid: 41001, name: 'fixture', status: 'idle' }])}'\n`, { mode: 0o700 });
for (const name of ['gh', 'open', 'ps']) writeFileSync(join(run, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const registry = app.sessionManager.getOperationRegistry();
const caller = { source: 'internal', sessionId: 'global', role: 'neo' } as const;
const read = async (name: string, input: unknown) => {
  const outcome = await invokeOperation(registry, name, input, caller);
  assert.equal(outcome.kind, 'completed', JSON.stringify(outcome));
  return (outcome as { value: { ok?: boolean; value?: Record<string, unknown> } & Record<string, unknown> }).value;
};
const ref = { adapter: 'claude-desktop', id: 'local_fixture' };
const observed: unknown[] = [];
try {
  await app.jobProcessor.stop();
  const asked = (await read('work.status', { ref })).value!;
  observed.push({ asked: { status: asked.status, waitingFor: asked.waitingFor, turnQuestion: asked.turnQuestion } });
  assert.equal(asked.status, 'needs_you');
  assert.equal(asked.waitingFor, 'Ship it?');
  assert.deepEqual(asked.turnQuestion, { text: 'Ship it?', actions: ['Yes', 'Not now'] });
  const found = await read('work.find', { adapter: 'claude-desktop', localOnly: true, limit: 5 });
  const work = ((found.value ?? found) as { places?: { work: { ref: { id: string }; status: string }[] }[] }).places?.flatMap((place) => place.work).find((item) => item.ref.id === ref.id);
  observed.push({ found: work?.status });
  assert.equal(work?.status, 'done');
  appendFileSync(path, JSON.stringify({ type: 'user', uuid: 'reply', timestamp: new Date().toISOString(), message: { content: 'Yes' } }) + '\n');
  const answered = (await read('work.status', { ref })).value!;
  observed.push({ answered: { status: answered.status, turnQuestion: answered.turnQuestion ?? null } });
  assert.notEqual(answered.status, 'needs_you');
  assert.equal(answered.turnQuestion, undefined);
  console.log('PASS: work.status reports the turn-ended question and drops it after a reply; work.find stays cheap.');
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
  await app.cleanup();
}
