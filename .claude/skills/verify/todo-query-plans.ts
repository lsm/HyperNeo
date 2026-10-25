import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';

export const todoQueries = {
  list: `SELECT id, ask_id, position, title, done_when FROM neo_todos
    WHERE ask_id = ? ORDER BY position, created_at`,
  recovery: `SELECT s.todo_id FROM neo_todo_sessions s JOIN neo_todos t ON t.id = s.todo_id
    WHERE s.ref IS NULL AND t.state = 'doing'`,
  window: `SELECT t.started_at AS start,
    (SELECT MIN(next.started_at) FROM neo_todo_sessions other
      JOIN neo_todos next ON next.id = other.todo_id
      WHERE other.ref = own.ref AND other.todo_id != t.id
        AND next.started_at > t.started_at) AS end
    FROM neo_todos t LEFT JOIN neo_todo_sessions own ON own.todo_id = t.id WHERE t.id = ?`,
  live: `UPDATE neo_todo_sessions SET live_status = ?1, link = COALESCE(?2, link), remote_link = ?4
    WHERE todo_id = ?3 AND (live_status IS NOT ?1 OR (?2 IS NOT NULL AND link IS NOT ?2)
      OR remote_link IS NOT ?4)`,
};

export function syntheticTodoDb() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const ask = db.prepare(`INSERT INTO neo_asks
    (id, session_id, title, request, created_at, updated_at) VALUES (?, 'neo', 'Synthetic ask', '', 1, 1)`);
  const todo = db.prepare(`INSERT INTO neo_todos
    (id, ask_id, position, title, done_when, state, started_at, created_at, updated_at)
    VALUES (?, ?, ?, 'Synthetic todo', 'Synthetic completion', ?, ?, 1, 1)`);
  const session = db.prepare(`INSERT INTO neo_todo_sessions
    (todo_id, target, ref, started_at) VALUES (?, '{}', ?, ?)`);
  db.transaction(() => {
    for (let i = 0; i < 376; i++) ask.run(`a${i}`);
    for (let i = 0; i < 1213; i++) {
      const at = i % 17 === 0 ? null : Math.floor(i / 2);
      todo.run(`t${i}`, `a${i % 376}`, Math.floor(i / 376), i % 20 === 0 ? 'doing' : 'done', at);
      if (i < 989) session.run(`t${i}`, i % 11 === 0 ? null : JSON.stringify({ adapter: 'codex', id: `s${i % 16}` }), at);
    }
  })();
  return db;
}

export function todoPlan(db: Database, sql: string, args: (string | number | null)[]) {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[])
    .map((row) => row.detail);
}

if (import.meta.main) {
  const db = syntheticTodoDb();
  const bindings = { list: ['a0'], recovery: [], window: ['t48'], live: ['running', null, 't48', null] };
  const report = Object.entries(todoQueries).map(([name, sql]) => {
    const args = bindings[name as keyof typeof bindings];
    const statement = db.prepare(sql);
    const samples = Array.from({ length: 100 }, () => {
      const start = performance.now();
      if (name === 'live') statement.run(...args);
      else statement.all(...args);
      return performance.now() - start;
    });
    return { name, plan: todoPlan(db, sql, args), meanMs: samples.reduce((a, b) => a + b) / samples.length, maxMs: Math.max(...samples) };
  });
  const repo = new CodingTodoPrRepository(db);
  console.log(JSON.stringify({ counts: { asks: 376, todos: 1213, sessions: 989 }, report, windows: ['t0', 't48', 't49', 't1000', 'missing'].map((id) => ({ id, ...repo.window(id) })) }, null, 2));
  db.close();
}
