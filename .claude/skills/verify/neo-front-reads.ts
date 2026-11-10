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
        `INSERT INTO neo_concerns(id,title,summary,context,revision,created_at,updated_at) VALUES (?,?,'Visible summary','Hidden context',1,?,10)`
      )
      .run(id, text, (i * 7) % 31);
    sql
      .prepare(
        `INSERT INTO neo_asks(id,session_id,title,request,status,outcome,created_at,updated_at) VALUES (?,'synthetic',?,'Hidden request',?,'Visible outcome',?,10)`
      )
      .run(id, text, i === 0 ? 'done' : 'open', (i * 7) % 31);
    sql
      .prepare(
        `INSERT INTO neo_todos(id,ask_id,position,title,done_when,state,blocked_reason,created_at,updated_at) VALUES (?,?,0,?,'Synthetic completion',?,'Visible blocker',?,10)`
      )
      .run(id, id, text, i === 0 ? 'done' : 'todo', (i * 7) % 31);
    sql
      .prepare(
        `INSERT INTO neo_questions(id,ask_id,text,kind,state,options,created_at) VALUES (?,?,?,'choice',?,'["One","Two"]',?)`
      )
      .run(id, id, text, i === 0 ? 'answered' : 'open', (i * 7) % 31);
  }
  const read = (
    kind: 'projects' | 'asks' | 'cards' | 'todos',
    input: Parameters<typeof neoFrontReads.run>[1]['input'] = {}
  ) => app.db.gateway.run(neoFrontReads, { conversationId, kind, input });
  type Kind = Parameters<typeof read>[0];
  type Item = Exclude<Awaited<ReturnType<typeof read>>, { items: unknown } | null>;
  async function collect(kind: Kind, input: Parameters<typeof read>[1] = {}) {
    const items: Item[] = [];
    for (let window = 0; window < 10; window++) {
      const result = await read(kind, input);
      assert(result);
      assert('items' in result);
      items.push(...result.items);
      if (!result.nextCursor) return items;
      input = { cursor: result.nextCursor };
    }
    throw new Error('Incomplete traversal');
  }
  for (const kind of ['projects', 'asks', 'cards', 'todos'] as const) {
    const expectedIds = Array.from({ length: 31 }, (_, i) => i)
      .filter((i) => kind === 'projects' || i !== 0)
      .sort((a, b) => ((b * 7) % 31) - ((a * 7) % 31))
      .map((i) => `record-${String(i).padStart(2, '0')}`);
    const ids: string[] = [];
    let input: Parameters<typeof read>[1] = {};
    let windows = 0;
    do {
      const page = await read(kind, input);
      assert(page && 'items' in page);
      assert(page.items.length <= 10);
      ids.push(...page.items.map((item) => item.id));
      assert.equal(page.total, ids.length);
      assert.equal(page.totalExact, false);
      windows++;
      if (windows === 1) {
        const table = {
          projects: 'neo_concerns',
          asks: 'neo_asks',
          cards: 'neo_questions',
          todos: 'neo_todos',
        }[kind];
        const timestamp = kind === 'cards' ? 'answered_at' : 'updated_at';
        sql.prepare(`UPDATE ${table} SET ${timestamp}=100 WHERE id=?`).run(expectedIds[10]);
        sql.prepare(`UPDATE ${table} SET ${timestamp}=-1 WHERE id=?`).run(page.items[0].id);
      }
      input = page.nextCursor ? { cursor: page.nextCursor } : {};
      if (!page.nextCursor) break;
    } while (windows < 10);
    assert.deepEqual(ids, expectedIds);
    const closed = await collect(kind, { text: '文' });
    assert.equal(closed.length, 1);
    assert.equal(closed[0].id, 'record-00');
    const detail = await read(kind, { id: 'record-00' });
    assert(detail && 'id' in detail);
    assert.equal(detail.id, closed[0].id);
    const field = { projects: 'status', asks: 'status', cards: 'text', todos: 'blocker' } as const;
    assert(detail[field[kind]]);
    assert(!JSON.stringify(detail).includes('Hidden'));
    const ambiguous = await read(kind, { text: 'Shared record' });
    assert(ambiguous && 'items' in ambiguous);
    assert.equal(ambiguous.total, 10);
    assert.equal(ambiguous.totalExact, false);
    const allMatches = await collect(kind, { text: 'Shared record' });
    assert.equal(allMatches.length, 30);
    for (const text of ['!!!', '']) {
      assert.deepEqual(await read(kind, { text }), {
        items: [],
        total: 0,
        totalExact: true,
        nextCursor: null,
      });
    }
    assert.equal(await read(kind, { id: 'missing' }), null);
    assert(!JSON.stringify(closed).includes('Hidden'));
    observations.push({
      kind,
      windows,
      records: ids.length,
      newestFirst: true,
      midPageEdit: true,
      shortSubstring: true,
      firstEstimatedTotal: ambiguous.total,
      searchMatches: allMatches.length,
    });
  }
  sql.prepare("UPDATE neo_todos SET state='done',blocked_reason=NULL WHERE id='record-01'").run();
  const fresh = await read('todos', { id: 'record-01' });
  assert(fresh && 'state' in fresh);
  assert.equal(fresh.state, 'done');
  assert.equal(fresh.blocker, null);
  assert.equal((await collect('todos')).length, 29);
  sql.prepare("DELETE FROM neo_session_bindings WHERE kind='neo'").run();
  const unbound = await read('projects');
  assert(unbound && 'items' in unbound);
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
    estimatesExplicit: true,
    uniformSearchPages: true,
    canonicalConversationOnly: true,
    tokenlessEmpty: true,
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
