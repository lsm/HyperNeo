import type { AgentProcessingState, PendingUserQuestion } from '@hyperneo/shared';
import type { SDKAssistantMessage, SDKMessage } from '@hyperneo/shared/sdk';
import { isToolUseBlock } from '@hyperneo/shared/sdk/type-guards';
import type { Database } from '../../storage/database.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { Logger } from '../logger.ts';
import { type IdleOwnerScope, isIdleWaiterAdmitted } from './idle-waiter-admission-pipeline.ts';
import { deliveryMetrics } from './message-delivery-metrics.ts';

type StreamingPhase = 'initializing' | 'thinking' | 'streaming' | 'finalizing';

export class ProcessingStateManager {
  private processingState: AgentProcessingState = { status: 'idle' };
  private streamingPhase: StreamingPhase = 'initializing';
  private streamingStartedAt: number | null = null;
  private processingStartedAt: number | null = null;
  private isCompacting = false;
  private logger: Logger;
  private onIdleCallback?: (owner?: IdleOwnerScope) => Promise<void>;
  private idleWaiters: Map<
    number,
    {
      resolve: () => void;
      gen?: number;
      owner?: IdleOwnerScope;
      fireEnd: () => void;
      resolveOnce: () => void;
      endOnce: () => void;
    }
  > = new Map();
  private nextIdleWaiterId = 0;
  private idleCallbackInFlight = false;
  private terminalIdleTransitions = 0;
  private pendingTerminalIdleArms = new Map<number, number>();
  private queryOwnerGeneration = 0;
  private turnOwnerToken = 0;

  constructor(
    private sessionId: string,
    private internalEventBus: InternalEventBus<DaemonInternalEventMap>,
    private db: Database
  ) {
    this.logger = new Logger(`ProcessingStateManager ${sessionId}`);
  }

  setOnIdleCallback(callback: (owner?: IdleOwnerScope) => Promise<void>): void {
    this.onIdleCallback = callback;
  }

  noteQueryOwnerGeneration(queryGeneration: number): void {
    this.queryOwnerGeneration = queryGeneration;
  }

  admitDeliveryTurn(): IdleOwnerScope {
    this.turnOwnerToken += 1;
    return this.getCurrentIdleOwner();
  }

  idleOwnerForQuery(queryGeneration: number): IdleOwnerScope {
    return { queryGeneration, turnToken: this.turnOwnerToken };
  }

  getCurrentIdleOwner(): IdleOwnerScope {
    return { queryGeneration: this.queryOwnerGeneration, turnToken: this.turnOwnerToken };
  }

  isIdleOwnerCurrent(owner?: IdleOwnerScope): boolean {
    if (!owner) return true;
    const current = this.getCurrentIdleOwner();
    return (
      current.queryGeneration === owner.queryGeneration && current.turnToken === owner.turnToken
    );
  }

  private admittedIdleWaiters(transitionOwner?: IdleOwnerScope) {
    const currentOwner = this.getCurrentIdleOwner();
    return [...this.idleWaiters.values()].filter((w) =>
      isIdleWaiterAdmitted({
        waiterOwner: w.owner,
        transitionOwner,
        currentOwner,
      })
    );
  }

  private takePendingTerminalArm(generation?: number): boolean {
    const keys =
      generation !== undefined ? [generation] : [-1, ...[...this.pendingTerminalIdleArms.keys()]];
    for (const key of keys) {
      const count = this.pendingTerminalIdleArms.get(key) ?? 0;
      if (count <= 0) continue;
      if (count <= 1) this.pendingTerminalIdleArms.delete(key);
      else this.pendingTerminalIdleArms.set(key, count - 1);
      return true;
    }
    return false;
  }

  private pendingTerminalArmTotal(): number {
    let total = 0;
    for (const count of this.pendingTerminalIdleArms.values()) total += count;
    return total;
  }

