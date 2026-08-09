/**
 * ProcessingStateManager - Agent processing state machine
 *
 * Manages the state transitions:
 * idle → queued → processing (phases: initializing/thinking/streaming/finalizing) → idle | interrupted
 *
 * Enhanced with streaming phase tracking for fine-grained progress updates.
 * Now persists state to database for recovery after restarts.
 */

import type { AgentProcessingState, PendingUserQuestion } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { SDKAssistantMessage, SDKMessage } from '@hyperneo/shared/sdk';
import { isToolUseBlock } from '@hyperneo/shared/sdk/type-guards';
import type { Database } from '../../storage/database';
import { Logger } from '../logger';

type StreamingPhase = 'initializing' | 'thinking' | 'streaming' | 'finalizing';

export class ProcessingStateManager {
  private processingState: AgentProcessingState = { status: 'idle' };
  private streamingPhase: StreamingPhase = 'initializing';
  private streamingStartedAt: number | null = null;
  private isCompacting = false;
  private logger: Logger;
  private onIdleCallback?: () => Promise<void>;

  constructor(
    private sessionId: string,
    private internalEventBus: InternalEventBus<DaemonInternalEventMap>,
    private db: Database
  ) {
    this.logger = new Logger(`ProcessingStateManager ${sessionId}`);
  }

  /**
   * Set callback to execute when state transitions to idle
   * Used for deferred restarts and other idle-triggered actions
   */
  setOnIdleCallback(callback: () => Promise<void>): void {
    this.onIdleCallback = callback;
  }

  /**
   * Restore processing state from database
   * Called on session initialization to recover state after restart
   */
  restoreFromDatabase(): void {
    const session = this.db.getSession(this.sessionId);
    if (!session?.processingState) {
      return;
    }

    try {
      const restoredState = JSON.parse(session.processingState) as AgentProcessingState;

      // Handle different states appropriately after restart
      if (restoredState.status === 'processing' || restoredState.status === 'queued') {
        // Active processing states should reset to idle after restart
        // The SDK query will need to be restarted anyway
        this.processingState = { status: 'idle' };
      } else if (restoredState.status === 'rate_limit_cooldown') {
        // Cooldown timers are not persisted; reset to idle so the user
        // can manually retry or send a new message.
        this.processingState = { status: 'idle' };
      } else if (restoredState.status === 'waiting_for_input') {
        // IMPORTANT: Preserve waiting_for_input state across restarts
        // The user's pending question should still be answerable after page refresh
        this.processingState = restoredState;
      } else {
        this.processingState = restoredState;
      }
    } catch (error) {
      this.logger.error('Failed to parse persisted processing state:', error);
      this.processingState = { status: 'idle' };
    }
  }

  /**
   * Persist current processing state to database
   * DB-first pattern: save to DB, then broadcast via EventBus
   */
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

  /**
   * Get current processing state
   */
  getState(): AgentProcessingState {
    return this.processingState;
  }

  /**
   * Check if currently processing
   */
  isProcessing(): boolean {
    return this.processingState.status === 'processing';
  }

  /**
   * Check if idle
   */
  isIdle(): boolean {
    return this.processingState.status === 'idle';
  }

  /**
   * Set state to idle
   */
  async setIdle(): Promise<void> {
    await this.setState({ status: 'idle' });

    // Execute idle callback if set (e.g., for deferred restarts)
    if (this.onIdleCallback) {
      try {
        await this.onIdleCallback();
      } catch (error) {
        this.logger.error('Error in onIdle callback:', error);
        // Don't re-throw - callback errors shouldn't break state transitions
      }
    }
  }

  /**
   * Set state to queued
   */
  async setQueued(messageId: string): Promise<void> {
    await this.setState({ status: 'queued', messageId });
  }

  /**
   * Return to idle only when the queued marker still belongs to `messageId`.
   * Delivery cancellation/skip paths use this compare-and-set so they cannot
   * clear a newer message's queued/processing state.
   */
  async clearQueuedIfOwnedBy(messageId: string): Promise<boolean> {
    const current = this.processingState;
    if (current.status !== 'queued' || current.messageId !== messageId) {
      return false;
    }
    await this.setIdle();
    return true;
  }

  /**
   * Set state to processing
   */
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

  /**
   * Set state to interrupted
   */
  async setInterrupted(): Promise<void> {
    await this.setState({ status: 'interrupted' });
  }

  /**
   * Set state to waiting_for_input
   * Called when agent uses AskUserQuestion tool and needs user response
   */
  async setWaitingForInput(pendingQuestion: PendingUserQuestion): Promise<void> {
    await this.setState({ status: 'waiting_for_input', pendingQuestion });
  }

