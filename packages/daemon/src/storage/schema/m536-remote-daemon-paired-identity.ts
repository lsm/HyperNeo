import type { Database } from '../sqlite-compat.ts';

export function runMigration536(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(remote_daemon_secrets)').all() as {
    name: string;
  }[];
  if (!columns.some((column) => column.name === 'peer_daemon_id'))
    db.exec('ALTER TABLE remote_daemon_secrets ADD COLUMN peer_daemon_id TEXT');
}
