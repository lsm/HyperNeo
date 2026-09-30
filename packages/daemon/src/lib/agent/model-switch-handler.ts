import type {
  Provider,
  Session,
  SessionConfig,
  CurrentModelInfo,
  ThinkingLevel,
  MessageHub,
} from '@hyperneo/shared';
import type { SessionRuntimeSettingsSnapshot } from '../../storage/repositories/session-runtime-settings-write.ts';
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
import superpipe, { type PipelineAPI } from 'superpipe';
import { neoCoordinatorBinding, neoCoordinatorRuntimePath } from '../neo/session-policy.ts';

const ONE_M_SUFFIX = /\[1m\]$/i;
const ACP_SWITCH_DISPOSE_TIMEOUT_MS = 8_000;
type ModelPair = Pick<SessionConfig, 'model' | 'provider'>;

export function gateSwitchIdle(guarded: boolean, busy: boolean) {
  return guarded && busy ? { reason: 'session_busy' as const } : { value: true as const };
}

export function gateSwitchPair(guarded: boolean, expected: ModelPair, current: ModelPair) {
  return guarded && (expected.model !== current.model || expected.provider !== current.provider)
    ? { reason: 'session_settings_changed' as const }
    : { value: true as const };
}

export function gateSwitchTurn(guarded: boolean, expected?: number, current?: number) {
  return guarded && (expected === undefined || expected !== current)
    ? { reason: 'session_turn_changed' as const }
    : { value: true as const };
}

const admitNonInterruptingSwitch = (superpipe({})('non-interrupting-model-switch') as PipelineAPI)
  .input(['guarded', 'busy', 'expected', 'current', 'generation', 'currentGeneration'])
  .pipe(gateSwitchIdle, ['guarded', 'busy'], 'result:admission')
  .pipe(gateSwitchPair, ['guarded', 'expected', 'current'], 'result:admission')
  .pipe(gateSwitchTurn, ['guarded', 'generation', 'currentGeneration'], 'result:admission')
  .end('admission') as (
  guarded: boolean,
  busy: boolean,
  expected: ModelPair,
  current: ModelPair,
  generation?: number,
  currentGeneration?: number
) => true | 'session_busy' | 'session_settings_changed' | 'session_turn_changed';

export interface RuntimeSettingsCommit {
  readonly snapshot: SessionRuntimeSettingsSnapshot;
  readonly thinkingLevel?: ThinkingLevel;
  readonly isCurrentOwner?: () => boolean;
}

export function gateCommitOwner(owned: boolean) {
  return owned ? { value: true as const } : { reason: 'session_settings_changed' as const };
}

export function providerIdentityClears(
  previousProvider: string | undefined,
  nextProvider: string
): { clearAcpSession: boolean; clearSdkSession: boolean } {
  return {
    clearAcpSession: previousProvider === 'acp' && nextProvider !== 'acp',
    clearSdkSession: previousProvider !== 'acp' && nextProvider === 'acp',
  };
}

const PROCESSING_STATUSES = new Set([
  'idle',
  'queued',
  'processing',
  'waiting_for_input',
  'rate_limit_cooldown',
  'interrupted',
]);

export function snapshotPair(snapshot: SessionRuntimeSettingsSnapshot): ModelPair {
  const config = JSON.parse(snapshot.config) as { model?: unknown; provider?: unknown };
  if (typeof config.model !== 'string')
    throw new Error(`runtime settings commit: snapshot ${snapshot.id} has no model`);
  return { model: config.model, provider: config.provider as Provider };
}

export function snapshotProcessingStatus(snapshot: SessionRuntimeSettingsSnapshot): string | null {
  const corrupt = `runtime settings commit: corrupt processing state for ${snapshot.id}`;
  if (snapshot.processingState === null) return null;
  let status: unknown = null;
  try {
    status = (JSON.parse(snapshot.processingState) as { status?: unknown } | null)?.status;
  } catch {
    status = null;
  }
  if (typeof status !== 'string' || !PROCESSING_STATUSES.has(status)) throw new Error(corrupt);
  return status;
}

