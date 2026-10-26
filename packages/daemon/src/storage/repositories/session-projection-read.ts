import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { SessionRepository } from './session-repository.ts';

class SessionProjectionReader extends SessionRepository {
  snapshot(showArchived?: boolean) {
    const allSessions = this.listSessions({ includeArchived: true });
    const hasArchivedSessions = allSessions.some((session) => session.status === 'archived');
    const sessions = showArchived ? allSessions : this.listSessions();
    return { sessions, hasArchivedSessions };
  }
}

export const sessionProjectionReads = defineRepositoryOp(
  'sessions.projection.read',
  'read',
  SessionProjectionReader,
  ['snapshot'] as const
);
