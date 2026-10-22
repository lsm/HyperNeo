import { appendFileSync, writeFileSync } from 'node:fs';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

export function installWorkSearchWait(run: string, waitMs: number, thread: string, repeat = false): void {
  const prepare = Database.prototype.prepare;
  let first = true;
  Database.prototype.prepare = function (sql, options) {
    const statement = prepare.call(this, sql, options);
    if (!sql.startsWith('SELECT v.content_id AS id, v.embedding')) return statement;
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== 'all') return typeof value === 'function' ? value.bind(target) : value;
        return (...args: unknown[]) => {
          const delay = (first || repeat) && args[0] === 'message' ? waitMs : 0;
          first = false;
          if (delay) {
            writeFileSync(`${run}/read-started`, thread);
            Bun.sleepSync(delay);
          }
          const started = performance.now();
          const rows = Reflect.apply(value, target, args);
          appendFileSync(`${run}/evidence/vector-reads.jsonl`, JSON.stringify({ thread, modeledWaitMs: delay, sqlMs: performance.now() - started, rows: rows.length }) + '\n');
          return rows;
        };
      },
    });
  };
}