  waitForIdleTransition(
    episodeGen?: number,
    onEnd?: () => void,
    owner?: IdleOwnerScope
  ): { promise: Promise<void>; cancel: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const id = this.nextIdleWaiterId++;
    let onEndFired = false;
    let resolved = false;
    const fireEnd = (): void => {
      if (onEndFired) return;
      onEndFired = true;
      onEnd?.();
    };
    const resolveOnce = (): void => {
      if (resolved) return;
      resolved = true;
      this.idleWaiters.delete(id);
      resolve();
    };
    const endOnce = (): void => {
      fireEnd();
      resolveOnce();
    };
    this.idleWaiters.set(id, { resolve, gen: episodeGen, owner, fireEnd, resolveOnce, endOnce });
    return {
      promise,
      cancel: () => {
        resolveOnce();
      },
    };
  }

  releaseIdleWaiters(episodeGen?: number, owner?: IdleOwnerScope): void {
    const admitted = new Set(this.admittedIdleWaiters(owner));
    const matching = [...this.idleWaiters.entries()].filter(
      ([, w]) => (episodeGen === undefined || w.gen === episodeGen) && admitted.has(w)
    );
    for (const [, w] of matching) w.endOnce();
  }

  beginTerminalIdle(owner?: IdleOwnerScope): void {
    this.terminalIdleTransitions += 1;
    const generation = owner?.queryGeneration ?? -1;
    this.pendingTerminalIdleArms.set(
      generation,
      (this.pendingTerminalIdleArms.get(generation) ?? 0) + 1
    );
    for (const waiter of this.admittedIdleWaiters(owner)) waiter.fireEnd();
  }

  cancelTerminalIdleArm(owner?: IdleOwnerScope): void {
    if (!owner) return;
    if (!this.takePendingTerminalArm(owner.queryGeneration)) return;
    this.terminalIdleTransitions -= 1;
  }

  restoreFromDatabase(): void {
    const session = this.db.getSession(this.sessionId);
    if (!session?.processingState) {
      return;
    }

    try {
      const restoredState = JSON.parse(session.processingState) as AgentProcessingState;

      if (restoredState.status === 'processing' || restoredState.status === 'queued') {
        this.processingState = { status: 'idle' };
      } else if (restoredState.status === 'rate_limit_cooldown') {
        this.processingState = { status: 'idle' };
      } else if (restoredState.status === 'waiting_for_input') {
        this.processingState = restoredState;
      } else {
        this.processingState = restoredState;
      }
    } catch (error) {
      this.logger.error('Failed to parse persisted processing state:', error);
      this.processingState = { status: 'idle' };
    }
  }

  private persistToDatabase(): void {
    try {
      const serialized = JSON.stringify(this.processingState);
      this.db.updateSession(this.sessionId, {
        processingState: serialized,
      });
    } catch (error) {
      this.logger.error('Failed to persist processing state to database:', error);
    }
  }

  getState(): AgentProcessingState {
    return this.processingState;
  }

  isProcessing(): boolean {
    return this.processingState.status === 'processing';
  }

  isIdle(): boolean {
    return this.processingState.status === 'idle';
  }

  isTerminalIdleInFlight(): boolean {
    return this.terminalIdleTransitions > 0;
  }

  isTerminalIdlePending(): boolean {
    return this.pendingTerminalArmTotal() > 0;
  }

  async setIdle(opts?: {
    suppressDeliveryWaiters?: boolean;
    suppressIdlePublish?: boolean;
    suppressIdleCallback?: boolean;
    owner?: IdleOwnerScope;
  }): Promise<void> {
    const transitionOwner = opts?.owner ?? this.getCurrentIdleOwner();
    const suppressDrain = opts?.suppressDeliveryWaiters || this.idleCallbackInFlight;
    const consumesTerminalFence = this.takePendingTerminalArm(opts?.owner?.queryGeneration);
    const ownsTerminalTransition = !suppressDrain || consumesTerminalFence;
    if (!consumesTerminalFence && !suppressDrain) {
      this.terminalIdleTransitions += 1;
    }
    if (!suppressDrain) {
      for (const w of this.admittedIdleWaiters(opts?.owner)) w.fireEnd();
    }
    try {
      if (this.isIdleOwnerCurrent(transitionOwner)) {
        await this.setState({ status: 'idle' }, opts?.suppressIdlePublish);
      }
      if (
        this.onIdleCallback &&
        !opts?.suppressIdleCallback &&
        !this.idleCallbackInFlight &&
        this.isIdleOwnerCurrent(transitionOwner)
      ) {
        this.idleCallbackInFlight = true;
        try {
          await this.onIdleCallback(transitionOwner);
        } catch (error) {
          this.logger.error('Error in onIdle callback:', error);
        } finally {
          this.idleCallbackInFlight = false;
        }
      }
    } finally {
      if (!suppressDrain) {
        const waiters = this.admittedIdleWaiters(opts?.owner);
        for (const w of waiters) w.endOnce();
      }
      if (ownsTerminalTransition) {
        this.terminalIdleTransitions -= 1;
      }
    }
  }

