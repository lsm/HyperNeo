import type { Database } from '../sqlite-compat.ts';

export class RemoteDaemonSecretRepository {
  constructor(private readonly db: Database) {}

  save(daemonId: string, url: string, credential: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO remote_daemon_secrets (daemon_id, url, credential, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (daemon_id) DO UPDATE SET url = excluded.url, credential = excluded.credential,
           created_at = excluded.created_at`
      )
      .run(daemonId, url, credential, now);
  }

  credentialFor(daemonId: string, url: string): string | null {
    const row = this.db
      .prepare('SELECT credential FROM remote_daemon_secrets WHERE daemon_id = ? AND url = ?')
      .get(daemonId, url) as { credential: string } | undefined;
    return row?.credential ?? null;
  }

  remove(daemonId: string): void {
    this.db.prepare('DELETE FROM remote_daemon_secrets WHERE daemon_id = ?').run(daemonId);
  }
}
