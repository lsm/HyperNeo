import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { SDKMessageRepository } from './sdk-message-repository.ts';
import { SessionRepository } from './session-repository.ts';

class SessionExportReader {
  constructor(private readonly db: Database) {}

  read(sessionId: string) {
    const session = new SessionRepository(this.db).getSession(sessionId);
    if (!session) throw new Error('Session not found');
    const { messages } = new SDKMessageRepository(this.db).getSDKMessages(sessionId, 10000);
    return { session, messages };
  }
}

export const sessionExportReads = defineRepositoryOp(
  'session.export.read',
  'read',
  SessionExportReader,
  ['read'] as const
);
