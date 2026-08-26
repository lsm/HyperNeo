import type { AgentProcessingState, PendingUserQuestion } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { SDKAssistantMessage, SDKMessage } from '@hyperneo/shared/sdk';
import { isToolUseBlock } from '@hyperneo/shared/sdk/type-guards';
import type { Database } from '../../storage/database.ts';
import { Logger } from '../logger.ts';

type StreamingPhase = 'initializing' | 'thinking' | 'streaming' | 'finalizing';

export interface IdleOwnerScope {
  queryGeneration: number;
  turnToken: number;
}

type IdleWaiter = {
  id: number;
  resolve: () => void;
  gen?: number;
  owner?: IdleOwnerScope;
  fireEnd: () => void;
  resolveOnce: () => void;
  endOnce: () => void;
};

export class ProcessingStateManager {
  private processingState: AgentProcessingState = { status: 'idle' };
  private streamingPhase: StreamingPhase = 'initializing';
  private streamingStartedAt: number | null = null;
  private isCompacting = false;
  private logger: Logger;
  private onIdleCallback?: (owner?: IdleOwnerScope) => Promise<void>;
  private idleWaiters: Map<number, IdleWaiter> = new Map();
  private nextIdleWaiterId = 0;
  private idleCallbackInFlight = false;
  private terminalIdleTransitions = 0;
  private pendingFenceOwners: IdleOwnerScope[] = [];
  private suppressedFenceCarryTokens: number[] = [];
  private queryOwnerGeneration = 0;
  private turnOwnerToken = 0;
  private lastIdleTransitionOwner?: IdleOwnerScope;

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

  getCurrentIdleOwner(): IdleOwnerScope {
    return { queryGeneration: this.queryOwnerGeneration, turnToken: this.turnOwnerToken };
  }

  isIdleOwnerCurrent(owner?: IdleOwnerScope): boolean {
    if (!owner) return true;
    const current = this.getCurrentIdleOwner();
    return (
      owner.queryGeneration === current.queryGeneration && owner.turnToken === current.turnToken
    );
  }

  hasSettledIdleOwner(owner: IdleOwnerScope): boolean {
    const last = this.lastIdleTransitionOwner;
    return (
      last !== undefined &&
      last.queryGeneration === owner.queryGeneration &&
      last.turnToken === owner.turnToken
    );
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
    this.idleWaiters.set(id, {
      id,
      resolve,
      gen: episodeGen,
      owner,
      fireEnd,
      resolveOnce,
      endOnce,
    });
    return {
      promise,
      cancel: () => {
        resolveOnce();
      },
    };
  }

  releaseIdleWaiters(episodeGen?: number): void {
    const matching = [...this.idleWaiters.entries()].filter(
      ([, w]) => episodeGen === undefined || w.gen === episodeGen
    );
    for (const [, w] of matching) w.endOnce();
  }

  private waiterOwnedByTransition(
    waiter: IdleWaiter,
    owner: IdleOwnerScope | undefined,
    fenceStartToken: number
  ): boolean {
    if (waiter.owner === undefined) return true;
    if (owner !== undefined) {
      return (
        waiter.owner.queryGeneration === owner.queryGeneration &&
        waiter.owner.turnToken === owner.turnToken
      );
    }
    return waiter.owner.turnToken <= fenceStartToken;
  }

  beginTerminalIdle(owner?: IdleOwnerScope): IdleOwnerScope {
    this.terminalIdleTransitions += 1;
    const fenceOwner = owner ?? this.getCurrentIdleOwner();
    this.pendingFenceOwners.push(fenceOwner);
    for (const waiter of this.idleWaiters.values()) {
      if (this.waiterOwnedByTransition(waiter, owner, fenceOwner.turnToken)) waiter.fireEnd();
    }
    return fenceOwner;
  }

  cancelTerminalFence(fence: IdleOwnerScope): void {
    const fenceIndex = this.pendingFenceOwners.indexOf(fence);
    if (fenceIndex >= 0) {
      this.pendingFenceOwners.splice(fenceIndex, 1);
      this.terminalIdleTransitions -= 1;
    }
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
    return this.pendingFenceOwners.length > 0;
  }

  async setIdle(opts?: {
    suppressDeliveryWaiters?: boolean;
    suppressIdlePublish?: boolean;
    suppressIdleCallback?: boolean;
    owner?: IdleOwnerScope;
    fence?: IdleOwnerScope;
  }): Promise<void> {
    const suppressDrain = opts?.suppressDeliveryWaiters || this.idleCallbackInFlight;
    let fenceOwner: IdleOwnerScope | undefined;
    if (opts?.fence) {
      const fenceIndex = this.pendingFenceOwners.indexOf(opts.fence);
      if (fenceIndex < 0) {
        return;
      }
      fenceOwner = this.pendingFenceOwners.splice(fenceIndex, 1)[0];
    }
    const consumesTerminalFence = fenceOwner !== undefined;
    const ownsTerminalTransition = !suppressDrain || consumesTerminalFence;
    const transitionOwner = opts?.owner ?? fenceOwner ?? this.getCurrentIdleOwner();
    this.lastIdleTransitionOwner = transitionOwner;
    const fenceStartToken = fenceOwner ? fenceOwner.turnToken : this.turnOwnerToken;
    if (consumesTerminalFence) {
      if (suppressDrain) {
        this.suppressedFenceCarryTokens.push(fenceStartToken);
      }
    } else if (!suppressDrain) {
      this.terminalIdleTransitions += 1;
    }
    const claimCeiling = Math.max(fenceStartToken, ...this.suppressedFenceCarryTokens);
    let claimed: IdleWaiter[] = [];
    if (!suppressDrain) {
      claimed = [...this.idleWaiters.values()].filter((w) =>
        this.waiterOwnedByTransition(w, opts?.owner, claimCeiling)
      );
      for (const w of claimed) w.fireEnd();
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
        const carryCeiling =
          this.suppressedFenceCarryTokens.length > 0
            ? Math.max(...this.suppressedFenceCarryTokens)
            : Number.NEGATIVE_INFINITY;
        const drainCeiling = Math.max(fenceStartToken, carryCeiling);
        const drained = [...this.idleWaiters.values()].filter((w) => {
          if (this.waiterOwnedByTransition(w, opts?.owner, drainCeiling)) return true;
          return opts?.owner !== undefined && w.owner != null && w.owner.turnToken <= carryCeiling;
        });
        for (const w of drained) {
          this.idleWaiters.delete(w.id);
          w.endOnce();
        }
        this.suppressedFenceCarryTokens = [];
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
    this.streamingPhase = phase;
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

  async setRateLimitCooldown(state: {
    retryCount: number;
    maxRetries: number;
    retryAt: number;
  }): Promise<void> {
    await this.setState({
      status: 'rate_limit_cooldown',
      retryCount: state.retryCount,
      maxRetries: state.maxRetries,
      retryAt: state.retryAt,
    });
  }

  isWaitingForInput(): boolean {
    return this.processingState.status === 'waiting_for_input';
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
      this.streamingPhase = 'initializing';
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
