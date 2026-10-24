import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';

export const saveRemoteDaemonSecret = defineDbOp({
  name: 'remoteDaemon.secret.save',
  mode: 'write',
  run: (
    db: Database,
    secret: { daemonId: string; url: string; credential: string; now: number }
  ): void => {
    db.prepare(
      `INSERT INTO remote_daemon_secrets (daemon_id, url, credential, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (daemon_id) DO UPDATE SET url = excluded.url, credential = excluded.credential,
         created_at = excluded.created_at`
    ).run(secret.daemonId, secret.url, secret.credential, secret.now);
  },
});

export const removeRemoteDaemonSecret = defineDbOp({
  name: 'remoteDaemon.secret.remove',
  mode: 'write',
  run: (db: Database, daemonId: string): void => {
    db.prepare('DELETE FROM remote_daemon_secrets WHERE daemon_id = ?').run(daemonId);
  },
});

export class RemoteDaemonSecretRepository {
  constructor(private readonly db: Database) {}

  save(daemonId: string, url: string, credential: string, now: number): Promise<void> {
    return gatewayFor(this.db).run(saveRemoteDaemonSecret, { daemonId, url, credential, now });
  }

  credentialFor(daemonId: string, url: string): string | null {
    const row = this.db
      .prepare('SELECT credential FROM remote_daemon_secrets WHERE daemon_id = ? AND url = ?')
      .get(daemonId, url) as { credential: string } | undefined;
    return row?.credential ?? null;
  }

  remove(daemonId: string): Promise<void> {
    return gatewayFor(this.db).run(removeRemoteDaemonSecret, daemonId);
  }
}
