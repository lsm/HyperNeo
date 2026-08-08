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
} from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Database } from '../../storage/database';
import type { ErrorManager } from '../error-manager';
import { ErrorCategory } from '../error-manager';
import type { Logger } from '../logger';
import { isValidModel, resolveModelAlias, getModelInfo } from '../model-service';
import { getProviderRegistry } from '../providers/factory.js';
import { inferProviderForModel } from '../providers/registry';
import { KimiProvider } from '../providers/kimi-provider.js';
import { stripThinkingBlocksFromSessionFile } from '../sdk-session-file-manager';
import type { ContextTracker } from './context-tracker';
import type { MessageQueue } from './message-queue';
import type { ProcessingStateManager } from './processing-state-manager';
import type { QueryLifecycleManager } from './query-lifecycle-manager';
import { AcpQueryAdapter } from '../acp/acp-query-adapter';
import type { QueryLike } from './query-like';

const ONE_M_SUFFIX = /\[1m\]$/i;

/**
 * Preserve the documented `[1m]` context-window suffix when switching to the
 * 1M Kimi K3 model. `getModelInfo` returns the canonical model ID, which may be
 * unsuffixed; appending the suffix ensures `buildSdkConfig` routes the session
 * to the intended 1M upstream model. Only the 1M K3 flagship qualifies — the
 * 256K-capped `k3-256k` must never carry the `[1m]` suffix.
 */
function preserveK3OneMSuffix(requestedModel: string, resolvedModel: string): string {
  if (
    ONE_M_SUFFIX.test(requestedModel.trim()) &&
    !ONE_M_SUFFIX.test(resolvedModel) &&
    KimiProvider.isKimiK3OneMModel(resolvedModel)
  ) {
    return `${resolvedModel}[1m]`;
  }
  return resolvedModel;
}

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

    const previousModel = session.config.model;
    // The literal stored provider — this is what the rollback restores. Kept
    // separate from previousProvider so a guard inference is never persisted.
    const originalProvider = session.config.provider;
    // Infer the provider from the stored model when the session config has none.
    // Long-horizon/worker agent sessions created before provider inference was added
    // may have a model but a blank provider; without this they are hard-blocked from
    // ever switching models. Downstream usages (alias resolution, acp handling) only
    // become more correct with the inferred value. The inference is used ONLY for
    // the guard and read-only checks — the catch block restores originalProvider,
    // since persisting a contested inference (e.g. the anthropic catch-all for a
    // Copilot model) would permanently reroute the session on a failed switch.
    const previousProvider =
      originalProvider ?? (previousModel ? inferProviderForModel(previousModel) : undefined);
    const previousAcpSessionId = session.acpSessionId;
    const previousSdkSessionId = session.sdkSessionId;
    const previousSdkOriginPath = session.sdkOriginPath;

    try {
      if (!previousProvider) {
        throw new Error('Session has no provider configured');
      }

      // Validate the new model against the new provider
      const sessionApiKey =
        newProvider === session.config.provider ? session.config.providerConfig?.apiKey : undefined;
      const isValid = await isValidModel(newModel, 'global', newProvider, sessionApiKey);
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
      const resolvedModel = preserveK3OneMSuffix(newModel, modelInfo?.id ?? newModel);

      // Resolve the current model in case it's also an alias.
      // Use session.config.provider (the current provider) for the current model.
      const currentResolvedModel = preserveK3OneMSuffix(
        session.config.model,
        await resolveModelAlias(session.config.model, 'global', previousProvider)
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

      const nextProvider = newProviderInstance.id as Provider;
      const clearAcpSessionId = previousProvider === 'acp' && nextProvider !== 'acp';
      const clearSdkSessionState = previousProvider !== 'acp' && nextProvider === 'acp';

      if (!this.isQueryActiveOrStarting()) {
        // Query hasn't been created yet OR query was already completed/interrupted.
        // Persist the new model/provider only. The next user message will start a
        // fresh SDK query with this config; starting an empty query here creates a
        // race where the first real message can be accepted before the agent turn
        // is ready to consume it.
        session.config.model = resolvedModel;
        // newProviderInstance is guaranteed non-null here (we returned early above).
        session.config.provider = nextProvider;
        if (clearAcpSessionId) {
          session.acpSessionId = undefined;
        }
        if (clearSdkSessionState) {
          session.sdkSessionId = undefined;
          session.sdkOriginPath = undefined;
        }
        // Only pass serializable fields — session.config may contain runtime-only
        // objects (mcpServers with closures, agents, spawnClaudeCodeProcess) that
        // cannot be JSON-stringified and would cause a cyclic structure error.
        db.updateSession(session.id, {
          config: {
            model: resolvedModel,
            provider: nextProvider,
          } as SessionConfig,
          ...(clearAcpSessionId ? { acpSessionId: undefined } : {}),
          ...(clearSdkSessionState ? { sdkSessionId: undefined, sdkOriginPath: undefined } : {}),
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
        session.config.provider = nextProvider;
        if (clearAcpSessionId) {
          session.acpSessionId = undefined;
        }
        if (clearSdkSessionState) {
          session.sdkSessionId = undefined;
          session.sdkOriginPath = undefined;
        }
        // Only pass serializable fields — session.config may contain runtime-only
        // objects (mcpServers with closures, agents, spawnClaudeCodeProcess) that
        // cannot be JSON-stringified and would cause a cyclic structure error.
        db.updateSession(session.id, {
          config: {
            model: resolvedModel,
            provider: nextProvider,
          } as SessionConfig,
          ...(clearAcpSessionId ? { acpSessionId: undefined } : {}),
          ...(clearSdkSessionState ? { sdkSessionId: undefined, sdkOriginPath: undefined } : {}),
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

        if (this.ctx.queryObject instanceof AcpQueryAdapter && nextProvider === 'acp') {
          await this.ctx.queryObject.setModel(resolvedModel);
        } else {
          // Restart the query via lifecycle manager
          // This spawns a new SDK subprocess with the new model configuration
          await lifecycleManager.restart();
        }
      }

      const selectedModel = session.config.model;
      contextTracker.setModel(selectedModel);

      // Emit success event
      messageHub.event(
        'session.model-switched',
        {
          from: previousModel,
          to: selectedModel,
          modelInfo: selectedModel === resolvedModel ? modelInfo || null : null,
        },
        { channel: `session:${session.id}` }
      );

      return {
        success: true,
        model: selectedModel,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Model switch failed:`, error);

      session.config.model = previousModel;
      session.config.provider = originalProvider;
      session.acpSessionId = previousAcpSessionId;
      session.sdkSessionId = previousSdkSessionId;
      session.sdkOriginPath = previousSdkOriginPath;
      db.updateSession(session.id, {
        config: {
          model: previousModel,
          provider: originalProvider,
        } as SessionConfig,
        acpSessionId: previousAcpSessionId,
        sdkSessionId: previousSdkSessionId,
        sdkOriginPath: previousSdkOriginPath,
      });
      contextTracker.setModel(previousModel);
      await internalEventBus.publish('session.updated', {
        sessionId: session.id,
        source: 'model-switch-rollback',
        session: { config: session.config },
      });

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
