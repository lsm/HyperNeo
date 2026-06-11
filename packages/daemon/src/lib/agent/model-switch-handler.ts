/**
 * ModelSwitchHandler - Handles model switching logic for AgentSession
 *
 * Extracted from AgentSession to reduce complexity and improve testability.
 * Takes AgentSession instance directly - handlers are internal parts of AgentSession.
 *
 * Handles:
 * - Model validation and alias resolution
 * - Query restart to regenerate system:init with new model
 * - Session config persistence
 * - Event emission for UI updates
 *
 * FIX: Always restarts query when switching models mid-conversation.
 * SDK's setModel() doesn't update the cached system:init message, which
 * causes MessageInfoDropdown to show stale model info. Restarting ensures
 * fresh system:init is emitted with the correct model.
 */

import type {
  Provider,
  Session,
  SessionConfig,
  CurrentModelInfo,
  MessageHub,
} from '@neokai/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Database } from '../../storage/database';
import type { ErrorManager } from '../error-manager';
import { ErrorCategory } from '../error-manager';
import type { Logger } from '../logger';
import { isValidModel, resolveModelAlias, getModelInfo } from '../model-service';
import { getProviderRegistry } from '../providers/factory.js';
import { stripThinkingBlocksFromSessionFile } from '../sdk-session-file-manager';
import type { ContextTracker } from './context-tracker';
import type { MessageQueue } from './message-queue';
import type { ProcessingStateManager } from './processing-state-manager';
import type { QueryLifecycleManager } from './query-lifecycle-manager';
import type { QueryLike } from './query-like';

/**
 * Context interface - what ModelSwitchHandler needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface ModelSwitchHandlerContext {
  readonly session: Session;
  readonly db: Database;
  readonly messageHub: MessageHub;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  readonly contextTracker: ContextTracker;
  readonly stateManager: ProcessingStateManager;
  readonly errorManager: ErrorManager;
  readonly logger: Logger;
  readonly lifecycleManager: QueryLifecycleManager;

  // Query state
  readonly queryObject: QueryLike | null;
  readonly queryPromise: Promise<void> | null;
  readonly messageQueue: MessageQueue;
}

/**
 * Result of a model switch operation
 */
export interface ModelSwitchResult {
  success: boolean;
  model: string;
  error?: string;
}

/**
 * Handles model switching for AgentSession
 */
export class ModelSwitchHandler {
  constructor(private ctx: ModelSwitchHandlerContext) {}

  /**
   * Get the effective workspace path for SDK session file lookups.
   * Must match QueryLifecycleManager.getSDKWorkspacePath().
   */
  private getSDKWorkspacePath(): string {
    const { session } = this.ctx;
    return session.worktree
      ? session.worktree.worktreePath
      : (session.workspacePath ?? process.cwd());
  }

  /**
   * Strip thinking blocks from JSONL when switching between providers.
   *
   * Thinking block signatures are provider-specific and cannot be validated by a
   * different provider's API. Anthropic rejects GLM/MiniMax signatures; GLM/MiniMax
   * reject Anthropic signatures. Both fail with "400: Invalid signature in thinking block".
   * Stripping preserves conversation text + tool usage while avoiding context loss.
   */
  private stripThinkingBlocksIfNeeded(previousProvider: string, newProvider: string): void {
    const { session, logger } = this.ctx;

    // Strip when switching between different providers — signatures are provider-specific
    if (previousProvider === newProvider) return;
    if (!session.sdkSessionId) return;

    const workspacePath = this.getSDKWorkspacePath();
    const result = stripThinkingBlocksFromSessionFile(workspacePath, session.sdkSessionId);

    if (result.stripped) {
      logger.info(
        `Stripped ${result.thinkingBlocksRemoved} thinking block(s) from JSONL ` +
          `for cross-provider switch ${previousProvider} → ${newProvider}` +
          (result.backupPath ? ` (backup: ${result.backupPath})` : '')
      );
    }
  }

  /**
   * Get current model ID for this session
   */
  getCurrentModel(): CurrentModelInfo {
    return {
      id: this.ctx.session.config.model,
      info: null, // Model info is fetched asynchronously by RPC handler
    };
  }

  private isQueryActiveOrStarting(): boolean {
    return Boolean(
      this.ctx.queryObject || this.ctx.queryPromise || this.ctx.messageQueue.isRunning()
    );
  }