export function gateCommitTarget(
  snapshot: SessionRuntimeSettingsSnapshot,
  pair: ModelPair,
  sessionId: string,
  expected: ModelPair,
  current: ModelPair
) {
  return snapshot.id !== sessionId ||
    snapshot.status !== 'active' ||
    snapshot.archivedAt !== null ||
    pair.model !== expected.model ||
    pair.provider !== expected.provider ||
    pair.model !== current.model ||
    pair.provider !== current.provider
    ? { reason: 'session_settings_changed' as const }
    : { value: true as const };
}

export function gateCommitIdle(
  snapshotStatus: string | null,
  nativeStatus: string,
  queued: boolean,
  queryActive: boolean
) {
  return (snapshotStatus !== null && snapshotStatus !== 'idle') ||
    nativeStatus !== 'idle' ||
    queued ||
    queryActive
    ? { reason: 'session_busy' as const }
    : { value: true as const };
}

export function gateCommitTurn(generation?: number, currentGeneration?: number) {
  return gateSwitchTurn(true, generation, currentGeneration);
}

const admitRuntimeSettingsCommit = (superpipe({})('runtime-settings-commit') as PipelineAPI)
  .input([
    'owned',
    'snapshot',
    'capturedPair',
    'sessionId',
    'expected',
    'current',
    'snapshotStatus',
    'nativeStatus',
    'queued',
    'queryActive',
    'generation',
    'currentGeneration',
  ])
  .pipe(
    gateCommitTarget,
    ['snapshot', 'capturedPair', 'sessionId', 'expected', 'current'],
    'result:admission'
  )
  .pipe(
    gateCommitIdle,
    ['snapshotStatus', 'nativeStatus', 'queued', 'queryActive'],
    'result:admission'
  )
  .pipe(gateCommitTurn, ['generation', 'currentGeneration'], 'result:admission')
  .pipe(gateCommitOwner, ['owned'], 'result:admission')
  .end('admission') as (
  owned: boolean,
  snapshot: SessionRuntimeSettingsSnapshot,
  capturedPair: ModelPair,
  sessionId: string,
  expected: ModelPair,
  current: ModelPair,
  snapshotStatus: string | null,
  nativeStatus: string,
  queued: boolean,
  queryActive: boolean,
  generation?: number,
  currentGeneration?: number
) => true | 'session_busy' | 'session_settings_changed' | 'session_turn_changed';

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
  getQueryGeneration?(): number;
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
    const { session, db } = this.ctx;
    if (neoCoordinatorBinding(db, session.id)) return neoCoordinatorRuntimePath(session.id);
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

  async switchModel(
    newModel: string,
    newProvider: string,
    nonInterrupting = false,
    commit?: RuntimeSettingsCommit
  ): Promise<ModelSwitchResult> {
    if (commit && !nonInterrupting)
      throw new Error('runtime settings commit requires the non-interrupting opt-in');
    const {
      session,
      db,
      internalEventBus,
      contextTracker,
      stateManager,
      errorManager,
      logger,
      lifecycleManager,
    } = this.ctx;

    const previousModel = session.config.model;
    const originalProvider = session.config.provider;
    const originalPair = { model: previousModel, provider: originalProvider };
    const generation = this.ctx.getQueryGeneration?.();
    let appliedPair: ModelPair | null = null;
    let durableCommit = false;
    const previousProvider =
      originalProvider ?? (previousModel ? inferProviderForModel(previousModel) : undefined);
    const previousAcpSessionId = session.acpSessionId;
    const previousSdkSessionId = session.sdkSessionId;
    const previousSdkOriginPath = session.sdkOriginPath;
    const previousMetadata = session.metadata;
    const capturedPair = commit ? snapshotPair(commit.snapshot) : null;
    const capturedStatus = commit ? snapshotProcessingStatus(commit.snapshot) : null;
    if (commit && capturedPair) {
      const early = gateCommitTarget(
        commit.snapshot,
        capturedPair,
        session.id,
        originalPair,
        session.config
      );
      if ('reason' in early)
        return { success: false, model: session.config.model, error: early.reason };
    }

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

      if (
        !commit &&
        currentResolvedModel === resolvedModel &&
        session.config.provider === newProvider
      ) {
        return {
          success: true,
          model: resolvedModel,
          error: `Already using ${modelInfo?.name || resolvedModel}`,
        };
      }

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

      const admission = admitNonInterruptingSwitch(
        nonInterrupting,
        this.isQueryActiveOrStarting(),
        originalPair,
        session.config,
        generation,
        this.ctx.getQueryGeneration?.()
      );
      if (admission !== true)
        return { success: false, model: session.config.model, error: admission };
      const nextProvider = newProviderInstance.id as Provider;
      const { clearAcpSession: clearAcpSessionId, clearSdkSession: clearSdkSessionState } =
        providerIdentityClears(previousProvider, nextProvider);

      appliedPair = { model: resolvedModel, provider: nextProvider };
      if (commit) {
        const admitted = admitRuntimeSettingsCommit(
          commit.isCurrentOwner?.() ?? true,
          commit.snapshot,
          capturedPair as ModelPair,
          session.id,
          originalPair,
          session.config,
          capturedStatus,
          stateManager.getState().status,
          this.ctx.messageQueue.hasQueuedMessages(),
          this.isQueryActiveOrStarting(),
          generation,
          this.ctx.getQueryGeneration?.()
        );
        if (admitted !== true)
          return { success: false, model: session.config.model, error: admitted };
        durableCommit =
          this.ctx.db.casSessionRuntimeSettings(commit.snapshot, {
            model: resolvedModel,
            provider: nextProvider,
            thinkingLevel: commit.thinkingLevel,
            clearAcpSession: clearAcpSessionId,
            clearSdkSession: clearSdkSessionState,
          }) === 'won';
        if (!durableCommit)
          return { success: false, model: session.config.model, error: 'session_settings_changed' };
      }
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
        if (commit?.thinkingLevel !== undefined)
          session.config.thinkingLevel = commit.thinkingLevel;
        if (!commit) {
          db.updateSession(session.id, {
            config: {
              model: resolvedModel,
              provider: nextProvider,
            } as SessionConfig,
            ...(clearAcpSessionId ? { acpSessionId: undefined, metadata: session.metadata } : {}),
            ...(clearSdkSessionState ? { sdkSessionId: undefined, sdkOriginPath: undefined } : {}),
          });
        }

        contextTracker.setModel(resolvedModel);

        if (nonInterrupting)
          this.stripThinkingBlocksIfNeeded(previousProvider, newProviderInstance.id);
        const reevaluation = this.ctx.reevaluateContextBudgetAfterModelSwitch?.();
        await internalEventBus.publish('session.updated', {
          sessionId: session.id,
          source: 'model-switch',
          session: { config: session.config },
        });

        if (!nonInterrupting)
          this.stripThinkingBlocksIfNeeded(previousProvider, newProviderInstance.id);

        if (reevaluation) {
          try {
            await reevaluation;
          } catch (error) {
            logger.warn(`post-switch context budget evaluation failed for ${session.id}:`, error);
          }
        }

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

      return {
        success: true,
        model: selectedModel,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Model switch failed:`, error);

      if (commit) {
        if (!durableCommit)
          return { success: false, model: session.config.model, error: errorMessage };
        logger.warn(`post-commit runtime settings side effect failed for ${session.id}:`, error);
        return { success: true, model: session.config.model, error: errorMessage };
      }

      if (
        nonInterrupting &&
        (!appliedPair ||
          admitNonInterruptingSwitch(
            true,
            this.isQueryActiveOrStarting(),
            appliedPair,
            session.config,
            generation,
            this.ctx.getQueryGeneration?.()
          ) !== true)
      )
        return { success: false, model: session.config.model, error: errorMessage };

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
