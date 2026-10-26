import type { NeoSessionMessage } from '@hyperneo/shared/types/neo-session-message';
import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { defineDbOp, defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';

const SELECT = `SELECT message_id AS messageId, conversation_id AS conversationId, sequence,
  from_session AS fromSession, from_name AS fromName, to_session AS toSession, to_name AS toName,
  text, created_at AS createdAt, kind FROM neo_session_messages`;

export const SENT_BY_NEO = "from_session GLOB 'neo:*'";
export const WORKER_BATCH_SENDER = 'system:worker-batch';
export const VISIBLE_IN_NEO = `(${SENT_BY_NEO} OR from_session = '${WORKER_BATCH_SENDER}')`;

export type NeoSessionMessageDraft = Omit<NeoSessionMessage, 'sequence'>;

export const recordNeoSessionMessage = defineDbOp({
  name: 'neo.sessionMessage.record',
  mode: 'write',
  run: (db: Database, message: NeoSessionMessageDraft, changes): void => {
    db.prepare(
      `INSERT OR IGNORE INTO neo_session_messages (conversation_id, message_id, from_session,
         from_name, to_session, to_name, text, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      message.conversationId,
      message.messageId,
      message.fromSession,
      message.fromName,
      message.toSession,
      message.toName,
      message.text,
      message.createdAt,
      message.kind
    );
    changes.notifyChange('neo_session_messages');
  },
});

export class NeoSessionMessageRepository {
  constructor(private readonly db: Database) {}

  private select(where: string) {
    return this.db.prepare(`${SELECT} ${where}`);
  }

  sentDuringTurn(input: { sender: string; recipient: string; from: number; to: number }) {
    return !!this.select(
      `WHERE conversation_id=(SELECT id FROM neo_conversation WHERE singleton=1)
        AND from_session=? AND to_session=? AND created_at>=? AND created_at<=? LIMIT 1`
    ).get(
      input.sender,
      input.recipient,
      new Date(input.from).toISOString(),
      new Date(input.to).toISOString()
    );
  }

  record(message: NeoSessionMessageDraft): Promise<void> {
    return gatewayFor(this.db).run(recordNeoSessionMessage, message);
  }

  get(conversationId: string, messageId: string): NeoSessionMessage | null {
    return (
      (this.select('WHERE conversation_id = ? AND message_id = ?').get(
        conversationId,
        messageId
      ) as NeoSessionMessage | null) ?? null
    );
  }

  latest(conversationId: string, limit: number): NeoSessionMessage[] {
    return (
      this.select(
        `WHERE conversation_id = ? AND ${VISIBLE_IN_NEO}
           ORDER BY created_at DESC, sequence DESC LIMIT ?`
      ).all(conversationId, limit) as NeoSessionMessage[]
    ).reverse();
  }
}

export const sentDuringTurn = defineRepositoryOp(
  'neo.turnReport.sentDuringTurn',
  'read',
  NeoSessionMessageRepository,
  ['sentDuringTurn']
);
