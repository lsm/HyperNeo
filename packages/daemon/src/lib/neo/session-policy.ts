import type { Database } from '../../storage/database.ts';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';

export function neoCoordinatorBinding(
  db: Pick<Database, 'getDatabase'> | undefined,
  sessionId: string
): NeoBinding | null {
  if (!sessionId.startsWith('neo:') || !db) return null;
  const row = db
    .getDatabase()
    .prepare(
      "SELECT session_id AS sessionId, concern_id AS projectId, kind FROM neo_session_bindings WHERE session_id = ? AND kind = 'neo'"
    )
    .get(sessionId) as NeoBinding | null;
  return row ?? null;
}
