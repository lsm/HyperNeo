import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import {
  type NeoAttentionEvent,
  NEO_ATTENTION_KINDS,
} from '../../../packages/daemon/src/lib/neo/attention/decide.ts';
import {
  createNeoAttention,
  neoAttentionDelivery,
} from '../../../packages/daemon/src/lib/neo/attention/tell.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
globalThis.fetch = (() => {
  throw new Error('External HTTP is disabled');
}) as typeof fetch;
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
const HOUR = 3_600_000;
try {
  await app.jobProcessor.stop();
  const registry = app.sessionManager.getOperationRegistry();
  const opened = await invokeOperation(registry, 'neo.open', {}, { source: 'rpc', principal: 'local' });
  assert.equal(opened.kind, 'completed', JSON.stringify(opened));
  const root = (opened.value as { sessionId: string }).sessionId;
  const db = app.db.getDatabase();
  const jobs = (queue: string) =>
    (
      db
        .prepare('SELECT payload FROM job_queue WHERE queue = ? ORDER BY created_at, rowid')
        .all(queue) as { payload: string }[]
    )
      .map((row) => JSON.parse(row.payload))
      .filter((entry) => entry.to?.sessionId === root)
      .map((entry) => String(entry.message.message.content));
  let covered = false;
  const drops: string[] = [];
  const tell = createNeoAttention({
    kinds: () => NEO_ATTENTION_KINDS,
    read: () => ({ covered, latestReportAt: null }),
    ...neoAttentionDelivery(
      db,
      () => root,
      () => false
    ),
    dropped: (event, reason) => drops.push(`${event.kind}: ${reason}`),
  });
  const step: NeoAttentionEvent = {
    kind: 'todo.neo_step',
    subject: { type: 'todo', id: 'synthetic-todo' },
    since: 1_000,
    facts: { title: 'Synthetic step', reason: 'no_worker' },
  };
  const blocked: NeoAttentionEvent = {
    ...step,
    kind: 'todo.blocked',
    facts: { text: 'Todo "Synthetic step" is blocked: synthetic reason.' },
  };
  const before = { wakes: jobs('mailbox').length, digests: jobs('neo_notes').length };
  const outcomes = [
    await tell(step, 1_000),
    await tell(step, 1_000 + HOUR - 1),
    await tell(step, 1_000 + HOUR),
    await tell(step, 1_000 + HOUR + 1),
    await tell(blocked, 1_000),
    await tell(blocked, 2_000),
  ];
  covered = true;
  outcomes.push(await tell(step, 1_000 + 4 * HOUR));
  const wakes = jobs('mailbox').slice(before.wakes);
  const digests = jobs('neo_notes').slice(before.digests);
  const evidence = { root, outcomes, wakes, digests, drops };
  writeFileSync(join(run, 'evidence/neo-attention-entry.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ wakes: wakes.length, digests: digests.length, drops }));
  assert.equal(wakes.length, 2, 'step 0 and the 1 h rung each reach the mailbox once');
  assert(wakes.every((text) => text.startsWith('Todo "Synthetic step" (synthetic-todo) needs your next step')));
  assert.deepEqual(digests, ['Todo "Synthetic step" is blocked: synthetic reason.']);
  assert.deepEqual(drops, ['todo.neo_step: covered by card']);
  console.log('PASS');
} finally {
  await app.cleanup();
}
