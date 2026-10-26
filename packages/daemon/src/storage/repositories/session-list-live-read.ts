import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import type { TableChangeScope } from '../reactive-database.ts';
import {
  SESSION_COUNTERS_SQL,
  SESSION_LIST_EXCLUDED_TYPES,
  SESSIONS_LIST_SQL,
  mapSessionRow,
} from '../../lib/live-query/queries/sessions.ts';

export function mayChangeSessionList(scope: TableChangeScope): boolean {
  if (scope.sessionType && SESSION_LIST_EXCLUDED_TYPES.has(scope.sessionType)) return false;
  return !scope.roomId && !scope.spaceId;
}

export function readSessionListMetadata(db: Database) {
  const row = db.prepare(SESSION_COUNTERS_SQL).get() as
    | { total_count: number; archived_count: number }
    | undefined;
  return { totalCount: row?.total_count ?? 0, archivedCount: row?.archived_count ?? 0 };
}

class SessionListLiveReader {
  constructor(private db: Database) {}

  read(includeArchived: number) {
    return {
      rows: (
        this.db.prepare(SESSIONS_LIST_SQL).all(includeArchived) as Record<string, unknown>[]
      ).map(mapSessionRow),
      metadata: readSessionListMetadata(this.db),
    };
  }
}

export const readLiveSessionList = defineRepositoryOp(
  'sessions.list.live.read',
  'read',
  SessionListLiveReader,
  ['read'] as const
);
