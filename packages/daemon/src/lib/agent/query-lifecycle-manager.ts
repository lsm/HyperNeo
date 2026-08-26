import type { MessageContent, Session, MessageHub, HyperNeoActionMessage } from '@hyperneo/shared';
import type { QueryLike } from './query-like.ts';
import { generateUUID } from '@hyperneo/shared';
import type { MessageQueue } from './message-queue.ts';
import type { ProcessingStateManager } from './processing-state-manager.ts';
import type { SDKMessageHandler } from './sdk-message-handler.ts';
import type { InterruptHandler } from './interrupt-handler.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { Database } from '../../storage/database.ts';
import type { ErrorManager } from '../error-manager.ts';
import { ErrorCategory } from '../error-manager.ts';
import { Logger } from '../logger.ts';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { throwIfDeliveryAborted, waitForDeliveryAbort } from './message-delivery.ts';
import type { IdleOwnerScope } from './processing-state-manager.ts';
import {
  createQueryRestartCtx,
  runQueryRestartPipeline,
  type QueryRestartHost,
} from './query-restart-pipeline.ts';
import {
  validateAndRepairSDKSession,
  findSDKSessionFileGlobally,
  migrateSDKSessionFile,
  getSDKSessionFilePath,
} from '../sdk-session-file-manager.ts';

export class IdleRestartSupersededError extends Error {
  constructor() {
    super('Deferred restart superseded: a successor delivery owns the session.');
    this.name = 'IdleRestartSupersededError';
  }
}

const DEFAULT_TERMINATION_TIMEOUT_MS = 5000;
const RESET_TERMINATION_TIMEOUT_MS = 3000;
const FORCE_PROCESS_KILL_DELAY_MS = 2000;
const MAX_TIMEOUT_DELIVERY_RETRIES = 1;

export type EnsureQueryStartedResult = 'started' | 'already-running' | 'blocked';

export interface QueryLifecycleManagerContext {
  readonly session: Session;
  readonly messageQueue: MessageQueue;
  readonly db: Database;
  readonly messageHub: MessageHub;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  readonly stateManager: ProcessingStateManager;
  readonly messageHandler: SDKMessageHandler;
  readonly interruptHandler: InterruptHandler;
  readonly errorManager: ErrorManager;

  queryObject: QueryLike | null;
  queryPromise: Promise<void> | null;
  firstMessageReceived: boolean;
  processExitedPromise: Promise<void> | null;
  resetProcessExitedPromise(): void;
  startupTimeoutTimer: ReturnType<typeof setTimeout> | null;
  queryAbortController: AbortController | null;
  terminateTrackedAgentProcesses(options?: {
    forceDelayMs?: number;
    processes?: Array<[number, import('./query-runner.ts').TrackedAgentProcess]>;
    noPidProcesses?: unknown[];
  }): void;
  snapshotTrackedAgentProcesses(): Array<[number, import('./query-runner.ts').TrackedAgentProcess]>;
  snapshotNoPidTrackedProcesses?(): unknown[];
  refreshProcessExitedPromise?(): void;

  pendingRestartReason: 'settings.local.json' | null;

  startStreamingQuery(): Promise<void>;

  resetTaskNotificationRequery?(): void;

  setCleaningUp(value: boolean): void;
  cleanupEventSubscriptions(): void;
  clearModelsCache(): Promise<void>;
  getQueryGeneration?(): number;
  retireRunnerTerminalFence?(generation: number): void;
  isRateLimitEpisodeSuperseded?(generation: number): boolean;
}

export class QueryLifecycleManager {
  private logger: Logger;
  private timeoutDeliveryRetryCounts = new Map<string, number>();
  private lastCeilingResetOwner: IdleOwnerScope | null = null;

  constructor(private ctx: QueryLifecycleManagerContext) {
    this.logger = new Logger(`QueryLifecycleManager ${ctx.session.id}`);
  }

  private clearAcpSessionStateForReset(): void {
    const { session, db } = this.ctx;
    if (session.config.provider !== 'acp') return;

    const updates: Partial<Session> = {};
    if (session.acpSessionId) {
      session.acpSessionId = undefined;
      updates.acpSessionId = undefined;
    }
    if (
      session.metadata?.acpInstructionsSent ||
      session.metadata?.acpContextUsageEstimate !== undefined
    ) {
      session.metadata = {
        ...session.metadata,
        acpInstructionsSent: undefined,
        acpContextUsageEstimate: undefined,
      };
      updates.metadata = session.metadata;
    }

    if (Object.keys(updates).length > 0) {
      db.updateSession(session.id, updates);
    }
  }

