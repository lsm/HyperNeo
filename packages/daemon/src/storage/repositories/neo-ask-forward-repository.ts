import type { NeoAskOrigin } from '../../lib/neo/ask-origin.ts';
import type { Database } from '../sqlite-compat.ts';

export interface NeoAskForward {
  hop: number;
  fromSessionId: string;
  toSessionId: string;
  toConcernId: string | null;
  forwardedAt: number;
}

const columns = `hop, from_session_id AS fromSessionId, to_session_id AS toSessionId,
  to_concern_id AS toConcernId, forwarded_at AS forwardedAt`;

export class NeoAskForwardRepository {
  constructor(private readonly db: Database) {}

  list(ask: NeoAskOrigin): NeoAskForward[] {
    return this.db
      .prepare(`SELECT ${columns} FROM neo_ask_forwards
        WHERE ask_session_id = ? AND ask_message_id = ? ORDER BY hop`)
      .all(ask.sessionId, ask.messageId) as NeoAskForward[];
  }

  record(ask: NeoAskOrigin, forward: NeoAskForward): boolean {
    return (
      this.db
        .prepare(`INSERT INTO neo_ask_forwards (ask_session_id, ask_message_id, hop,
          from_session_id, to_session_id, to_concern_id, forwarded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
        .run(
          ask.sessionId,
          ask.messageId,
          forward.hop,
          forward.fromSessionId,
          forward.toSessionId,
          forward.toConcernId,
          forward.forwardedAt
        ).changes > 0
    );
  }
}
