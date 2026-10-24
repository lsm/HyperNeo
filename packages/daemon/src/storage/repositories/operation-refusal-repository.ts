import type { OperationRefusal } from '../../lib/operations/mcp-adapter.ts';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';

export const recordOperationRefusal = defineDbOp({
  name: 'operationRefusal.record',
  mode: 'write',
  run: (
    db: Database,
    { refusal, sessionId, at }: { refusal: OperationRefusal; sessionId: string; at: number }
  ): void => {
    db.prepare(
      'INSERT INTO operation_refusals (operation, reason, session_id, at) VALUES (?, ?, ?, ?)'
    ).run(refusal.operation, refusal.reason, sessionId, at);
  },
});
