/**
 * McpEnablementRepository
 *
 * CRUD for the unified per-scope MCP enablement override table. Each row is an
 * explicit (scope_type, scope_id, server_id) override that either enables or
 * disables a registry server at that scope. Missing rows mean "inherit" — the
 * resolver (packages/daemon/src/lib/mcp/resolve-mcp-servers.ts) applies the
 * session > room > space > registry precedence.
 *
 * Each write calls reactiveDb.notifyChange('mcp_enablement') so LiveQueryEngine
 * can invalidate frontend subscriptions on every change.
 */

import type { Database as BunDatabase } from '../sqlite-compat';
import type { McpEnablementOverride, McpEnablementScopeType } from '@hyperneo/shared';
import type { ReactiveDatabase } from '../reactive-database';

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class McpEnablementRepository {
  constructor(
    private db: BunDatabase,
    private reactiveDb: ReactiveDatabase
  ) {}

  /**
   * Upsert an explicit override for (scopeType, scopeId, serverId).
   *
   * Calling with `enabled=true` explicitly enables the server at that scope,
   * overriding whatever the next-less-specific scope says. Calling with
   * `enabled=false` explicitly disables it. To remove the override entirely
   * (revert to inheritance), call {@link clearOverride}.
   */
  setOverride(
    scopeType: McpEnablementScopeType,
    scopeId: string,
    serverId: string,
    enabled: boolean
  ): McpEnablementOverride {
    // Single INSERT OR REPLACE handles both insert and update. The composite
    // PRIMARY KEY (server_id, scope_type, scope_id) means a conflict on any
    // of those triples swaps the `enabled` column in place.
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

  /**
   * Return the single override for (scopeType, scopeId, serverId), or null if
   * none exists. A null return means "inherit from parent scope / registry".
   */
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

  /**
   * All override rows that target the given scope (e.g. every override at
   * scope='space' with scopeId='space-1'). Useful when the UI renders the
   * override list for a single scope.
   */
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

  /**
   * All override rows for a given server (any scope). Used by the registry
   * UI to show "server X is explicitly disabled in the following scopes".
   */
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

  /**
   * All overrides across all scopes. Primarily for the resolver, which fetches
   * every override matching a session's scope chain. Callers should typically
   * prefer {@link listForScopes} which pre-filters in SQL.
   */
  listAll(): McpEnablementOverride[] {
    const rows = this.db
      .prepare(`SELECT * FROM mcp_enablement ORDER BY scope_type ASC, scope_id ASC`)
      .all() as EnablementRow[];
    return rows.map(rowToOverride);
  }

  /**
   * Return every override matching any of the given (scopeType, scopeId)
   * pairs. Shape is intended for the pure resolver's input: the caller
   * assembles the session's scope chain (space, room, session) and hands it
   * to this method, which returns only the rows that matter for resolution.
   */
  listForScopes(
    scopes: Array<{ scopeType: McpEnablementScopeType; scopeId: string }>
  ): McpEnablementOverride[] {
    if (scopes.length === 0) return [];

    // Hand-roll the placeholder list so every scope pair becomes `(?,?)`.
    // SQLite doesn't natively accept tuple-IN for composite keys, so we use
    // an OR chain instead. The list is bounded (≤3 scopes for any session).
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

  /**
   * Delete a single override. Returns true if a row was removed.
   * Removing an override means "inherit from next parent scope" again.
   */
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

  /**
   * Drop every override at a given scope (e.g. "reset this room to inherit").
   * Returns the number of rows removed.
   */
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
