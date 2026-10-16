import type { OperationRefusal } from '../../lib/operations/mcp-adapter.ts';
import type { Database } from '../sqlite-compat.ts';

export class OperationRefusalRepository {
  constructor(private readonly db: Database) {}

  record(refusal: OperationRefusal, sessionId: string, at = Date.now()): void {
    this.db
      .prepare(
        'INSERT INTO operation_refusals (operation, reason, session_id, at) VALUES (?, ?, ?, ?)'
      )
      .run(refusal.operation, refusal.reason, sessionId, at);
  }
}
