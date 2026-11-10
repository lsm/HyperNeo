import { strict as assert } from 'node:assert';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { neoFrontReads } from '../../../packages/daemon/src/storage/repositories/neo-front-read-worker.ts';
const app = await createDaemonApp({
  config: {
    ...getConfig({
      host: '127.0.0.1',
      port: 0,
      dbPath: join(run, 'data/daemon.db'),
      workspaceRoot: run,
    }),
    disableWorktrees: true,
  },
  verbose: false,
});
const observations = [];
try {
  assert(![8399, 8499].includes(app.server.port));
  await app.jobProcessor.stop();
  const sql = app.db.getDatabase();
  const conversationId = '10000000-0000-4000-8000-000000000000';
  sql
    .prepare("INSERT INTO neo_session_bindings VALUES (?,NULL,'neo')")
    .run(`neo:${conversationId}`);
  sql.prepare('INSERT INTO neo_conversation VALUES (1,?,0)').run(conversationId);
  for (let i = 0; i < 31; i++) {
    const id = `record-${String(i).padStart(2, '0')}`;
    const text = i === 0 ? 'Archived 中文事项' : `Shared record ${i}`;
    sql
      .prepare(
        `INSERT INTO neo_concerns(id,title,summary,context,revision,created_at,updated_at) VALUES (?,?,'Visible summary','Hidden context',1,0,10)`
      )
      .run(id, text);
    sql
      .prepare(
        `INSERT INTO neo_asks(id,session_id,title,request,status,outcome,created_at,updated_at) VALUES (?,'synthetic',?,'Hidden request',?,'Visible outcome',0,10)`
      )
      .run(id, text, i === 0 ? 'done' : 'open');
    sql
      .prepare(
        `INSERT INTO neo_todos(id,ask_id,position,title,done_when,state,blocked_reason,created_at,updated_at) VALUES (?,?,0,?,'Synthetic completion',?,'Visible blocker',0,10)`
      )
      .run(id, id, text, i === 0 ? 'done' : 'todo');
    sql
      .prepare(
        `INSERT INTO neo_questions(id,ask_id,text,kind,state,options,created_at) VALUES (?,?,?,'choice',?,'["One","Two"]',10)`
      )
      .run(id, id, text, i === 0 ? 'answered' : 'open');
  }
  const read = (
    kind: 'projects' | 'asks' | 'cards' | 'todos',
    input: Parameters<typeof neoFrontReads.run>[1]['input'] = {}
  ) => app.db.gateway.run(neoFrontReads, { conversationId, kind, input });
  for (const kind of ['projects', 'asks', 'cards', 'todos'] as const) {
    const expected = kind === 'projects' ? 31 : 30;
    const ids = [];
    let input = {};
    let pages = 0;
    do {
      const page = await read(kind, input);
      assert(page && 'items' in page);
      assert.equal(page.total, expected);
      assert(page.items.length <= 10);
      ids.push(...page.items.map((item) => item.id));
      pages++;
      input = page.nextCursor ? { cursor: page.nextCursor } : {};
      if (!page.nextCursor) break;
    } while (pages < 10);
    assert.equal(ids.length, expected);
    assert.equal(new Set(ids).size, expected);
    const closed = await read(kind, { text: '中文事项' });
    assert(closed && 'id' in closed);
    assert.equal(closed.id, 'record-00');
    assert.deepEqual(closed, await read(kind, { id: 'record-00' }));
    const ambiguous = await read(kind, { text: 'Shared record' });
    assert(ambiguous && 'items' in ambiguous);
    assert.equal(ambiguous.total, 30);
    assert.equal(ambiguous.items.length, 10);
    assert(ambiguous.nextCursor);
    const next = await read(kind, { cursor: ambiguous.nextCursor });
    assert(next && 'items' in next);
    assert.equal(next.total, 30);
    assert.equal(await read(kind, { id: 'missing' }), null);
    assert(!JSON.stringify(closed).includes('Hidden'));
    observations.push({
      kind,
      pages,
      total: expected,
      searchedClosed: true,
      searchTotal: ambiguous.total,
    });
  }
  sql.prepare("UPDATE neo_todos SET state='done',blocked_reason=NULL WHERE id='record-01'").run();
  const fresh = await read('todos', { id: 'record-01' });
  assert(fresh && 'state' in fresh);
  assert.equal(fresh.state, 'done');
  assert.equal(fresh.blocker, null);
  const latest = await read('todos');
  assert(latest && 'items' in latest);
  assert.equal(latest.total, 29);
  await assert.rejects(() =>
    app.db.gateway.run(neoFrontReads, {
      conversationId: '20000000-0000-4000-8000-000000000000',
      kind: 'asks',
      input: {},
    })
  );
  assert.notEqual(app.db.getGlobalSettings().neo?.front?.enabled, true);
  const evidence = {
    head: process.argv[2],
    port: app.server.port,
    observations,
    freshRead: true,
    invalidScopeRefused: true,
    switchOff: true,
  };
  mkdirSync(join(run, 'evidence'), { recursive: true });
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await app.cleanup();
}
console.log('isolated_scoped_reads_exit=0');
