import type { Database } from '../sqlite-compat.ts';

type Origin = { sessionId: string; messageId: string };

export class NeoInputOriginRepository {
  constructor(private readonly db: Database) {}

  private hasTable(): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_input_origins' AND type = 'table'")
      .get();
  }

  get(sessionId: string, messageId: string): Origin | null {
    if (!this.hasTable()) return null;
    return (
      (this.db
        .prepare(
          `SELECT origin_session_id AS sessionId, origin_message_id AS messageId
             FROM neo_input_origins WHERE session_id = ? AND message_id = ?`
        )
        .get(sessionId, messageId) as Origin | undefined) ?? null
    );
  }

  trigger(sessionId: string, messageId: string): string | null {
    if (!this.hasTable()) return null;
    return (
      (
        this.db
          .prepare(
            'SELECT trigger_id AS triggerId FROM neo_input_origins WHERE session_id = ? AND message_id = ?'
          )
          .get(sessionId, messageId) as { triggerId: string | null } | undefined
      )?.triggerId ?? null
    );
  }

  record(input: Origin, origin: Origin, at: number, triggerId: string | null = null): void {
    if (!this.hasTable()) return;
    this.db
      .prepare(
        `INSERT INTO neo_input_origins(session_id, message_id, origin_session_id, origin_message_id, stamped_at, trigger_id)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, message_id) DO NOTHING`
      )
      .run(input.sessionId, input.messageId, origin.sessionId, origin.messageId, at, triggerId);
  }
}
