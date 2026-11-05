import type { Database } from '../sqlite-compat.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { connectionStatus, type ConnectionStatus } from '../../lib/connections/status.ts';

class GoogleConnections {
  constructor(private readonly db: Database) {}

  list(): ConnectionStatus[] {
    const rows = this.db
      .prepare('SELECT status_json FROM google_connections ORDER BY id')
      .all() as { status_json: string }[];
    return rows.map((row) => connectionStatus.parse(JSON.parse(row.status_json)));
  }

  put(input: unknown): void {
    const status = connectionStatus.parse(input);
    this.db
      .prepare(`INSERT INTO google_connections (id, account_id, status_json) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, status_json = excluded.status_json`)
      .run(status.id, status.accountId, JSON.stringify(status));
  }
}

export const googleConnectionReads = defineRepositoryOp(
  'connections.read',
  'read',
  GoogleConnections,
  ['list']
);
export const googleConnectionWrites = defineRepositoryOp(
  'connections.write',
  'write',
  GoogleConnections,
  ['put']
);
