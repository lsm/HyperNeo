import type { NeoSessionMessage } from '@hyperneo/shared/types/neo-session-message';
import type { Database } from '../sqlite-compat.ts';

const SELECT = `SELECT message_id AS messageId, conversation_id AS conversationId, sequence,
  from_session AS fromSession, from_name AS fromName, to_session AS toSession, to_name AS toName,
  text, created_at AS createdAt FROM neo_session_messages`;

export type NeoSessionMessageDraft = Omit<NeoSessionMessage, 'sequence'>;

export class NeoSessionMessageRepository {
  constructor(
    private readonly db: Database,
    private readonly changed: () => void = () => {}
  ) {}

  record(message: NeoSessionMessageDraft): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO neo_session_messages (conversation_id, message_id, from_session,
           from_name, to_session, to_name, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.conversationId,
        message.messageId,
        message.fromSession,
        message.fromName,
        message.toSession,
        message.toName,
        message.text,
        message.createdAt
      );
    this.changed();
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
          `${SELECT} WHERE conversation_id = ? ORDER BY created_at DESC, sequence DESC LIMIT ?`
        )
        .all(conversationId, limit) as NeoSessionMessage[]
    ).reverse();
  }
}
