import type { Database as BunDatabase } from '../sqlite-compat';
import type { McpEnablementOverride, McpEnablementScopeType } from '@hyperneo/shared';
import type { ReactiveDatabase } from '../reactive-database';

interface EnablementRow {
  scope_type: string;
  scope_id: string;
  server_id: string;
  enabled: number;
}

function rowToOverride(row: EnablementRow): McpEnablementOverride {
  return {
    scopeType: row.scope_type as McpEnablementScopeType,
    scopeId: row.scope_id,
    serverId: row.server_id,
    enabled: row.enabled === 1,
  };
}

export class McpEnablementRepository {
  constructor(
    private db: BunDatabase,
    private reactiveDb: ReactiveDatabase
  ) {}

  setOverride(
    scopeType: McpEnablementScopeType,
    scopeId: string,
    serverId: string,
    enabled: boolean
  ): McpEnablementOverride {
    this.db
      .prepare(
        `INSERT INTO mcp_enablement (server_id, scope_type, scope_id, enabled)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(server_id, scope_type, scope_id)
				 DO UPDATE SET enabled = excluded.enabled`
      )
      .run(serverId, scopeType, scopeId, enabled ? 1 : 0);
    this.reactiveDb.notifyChange('mcp_enablement');
    return { scopeType, scopeId, serverId, enabled };
  }

  getOverride(
    scopeType: McpEnablementScopeType,
    scopeId: string,
    serverId: string
  ): McpEnablementOverride | null {
    const row = this.db
      .prepare(
        `SELECT * FROM mcp_enablement
				 WHERE scope_type = ? AND scope_id = ? AND server_id = ?`
      )
      .get(scopeType, scopeId, serverId) as EnablementRow | undefined;
    return row ? rowToOverride(row) : null;
  }

  listForScope(scopeType: McpEnablementScopeType, scopeId: string): McpEnablementOverride[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mcp_enablement
				 WHERE scope_type = ? AND scope_id = ?
				 ORDER BY server_id ASC`
      )
      .all(scopeType, scopeId) as EnablementRow[];
    return rows.map(rowToOverride);
  }

  listForServer(serverId: string): McpEnablementOverride[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mcp_enablement
				 WHERE server_id = ?
				 ORDER BY scope_type ASC, scope_id ASC`
      )
      .all(serverId) as EnablementRow[];
    return rows.map(rowToOverride);
  }

  listAll(): McpEnablementOverride[] {
    const rows = this.db
      .prepare(`SELECT * FROM mcp_enablement ORDER BY scope_type ASC, scope_id ASC`)
      .all() as EnablementRow[];
    return rows.map(rowToOverride);
  }

  listForScopes(
    scopes: Array<{ scopeType: McpEnablementScopeType; scopeId: string }>
  ): McpEnablementOverride[] {
    if (scopes.length === 0) return [];

    const clauses: string[] = [];
    const params: string[] = [];
    for (const s of scopes) {
      clauses.push(`(scope_type = ? AND scope_id = ?)`);
      params.push(s.scopeType, s.scopeId);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM mcp_enablement
				 WHERE ${clauses.join(' OR ')}`
      )
      .all(...params) as EnablementRow[];
    return rows.map(rowToOverride);
  }

  clearOverride(scopeType: McpEnablementScopeType, scopeId: string, serverId: string): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM mcp_enablement
				 WHERE scope_type = ? AND scope_id = ? AND server_id = ?`
      )
      .run(scopeType, scopeId, serverId);
    const deleted = result.changes > 0;
    if (deleted) {
      this.reactiveDb.notifyChange('mcp_enablement');
    }
    return deleted;
  }

  clearScope(scopeType: McpEnablementScopeType, scopeId: string): number {
    const result = this.db
      .prepare(`DELETE FROM mcp_enablement WHERE scope_type = ? AND scope_id = ?`)
      .run(scopeType, scopeId);
    if (result.changes > 0) {
      this.reactiveDb.notifyChange('mcp_enablement');
    }
    return result.changes;
  }
}
