import type {
  Provider,
  Session,
  SessionConfig,
  CurrentModelInfo,
  MessageHub,
} from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { Database } from '../../storage/database.ts';
import type { ErrorManager } from '../error-manager.ts';
import { ErrorCategory } from '../error-manager.ts';
import type { Logger } from '../logger.ts';
import { isValidModel, resolveModelAlias, getModelInfo } from '../model-service.ts';
import { getProviderRegistry } from '../providers/factory.js';
import { inferProviderForModel } from '../providers/registry.ts';
import { KimiProvider } from '../providers/kimi-provider.js';
import { stripThinkingBlocksFromSessionFile } from '../sdk-session-file-manager.ts';
import type { ContextTracker } from './context-tracker.ts';
import type { MessageQueue } from './message-queue.ts';
import type { ProcessingStateManager } from './processing-state-manager.ts';
import type { QueryLifecycleManager } from './query-lifecycle-manager.ts';
import { AcpQueryAdapter } from '../acp/acp-query-adapter.ts';
import { disposeAcpSessions } from '../acp/acp-model-fetcher.ts';
import { AcpProvider } from '../providers/acp-provider.ts';
import type { QueryLike } from './query-like.ts';

const ONE_M_SUFFIX = /\[1m\]$/i;
const ACP_SWITCH_DISPOSE_TIMEOUT_MS = 8_000;

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

  readonly queryObject: QueryLike | null;
  readonly queryPromise: Promise<void> | null;
  readonly messageQueue: MessageQueue;
  readonly disposeAcpSessions?: typeof disposeAcpSessions;
  reevaluateContextBudgetAfterModelSwitch?(): Promise<void>;
}

export interface ModelSwitchResult {
  success: boolean;
  model: string;
  error?: string;
}

export class ModelSwitchHandler {
  constructor(private ctx: ModelSwitchHandlerContext) {}

  private getSDKWorkspacePath(): string {
    const { session } = this.ctx;
    return session.worktree
      ? session.worktree.worktreePath
      : (session.workspacePath ?? process.cwd());
  }

  private stripThinkingBlocksIfNeeded(previousProvider: string, newProvider: string): void {
    const { session, logger } = this.ctx;

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

  getCurrentModel(): CurrentModelInfo {
    return {
      id: this.ctx.session.config.model,
      info: null,
    };
  }

  private isQueryActiveOrStarting(): boolean {
    return Boolean(
      this.ctx.queryObject || this.ctx.queryPromise || this.ctx.messageQueue.isRunning()
    );
  }

  private async disposePreviousAcpSession(
    previousAcpSessionId: string,
    stashedCommand: string | undefined
  ): Promise<void> {
    const acpProvider = getProviderRegistry().get('acp');
    const currentCommand =
      acpProvider instanceof AcpProvider
        ? acpProvider.getAcpCommand()
        : process.env.HYPERNEO_ACP_COMMAND;
    const previousCommand = stashedCommand ?? currentCommand;
    if (!previousCommand) return;
    const dispose = this.ctx.disposeAcpSessions ?? disposeAcpSessions;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ACP_SWITCH_DISPOSE_TIMEOUT_MS);
    timer.unref();
    try {
      await dispose(previousCommand, [previousAcpSessionId], undefined, controller.signal).catch(
        (error) => {
          this.ctx.logger.warn(
            `Failed to dispose previous ACP session ${previousAcpSessionId}:`,
            error
          );
        }
      );
    } finally {
      clearTimeout(timer);
    }
  }

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
    const originalProvider = session.config.provider;
    const previousProvider =
      originalProvider ?? (previousModel ? inferProviderForModel(previousModel) : undefined);
    const previousAcpSessionId = session.acpSessionId;
    const previousSdkSessionId = session.sdkSessionId;
    const previousSdkOriginPath = session.sdkOriginPath;
    const previousMetadata = session.metadata;

