import { defineRepositoryOp } from './db-gateway/db-op.ts';
import type { Database } from './sqlite-compat.ts';
import type { WorkTurn } from './work-turns.ts';

export interface WorkInputIdentity {
  adapter: 'codex-desktop' | 'claude-code';
  marker: string;
}

class WorkInputRepository {
  constructor(private readonly db: Database) {}

  find(sessionId: string, input: WorkInputIdentity): WorkTurn | null {
    const kind = input.adapter === 'codex-desktop' ? 'codex' : 'claude';
    const row = this.db
      .prepare(
        `SELECT COALESCE(message_id, source_id) AS messageId, message_type AS role,
           timestamp AS at, substr(body, 1, 4000) AS text
         FROM message_search_content
         WHERE kind IN ('codex', 'claude') AND kind = ? AND session_id = ?
           AND message_type = 'user'
           AND (body = ? OR substr(body, 1, length(?) + 1) = ? || char(10))
         ORDER BY id LIMIT 1`
      )
      .get(kind, sessionId, input.marker, input.marker, input.marker) as WorkTurn | undefined;
    return row ?? null;
  }
}

export const readWorkInput = defineRepositoryOp('workInput.read', 'read', WorkInputRepository, [
  'find',
] as const);
