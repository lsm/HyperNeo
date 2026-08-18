import type { Session } from '@hyperneo/shared';
import type { QueryLike } from './query-like';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Database } from '../../storage/database';
import type { Logger } from '../logger';
import type { SettingsManager } from '../settings-manager';
import type { ContextTracker } from './context-tracker';
import { ContextFetcher } from './context-fetcher';
import { getSessionModelInfo } from '../model-service';

export interface SDKRuntimeConfigContext {
  readonly session: Session;
  readonly db: Database;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  readonly settingsManager: SettingsManager;
  readonly logger: Logger;
  readonly contextTracker: ContextTracker;

  readonly queryObject: QueryLike | null;
  readonly firstMessageReceived: boolean;

  restartQuery(): Promise<void>;
}

interface ConfigUpdateResult {
  success: boolean;
  error?: string;
}

interface McpServerStatus {
  name: string;
  status: string;
  error?: string;
}

export class SDKRuntimeConfig {
  constructor(private ctx: SDKRuntimeConfigContext) {}

  async setMaxThinkingTokens(tokens: number | null): Promise<ConfigUpdateResult> {
    const { session, db, internalEventBus, logger, queryObject, firstMessageReceived } = this.ctx;

    try {
      if (!queryObject || !firstMessageReceived) {
        session.config.maxThinkingTokens = tokens;
        db.updateSession(session.id, { config: session.config });
        return { success: true };
      }

      if (queryObject.setMaxThinkingTokens) {
        await queryObject.setMaxThinkingTokens(tokens);
      }

      session.config.maxThinkingTokens = tokens;
      db.updateSession(session.id, { config: session.config });

      await internalEventBus.publish('session.updated', {
        sessionId: session.id,
        source: 'thinking-tokens',
        session: { config: session.config },
      });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to set max thinking tokens:', error);
      return { success: false, error: errorMessage };
    }
  }

  async setPermissionMode(mode: string): Promise<ConfigUpdateResult> {
    const { session, db, internalEventBus, logger, queryObject, firstMessageReceived } = this.ctx;

    try {
      if (!queryObject || !firstMessageReceived) {
        session.config.permissionMode = mode as Session['config']['permissionMode'];
        db.updateSession(session.id, { config: session.config });
        return { success: true };
      }

      session.config.permissionMode = mode as Session['config']['permissionMode'];
      db.updateSession(session.id, { config: session.config });

      if (queryObject.setPermissionMode) {
        await queryObject.setPermissionMode(mode);
      }

      await internalEventBus.publish('session.updated', {
        sessionId: session.id,
        source: 'permission-mode',
        session: { config: session.config },
      });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to set permission mode:', error);
      return { success: false, error: errorMessage };
    }
  }

  async getMcpServerStatus(): Promise<McpServerStatus[]> {
    const { logger, queryObject, firstMessageReceived } = this.ctx;

    if (!queryObject || !firstMessageReceived) {
      return [];
    }

    try {
      if (queryObject.mcpServerStatus) {
        const status = await queryObject.mcpServerStatus();
        return status as McpServerStatus[];
      }
      return [];
    } catch (error) {
      logger.warn('Failed to get MCP server status:', error);
      return [];
    }
  }

  async updateToolsConfig(tools: Session['config']['tools']): Promise<ConfigUpdateResult> {
    const { session, db, internalEventBus, logger } = this.ctx;

    try {
      const newConfig = { ...session.config, tools };
      session.config = newConfig;
      db.updateSession(session.id, { config: newConfig });

      await this.refreshContextUsage();

      await internalEventBus.publish('session.updated', {
        sessionId: session.id,
        source: 'config',
        session: { config: session.config },
      });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to update tools config:', error);
      return { success: false, error: errorMessage };
    }
  }

  private async refreshContextUsage(): Promise<void> {
    const { session, internalEventBus, contextTracker, queryObject, logger } = this.ctx;
    if (!queryObject) return;

    try {
      const fetcher = new ContextFetcher(session.id);
      const modelInfo = await getSessionModelInfo(session);
      const contextInfo = await fetcher.fetch(queryObject, modelInfo);
      if (!contextInfo) return;
      contextTracker.updateWithDetailedBreakdown(contextInfo);
      await internalEventBus.publish('context.updated', {
        sessionId: session.id,
        contextInfo,
      });
    } catch (error) {
      logger.warn('Failed to refresh context usage after tools update:', error);
    }
  }
}