  async setQueued(messageId: string): Promise<void> {
    await this.setState({ status: 'queued', messageId });
  }

  async setQueuedIfIdle(messageId: string): Promise<boolean> {
    if (this.processingState.status !== 'idle') return false;
    await this.setQueued(messageId);
    return true;
  }

  async clearQueuedIfOwnedBy(messageId: string): Promise<boolean> {
    const current = this.processingState;
    if (current.status !== 'queued' || current.messageId !== messageId) {
      return false;
    }
    await this.setIdle();
    return true;
  }

  async setProcessing(messageId: string, phase: StreamingPhase = 'initializing'): Promise<void> {
    if (this.processingState.status === 'processing') {
      this.noteInitializationProgress(phase);
    }
    this.streamingPhase = phase;
    this.processingStartedAt = Date.now();
    if (phase === 'streaming' && !this.streamingStartedAt) {
      this.streamingStartedAt = Date.now();
    }

    await this.setState({
      status: 'processing',
      messageId,
      phase: this.streamingPhase,
      streamingStartedAt: this.streamingStartedAt ?? undefined,
      isCompacting: this.isCompacting,
    });
  }

  async setInterrupted(): Promise<void> {
    await this.setState({ status: 'interrupted' });
  }

  async setWaitingForInput(pendingQuestion: PendingUserQuestion): Promise<void> {
    await this.setState({ status: 'waiting_for_input', pendingQuestion });
  }

  async setRateLimitCooldown(
    state: {
      retryCount: number;
      maxRetries: number;
      retryAt: number;
    },
    ownerGeneration?: number
  ): Promise<void> {
    if (ownerGeneration !== undefined && this.queryOwnerGeneration !== ownerGeneration) {
      return;
    }
    const previousState = this.processingState;
    const cooldownState: AgentProcessingState = {
      status: 'rate_limit_cooldown',
      retryCount: state.retryCount,
      maxRetries: state.maxRetries,
      retryAt: state.retryAt,
    };
    let writeError: unknown;
    try {
      await this.setState(cooldownState);
    } catch (error) {
      writeError = error;
    }
    if (
      ownerGeneration !== undefined &&
      this.queryOwnerGeneration !== ownerGeneration &&
      this.processingState === cooldownState
    ) {
      await this.setState(previousState);
    }
    if (writeError !== undefined) {
      throw writeError;
    }
  }

  isWaitingForInput(): boolean {
    return this.processingState.status === 'waiting_for_input';
  }

  stuckInitializingMs(now: number = Date.now()): number | null {
    const state = this.processingState;
    if (state.status !== 'processing' || state.phase !== 'initializing') return null;
    if (this.processingStartedAt === null) return null;
    return Math.max(0, now - this.processingStartedAt);
  }

  private noteInitializationProgress(nextPhase: StreamingPhase): void {
    if (this.streamingPhase !== 'initializing' || nextPhase === 'initializing') return;
    if (this.processingStartedAt === null) return;
    deliveryMetrics.recordInitializationDuration(
      Date.now() - this.processingStartedAt,
      'progressed'
    );
  }

  getPendingQuestion(): PendingUserQuestion | null {
    if (this.processingState.status === 'waiting_for_input') {
      return this.processingState.pendingQuestion;
    }
    return null;
  }

