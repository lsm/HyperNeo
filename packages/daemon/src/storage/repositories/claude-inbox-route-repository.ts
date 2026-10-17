import type { Database } from '../sqlite-compat.ts';

export class ClaudeInboxRouteRepository {
  constructor(private readonly db: Database) {}

  record(sessionId: string, returnTo: string, inboxDir: string, at = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO claude_inbox_routes (session_id, return_to, inbox_dir, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET return_to = excluded.return_to,
           inbox_dir = excluded.inbox_dir, updated_at = excluded.updated_at`
      )
      .run(sessionId, returnTo, inboxDir, at);
  }

  returnTo(sessionId: string): string | null {
    const row = this.db
      .prepare('SELECT return_to AS returnTo FROM claude_inbox_routes WHERE session_id = ?')
      .get(sessionId) as { returnTo: string } | null | undefined;
    return row?.returnTo ?? null;
  }

  inboxDirs(): string[] {
    return (
      this.db.prepare('SELECT DISTINCT inbox_dir AS dir FROM claude_inbox_routes').all() as {
        dir: string;
      }[]
    ).map((row) => row.dir);
  }
}
