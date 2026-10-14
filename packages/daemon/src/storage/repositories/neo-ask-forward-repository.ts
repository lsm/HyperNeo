import type { NeoAskOrigin } from '../../lib/neo/ask-origin.ts';
import type { Database } from '../sqlite-compat.ts';

export interface NeoAskForward {
  hop: number;
  fromSessionId: string;
  toSessionId: string;
  toProjectId: string | null;
  forwardedAt: number;
}

type ForwardRow = NeoAskForward & { askSessionId: string; askMessageId: string };

const columns = `hop, from_session_id AS fromSessionId, to_session_id AS toSessionId,
  to_concern_id AS toProjectId, forwarded_at AS forwardedAt`;

export class NeoAskForwardRepository {
  constructor(private readonly db: Database) {}

  list(ask: NeoAskOrigin): NeoAskForward[] {
    return this.db
      .prepare(`SELECT ${columns} FROM neo_ask_forwards
        WHERE ask_session_id = ? AND ask_message_id = ? ORDER BY hop`)
      .all(ask.sessionId, ask.messageId) as NeoAskForward[];
  }

  listFrom(sessionId: string, askMessageId: string): (NeoAskForward & { ask: NeoAskOrigin })[] {
    return this.withAsk(
      this.db
        .prepare(`SELECT ${columns}, ask_session_id AS askSessionId, ask_message_id AS askMessageId
          FROM neo_ask_forwards WHERE from_session_id = ? AND ask_message_id = ? ORDER BY hop`)
        .all(sessionId, askMessageId) as ForwardRow[]
    );
  }

  listRecent(limit: number): (NeoAskForward & { ask: NeoAskOrigin })[] {
    return this.withAsk(
      this.db
        .prepare(`SELECT ${columns}, ask_session_id AS askSessionId, ask_message_id AS askMessageId
          FROM neo_ask_forwards ORDER BY forwarded_at DESC LIMIT ?`)
        .all(limit) as ForwardRow[]
    );
  }

  listTo(sessionId: string, limit: number): (NeoAskForward & { ask: NeoAskOrigin })[] {
    return this.withAsk(
      this.db
        .prepare(`SELECT ${columns}, ask_session_id AS askSessionId, ask_message_id AS askMessageId
          FROM neo_ask_forwards WHERE to_session_id = ? ORDER BY forwarded_at DESC LIMIT ?`)
        .all(sessionId, limit) as ForwardRow[]
    );
  }

  private withAsk(rows: ForwardRow[]): (NeoAskForward & { ask: NeoAskOrigin })[] {
    return rows.map(({ askSessionId, askMessageId, ...forward }) => ({
      ...forward,
      ask: { sessionId: askSessionId, messageId: askMessageId },
    }));
  }

  remove(ask: NeoAskOrigin, hop: number): void {
    this.db
      .prepare(
        'DELETE FROM neo_ask_forwards WHERE ask_session_id = ? AND ask_message_id = ? AND hop = ?'
      )
      .run(ask.sessionId, ask.messageId, hop);
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
          forward.toProjectId,
          forward.forwardedAt
        ).changes > 0
    );
  }
}
