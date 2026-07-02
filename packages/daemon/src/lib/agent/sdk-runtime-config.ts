/**
 * SDKRuntimeConfig - Runtime SDK configuration management
 *
 * Extracted from AgentSession to reduce complexity.
 * Takes AgentSession instance directly - handlers are internal parts of AgentSession.
 *
 * Handles:
 * - setMaxThinkingTokens - Adjust thinking tokens at runtime
 * - setPermissionMode - Change permission mode
 * - getMcpServerStatus - Get MCP server status
 * - updateToolsConfig - Update tools configuration with restart
 */

import type { Session } from '@hyperneo/shared';
import type { QueryLike } from './query-like';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Database } from '../../storage/database';
import type { Logger } from '../logger';
import type { SettingsManager } from '../settings-manager';
import type { ContextTracker } from './context-tracker';
import { ContextFetcher } from './context-fetcher';
import { getSessionModelInfo } from '../model-service';

/**
 * Context interface - what SDKRuntimeConfig needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface SDKRuntimeConfigContext {
  readonly session: Session;
  readonly db: Database;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  readonly settingsManager: SettingsManager;
  readonly logger: Logger;
  readonly contextTracker: ContextTracker;

  // Query state
  readonly queryObject: QueryLike | null;
  readonly firstMessageReceived: boolean;

  // Method to restart query (needs to be a method, not a simple property)
  restartQuery(): Promise<void>;
}

/**
 * Result of a config update operation
 */
interface ConfigUpdateResult {
  success: boolean;
  error?: string;
}

/**
 * MCP server status entry
 */
interface McpServerStatus {
  name: string;
  status: string;
  error?: string;
}

/**
 * Manages SDK runtime configuration
 */
export class SDKRuntimeConfig {
  constructor(private ctx: SDKRuntimeConfigContext) {}

  /**
   * Set max thinking tokens at runtime
   * @deprecated Use session.setThinkingLevel() instead. This uses the deprecated
   * SDK API which is treated as on/off (0 = disabled, any value = adaptive) on Opus 4.6.
   */
  async setMaxThinkingTokens(tokens: number | null): Promise<ConfigUpdateResult> {
    const { session, db, internalEventBus, logger, queryObject, firstMessageReceived } = this.ctx;

    try {
      // If query not running or transport not ready, just update config
      if (!queryObject || !firstMessageReceived) {
        session.config.maxThinkingTokens = tokens;
        db.updateSession(session.id, { config: session.config });
        return { success: true };
      }

      // Use native query method when available
      if (queryObject.setMaxThinkingTokens) {
        await queryObject.setMaxThinkingTokens(tokens);
      }

      // Update config
      session.config.maxThinkingTokens = tokens;
      db.updateSession(session.id, { config: session.config });

      // Emit event for UI update
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

  /**
   * Set permission mode at runtime
   */
  async setPermissionMode(mode: string): Promise<ConfigUpdateResult> {
    const { session, db, internalEventBus, logger, queryObject, firstMessageReceived } = this.ctx;

    try {
      // If query not running or transport not ready, just update config
      if (!queryObject || !firstMessageReceived) {
        session.config.permissionMode = mode as Session['config']['permissionMode'];
        db.updateSession(session.id, { config: session.config });
        return { success: true };
      }

      // Use native query method when available
      if (queryObject.setPermissionMode) {
        await queryObject.setPermissionMode(mode);
      }

      // Update config
      session.config.permissionMode = mode as Session['config']['permissionMode'];
      db.updateSession(session.id, { config: session.config });

      // Emit event for UI update
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

  /**
   * Get MCP server status from SDK
   */
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

  /**
   * Update tools configuration and restart query to apply changes
   */
  async updateToolsConfig(tools: Session['config']['tools']): Promise<ConfigUpdateResult> {
    const { session, db, internalEventBus, logger } = this.ctx;

    try {
      // 1. Update session config in memory and DB
      const newConfig = { ...session.config, tools };
      session.config = newConfig;
      db.updateSession(session.id, { config: newConfig });

      // 2. Refresh context breakdown via the SDK's native method.
      // Previously this queued `/context` into the message stream, but we
      // no longer consume those replies and they'd surface as visible
      // messages in the transcript. Use `query.getContextUsage()` directly.
      await this.refreshContextUsage();

      // 3. Emit event for StateManager
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

  /**
   * Fetch fresh context usage via the SDK and update the tracker + UI.
   *
   * Best-effort: errors are logged but do not fail the outer operation.
   * Silently skips when there is no live query handle (e.g. pre-start).
   */
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
