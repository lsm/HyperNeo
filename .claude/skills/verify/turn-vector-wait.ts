import { appendFileSync } from 'node:fs';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

export function installTurnVectorWait(run: string, waitMs: number, thread: string, target: 'read' | 'write' = 'read'): void {
  const prepare = Database.prototype.prepare;
  let first = true;
  Database.prototype.prepare = function (sql, options) {
    const statement = prepare.call(this, sql, options);
    if (target === 'read' ? !sql.startsWith('SELECT MIN(content_id) AS low, MAX(content_id) AS high') : !sql.trimStart().startsWith('INSERT INTO message_search_vectors')) return statement;
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== (target === 'read' ? 'get' : 'run')) return typeof value === 'function' ? value.bind(target) : value;
        return (...args: unknown[]) => {
          const delay = first ? waitMs : 0;
          first = false;
          if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
          const started = performance.now();
          const result = Reflect.apply(value, target, args);
          appendFileSync(`${run}/evidence/range-reads.jsonl`, JSON.stringify({ thread, modeledWaitMs: delay, sqlMs: performance.now() - started, result }) + '\n');
          return result;
        };
      },
    });
  };
}
