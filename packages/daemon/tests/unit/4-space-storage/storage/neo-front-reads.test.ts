import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from '../../../../src/storage/database.ts';
import { runMigration497 } from '../../../../src/storage/schema/m497-neo-front-search.ts';
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

type Item = Exclude<Awaited<ReturnType<typeof read>>, { items: unknown } | null>;
async function collect(kind: (typeof kinds)[number], input: Parameters<typeof read>[1] = {}) {
  const items: Item[] = [];
  for (let page = 0; page < 1000; page++) {
    const result = await read(kind, input);
    if (!result) return items;
    if (!('items' in result)) return [...items, result];
    items.push(...result.items);
    if (!result.nextCursor) return items;
    input = { cursor: result.nextCursor };
  }
  throw new Error('Pagination did not finish');
}

for (const kind of kinds) {
  test(`${kind} lists every visible active item with bounded stable pages and explicit estimates`, async () => {
    const first = await read(kind);
    expect(first).toMatchObject({ total: 10, totalExact: false });
    const items = await collect(kind);
    const ids = items.map((item) => item.id);
    expect(ids.length).toBe(kind === 'projects' ? 24 : 23);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('item-23');
  });

  test(`${kind} searches cover every window and include closed records with unique details`, async () => {
    const found = await collect(kind, { text: '中文记录' });
    expect(found).toHaveLength(1);
    const detail = await read(kind, { id: 'item-00' });
    if (!detail || 'items' in detail) throw new Error('Expected detail');
    expect(found[0]).toHaveProperty('id', detail.id);
    expect(found[0]).not.toHaveProperty('status');
    expect(JSON.stringify(found)).not.toContain('Private');
    const candidates = await read(kind, { text: 'Shared match' });
    expect(candidates).toMatchObject({ total: 10, totalExact: false });
    if (!candidates || !('items' in candidates)) throw new Error('Expected candidates');
    expect(candidates.items).toHaveLength(10);
    expect(candidates.items[0]).not.toHaveProperty('blocker');
    expect(candidates.items[0]).not.toHaveProperty('text');
    expect(await collect(kind, { text: 'Shared match' })).toHaveLength(23);
    expect(await collect(kind, { text: 'not-present' })).toEqual([]);
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
  expect(await collect('todos')).toHaveLength(22);
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
    expect(second).toMatchObject({ total: 20, totalExact: false });
    if (!second || !('items' in second)) throw new Error('Expected search page');
    expect(second.items).toHaveLength(10);
    expect(
      second.items.some((item) => first.items.some((previous) => previous.id === item.id))
    ).toBe(false);
    expect(await collect(kind, { text: '中' })).toMatchObject([{ id: 'item-00' }]);
  }
});

test('merged projects are absent from lists, details and searches', async () => {
  db.getDatabase()
    .prepare(
      "INSERT INTO neo_project_merges (source_id,target_id,merged_at) VALUES ('item-00','item-01',20)"
    )
    .run();
  expect(await collect('projects')).toHaveLength(23);
  expect(await read('projects', { id: 'item-00' })).toBeNull();
  expect(await collect('projects', { text: '中文记录' })).toEqual([]);
});

test('reader-visible edits between search pages stay fresh without skips or repeats', async () => {
  for (const kind of kinds) {
    const first = await read(kind, { text: 'Shared match' });
    if (!first || !('items' in first) || !first.nextCursor) throw new Error('Expected page');
    const table = {
      projects: 'neo_concerns',
      asks: 'neo_asks',
      cards: 'neo_questions',
      todos: 'neo_todos',
    }[kind];
    const timestamp = kind === 'cards' ? 'answered_at' : 'updated_at';
    db.getDatabase().prepare(`UPDATE ${table} SET ${timestamp}=100 WHERE id='item-13'`).run();
    db.getDatabase().prepare(`UPDATE ${table} SET ${timestamp}=-1 WHERE id='item-22'`).run();
    const edit = {
      projects: "title='Shared match edited'",
      asks: "status='done'",
      cards: "state='answered'",
      todos: "state='doing'",
    }[kind];
    db.getDatabase().prepare(`UPDATE ${table} SET ${edit} WHERE id IN ('item-13','item-22')`).run();
    const items = [...first.items];
    const ids = first.items.map((item) => item.id);
    let cursor: string | null = first.nextCursor;
    while (cursor && ids.length < 50) {
      const page = await read(kind, { cursor });
      if (!page || !('items' in page)) throw new Error('Expected page');
      items.push(...page.items);
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    }
    expect(ids.filter((id) => id === 'item-13')).toHaveLength(1);
    expect(ids.filter((id) => id === 'item-22')).toHaveLength(1);
    expect(ids.length).toBe(23);
    expect(new Set(ids).size).toBe(ids.length);
    const field = kind === 'projects' ? 'name' : 'state';
    const value = {
      projects: 'Shared match edited',
      asks: 'done',
      cards: 'answered',
      todos: 'doing',
    }[kind];
    expect(items.find((item) => item.id === 'item-13')?.[field]).toBe(value);
    expect(await read(kind, { id: 'item-22' })).toHaveProperty(field, value);
  }
});

