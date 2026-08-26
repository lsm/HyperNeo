import type { Session, McpServerConfig } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { Database } from '../../storage/database.ts';
import { SettingsManager } from '../settings-manager.ts';
import { Logger } from '../logger.ts';

export interface SessionConfigHandlerContext {
  readonly session: Session;
  readonly db: Database;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;

  settingsManager: SettingsManager;
}

export class SessionConfigHandler {
  private logger: Logger;

  constructor(private ctx: SessionConfigHandlerContext) {
    this.logger = new Logger(`SessionConfigHandler ${ctx.session.id}`);
  }

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

  async updateUserMcpServers(servers: Record<string, McpServerConfig>): Promise<void> {
    const { session, db, internalEventBus } = this.ctx;

    const existing = (session.config?.mcpServers ?? {}) as Record<string, McpServerConfig>;
    const runtimeServers: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(existing)) {
      if ((cfg as { type?: string }).type === 'sdk') {
        runtimeServers[name] = cfg;
      }
    }

    const merged: Record<string, McpServerConfig> = { ...servers, ...runtimeServers };

    session.config = { ...session.config, mcpServers: merged };
    db.updateSession(session.id, { config: session.config });

    await internalEventBus.publish('session.updated', {
      sessionId: session.id,
      source: 'config-update',
      session: { config: session.config },
    });
  }

  updateMetadata(updates: Partial<Session>): void {
    const { session, db } = this.ctx;

    if (updates.title) session.title = updates.title;

    if (updates.workspacePath !== undefined) {
      session.workspacePath = updates.workspacePath;
      if (updates.workspacePath) {
        this.ctx.settingsManager = new SettingsManager(db, updates.workspacePath);
      }
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
    if ('acpSessionId' in updates) session.acpSessionId = updates.acpSessionId;

    db.updateSession(session.id, updates);
  }
}
