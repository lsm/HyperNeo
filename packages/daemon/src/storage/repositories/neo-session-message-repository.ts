import type { NeoSessionMessage } from '@hyperneo/shared/types/neo-session-message';
import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { type ChangeRecorder, defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';

const SELECT = `SELECT message_id AS messageId, conversation_id AS conversationId, sequence,
  from_session AS fromSession, from_name AS fromName, to_session AS toSession, to_name AS toName,
  text, created_at AS createdAt FROM neo_session_messages`;

export const SENT_BY_NEO = "from_session GLOB 'neo:*'";
export const WORKER_BATCH_SENDER = 'system:worker-batch';
export const VISIBLE_IN_NEO = `(${SENT_BY_NEO} OR from_session = '${WORKER_BATCH_SENDER}')`;

export type NeoSessionMessageDraft = Omit<NeoSessionMessage, 'sequence'>;

export const persistNeoSessionMessage = (
  db: Database,
  message: NeoSessionMessageDraft,
  changes: ChangeRecorder
): void => {
  db.prepare(
    `INSERT OR IGNORE INTO neo_session_messages (conversation_id, message_id, from_session,
         from_name, to_session, to_name, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    message.conversationId,
    message.messageId,
    message.fromSession,
    message.fromName,
    message.toSession,
    message.toName,
    message.text,
    message.createdAt
  );
  changes.notifyChange('neo_session_messages');
};

export const recordNeoSessionMessage = defineDbOp({
  name: 'neo.sessionMessage.record',
  mode: 'write',
  run: persistNeoSessionMessage,
});

export class NeoSessionMessageRepository {
  constructor(private readonly db: Database) {}

  record(message: NeoSessionMessageDraft): Promise<void> {
    return gatewayFor(this.db).run(recordNeoSessionMessage, message);
  }

  get(conversationId: string, messageId: string): NeoSessionMessage | null {
    return (
      (this.db
        .prepare(`${SELECT} WHERE conversation_id = ? AND message_id = ?`)
        .get(conversationId, messageId) as NeoSessionMessage | null) ?? null
    );
  }

  latest(conversationId: string, limit: number): NeoSessionMessage[] {
    return (
      this.db
        .prepare(
          `${SELECT} WHERE conversation_id = ? AND ${VISIBLE_IN_NEO}
           ORDER BY created_at DESC, sequence DESC LIMIT ?`
        )
        .all(conversationId, limit) as NeoSessionMessage[]
    ).reverse();
  }
}