    try {
      if (!previousProvider) {
        throw new Error('Session has no provider configured');
      }

      const sessionApiKey =
        newProvider === session.config.provider ? session.config.providerConfig?.apiKey : undefined;
      const isValid = await isValidModel(newModel, 'global', newProvider, sessionApiKey);
      if (!isValid) {
        const error = `Invalid model: ${newModel}. Use a valid model ID or alias.`;
        logger.error(`${error}`);
        return { success: false, model: session.config.model, error };
      }

      const modelInfo = await getModelInfo(newModel, 'global', newProvider);
      const resolvedModel = preserveK3OneMSuffix(newModel, modelInfo?.id ?? newModel);

      const currentResolvedModel = preserveK3OneMSuffix(
        session.config.model,
        await resolveModelAlias(session.config.model, 'global', previousProvider)
      );

      if (currentResolvedModel === resolvedModel && session.config.provider === newProvider) {
        return {
          success: true,
          model: resolvedModel,
          error: `Already using ${modelInfo?.name || resolvedModel}`,
        };
      }

      messageHub.event(
        'session.model-switching',
        {
          from: previousModel,
          to: resolvedModel,
        },
        { channel: `session:${session.id}` }
      );

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
        session.config.model = resolvedModel;
        session.config.provider = nextProvider;
        if (clearAcpSessionId) {
          session.acpSessionId = undefined;
          session.metadata = {
            ...session.metadata,
            acpContextUsageEstimate: undefined,
            acpSessionCommand: undefined,
          };
        }
        if (clearSdkSessionState) {
          session.sdkSessionId = undefined;
          session.sdkOriginPath = undefined;
        }
        db.updateSession(session.id, {
          config: {
            model: resolvedModel,
            provider: nextProvider,
          } as SessionConfig,
          ...(clearAcpSessionId ? { acpSessionId: undefined, metadata: session.metadata } : {}),
          ...(clearSdkSessionState ? { sdkSessionId: undefined, sdkOriginPath: undefined } : {}),
        });

        contextTracker.setModel(resolvedModel);

        await internalEventBus.publish('session.updated', {
          sessionId: session.id,
          source: 'model-switch',
          session: { config: session.config },
        });

        this.stripThinkingBlocksIfNeeded(previousProvider, newProviderInstance.id);

        await this.ctx.reevaluateContextBudgetAfterModelSwitch?.();

        if (clearAcpSessionId && previousAcpSessionId) {
          await this.disposePreviousAcpSession(
            previousAcpSessionId,
            previousMetadata?.acpSessionCommand
          );
        }
      } else {
        session.config.model = resolvedModel;
        session.config.provider = nextProvider;
        if (clearAcpSessionId) {
          session.acpSessionId = undefined;
          session.metadata = {
            ...session.metadata,
            acpContextUsageEstimate: undefined,
            acpSessionCommand: undefined,
          };
        }
        if (clearSdkSessionState) {
          session.sdkSessionId = undefined;
          session.sdkOriginPath = undefined;
        }
        db.updateSession(session.id, {
          config: {
            model: resolvedModel,
            provider: nextProvider,
          } as SessionConfig,
          ...(clearAcpSessionId ? { acpSessionId: undefined, metadata: session.metadata } : {}),
          ...(clearSdkSessionState ? { sdkSessionId: undefined, sdkOriginPath: undefined } : {}),
        });

        contextTracker.setModel(resolvedModel);

        await internalEventBus.publish('session.updated', {
          sessionId: session.id,
          source: 'model-switch',
          session: { config: session.config },
        });

        this.stripThinkingBlocksIfNeeded(previousProvider, newProviderInstance.id);

        if (this.ctx.queryObject instanceof AcpQueryAdapter && nextProvider === 'acp') {
          await this.ctx.queryObject.setModel(resolvedModel);
          await this.ctx.reevaluateContextBudgetAfterModelSwitch?.();
        } else {
          await lifecycleManager.restart({
            beforeStart: () => this.ctx.reevaluateContextBudgetAfterModelSwitch?.(),
          });
          if (clearAcpSessionId && previousAcpSessionId) {
            await this.disposePreviousAcpSession(
              previousAcpSessionId,
              previousMetadata?.acpSessionCommand
            );
          }
        }
      }

      const selectedModel = session.config.model;
      contextTracker.setModel(selectedModel);

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
      session.metadata = previousMetadata;
      db.updateSession(session.id, {
        config: {
          model: previousModel,
          provider: originalProvider,
        } as SessionConfig,
        acpSessionId: previousAcpSessionId,
        sdkSessionId: previousSdkSessionId,
        sdkOriginPath: previousSdkOriginPath,
        metadata: previousMetadata,
      });
      contextTracker.setModel(previousModel);
      await this.ctx.reevaluateContextBudgetAfterModelSwitch?.();
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
