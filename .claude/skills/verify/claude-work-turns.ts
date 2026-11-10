import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });

const session = '10000000-0000-4000-8000-000000009805';
const folder = join(run, 'home/.claude/projects/-synthetic');
mkdirSync(folder, { recursive: true });
const pr = 'https://github.com/synthetic/proof/pull/1';
const time = (second: number) => `2026-11-06T04:00:0${second}.000Z`;
const text = (id: string, second: number, value: string) => ({ type: 'assistant', uuid: id, timestamp: time(second), message: { id: 'final', stop_reason: 'end_turn', content: [{ type: 'text', text: value }] } });
const rows = [
  { type: 'user', uuid: 'first-input', timestamp: time(1), message: { content: 'Open the PR' } },
  { type: 'attachment', uuid: 'row', timestamp: time(2), attachment: { type: 'queued_command', source_uuid: 'queued-receipt', origin: { kind: 'peer', body: 'Also this' } } },
  { type: 'system', subtype: 'compact_boundary', timestamp: time(3) },
  { type: 'user', uuid: 'summary', isCompactSummary: true, timestamp: time(4), message: { content: 'Summary' } },
  { type: 'user', uuid: 'tool', timestamp: time(5), message: { content: [{ type: 'tool_result', content: pr }] } },
  text('part-1', 6, 'Opened it.'),
  text('part-2', 7, 'See `https://example.com/report`.'),
];
writeFileSync(join(folder, `${session}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const evidence: unknown[] = [];
try {
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  const registry = app.sessionManager.getOperationRegistry();
  const read = async (cursor?: string) => {
    const outcome = await invokeOperation(registry, 'work.turns', { ref: { adapter: 'claude-code', id: session }, ...(cursor ? { cursor } : {}) }, { source: 'rpc' });
    evidence.push(outcome);
    assert.equal(outcome.kind, 'completed', JSON.stringify(outcome));
    const reply = (outcome as { value: { ok: boolean; value: { turns: { cursor: string; inputs: string[]; urls: string[]; id: string }[] } } }).value;
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply.value.turns;
  };
  const turns = await read();
  assert.equal(turns.length, 1, JSON.stringify(turns));
  assert.equal(turns[0].id, 'part-2');
  assert.deepEqual(turns[0].inputs, ['first-input', 'queued-receipt']);
  assert.deepEqual(turns[0].urls.toSorted(), ['https://example.com/report', pr]);
  assert.deepEqual(await read(turns[0].cursor), []);
  console.log('PASS: work.turns on a real daemon reads one Claude turn with its queued input, across a compaction, and the cursor reads nothing more.');
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