  /**
   * Set state to rate_limit_cooldown
   * Called when 429 retry exhaustion is detected and auto-retry is scheduled
   */
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

  /**
   * Check if currently waiting for user input
   */
  isWaitingForInput(): boolean {
    return this.processingState.status === 'waiting_for_input';
  }

  /**
   * Get pending question if in waiting_for_input state
   */
  getPendingQuestion(): PendingUserQuestion | null {
    if (this.processingState.status === 'waiting_for_input') {
      return this.processingState.pendingQuestion;
    }
    return null;
  }

  /**
   * Update draft responses for pending question (for saving partial input)
   */
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

    // Persist and broadcast
    this.persistToDatabase();
    await this.internalEventBus.publish('session.updated', {
      sessionId: this.sessionId,
      source: 'processing-state',
      processingState: this.processingState,
    });
  }

  /**
   * Set compacting state
   * Folded into unified state.session via isCompacting field
   */
  async setCompacting(isCompacting: boolean): Promise<void> {
    this.isCompacting = isCompacting;

    // Only relevant when processing
    if (this.processingState.status === 'processing') {
      this.processingState = {
        ...this.processingState,
        isCompacting,
      };

      // Persist and broadcast
      this.persistToDatabase();
      await this.internalEventBus.publish('session.updated', {
        sessionId: this.sessionId,
        source: 'processing-state',
        processingState: this.processingState,
      });
    }
  }

  /**
   * Check if currently compacting
   */
  getIsCompacting(): boolean {
    return this.isCompacting;
  }

  /**
   * Update the streaming phase (only valid during processing)
   */
  async updatePhase(phase: StreamingPhase): Promise<void> {
    if (this.processingState.status !== 'processing') {
      this.logger.warn(`Cannot update phase to ${phase} - not in processing state`);
      return;
    }

    this.streamingPhase = phase;

    // Track when streaming actually started
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

    // DB-first: Persist to database before broadcasting
    this.persistToDatabase();

    // Broadcast updated state via unified session.updated event
    // Include processingState so StateManager can cache it (decoupled)
    await this.internalEventBus.publish('session.updated', {
      sessionId: this.sessionId,
      source: 'processing-state',
      processingState: this.processingState,
    });
  }

  /**
   * Auto-detect phase from SDK message type
   * Called during SDK message processing to automatically update phase
   */
  async detectPhaseFromMessage(message: SDKMessage): Promise<void> {
    if (this.processingState.status !== 'processing') {
      return; // Only detect during processing
    }

    if (message.type === 'stream_event') {
      // We're actively streaming content deltas
      if (this.streamingPhase !== 'streaming') {
        await this.updatePhase('streaming');
      }
    } else if (message.type === 'assistant') {
      // Assistant message indicates thinking/tool use phase
      const content = (message as SDKAssistantMessage).message.content;
      const hasToolUse = content.some(isToolUseBlock);

      if (hasToolUse && this.streamingPhase === 'initializing') {
        // Transition from initializing to thinking when we see tool use
        await this.updatePhase('thinking');
      } else if (
        !hasToolUse &&
        this.streamingPhase === 'initializing' &&
        content.some(
          (block: unknown) =>
            typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
        )
      ) {
        // If we get a text response without tool use, we're likely about to stream
        await this.updatePhase('thinking');
      }
    } else if (message.type === 'result') {
      // Final result - move to finalizing phase briefly before idle
      if (this.streamingPhase !== 'finalizing') {
        await this.updatePhase('finalizing');
      }
    }
  }

  /**
   * Internal state setter with event emission
   * DB-first pattern: save to DB, then broadcast via EventBus
   */
  private async setState(newState: AgentProcessingState): Promise<void> {
    // If transitioning to idle or interrupted, reset phase tracking
    if (newState.status === 'idle' || newState.status === 'interrupted') {
      this.streamingPhase = 'initializing';
      this.streamingStartedAt = null;
      this.isCompacting = false; // Reset compacting on idle/interrupted
    }

    this.processingState = newState;

    // DB-first: Persist to database before broadcasting
    this.persistToDatabase();

    // Emit event via InternalEventBus<DaemonInternalEventMap> (StateManager caches processingState)
    // Include data so StateManager doesn't need to fetch from us (decoupled)
    await this.internalEventBus.publish('session.updated', {
      sessionId: this.sessionId,
      source: 'processing-state',
      processingState: newState,
    });
  }
}
