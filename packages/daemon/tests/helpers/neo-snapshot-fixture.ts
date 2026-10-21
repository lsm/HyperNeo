import type { Database } from '../../src/storage/sqlite-compat.ts';

export function seedNeoSnapshotFixture(db: Database): void {
  const ask = db.prepare(`INSERT INTO neo_asks
    (id,project_id,session_id,title,request,status,created_at,updated_at)
    VALUES (?,NULL,'synthetic',?,'Synthetic human request',?,?,?)`);
  const todo = db.prepare(`INSERT INTO neo_todos
    (id,ask_id,position,title,done_when,instruction,report,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const link = db.prepare(`INSERT INTO neo_todo_sessions(todo_id,target,link)
    VALUES (?,'{}',?)`);
  const question = db.prepare(`INSERT INTO neo_questions
    (id,ask_id,text,kind,state,answer,answered_by,answered_at,created_at)
    VALUES (?,?,'Synthetic question','reply','answered','"Yes"','chat',?,?)`);
  db.transaction(() => {
    for (let i = 0; i < 181; i++)
      ask.run(
        `ask-${i}`,
        `Synthetic ask ${i}`,
        i < 19 ? 'open' : i < 172 ? 'done' : 'dropped',
        i,
        i
      );
    const shown = [
      ...Array.from({ length: 19 }, (_, i) => 18 - i),
      ...Array.from({ length: 31 }, (_, i) => 180 - i),
    ];
    for (let i = 0; i < 231; i++) {
      todo.run(
        `todo-${i}`,
        `ask-${shown[i % 50]}`,
        Math.floor(i / 50),
        `Synthetic todo ${i}`,
        'Synthetic completion',
        'x'.repeat(1155),
        'r'.repeat(711),
        i,
        i
      );
      link.run(`todo-${i}`, `/session/synthetic-${i}`);
    }
    for (let i = 0; i < 66; i++) question.run(`question-${i}`, `ask-${shown[i % 50]}`, i, i);
  })();
}

export function observeNeoSnapshotQueries(db: Database, delayMs = 0, onFirstChild = () => {}) {
  const original = db.prepare;
  const queries: { sql: string; child: boolean; build: boolean }[] = [];
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let notified = false;
  db.prepare = ((...args: Parameters<Database['prepare']>) => {
    const statement = original.apply(db, args);
    const sql = args[0].replace(/\s+/g, ' ').toLowerCase();
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === 'all' || key === 'get')
          return (...bindings: unknown[]) => {
            const child =
              /from (neo_todos|neo_questions|neo_todo_sessions) where (ask_id|todo_id)/.test(sql);
            queries.push({
              sql,
              child,
              build:
                sql.includes('from neo_asks where') && sql.includes("order by status = 'open'"),
            });
            if (child && !notified) {
              notified = true;
              onFirstChild();
            }
            if (child && delayMs) Atomics.wait(sleeper, 0, 0, delayMs);
            return Reflect.apply(value, target, bindings);
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }) as Database['prepare'];
  return {
    queries,
    reset: () => {
      queries.length = 0;
      notified = false;
    },
    restore: () => {
      db.prepare = original;
    },
  };
}