  async updateQuestionDraft(draftResponses: PendingUserQuestion['draftResponses']): Promise<void> {
    if (this.processingState.status !== 'waiting_for_input') {
      this.logger.warn('Cannot update draft - not in waiting_for_input state');
      return;
    }

    this.processingState = {
      ...this.processingState,
      pendingQuestion: {
        ...this.processingState.pendingQuestion,
        draftResponses,
      },
    };

    this.persistToDatabase();
    await this.internalEventBus.publish('session.updated', {
      sessionId: this.sessionId,
      source: 'processing-state',
      processingState: this.processingState,
    });
  }

  async setCompacting(isCompacting: boolean): Promise<void> {
    this.isCompacting = isCompacting;

    if (this.processingState.status === 'processing') {
      this.processingState = {
        ...this.processingState,
        isCompacting,
      };

      this.persistToDatabase();
      await this.internalEventBus.publish('session.updated', {
        sessionId: this.sessionId,
        source: 'processing-state',
        processingState: this.processingState,
      });
    }
  }

  getIsCompacting(): boolean {
    return this.isCompacting;
  }

  async updatePhase(phase: StreamingPhase): Promise<void> {
    if (this.processingState.status !== 'processing') {
      this.logger.warn(`Cannot update phase to ${phase} - not in processing state`);
      return;
    }

    this.noteInitializationProgress(phase);
    this.streamingPhase = phase;

    if (phase === 'streaming' && !this.streamingStartedAt) {
      this.streamingStartedAt = Date.now();
    }

    this.processingState = {
      status: 'processing',
      messageId: this.processingState.messageId,
      phase: this.streamingPhase,
      streamingStartedAt: this.streamingStartedAt ?? undefined,
      isCompacting: this.isCompacting,
    };

    this.persistToDatabase();

    await this.internalEventBus.publish('session.updated', {
      sessionId: this.sessionId,
      source: 'processing-state',
      processingState: this.processingState,
    });
  }

  async detectPhaseFromMessage(message: SDKMessage): Promise<void> {
    if (this.processingState.status !== 'processing') {
      return;
    }

    if (message.type === 'stream_event') {
      const event = (message as Extract<SDKMessage, { type: 'stream_event' }>).event as {
        type?: string;
        delta?: { type?: string };
        content_block?: { type?: string };
      };
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        if (this.streamingPhase !== 'streaming') {
          await this.updatePhase('streaming');
        }
      } else if (
        (event?.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') ||
        (event?.type === 'content_block_start' && event.content_block?.type === 'thinking')
      ) {
        if (this.streamingPhase !== 'thinking') {
          await this.updatePhase('thinking');
        }
      }
    } else if (message.type === 'assistant') {
      const content = (message as SDKAssistantMessage).message.content;
      const hasToolUse = content.some(isToolUseBlock);

      if (hasToolUse && this.streamingPhase === 'initializing') {
        await this.updatePhase('thinking');
      } else if (
        !hasToolUse &&
        this.streamingPhase === 'initializing' &&
        content.some(
          (block: unknown) =>
            typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
        )
      ) {
        await this.updatePhase('thinking');
      }
    } else if (message.type === 'result') {
      if (this.streamingPhase !== 'finalizing') {
        await this.updatePhase('finalizing');
      }
    }
  }

  private async setState(newState: AgentProcessingState, suppressPublish = false): Promise<void> {
    if (newState.status === 'idle' || newState.status === 'interrupted') {
      if (
        this.processingState.status === 'processing' &&
        this.streamingPhase === 'initializing' &&
        this.processingStartedAt !== null
      ) {
        deliveryMetrics.recordInitializationDuration(
          Date.now() - this.processingStartedAt,
          'never_progressed'
        );
      }
      this.streamingPhase = 'initializing';
      this.processingStartedAt = null;
      this.streamingStartedAt = null;
      this.isCompacting = false;
    }

    this.processingState = newState;

    this.persistToDatabase();

    if (suppressPublish) return;

    await this.internalEventBus.publish('session.updated', {
      sessionId: this.sessionId,
      source: 'processing-state',
      processingState: newState,
    });
  }
}
