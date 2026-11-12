import {
  NEO_REMOVED_PREREQUISITE,
  NEO_REMOVED_PREREQUISITE_OPTIONS,
  planNeoCancelledEdges,
} from '../../lib/neo/todo-removal.ts';
import type { Database } from '../sqlite-compat.ts';

type Row = {
  id: string;
  askId: string;
  root: string;
  position: number;
  title: string;
  state: Parameters<typeof planNeoCancelledEdges>[0][number]['state'];
  startedAt: number | null;
  dependsOn: string | null;
  replacedBy: string | null;
};
type Card = { kind: 'start' | 'choice'; todos: string; cause: string | null };

export function runMigration506(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[];
  if (!columns.length || columns.some((column) => column.name === 'cause')) return;
  db.transaction(() => {
    db.exec(`
      ALTER TABLE neo_questions ADD COLUMN cause TEXT;
      UPDATE neo_todos SET depends_on = COALESCE((
        SELECT json_array(before.id) FROM neo_todos before
        WHERE before.ask_id = neo_todos.ask_id AND before.position < neo_todos.position
        ORDER BY before.position DESC LIMIT 1
      ), '[]') WHERE depends_on IS NULL AND state IN ('todo', 'doing', 'blocked', 'failed');
    `);
    const rows = db
      .prepare(
        `SELECT t.id, t.ask_id AS askId, COALESCE(a.parent_id, a.id) AS root, t.position, t.title,
           t.state, t.started_at AS startedAt, t.depends_on AS dependsOn, t.replaced_by AS replacedBy
         FROM neo_todos t JOIN neo_asks a ON a.id = t.ask_id
         WHERE COALESCE(a.parent_id, a.id) IN (
           SELECT COALESCE(home.parent_id, home.id) FROM neo_asks home WHERE home.status = 'open'
         ) ORDER BY t.ask_id, t.position, t.created_at`
      )
      .all() as Row[];
    const cards = (
      db
        .prepare(
          "SELECT kind, todos, cause FROM neo_questions WHERE state = 'open' AND kind = 'start'"
        )
        .all() as Card[]
    ).map((card) => ({
      ...card,
      state: 'open' as const,
      todos: JSON.parse(card.todos) as string[],
    }));
    const open = new Set(
      (db.prepare("SELECT id FROM neo_asks WHERE status = 'open'").all() as { id: string }[]).map(
        (ask) => ask.id
      )
    );
    const now = Date.now();
    const edge = db.prepare('UPDATE neo_todos SET depends_on = ?, updated_at = ? WHERE id = ?');
    const card = db.prepare(
      `INSERT INTO neo_questions (id, ask_id, text, kind, options, todos, cause, created_at)
       VALUES (?, ?, ?, 'choice', ?, ?, ?, ?)`
    );
    for (const root of new Set(rows.map((row) => row.root))) {
      const family = rows
        .filter((row) => row.root === root)
        .map((row) => ({
          ...row,
          dependsOn: row.dependsOn ? (JSON.parse(row.dependsOn) as string[]) : null,
        }));
      const plan = planNeoCancelledEdges(family, cards);
      for (const { todo, patch } of plan.writes)
        if (open.has(todo.askId)) edge.run(JSON.stringify(patch.dependsOn), now, todo.id);
      for (const held of plan.cards.filter((item) => open.has(item.askId)))
        card.run(
          crypto.randomUUID(),
          held.askId,
          held.text,
          JSON.stringify(NEO_REMOVED_PREREQUISITE_OPTIONS),
          JSON.stringify(held.todos),
          NEO_REMOVED_PREREQUISITE,
          now
        );
    }
  })();
}