test('large-table windows and FTS probes are bounded without counts or sorting scans', async () => {
  const sql = db.getDatabase();
  sql.transaction(() => {
    const insert = sql.prepare(`INSERT INTO neo_concerns
      (id,title,summary,context,revision,created_at,updated_at) VALUES (?,?,'','',1,0,10)`);
    for (let n = 0; n < 5000; n++) insert.run(`large-${n}`, `Large searchable project ${n}`);
  })();
  const prepare = sql.prepare.bind(sql);
  const observed: { query: string; plan: string; rows: number }[] = [];
  sql.prepare = ((query: string) =>
    new Proxy(prepare(query), {
      get(target, property) {
        if (property === 'get' || property === 'all')
          return (...bindings: never[]) => {
            if (/count\s*\(/i.test(query)) throw new Error('Unbounded count');
            const plan = prepare(`EXPLAIN QUERY PLAN ${query}`).all(...bindings) as {
              detail: string;
            }[];
            const result = Reflect.apply(target[property], target, bindings);
            observed.push({
              query,
              plan: plan.map((row) => row.detail).join('\n'),
              rows: Array.isArray(result) ? result.length : Number(!!result),
            });
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })) as typeof sql.prepare;
  try {
    for (const kind of kinds)
      for (const text of ['searchable', '文', '!!!', '']) {
        observed.length = 0;
        const page = await read(kind, { text });
        expect(observed.every((row) => row.rows <= 11)).toBe(true);
        expect(observed.some((row) => row.plan.includes('USE TEMP B-TREE'))).toBe(false);
        if (text === '!!!' || text === '')
          expect(page).toMatchObject({ items: [], total: 0, totalExact: true, nextCursor: null });
        else {
          expect(page).toHaveProperty('totalExact', false);
          const candidate = observed.find((row) => row.query.includes('LIMIT 11'));
          expect(candidate?.plan).toContain('USING INDEX idx_front_');
          if (text === 'searchable')
            expect(observed.some((row) => /VIRTUAL TABLE INDEX.*M/.test(row.plan))).toBe(true);
        }
        console.log(JSON.stringify({ kind, text, observed }));
      }
    const first = await read('projects');
    if (!first || !('items' in first) || !first.nextCursor) throw new Error('Expected page');
    expect(first).toMatchObject({ total: 10, totalExact: false });
    observed.length = 0;
    await read('projects', { cursor: first.nextCursor });
    const candidate = observed.find((row) => row.query.includes('LIMIT 11'));
    expect(candidate?.plan).toMatch(/SEARCH neo_concerns USING INDEX.*created_at.*</);
    expect(candidate?.rows).toBe(11);
    console.log(JSON.stringify({ continuation: observed }));
  } finally {
    sql.prepare = prepare;
  }
});

test('front FTS backfills existing records and follows title edits and deletes', async () => {
  const sql = db.getDatabase();
  for (const fts of ['neo_front_project_fts']) {
    for (const suffix of ['ai', 'ad', 'au']) sql.exec(`DROP TRIGGER ${fts}_${suffix}`);
    sql.exec(`DROP TABLE ${fts}`);
  }
  runMigration497(sql);
  runMigration497(sql);
  for (const kind of kinds)
    expect(await collect(kind, { text: '中' })).toMatchObject([{ id: 'item-00' }]);
  sql.prepare("UPDATE neo_concerns SET title='Renamed project' WHERE id='item-00'").run();
  expect(await read('projects', { text: 'Unique archived' })).toHaveProperty('total', 0);
  expect(await collect('projects', { text: 'Renamed' })).toMatchObject([{ id: 'item-00' }]);
  sql.prepare("UPDATE neo_asks SET title='Renamed ask' WHERE id='item-00'").run();
  expect(await collect('asks', { text: 'Renamed' })).toMatchObject([{ id: 'item-00' }]);
  sql.prepare("DELETE FROM neo_concerns WHERE id='item-00'").run();
  expect(await read('projects', { text: 'Renamed' })).toHaveProperty('total', 0);
  sql.prepare("DELETE FROM neo_asks WHERE id='item-00'").run();
  expect(await read('asks', { text: 'Renamed' })).toHaveProperty('total', 0);
});

test('pages newest creation time first across a boundary regardless of UUID order', async () => {
  for (const kind of kinds) {
    const table = {
      projects: 'neo_concerns',
      asks: 'neo_asks',
      cards: 'neo_questions',
      todos: 'neo_todos',
    }[kind];
    for (let n = 0; n < 24; n++)
      db.getDatabase()
        .prepare(`UPDATE ${table} SET created_at=? WHERE id=?`)
        .run(24 - n, `item-${String(n).padStart(2, '0')}`);
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await read(kind, cursor ? { cursor } : {});
      if (!page || !('items' in page)) throw new Error('Expected page');
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor && ids.length < 50);
    const expected = Array.from(
      { length: kind === 'projects' ? 24 : 23 },
      (_, n) => `item-${String(n + (kind === 'projects' ? 0 : 1)).padStart(2, '0')}`
    );
    expect(ids).toEqual(expected);
  }
});

test('reports approximate totals without issuing an aggregate count', async () => {
  const sql = db.getDatabase();
  const prepare = sql.prepare.bind(sql);
  sql.prepare = ((query: string) => {
    if (/count\s*\(/i.test(query)) throw new Error('Unbounded count');
    return prepare(query);
  }) as typeof sql.prepare;
  try {
    for (const kind of kinds) {
      const page = await read(kind);
      expect(page).toHaveProperty('totalExact', false);
      expect(page).toHaveProperty('total', 10);
    }
  } finally {
    sql.prepare = prepare;
  }
});

test('short terms retain middle-of-word substrings and tokenless queries are empty', async () => {
  for (const kind of kinds) {
    const first = await read(kind, { text: '文' });
    const ids: string[] = [];
    let next = first;
    let pages = 0;
    while (next && pages++ < 10) {
      if ('items' in next) {
        ids.push(...next.items.map((item) => item.id));
        if (!next.nextCursor) break;
        next = await read(kind, { cursor: next.nextCursor });
      } else {
        ids.push(next.id);
        break;
      }
    }
    expect(ids).toEqual(['item-00']);
    expect(await collect(kind, { text: 'ha' })).toHaveLength(23);
    expect(await collect(kind, { text: 'ared' })).toHaveLength(23);
    for (const text of ['!!!', '  '])
      expect(await read(kind, { text })).toMatchObject({
        items: [],
        total: 0,
        totalExact: true,
        nextCursor: null,
      });
  }
});

test('the durable conversation scopes reads even while its coordinator binding is absent', async () => {
  db.getDatabase().prepare("DELETE FROM neo_session_bindings WHERE kind='neo'").run();
  expect(await read('projects')).toMatchObject({ total: 10, totalExact: false });
  await expect(
    db.gateway.run(neoFrontReads, {
      conversationId: '20000000-0000-4000-8000-000000000000',
      kind: 'projects',
      input: {},
    })
  ).rejects.toThrow('Front conversation unavailable');
});

test('unique searches keep the page shape in early, middle and final windows', async () => {
  for (const id of ['item-23', 'item-13', 'item-00']) {
    const sql = db.getDatabase();
    sql.prepare('UPDATE neo_concerns SET title=? WHERE id=?').run(`Only ${id}`, id);
    let input: Parameters<typeof read>[1] = { text: `Only ${id}` };
    const ids: string[] = [];
    for (let window = 0; window < 10; window++) {
      const page = await read('projects', input);
      expect(page).toHaveProperty('items');
      if (!page || !('items' in page)) throw new Error('Expected page');
      ids.push(...page.items.map((item) => item.id));
      if (!page.nextCursor) break;
      input = { cursor: page.nextCursor };
    }
    expect(ids).toEqual([id]);
    expect(await read('projects', { id })).toMatchObject({ id, status: 'Visible status' });
  }
});

test('forward-only discovery restarts to include a project renamed behind the cursor', async () => {
  const sql = db.getDatabase();
  sql.prepare("UPDATE neo_concerns SET title='Needle older' WHERE id='item-01'").run();
  const first = await read('projects', { text: 'Needle' });
  if (!first || !('items' in first) || !first.nextCursor) throw new Error('Expected window');
  expect(first.items).toEqual([]);
  sql.prepare("UPDATE neo_concerns SET title='Needle newcomer' WHERE id='item-23'").run();
  const continued = await collect('projects', { cursor: first.nextCursor });
  expect(continued.map((item) => item.id)).toEqual(['item-01']);
  expect((await collect('projects', { text: 'Needle' })).map((item) => item.id)).toEqual([
    'item-23',
    'item-01',
  ]);
  expect(await read('projects', { id: 'item-23' })).toHaveProperty('name', 'Needle newcomer');
  expect(first).toHaveProperty('forwardOnly', true);
});

test('forward-only open lists restart to include an ask reopened behind the cursor', async () => {
  const sql = db.getDatabase();
  sql.prepare("UPDATE neo_asks SET status='done' WHERE id='item-23'").run();
  const first = await read('asks');
  if (!first || !('items' in first) || !first.nextCursor) throw new Error('Expected window');
  expect(first.items.some((item) => item.id === 'item-23')).toBe(false);
  sql.prepare("UPDATE neo_asks SET status='open' WHERE id='item-23'").run();
  expect(
    (await collect('asks', { cursor: first.nextCursor })).some((item) => item.id === 'item-23')
  ).toBe(false);
  expect((await collect('asks')).some((item) => item.id === 'item-23')).toBe(true);
  expect(await read('asks', { id: 'item-23' })).toHaveProperty('state', 'open');
  expect(first).toMatchObject({ forwardOnly: true, totalExact: false });
});
