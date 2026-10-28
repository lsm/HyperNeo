import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { Result, WorkDetail } from '../../../packages/daemon/src/lib/drivers/types.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const projects = join(run, 'home/.claude/projects/-fixture');
const desktop = join(run, 'home/Library/Application Support/Claude/claude-code-sessions/fixture/account');
for (const dir of [projects, desktop, join(run, 'home/.claude/sessions'), join(run, 'evidence')]) mkdirSync(dir, { recursive: true });
const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
const fixture = readFileSync(new URL('../../../packages/daemon/tests/unit/1-core/drivers/fixtures/claude-observed-identity.jsonl', import.meta.url), 'utf8');
for (const [index, id] of ids.entries()) {
  writeFileSync(join(projects, `${id}.jsonl`), JSON.stringify({ type: 'user', cwd: '/fixture', message: { content: 'fixture' } }) + '\n' + fixture);
  writeFileSync(join(run, `home/.claude/sessions/${41001 + index}.json`), JSON.stringify({ sessionId: id, pid: 41001 + index, procStart: 1, entrypoint: index ? 'claude-desktop' : 'cli', version: 'fixture' }));
}
writeFileSync(join(desktop, 'local_fixture.json'), JSON.stringify({ sessionId: 'local_fixture', cliSessionId: ids[1], cwd: '/fixture', title: 'fixture' }));
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\n[ "$1" = agents ] && [ "$2" = --json ] || exit 2\nprintf \'%s\\n\' \'' + JSON.stringify(ids.map((sessionId, index) => ({ sessionId, pid: 41001 + index, name: 'fixture', status: 'busy' }))) + '\'\n', { mode: 0o700 });
for (const name of ['gh', 'open', 'ps']) writeFileSync(join(run, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
const evidence: unknown[] = [];
async function status(adapter: string, id: string) {
  const requestId = crypto.randomUUID();
  const reply = new Promise<Result<WorkDetail>>((done, fail) => {
    const timer = setTimeout(() => { ws.removeEventListener('message', receive); fail(new Error('RPC timeout')); }, 15000);
    const receive = (event: MessageEvent) => {
      const value = JSON.parse(String(event.data));
      if (value.requestId !== requestId && value.id !== requestId) return;
      clearTimeout(timer); ws.removeEventListener('message', receive);
      evidence.push(value);
      if (value.error) fail(new Error(JSON.stringify(value.error))); else done(value.data);
    };
    ws.addEventListener('message', receive);
  });
  ws.send(JSON.stringify({ type: 'REQ', id: requestId, sessionId: 'global', version: '1.0.0', timestamp: new Date().toISOString(), method: 'operation.invoke', data: { name: 'work.status', input: { ref: { adapter, id }, since: Date.now() } } }));
  const result = await reply;
  assert(result.ok, JSON.stringify(result));
  return result.value;
}
try {
  assert.notEqual(app.server.port, 8399);
  await new Promise<void>((done, fail) => { ws.onopen = () => done(); ws.onerror = () => fail(new Error('WebSocket failed')); });
  for (const [adapter, id, cliId] of [['claude-code', ids[0], ids[0]], ['claude-desktop', 'local_fixture', ids[1]]]) {
    const first = await status(adapter, id);
    assert.equal(first.model, 'claude-opus-5-5'); assert.equal(first.effort, 'medium');
    assert.equal(first.identityObservation?.source, 'assistant-transcript');
    const path = join(projects, `${cliId}.jsonl`);
    appendFileSync(path, JSON.stringify({ type: 'assistant', uuid: 'switch', timestamp: new Date().toISOString(), effort: 'medium', perTurnEffort: 'high', message: { model: 'claude-sonnet-5', content: [] } }) + '\n');
    const changed = await status(adapter, id);
    assert.equal(changed.model, 'claude-sonnet-5'); assert.equal(changed.effort, 'high');
    appendFileSync(path, JSON.stringify({ type: 'assistant', uuid: 'partial', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'effort: low' }] } }) + '\n');
    const partial = await status(adapter, id);
    assert.equal(partial.model, 'claude-opus-5-5'); assert.equal(partial.effort, undefined);
  }
  console.log('PASS: both public work.status adapters expose trusted identity, switch effort/model, preserve unknown.');
} finally {
  writeFileSync(join(run, 'evidence/rpc.json'), JSON.stringify(evidence, null, 2));
  ws.close();
  await app.cleanup();
}
