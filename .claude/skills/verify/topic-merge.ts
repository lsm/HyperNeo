import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NEO_TOPICS_REORGANIZE_NIGHTLY } from '../../../packages/daemon/src/lib/neo/reorganize-nightly.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const neo = 'neo:10000000-0000-4000-8000-000000000007';
const network = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error('External HTTP is disabled');
}) as typeof fetch;
try {
  const app = await createDaemonApp({
    config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
    verbose: false,
  });
  try {
    await app.jobProcessor.stop();
    const db = app.db.getDatabase();
    const registry = () => app.sessionManager.getOperationRegistry();
    const as = (sessionId: string) =>
      createOperationMcpHandler(registry, () => ({ sessionId, role: 'neo' }));
    const call = async (name: string, input: unknown, sessionId = neo) => {
      const reply = await as(sessionId)({ name, input });
      const result = JSON.parse(reply.content[0].text);
      evidence.push({ name, input, sessionId, isError: reply.isError ?? false, result });
      return result;
    };
    const stored = () =>
      (db.prepare('SELECT title, topic FROM neo_asks ORDER BY title').all() as {
        title: string;
        topic: string;
      }[]).map((row) => `${row.title}=${row.topic}`);

    db.prepare(
      "INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic Neo', '/tmp', '2026-11-17T00:00:00Z', '2026-11-17T00:00:00Z', 'active', '{}', '{}')"
    ).run(neo);
    new NeoRepository(db).reserveBinding({ sessionId: neo, kind: 'neo', projectId: null });
    const ids: Record<string, string> = {};
    for (const [title, topic] of [
      ['a-school', 'Kids'],
      ['b-camp', 'kids'],
      ['c-tutor', '孩子'],
      ['d-roof', '家'],
    ]) {
      const opened = await call('neo.ask.propose', { title, request: 'Synthetic request', topic });
      assert.equal(opened.ok, true);
      ids[title] = opened.ask.id;
    }
    await call('neo.ask.settle', { askId: ids['b-camp'], status: 'done', outcome: 'Synthetic' });

    const moved = db
      .prepare("UPDATE job_queue SET run_at = 0 WHERE queue = ? AND status = 'pending'")
      .run(NEO_TOPICS_REORGANIZE_NIGHTLY).changes;
    assert.equal(moved, 1);
    await app.jobProcessor.tick();
    const nightly = db
      .prepare('SELECT status FROM job_queue WHERE queue = ? ORDER BY created_at')
      .all(NEO_TOPICS_REORGANIZE_NIGHTLY) as { status: string }[];
    const turns = db
      .prepare("SELECT queue, payload FROM job_queue WHERE payload LIKE '%Daily topic tidy%'")
      .all() as { queue: string; payload: string }[];
    evidence.push({ name: 'nightly job', nightly, turns });
    assert.deepEqual(
      nightly.map((job) => job.status),
      ['completed', 'pending']
    );
    assert.equal(turns.length, 1);
    assert.equal(turns[0].queue, 'mailbox');
    assert.match(turns[0].payload, /Kids 2/);
    assert.match(turns[0].payload, /neo\.topic\.merge/);
    assert.equal(JSON.parse(turns[0].payload).to.sessionId, neo);

    const stranger = await call(
      'neo.topic.merge',
      { from: 'kids', to: '孩子' },
      'neo:10000000-0000-4000-8000-000000000008'
    );
    assert.equal(stranger.ok, false);
    assert.deepEqual(stored(), ['a-school=Kids', 'b-camp=kids', 'c-tutor=孩子', 'd-roof=家']);

    assert.deepEqual(await call('neo.topic.merge', { from: 'kids', to: '孩子' }), {
      ok: true,
      merged: 2,
    });
    const after = stored();
    evidence.push({ name: 'stored topics after merge', after });
    assert.deepEqual(after, ['a-school=孩子', 'b-camp=孩子', 'c-tutor=孩子', 'd-roof=家']);
    const rejected = await as(neo)({
      name: 'neo.topic.merge', input: { from: '孩子', to: '甲乙丙丁戊己A' },
    });
    assert.equal(rejected.isError, true);
    assert.deepEqual(stored(), after);
    evidence.push({ name: 'rejected merge', result: rejected.content[0].text });

    const legacy = '甲乙丙丁戊己A';
    db.prepare('UPDATE neo_asks SET topic = ? WHERE id = ?').run(legacy, ids['d-roof']);
    let from = legacy;
    for (const to of ['HyperNeo', 'neo-ios', '支付', 'Twelve cells', '甲乙丙丁戊👨‍👩‍👧‍👦', '家庭']) {
      assert.deepEqual(await call('neo.topic.merge', { from, to }), { ok: true, merged: 1 });
      assert(stored().includes(`d-roof=${to}`));
      from = to;
    }
  } finally {
    await app.cleanup();
  }
  console.log(
    `PASS: the real nightly job queued one Neo turn listing "Kids 2" and neo.topic.merge; a non-bound Neo session was refused; neo.topic.merge from kids to 孩子 rewrote 2 asks (one settled), leaving 家. Evidence: ${run}/evidence/topic-merge.json`
  );
} finally {
  globalThis.fetch = network;
  writeFileSync(join(run, 'evidence/topic-merge.json'), JSON.stringify(evidence, null, 2));
}
