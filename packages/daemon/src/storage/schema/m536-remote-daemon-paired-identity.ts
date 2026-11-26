import type { Database } from '../sqlite-compat.ts';

export function runMigration536(db: Database): void {
  db.exec('ALTER TABLE remote_daemon_secrets ADD COLUMN peer_daemon_id TEXT');
}