  /**
   * Switch to a different model mid-session.
   *
   * Always restarts the query to ensure SDK emits a fresh system:init message
   * with the correct model. This is necessary because SDK's setModel() doesn't
   * update the cached system:init, causing stale model info in the UI.
   *
   * @param newModel - Model ID or alias to switch to
   * @param newProvider - Provider ID for the new model (required)
   */
  async switchModel(newModel: string, newProvider: string): Promise<ModelSwitchResult> {
    const {
      session,
      db,
      messageHub,
      internalEventBus,
      contextTracker,
      stateManager,
      errorManager,
      logger,
      lifecycleManager,
    } = this.ctx;

    try {
      if (!session.config.provider) {
        throw new Error('Session has no provider configured');
      }

      // Validate the new model against the new provider
      const isValid = await isValidModel(newModel, 'global', newProvider);
      if (!isValid) {
        const error = `Invalid model: ${newModel}. Use a valid model ID or alias.`;
        logger.error(`${error}`);
        return { success: false, model: session.config.model, error };
      }

      // Get model info from the ORIGINAL alias to preserve provider context.
      // Resolving alias first (e.g., 'copilot-anthropic-sonnet' → 'claude-sonnet-4.6')
      // and then calling getModelInfo loses the provider — two providers can share
      // the same canonical ID (e.g., Anthropic and anthropic-copilot both have
      // 'claude-sonnet-4.6').
      // Use newProvider to correctly disambiguate same-ID models across providers.
      const modelInfo = await getModelInfo(newModel, 'global', newProvider);
      // modelInfo is non-null here because isValidModel passed above;
      // fall back to newModel as-is for defensive safety (unreachable in practice).
      const resolvedModel = modelInfo?.id ?? newModel;

      // Resolve the current model in case it's also an alias.
      // Use session.config.provider (the current provider) for the current model.
      const currentResolvedModel = await resolveModelAlias(
        session.config.model,
        'global',
        session.config.provider
      );

      // Check if already using this model (compare resolved IDs and provider).
      // Must check provider too: two providers can share the same canonical ID
      // (e.g., anthropic and anthropic-copilot both have claude-sonnet-4.6),
      // so switching providers on the same model ID is a meaningful operation.
      if (currentResolvedModel === resolvedModel && session.config.provider === newProvider) {
        return {
          success: true,
          model: resolvedModel,
          error: `Already using ${modelInfo?.name || resolvedModel}`,
        };
      }

      const previousModel = session.config.model;
      const previousProvider = session.config.provider;

      // Emit model switching event
      messageHub.event(
        'session.model-switching',
        {
          from: previousModel,
          to: resolvedModel,
        },
        { channel: `session:${session.id}` }
      );

      // Locate the provider instance for the new model.
      // newProvider is a required string, so detectProviderForModel always receives
      // an explicit provider — no heuristic fallback is needed.
      const providerRegistry = getProviderRegistry();
      const newProviderInstance = providerRegistry.detectProviderForModel(
        resolvedModel,
        newProvider
      );

      if (!newProviderInstance) {
        const errMsg = `Cannot switch to model '${resolvedModel}': provider '${newProvider}' is not registered.`;
        logger.error(errMsg);
        return { success: false, model: session.config.model, error: errMsg };
      }

      if (!this.isQueryActiveOrStarting()) {
        // Query hasn't been created yet OR query was already completed/interrupted.
        // Persist the new model/provider only. The next user message will start a
        // fresh SDK query with this config; starting an empty query here creates a
        // race where the first real message can be accepted before the agent turn
        // is ready to consume it.
        session.config.model = resolvedModel;
        // newProviderInstance is guaranteed non-null here (we returned early above).
        session.config.provider = newProviderInstance.id as Provider;
        // Only pass serializable fields — session.config may contain runtime-only
        // objects (mcpServers with closures, agents, spawnClaudeCodeProcess) that
        // cannot be JSON-stringified and would cause a cyclic structure error.
        db.updateSession(session.id, {
          config: {
            model: resolvedModel,
            provider: newProviderInstance.id as Provider,
          } as SessionConfig,
        });

        // Update context tracker model
        contextTracker.setModel(resolvedModel);

        // Emit session.updated event - include data for decoupled state management
        await internalEventBus.publish('session.updated', {
          sessionId: session.id,
          source: 'model-switch',
          session: { config: session.config },
        });

        // Strip thinking blocks from JSONL if switching to Anthropic from another provider
        this.stripThinkingBlocksIfNeeded(previousProvider, newProviderInstance.id);
      } else {
        // Query exists - always restart to apply the new model/provider.
        // We must restart even if firstMessageReceived is false because the SDK
        // subprocess is already running with the old model. The restart spawns a new
        // subprocess with the updated config and resumes the conversation if the
        // SDK session file is still valid.
        //
        // FIX: SDK's setModel() doesn't update the cached system:init message,
        // causing MessageInfoDropdown to show stale model info.
        // Restarting forces SDK to emit fresh system:init with correct model.

        // Update session config first (will be used when query restarts)
        session.config.model = resolvedModel;
        // newProviderInstance is guaranteed non-null here (we returned early above).
        session.config.provider = newProviderInstance.id as Provider;
        // Only pass serializable fields — session.config may contain runtime-only
        // objects (mcpServers with closures, agents, spawnClaudeCodeProcess) that
        // cannot be JSON-stringified and would cause a cyclic structure error.
        db.updateSession(session.id, {
          config: {
            model: resolvedModel,
            provider: newProviderInstance.id as Provider,
          } as SessionConfig,
        });

        // Update context tracker model
        contextTracker.setModel(resolvedModel);

        // Emit session.updated event so state-manager and UI know the model changed
        // This prevents stale model display during the restart window before
        // the restarted query emits a fresh system:init with the new model
        await internalEventBus.publish('session.updated', {
          sessionId: session.id,
          source: 'model-switch',
          session: { config: session.config },
        });

        // Strip thinking blocks from JSONL if switching to Anthropic from another provider
        this.stripThinkingBlocksIfNeeded(previousProvider, newProviderInstance.id);

        // Restart the query via lifecycle manager
        // This spawns a new SDK subprocess with the new model configuration
        await lifecycleManager.restart();
      }

      // Emit success event
      messageHub.event(
        'session.model-switched',
        {
          from: previousModel,
          to: resolvedModel,
          modelInfo: modelInfo || null,
        },
        { channel: `session:${session.id}` }
      );

      return {
        success: true,
        model: resolvedModel,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Model switch failed:`, error);

      await errorManager.handleError(
        session.id,
        error as Error,
        ErrorCategory.MODEL,
        `Failed to switch model: ${errorMessage}`,
        stateManager.getState(),
        {
          requestedModel: newModel,
          currentModel: session.config.model,
        }
      );

      return {
        success: false,
        model: session.config.model,
        error: errorMessage,
      };
    }
  }
}
