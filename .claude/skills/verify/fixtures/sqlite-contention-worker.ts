import { DB_OPS } from '../../../../packages/daemon/src/storage/db-gateway/db-ops.ts';
import { defineDbOp, type DbOp } from '../../../../packages/daemon/src/storage/db-gateway/db-op.ts';

if (process.env.NODE_ENV !== 'test') throw new Error('Synthetic worker requires NODE_ENV=test');
const holder = defineDbOp({
  name: 'test.holdWriter',
  mode: 'write',
  run(db, args: { signal: SharedArrayBuffer; delayMs: number }) {
    db.run('INSERT INTO contention VALUES (?)', 'synthetic holder');
    Atomics.store(new Int32Array(args.signal), 0, 1);
    Bun.sleepSync(args.delayMs);
    return 'holder committed';
  },
});
(DB_OPS as Map<string, DbOp<never, unknown>>).set(holder.name, holder);
await import('../../../../packages/daemon/src/storage/db-gateway/db-gateway-worker.ts');