  private getSDKWorkspacePath(): string {
    const { session } = this.ctx;
    return session.worktree
      ? session.worktree.worktreePath
      : (session.workspacePath ?? process.cwd());
  }

  private ensureSDKSessionFileMigrated(): boolean {
    const { session, db } = this.ctx;
    if (!session.sdkSessionId) return false;

    const currentWorkspacePath = this.getSDKWorkspacePath();

    const currentFilePath = getSDKSessionFilePath(currentWorkspacePath, session.sdkSessionId);
    if (existsSync(currentFilePath)) {
      if (!session.sdkOriginPath) {
        session.sdkOriginPath = currentWorkspacePath;
        db.updateSession(session.id, { sdkOriginPath: currentWorkspacePath });
      }
      return true;
    }

    if (session.sdkOriginPath && session.sdkOriginPath !== currentWorkspacePath) {
      const migrated = migrateSDKSessionFile(
        session.sdkOriginPath,
        currentWorkspacePath,
        session.sdkSessionId
      );
      if (migrated) {
        this.logger.info(
          `SDK session file migrated from ${session.sdkOriginPath} → ${currentWorkspacePath} ` +
            `(sdkSessionId: ${session.sdkSessionId})`
        );
        session.sdkOriginPath = currentWorkspacePath;
        db.updateSession(session.id, { sdkOriginPath: currentWorkspacePath });
        return true;
      }
    }

    const foundFilePath = findSDKSessionFileGlobally(session.sdkSessionId);
    if (foundFilePath) {
      try {
        const targetDir = dirname(currentFilePath);
        mkdirSync(targetDir, { recursive: true });
        copyFileSync(foundFilePath, currentFilePath);
        this.logger.info(
          `SDK session file recovered via global scan: ${foundFilePath} → ${currentFilePath} ` +
            `(sdkSessionId: ${session.sdkSessionId})`
        );
        session.sdkOriginPath = currentWorkspacePath;
        db.updateSession(session.id, { sdkOriginPath: currentWorkspacePath });
        return true;
      } catch (err) {
        this.logger.warn(`Failed to copy SDK session file from global scan result: ${err}`);
      }
    }

    return false;
  }

  private validateAndRepairWithMigration(): boolean {
    const { session, db } = this.ctx;
    if (!session.sdkSessionId) return false;

    const fileFound = this.ensureSDKSessionFileMigrated();

    if (!fileFound) {
      this.logger.warn(
        `SDK session file not found anywhere for sdkSessionId=${session.sdkSessionId}. ` +
          'Will attempt resume anyway — the SDK may produce a "No conversation found" error ' +
          'and start fresh automatically.'
      );
      return false;
    }

    return validateAndRepairSDKSession(
      this.getSDKWorkspacePath(),
      session.sdkSessionId,
      session.id,
      db
    );
  }

