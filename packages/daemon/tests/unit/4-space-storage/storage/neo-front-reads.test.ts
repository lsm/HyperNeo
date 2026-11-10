import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from '../../../../src/storage/database.ts';
import { neoFrontReads } from '../../../../src/storage/repositories/neo-front-read-worker.ts';
import { createTestDb } from '../../../helpers/database.ts';

let db: Database;
const conversationId = '10000000-0000-4000-8000-000000000000';
const kinds = ['projects', 'asks', 'cards', 'todos'] as const;
beforeEach(async () => {
  db = await createTestDb();
  const sql = db.getDatabase();
  sql
    .prepare("INSERT INTO neo_session_bindings VALUES (?,NULL,'neo')")
    .run(`neo:${conversationId}`);
  sql.prepare('INSERT INTO neo_conversation VALUES (1,?,0)').run(conversationId);
  for (let n = 0; n < 24; n++) {
    const id = `item-${String(n).padStart(2, '0')}`;
    const text =
      n === 0 ? `Unique archived ${'word '.repeat(50)}Mandarin 中文记录` : `Shared match ${n}`;
    sql
      .prepare(`INSERT INTO neo_concerns
      (id,title,summary,context,revision,created_at,updated_at) VALUES (?,?,'Visible status','Private context',1,0,10)`)
      .run(id, text);
    sql
      .prepare(`INSERT INTO neo_asks
      (id,session_id,title,request,status,outcome,created_at,updated_at)
      VALUES (?,'synthetic',?,'Private instructions',?,'Visible outcome',0,10)`)
      .run(id, text, n === 0 ? 'done' : 'open');
    sql
      .prepare(`INSERT INTO neo_todos
      (id,ask_id,position,title,done_when,state,blocked_reason,instruction,created_at,updated_at)
      VALUES (?,?,0,?,'Done condition',?,'Visible blocker','Private instructions',0,10)`)
      .run(id, id, text, n === 0 ? 'done' : 'todo');
    sql
      .prepare(`INSERT INTO neo_questions
      (id,ask_id,text,kind,state,options,created_at) VALUES (?,?,?,'choice',?,'["One","Two"]',10)`)
      .run(id, id, text, n === 0 ? 'answered' : 'open');
  }
});
afterEach(() => db.close());
const read = (
  kind: (typeof kinds)[number],
  input: Parameters<typeof neoFrontReads.run>[1]['input'] = {}
) => db.gateway.run(neoFrontReads, { conversationId, kind, input });

for (const kind of kinds) {
  test(`${kind} lists every visible active item with bounded stable pages and totals`, async () => {
    const expected = kind === 'projects' ? 24 : 23;
    const ids: string[] = [];
    let input = {};
    do {
      const page = await read(kind, input);
      expect(page).toHaveProperty('total', expected);
      if (!page || !('items' in page)) throw new Error('Expected page');
      expect(page.items.length).toBeLessThanOrEqual(10);
      ids.push(...page.items.map((item) => item.id));
      input = page.nextCursor ? { cursor: page.nextCursor } : {};
      if (!page.nextCursor) break;
    } while (ids.length <= expected);
    expect(ids.length).toBe(expected);
    expect(new Set(ids).size).toBe(expected);
    expect(ids[0]).toBe('item-23');
  });

  test(`${kind} searches beyond page one and includes closed records with unique details`, async () => {
    const found = await read(kind, { text: '中文记录' });
    expect(found).toMatchObject({ id: 'item-00' });
    expect(found).toEqual(await read(kind, { id: 'item-00' }));
    expect(JSON.stringify(found)).not.toContain('Private');
    const candidates = await read(kind, { text: 'Shared match' });
    expect(candidates).toHaveProperty('total', 23);
    if (!candidates || !('items' in candidates)) throw new Error('Expected candidates');
    expect(candidates.items).toHaveLength(10);
    expect(candidates.items[0]).not.toHaveProperty('blocker');
    expect(candidates.items[0]).not.toHaveProperty('text');
    expect(await read(kind, { text: 'not-present' })).toMatchObject({
      items: [],
      total: 0,
      nextCursor: null,
    });
    expect(await read(kind, { id: 'missing' })).toBeNull();
  });
}

test('details expose only visible status and choice fields', async () => {
  expect(await read('projects', { id: 'item-00' })).toMatchObject({
    name: expect.any(String),
    status: 'Visible status',
  });
  expect(await read('asks', { id: 'item-00' })).toMatchObject({
    state: 'done',
    status: 'Visible outcome',
  });
  expect(await read('todos', { id: 'item-00' })).toMatchObject({
    state: 'done',
    blocker: 'Visible blocker',
  });
  expect(await read('cards', { id: 'item-00' })).toMatchObject({
    state: 'answered',
    text: expect.any(String),
    options: ['One', 'Two'],
  });
});

test('each read reflects fresh committed state', async () => {
  expect(await read('todos', { id: 'item-01' })).toHaveProperty('state', 'todo');
  db.getDatabase()
    .prepare("UPDATE neo_todos SET state='done', blocked_reason=NULL WHERE id='item-01'")
    .run();
  expect(await read('todos', { id: 'item-01' })).toMatchObject({ state: 'done', blocker: null });
  expect(await read('todos')).toHaveProperty('total', 22);
});

test('rejects unknown conversations, cross-tool cursors and mixed selectors', async () => {
  await expect(
    db.gateway.run(neoFrontReads, { conversationId: 'other', kind: 'asks', input: {} })
  ).rejects.toThrow();
  const page = await read('asks');
  if (!page || !('items' in page) || !page.nextCursor) throw new Error('Expected cursor');
  await expect(read('cards', { cursor: page.nextCursor })).rejects.toThrow();
  await expect(read('asks', { cursor: 'invalid' })).rejects.toThrow();
  await expect(read('asks', { id: 'item-01', text: 'Shared' })).rejects.toThrow();
});

test('search paging retains its filter and matches the full text before limiting', async () => {
  for (const kind of kinds) {
    const first = await read(kind, { text: 'match Shared' });
    if (!first || !('items' in first) || !first.nextCursor) throw new Error('Expected search page');
    const second = await read(kind, { cursor: first.nextCursor });
    expect(second).toHaveProperty('total', 23);
    if (!second || !('items' in second)) throw new Error('Expected search page');
    expect(second.items).toHaveLength(10);
    expect(
      second.items.some((item) => first.items.some((previous) => previous.id === item.id))
    ).toBe(false);
    expect(await read(kind, { text: '中' })).toMatchObject({ id: 'item-00' });
  }
});

test('merged projects are absent from lists, details and searches', async () => {
  db.getDatabase()
    .prepare(
      "INSERT INTO neo_project_merges (source_id,target_id,merged_at) VALUES ('item-00','item-01',20)"
    )
    .run();
  expect(await read('projects')).toHaveProperty('total', 23);
  expect(await read('projects', { id: 'item-00' })).toBeNull();
  expect(await read('projects', { text: '中文记录' })).toMatchObject({
    total: 0,
    items: [],
    nextCursor: null,
  });
});
