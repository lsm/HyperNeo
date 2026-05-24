/**
 * SessionConfigHandler - Manages session configuration and metadata updates
 *
 * Extracted from AgentSession to reduce complexity.
 * Takes AgentSession context directly - handlers are internal parts of AgentSession.
 *
 * Handles:
 * - Session config updates with DB persistence and event broadcasting
 * - Session metadata updates with field-level merging
 * - SettingsManager recreation when workspace changes
 */

import type { Session, McpServerConfig } from '@neokai/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Database } from '../../storage/database';
import { SettingsManager } from '../settings-manager';
import { Logger } from '../logger';

/**
 * Context interface - what SessionConfigHandler needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface SessionConfigHandlerContext {
  readonly session: Session;
  readonly db: Database;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;

  // Mutable settings manager (needs to be recreated when workspace changes)
  settingsManager: SettingsManager;
}

export class SessionConfigHandler {
  private logger: Logger;

  constructor(private ctx: SessionConfigHandlerContext) {
    this.logger = new Logger(`SessionConfigHandler ${ctx.session.id}`);
  }

  /**
   * Update session configuration
   *
   * Merges the provided config updates with existing config,
   * persists to database, and broadcasts the update event.
   *
   * **Warning:** If `configUpdates.mcpServers` is set, the entire `mcpServers`
   * key is replaced — this will drop any runtime-injected in-process servers
   * (`node-agent`, `task-agent`, `space-agent-tools`, `db-query`).
   * For user-facing MCP configuration changes use `updateUserMcpServers` instead.
   */
  async updateConfig(configUpdates: Partial<Session['config']>): Promise<void> {
    const { session, db, internalEventBus } = this.ctx;

    session.config = { ...session.config, ...configUpdates };
    db.updateSession(session.id, { config: session.config });

    await internalEventBus.publish('session.updated', {
      sessionId: session.id,
      source: 'config-update',
      session: { config: session.config },
    });
  }

  /**
   * Update only the user-managed (subprocess) MCP servers, preserving all
   * in-process (SDK-type) servers already present in the session config.
   *
   * In-process servers (`node-agent`, `task-agent`, `space-agent-tools`, `db-query`)
   * are identified by `server.type === 'sdk'` and are never overwritten here.
   * User-managed subprocess servers (`type: 'stdio' | 'sse' | 'http'`) are replaced
   * wholesale with the provided `servers` map.
   *
   * Persists to DB and emits a `session.updated` event like `updateConfig`.
   */
  async updateUserMcpServers(servers: Record<string, McpServerConfig>): Promise<void> {
    const { session, db, internalEventBus } = this.ctx;

    // Collect in-process (SDK-type) servers that must be preserved.
    const existing = (session.config?.mcpServers ?? {}) as Record<string, McpServerConfig>;
    const runtimeServers: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(existing)) {
      // In-process servers are McpSdkServerConfigWithInstance with type === 'sdk'.
      if ((cfg as { type?: string }).type === 'sdk') {
        runtimeServers[name] = cfg;
      }
    }

    // Merge: runtime servers take precedence, then user-provided subprocess servers.
    const merged: Record<string, McpServerConfig> = { ...servers, ...runtimeServers };

    session.config = { ...session.config, mcpServers: merged };
    db.updateSession(session.id, { config: session.config });

    await internalEventBus.publish('session.updated', {
      sessionId: session.id,
      source: 'config-update',
      session: { config: session.config },
    });
  }

  /**
   * Update session metadata
   *
   * Supports partial updates to various session fields:
   * - title, workspacePath, status, archivedAt, worktree
   * - metadata: Merged field-by-field, null/undefined values delete fields
   * - config: Merged with existing config
   *
   * When workspacePath changes, recreates the SettingsManager.
   */
  updateMetadata(updates: Partial<Session>): void {
    const { session, db } = this.ctx;

    if (updates.title) session.title = updates.title;

    if (updates.workspacePath) {
      session.workspacePath = updates.workspacePath;
      // Recreate settings manager for new workspace
      this.ctx.settingsManager = new SettingsManager(db, updates.workspacePath);
    }

    if (updates.status) session.status = updates.status;

    if (updates.metadata) {
      const mergedMetadata = { ...session.metadata };
      for (const [key, value] of Object.entries(updates.metadata)) {
        if (value === undefined || value === null) {
          delete mergedMetadata[key as keyof typeof mergedMetadata];
        } else {
          (mergedMetadata as Record<string, unknown>)[key] = value;
        }
      }
      session.metadata = mergedMetadata;
    }

    if (updates.config) {
      session.config = { ...session.config, ...updates.config };
    }

    if (updates.archivedAt !== undefined) session.archivedAt = updates.archivedAt;
    if ('worktree' in updates) session.worktree = updates.worktree;

    db.updateSession(session.id, updates);
  }
}