  async stop(options?: { timeoutMs?: number; catchQueryErrors?: boolean }): Promise<void> {
    const { timeoutMs = DEFAULT_TERMINATION_TIMEOUT_MS, catchQueryErrors = false } = options ?? {};
    const { messageQueue } = this.ctx;
    const stopGeneration = this.ctx.getQueryGeneration?.();

    if (stopGeneration !== undefined) {
      this.ctx.retireRunnerTerminalFence?.(stopGeneration);
    }

    this.ctx.messageHandler.cancelSuppressedResultWait();
    this.ctx.messageHandler.retirePendingTerminalFence();

    const processExitedPromise = this.ctx.processExitedPromise;
    const trackedProcessSnapshot = this.ctx.snapshotTrackedAgentProcesses();
    const noPidProcessSnapshot = this.ctx.snapshotNoPidTrackedProcesses?.() ?? [];
    const queryAbortController = this.ctx.queryAbortController;
    const queryPromise = this.ctx.queryPromise;
    const queryObject = this.ctx.queryObject;
    const startupTimeoutTimer = this.ctx.startupTimeoutTimer;

    messageQueue.stop();
    queryAbortController?.abort();

    if (queryObject && typeof queryObject.interrupt === 'function') {
      if (this.ctx.firstMessageReceived) {
        try {
          await queryObject.interrupt();
        } catch {}
      }
    }

    if (queryPromise) {
      try {
        const promiseToAwait = catchQueryErrors ? queryPromise.catch(() => {}) : queryPromise;

        await Promise.race([
          promiseToAwait,
          new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      } catch {}
    }

    this.ctx.terminateTrackedAgentProcesses({
      forceDelayMs: FORCE_PROCESS_KILL_DELAY_MS,
      processes: trackedProcessSnapshot,
      noPidProcesses: noPidProcessSnapshot,
    });

    if (this.ctx.queryPromise === queryPromise) {
      const lateProcesses = this.ctx
        .snapshotTrackedAgentProcesses()
        .filter((process) => !trackedProcessSnapshot.some((entry) => entry[1] === process[1]));
      if (lateProcesses.length > 0) {
        this.ctx.terminateTrackedAgentProcesses({
          forceDelayMs: FORCE_PROCESS_KILL_DELAY_MS,
          processes: lateProcesses,
          noPidProcesses: [],
        });
      }
    }

    if (queryObject && this.ctx.queryObject === queryObject) {
      try {
        queryObject.close();
      } catch {}
    }

    if (processExitedPromise) {
      await Promise.race([
        processExitedPromise,
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
      if (this.ctx.processExitedPromise === processExitedPromise) {
        this.ctx.resetProcessExitedPromise();
      }
    }

    const staleTimer = this.ctx.startupTimeoutTimer;
    if (staleTimer && staleTimer === startupTimeoutTimer) {
      clearTimeout(staleTimer);
      this.ctx.startupTimeoutTimer = null;
    }
    const staleAbort = this.ctx.queryAbortController;
    if (
      staleAbort &&
      staleAbort !== queryAbortController &&
      this.ctx.queryPromise === queryPromise
    ) {
      staleAbort.abort();
    }
    if (this.ctx.queryPromise === queryPromise) {
      this.ctx.queryAbortController = null;
      this.ctx.queryPromise = null;
    }
    if (this.ctx.queryObject === queryObject) {
      this.ctx.queryObject = null;
    }

    this.ctx.messageHandler.retirePendingTerminalFence({ generation: stopGeneration });
    if (stopGeneration !== undefined) {
      this.ctx.retireRunnerTerminalFence?.(stopGeneration);
    }
  }

  async restart(options?: { idleOwner?: IdleOwnerScope }): Promise<void> {
    const idleOwner = options?.idleOwner;
    const ctx = createQueryRestartCtx(this.buildQueryRestartHost(idleOwner), idleOwner);
    try {
      await runQueryRestartPipeline(ctx);
    } catch (error) {
      if (!ctx.superseded && !this.ctx.stateManager.isIdleOwnerCurrent(idleOwner)) {
        ctx.superseded = true;
      }
      if (ctx.superseded) {
        throw new IdleRestartSupersededError();
      }
      if (ctx.reachedSuppressedIdle && this.ctx.stateManager.isIdleOwnerCurrent(idleOwner)) {
        this.ctx.stateManager.releaseIdleWaiters();
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Query restart failed: ${errorMessage}`);
    }
    if (ctx.superseded) {
      this.logger.info('Restart abandoned: a successor delivery owns the session.');
      throw new IdleRestartSupersededError();
    }
  }

  private buildQueryRestartHost(idleOwner?: IdleOwnerScope): QueryRestartHost {
    return {
      isIdleOwnerCurrent: () => this.ctx.stateManager.isIdleOwnerCurrent(idleOwner),
      resetTurnGuards: () => {
        this.ctx.messageHandler.resetCircuitBreaker();
        this.ctx.resetTaskNotificationRequery?.();
      },
      publishErrorClear: async () => {
        await this.ctx.internalEventBus.publish('session.errorClear', {
          sessionId: this.ctx.session.id,
        });
      },
      stopQuery: () => this.stop(),
      settleSuppressedIdle: (owner?: IdleOwnerScope) =>
        this.ctx.stateManager.setIdle({
          suppressDeliveryWaiters: true,
          owner,
        }),
      repairSessionFile: async () => {
        const { session } = this.ctx;
        if (session.config.provider !== 'acp' && session.sdkSessionId) {
          const isValid = this.validateAndRepairWithMigration();
          if (!isValid) {
            this.logger.warn(
              `SDK session file missing/invalid for ${session.sdkSessionId}. ` +
                'Emitting sdk_resume_choice for user, but starting query anyway.'
            );
            await this.emitSdkResumeChoiceMessage();
          }
        }
      },
      clearModelsCacheState: () => this.ctx.clearModelsCache(),
      startStreaming: async () => {
        await this.ctx.startStreamingQuery();
      },
    };
  }

  async reset(options?: { restartAfter?: boolean }): Promise<{ success: boolean; error?: string }> {
    const { restartAfter = true } = options ?? {};
    const {
      session,
      db,
      messageQueue,
      messageHub,
      internalEventBus,
      stateManager,
      messageHandler,
    } = this.ctx;

    this.ctx.messageHandler.cancelSuppressedResultWait();
    this.ctx.resetTaskNotificationRequery?.();

    if (!this.ctx.queryObject && !this.ctx.queryPromise) {
      messageQueue.clear();
      this.ctx.pendingRestartReason = null;
      messageHandler.resetCircuitBreaker();
      this.clearAcpSessionStateForReset();
      await stateManager.setIdle();
      await this.ctx.clearModelsCache();
      return { success: true };
    }

    let reachedSuppressedIdle = false;

    try {
      const lastSdkCost = session.metadata?.lastSdkCost || 0;
      const costBaseline = session.metadata?.costBaseline || 0;
      if (lastSdkCost > 0) {
        session.metadata = {
          ...session.metadata,
          costBaseline: costBaseline + lastSdkCost,
          lastSdkCost: 0,
        };
        db.updateSession(session.id, { metadata: session.metadata });
      }

      messageQueue.clear();
      this.ctx.pendingRestartReason = null;
      messageHandler.resetCircuitBreaker();
      this.clearAcpSessionStateForReset();
      await internalEventBus.publish('session.errorClear', { sessionId: session.id });

      await this.stop({
        timeoutMs: RESET_TERMINATION_TIMEOUT_MS,
        catchQueryErrors: true,
      });

      this.ctx.firstMessageReceived = false;
      await stateManager.setIdle({ suppressDeliveryWaiters: restartAfter });
      reachedSuppressedIdle = true;

      await this.ctx.clearModelsCache();

      if (restartAfter) {
        if (session.config.provider !== 'acp' && session.sdkSessionId) {
          const isValid = this.validateAndRepairWithMigration();
          if (!isValid) {
            this.logger.warn(
              `SDK session file missing/invalid for ${session.sdkSessionId}. ` +
                'Emitting sdk_resume_choice for user, but starting query anyway.'
            );
            await this.emitSdkResumeChoiceMessage();
          }
        }

        await this.ctx.startStreamingQuery();
      }

      messageHub.event(
        'session.reset',
        { message: 'Agent has been reset and is ready for new messages' },
        { channel: `session:${session.id}` }
      );

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Query reset failed:', error);
      if (restartAfter && reachedSuppressedIdle) {
        this.ctx.stateManager.releaseIdleWaiters();
      }
      return { success: false, error: errorMessage };
    }
  }

  private async emitSdkResumeChoiceMessage(): Promise<boolean> {
    const { session, db, messageHub } = this.ctx;

    const messageRepo = db.getSDKMessageRepo?.();
    if (messageRepo?.hasUnresolvedHyperNeoAction?.(session.id, 'sdk_resume_choice')) {
      return true;
    }

    const actionMessage: HyperNeoActionMessage = {
      type: 'hyperneo_action',
      uuid: generateUUID(),
      session_id: session.id,
      action: 'sdk_resume_choice',
      resolved: false,
      timestamp: Date.now(),
    };

    db.saveHyperNeoActionMessage(session.id, actionMessage);

    if (
      messageRepo?.hasUnresolvedHyperNeoAction &&
      !messageRepo.hasUnresolvedHyperNeoAction(session.id, 'sdk_resume_choice')
    ) {
      return false;
    }

    messageHub.event(
      'state.sdkMessages.delta',
      { added: [actionMessage], timestamp: Date.now() },
      { channel: `session:${session.id}` }
    );
    return true;
  }

  async ensureQueryStarted(signal?: AbortSignal): Promise<EnsureQueryStartedResult> {
    const { session, messageQueue, interruptHandler } = this.ctx;
    throwIfDeliveryAborted(signal);

    const interruptPromise = interruptHandler.getInterruptPromise();
    if (interruptPromise) {
      const aborted = waitForDeliveryAbort(signal);
      try {
        await Promise.race([
          interruptPromise.catch(() => {}),
          new Promise((r) => setTimeout(r, 5000)),
          aborted.promise,
        ]);
      } finally {
        aborted.cancel();
      }
    }

    if (messageQueue.isRunning()) {
      if (!this.ctx.queryPromise) {
        const stalePids = this.ctx
          .snapshotTrackedAgentProcesses()
          .map(([pid]) => pid)
          .join(',');
        this.logger.warn(
          `Stale running state detected for session ${session.id}: ` +
            `messageQueue.isRunning()=true but queryPromise=null ` +
            `(trackedPids=[${stalePids}] queueSize=${messageQueue.size()}). ` +
            'Force-stopping and restarting.'
        );
        messageQueue.stop();
        this.ctx.queryObject = null;

        const orphanedProcesses = this.ctx.snapshotTrackedAgentProcesses();
        const orphanedNoPidProcesses = this.ctx.snapshotNoPidTrackedProcesses?.() ?? [];
        this.ctx.terminateTrackedAgentProcesses({
          forceDelayMs: FORCE_PROCESS_KILL_DELAY_MS,
          processes: orphanedProcesses,
          noPidProcesses: orphanedNoPidProcesses,
        });
        this.ctx.refreshProcessExitedPromise?.();
        const orphanExit = this.ctx.processExitedPromise;
        if (orphanExit) {
          const aborted = waitForDeliveryAbort(signal);
          try {
            await Promise.race([
              orphanExit,
              new Promise((resolve) => setTimeout(resolve, DEFAULT_TERMINATION_TIMEOUT_MS)),
              aborted.promise,
            ]);
          } finally {
            aborted.cancel();
          }
          if (this.ctx.processExitedPromise === orphanExit) {
            this.ctx.resetProcessExitedPromise();
          }
        }
      } else {
        this.logger.debug(
          `ensureQueryStarted: session ${session.id} already running, skipping start`
        );
        return 'already-running';
      }
    } else {
      this.logger.debug(`ensureQueryStarted: session ${session.id} not running, starting query`);
    }

    throwIfDeliveryAborted(signal);

    if (session.config.provider !== 'acp' && session.sdkSessionId) {
      const isValid = this.validateAndRepairWithMigration();
      if (!isValid) {
        this.logger.warn(
          `SDK session file missing for sdkSessionId=${session.sdkSessionId}. ` +
            'Emitting sdk_resume_choice action message for user.'
        );
        const recoveryPromptAvailable = await this.emitSdkResumeChoiceMessage();
        if (!recoveryPromptAvailable) {
          throw new Error(
            `Unable to start session: SDK transcript ${session.sdkSessionId} is missing ` +
              'and the recovery prompt could not be persisted.'
          );
        }
        return 'blocked';
      }
    }

    await this.ctx.clearModelsCache();
    throwIfDeliveryAborted(signal);

    await this.ctx.startStreamingQuery();
    throwIfDeliveryAborted(signal);
    return 'started';
  }

  async startQueryAndEnqueue(
    messageId: string,
    messageContent: string | MessageContent[],
    episodeGeneration?: number,
    options?: { prepend?: boolean; queryGeneration?: number }
  ): Promise<'started' | 'aborted'> {
    const { session, messageQueue, stateManager, internalEventBus } = this.ctx;

    if (options?.prepend) {
      await stateManager.setQueued(messageId);
      if (
        options.queryGeneration !== undefined &&
        this.ctx.getQueryGeneration?.() !== options.queryGeneration
      ) {
        this.logger.info(
          `startQueryAndEnqueue: aborted prepend re-enqueue of ${messageId} (the originating query was superseded).`
        );
        return 'aborted';
      }
      void messageQueue
        .enqueueWithId(messageId, messageContent, false, { prepend: true })
        .catch((error) => this.handleQueuedMessageFailure(messageId, messageContent, error))
        .catch((handlerError) => {
          this.logger.warn('Failed to handle queued message delivery error', handlerError);
        });
    }

    let queryStartResult: EnsureQueryStartedResult;
    try {
      queryStartResult = await this.ensureQueryStarted();
    } catch (error) {
      if (options?.prepend) {
        messageQueue.remove(messageId);
      }
      throw error;
    }
    if (
      episodeGeneration !== undefined &&
      this.ctx.isRateLimitEpisodeSuperseded?.(episodeGeneration)
    ) {
      this.logger.info(
        `startQueryAndEnqueue: aborting retry of ${messageId} ` +
          `(rate-limit episode superseded during query startup).`
      );
      if (messageQueue.remove(messageId)) {
        this.logger.info(
          `startQueryAndEnqueue: removed superseded retry message ${messageId} from the queue.`
        );
      }
      return 'aborted';
    }
    if (queryStartResult === 'blocked') {
      if (options?.prepend) {
        messageQueue.remove(messageId);
        throw new Error(
          `Rate limit retry of ${messageId} is blocked on sdk_resume_choice; ` +
            `not reporting the recovery query as started.`
        );
      }
      await stateManager.setQueued(messageId);
      this.logger.debug(
        `startQueryAndEnqueue: session ${session.id} is blocked on sdk_resume_choice; ` +
          `leaving message ${messageId} persisted as enqueued for replay after the choice.`
      );
      return 'aborted';
    }
    if (!messageQueue.isRunning() || !this.ctx.queryPromise) {
      throw new Error('Agent query did not start; message remains queued for retry.');
    }

    if (options?.prepend) {
      if (
        options.queryGeneration !== undefined &&
        queryStartResult !== 'started' &&
        this.ctx.getQueryGeneration?.() !== options.queryGeneration
      ) {
        messageQueue.remove(messageId);
        this.logger.info(
          `startQueryAndEnqueue: aborted prepend re-enqueue of ${messageId} (the originating query was superseded).`
        );
        return 'aborted';
      }
      internalEventBus.publish('message.sent', { sessionId: session.id }).catch((error) => {
        this.logger.warn('Failed to emit message.sent event', error);
      });
      return 'started';
    }

    await stateManager.setQueued(messageId);

    if (
      options?.queryGeneration !== undefined &&
      queryStartResult !== 'started' &&
      this.ctx.getQueryGeneration?.() !== options.queryGeneration
    ) {
      messageQueue.remove(messageId);
      this.logger.info(
        `startQueryAndEnqueue: aborted re-enqueue of ${messageId} (the originating query was superseded).`
      );
      return 'aborted';
    }

    try {
      void messageQueue
        .enqueueWithId(messageId, messageContent)
        .catch((error) => this.handleQueuedMessageFailure(messageId, messageContent, error))
        .catch((handlerError) => {
          this.logger.warn('Failed to handle queued message delivery error', handlerError);
        });
    } catch (error) {
      await this.handleQueuedMessageFailure(messageId, messageContent, error);
      throw error;
    }

    internalEventBus.publish('message.sent', { sessionId: session.id }).catch((error) => {
      this.logger.warn('Failed to emit message.sent event', error);
    });
    return 'started';
  }

  private async handleQueuedMessageFailure(
    messageId: string,
    messageContent: string | MessageContent[],
    error: unknown
  ): Promise<void> {
    const { session, messageQueue, stateManager, errorManager } = this.ctx;

    if (error instanceof Error && error.message === 'Interrupted by user') {
      return;
    }

    const normalizedError = error instanceof Error ? error : new Error(String(error));
    const isTimeoutError = normalizedError.name === 'MessageQueueTimeoutError';
    await errorManager.handleError(
      session.id,
      normalizedError,
      isTimeoutError ? ErrorCategory.TIMEOUT : ErrorCategory.MESSAGE,
      isTimeoutError
        ? 'The SDK is not responding. Click "Reset Agent" to recover.'
        : 'Failed to process message. Please try again.',
      stateManager.getState(),
      { messageId }
    );

    if (!isTimeoutError) {
      this.timeoutDeliveryRetryCounts.delete(messageId);
      await stateManager.setIdle();
      return;
    }

    const retryCount = this.timeoutDeliveryRetryCounts.get(messageId) ?? 0;
    if (retryCount >= MAX_TIMEOUT_DELIVERY_RETRIES) {
      this.timeoutDeliveryRetryCounts.delete(messageId);
      await this.markEnqueuedMessageFailed(messageId);
      await stateManager.setIdle();
      this.logger.warn(
        `Message ${messageId} timed out after ${MAX_TIMEOUT_DELIVERY_RETRIES} delivery retry.`
      );
      return;
    }
    this.timeoutDeliveryRetryCounts.set(messageId, retryCount + 1);

    try {
      const resetResult = await this.reset({ restartAfter: true });
      if (!resetResult.success) {
        throw new Error(resetResult.error || 'Agent query reset failed.');
      }
      await stateManager.setQueued(messageId);
      if (!messageQueue.isRunning() || !this.ctx.queryPromise) {
        throw new Error('Agent query did not restart; message remains queued for retry.');
      }
      await messageQueue.enqueueWithId(messageId, messageContent);
      this.timeoutDeliveryRetryCounts.delete(messageId);
    } catch (retryError) {
      this.timeoutDeliveryRetryCounts.delete(messageId);
      await this.markEnqueuedMessageFailed(messageId);
      await stateManager.setIdle();
      this.logger.warn('Failed to recover queued message delivery', retryError);
    }
  }

  private async markEnqueuedMessageFailed(messageId: string): Promise<void> {
    const { session, db, internalEventBus } = this.ctx;
    const enqueuedMessage = db.getMessageByStatusAndUuid(session.id, 'enqueued', messageId);
    if (!enqueuedMessage) {
      return;
    }

    db.updateMessageStatus([enqueuedMessage.dbId], 'failed');
    try {
      await internalEventBus.publish('messages.statusChanged', {
        sessionId: session.id,
        messageIds: [enqueuedMessage.dbId],
        status: 'failed',
      });
    } catch (error) {
      this.logger.warn('Failed to emit failed message status update', error);
    }
  }

  async restartQuery(): Promise<void> {
    const { messageQueue, stateManager } = this.ctx;

    if (!messageQueue.isRunning() || !this.ctx.queryObject) {
      return;
    }

    const currentState = stateManager.getState();
    if (currentState.status === 'processing') {
      this.ctx.pendingRestartReason = 'settings.local.json';
      return;
    }

    try {
      await this.restart({ idleOwner: stateManager.getCurrentIdleOwner() });
    } catch (error) {
      if (error instanceof IdleRestartSupersededError) {
        this.ctx.pendingRestartReason = 'settings.local.json';
        this.scheduleDeferredRestartRetry();
        return;
      }
      throw error;
    }
  }

  private scheduleDeferredRestartRetry(): void {
    this.armDeferredRestartRetry(this.ctx.stateManager.getCurrentIdleOwner(), 0);
  }

  private armDeferredRestartRetry(successorOwner: IdleOwnerScope, rescheduleDepth: number): void {
    const waiter = this.ctx.stateManager.waitForIdleTransition(
      undefined,
      undefined,
      successorOwner
    );
    void waiter.promise.then(() => {
      if (!this.ctx.pendingRestartReason) return;
      void this.executeDeferredRestartIfPending(successorOwner, rescheduleDepth);
    });
    if (this.ctx.stateManager.hasSettledIdleOwner(successorOwner)) {
      waiter.cancel();
      if (this.ctx.pendingRestartReason) {
        void this.executeDeferredRestartIfPending(successorOwner, rescheduleDepth);
      }
    }
  }

  async executeDeferredRestartIfPending(
    idleOwner?: IdleOwnerScope,
    rescheduleDepth = 0
  ): Promise<boolean> {
    if (!this.ctx.pendingRestartReason) {
      return false;
    }

    const reason = this.ctx.pendingRestartReason;
    this.ctx.pendingRestartReason = null;

    try {
      await this.restart({ idleOwner });
      return true;
    } catch (error) {
      if (error instanceof IdleRestartSupersededError) {
        this.ctx.pendingRestartReason = reason;
        const nextOwner = this.ctx.stateManager.getCurrentIdleOwner();
        const lastReset = this.lastCeilingResetOwner;
        const ownerAlreadyReset =
          lastReset !== null &&
          lastReset.queryGeneration === nextOwner.queryGeneration &&
          lastReset.turnToken === nextOwner.turnToken;
        if (rescheduleDepth < 8) {
          this.armDeferredRestartRetry(nextOwner, rescheduleDepth + 1);
        } else if (!ownerAlreadyReset) {
          this.lastCeilingResetOwner = { ...nextOwner };
          this.armDeferredRestartRetry(nextOwner, 0);
        }
      }
      return false;
    }
  }

  async cleanup(): Promise<void> {
    this.ctx.setCleaningUp(true);

    this.ctx.cleanupEventSubscriptions();

    try {
      await this.ctx.clearModelsCache();
    } catch {}

    try {
      await this.stop({ timeoutMs: 15000, catchQueryErrors: true });
      await new Promise((r) => setTimeout(r, 1000));
    } catch {}
  }
}
