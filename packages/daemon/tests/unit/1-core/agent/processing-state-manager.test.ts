/**
 * ProcessingStateManager Tests
 *
 * Tests for agent processing state machine including:
 * - State transitions (idle -> queued -> processing -> idle)
 * - Streaming phase tracking
 * - Database persistence
 * - Event emission
 * - State restoration after restart
 * - Question/answer handling
 * - Compacting state tracking
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { AgentProcessingState, PendingUserQuestion } from '@hyperneo/shared';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Database } from '../../../../src/storage/database';
import type { SDKMessage } from '@hyperneo/shared/sdk';

describe('ProcessingStateManager', () => {
  let manager: ProcessingStateManager;
  let mockDb: Database;
  let mockInternalEventBus: InternalEventBus<any>;
  let updateSessionMock: ReturnType<typeof mock>;
  let emitMock: ReturnType<typeof mock>;
  const sessionId = 'test-session-id';

  function createMockDb(): Database {
    return {
      getSession: mock(() => null),
      updateSession: updateSessionMock,
    } as unknown as Database;
  }

  function createMockInternalEventBus(): InternalEventBus<any> {
    return {
      publish: emitMock,
      publishAsync: emitMock,
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;
  }

  beforeEach(() => {
    updateSessionMock = mock(() => {});
    emitMock = mock(async () => {});
    mockDb = createMockDb();
    mockInternalEventBus = createMockInternalEventBus();
    manager = new ProcessingStateManager(sessionId, mockInternalEventBus, mockDb);
  });

  describe('initialization', () => {
    test('starts with idle state', () => {
      const state = manager.getState();
      expect(state.status).toBe('idle');
    });

    test('isIdle returns true initially', () => {
      expect(manager.isIdle()).toBe(true);
    });

    test('isProcessing returns false initially', () => {
      expect(manager.isProcessing()).toBe(false);
    });

    test('isWaitingForInput returns false initially', () => {
      expect(manager.isWaitingForInput()).toBe(false);
    });

    test('getIsCompacting returns false initially', () => {
      expect(manager.getIsCompacting()).toBe(false);
    });
  });

  describe('setIdle', () => {
    test('transitions to idle state', async () => {
      await manager.setIdle();

      const state = manager.getState();
      expect(state.status).toBe('idle');
      expect(manager.isIdle()).toBe(true);
    });

    test('persists state to database', async () => {
      await manager.setIdle();

      expect(updateSessionMock).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({
          processingState: expect.any(String),
        })
      );

      const savedState = JSON.parse(updateSessionMock.mock.calls[0][1].processingState);
      expect(savedState.status).toBe('idle');
    });

    test('emits session.updated event', async () => {
      await manager.setIdle();

      expect(emitMock).toHaveBeenCalledWith(
        'session.updated',
        expect.objectContaining({
          sessionId,
          source: 'processing-state',
          processingState: expect.objectContaining({ status: 'idle' }),
        })
      );
    });

    test('resets streaming phase tracking', async () => {
      // First set to processing
      await manager.setProcessing('msg-1', 'streaming');

      // Then back to idle
      await manager.setIdle();

      // Check internal state was reset
      expect(manager.getIsCompacting()).toBe(false);
    });

    test('executes onIdleCallback when set', async () => {
      const callbackMock = mock(async () => {});
      manager.setOnIdleCallback(callbackMock);

      await manager.setIdle();

      expect(callbackMock).toHaveBeenCalled();
    });

    test('handles callback errors gracefully', async () => {
      const callbackMock = mock(async () => {
        throw new Error('Callback error');
      });
      manager.setOnIdleCallback(callbackMock);

      // Should not throw
      await manager.setIdle();

      expect(callbackMock).toHaveBeenCalled();
    });

    test('clears pending question state', async () => {
      await manager.setWaitingForInput({ toolUseId: 'tool-123', questions: [] });

      await manager.setIdle();

      expect(manager.getState()).toEqual({ status: 'idle' });
      const savedState = JSON.parse(
        updateSessionMock.mock.calls[updateSessionMock.mock.calls.length - 1][1].processingState
      );
      expect(savedState).toEqual({ status: 'idle' });
    });
  });

  describe('setQueued', () => {
    test('transitions to queued state', async () => {
      await manager.setQueued('msg-123');

      const state = manager.getState();
      expect(state.status).toBe('queued');
      expect(state.messageId).toBe('msg-123');
    });

    test('persists queued state to database', async () => {
      await manager.setQueued('msg-456');

      expect(updateSessionMock).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({
          processingState: JSON.stringify({ status: 'queued', messageId: 'msg-456' }),
        })
      );
    });

    test('emits session.updated event with queued state', async () => {
      await manager.setQueued('msg-789');

      expect(emitMock).toHaveBeenCalledWith(
        'session.updated',
        expect.objectContaining({
          sessionId,
          source: 'processing-state',
          processingState: { status: 'queued', messageId: 'msg-789' },
        })
      );
    });
  });

  describe('setQueuedIfIdle', () => {
    test('sets the queued marker while idle and returns true', async () => {
      const didSet = await manager.setQueuedIfIdle('msg-turn');

      expect(didSet).toBe(true);
      expect(manager.getState()).toMatchObject({ status: 'queued', messageId: 'msg-turn' });
    });

    test('first writer wins — a concurrent send never steals the marker (#3743968035)', async () => {
      await manager.setQueuedIfIdle('msg-first');

      const didSet = await manager.setQueuedIfIdle('msg-second');

      expect(didSet).toBe(false);
      expect(manager.getState()).toMatchObject({ status: 'queued', messageId: 'msg-first' });
    });

    test('does not downgrade a processing session', async () => {
      await manager.setProcessing('msg-active');

      const didSet = await manager.setQueuedIfIdle('msg-steer');

      expect(didSet).toBe(false);
      expect(manager.getState().status).toBe('processing');
    });
  });

  describe('setProcessing', () => {
    test('transitions to processing state with default phase', async () => {
      await manager.setProcessing('msg-1');

      const state = manager.getState();
      expect(state.status).toBe('processing');
      expect(state.messageId).toBe('msg-1');
      expect(state.phase).toBe('initializing');
      expect(manager.isProcessing()).toBe(true);
    });

    test('transitions to processing state with custom phase', async () => {
      await manager.setProcessing('msg-2', 'thinking');

      const state = manager.getState();
      expect(state.phase).toBe('thinking');
    });

    test('transitions to processing state with streaming phase', async () => {
      await manager.setProcessing('msg-3', 'streaming');

      const state = manager.getState();
      expect(state.phase).toBe('streaming');
      expect(state.streamingStartedAt).toBeDefined();
    });

    test('includes isCompacting in processing state', async () => {
      await manager.setCompacting(true);
      await manager.setProcessing('msg-4');

      const state = manager.getState();
      expect(state.isCompacting).toBe(true);
    });

    test('persists processing state to database', async () => {
      await manager.setProcessing('msg-5', 'thinking');

      expect(updateSessionMock).toHaveBeenCalled();

      const savedState = JSON.parse(updateSessionMock.mock.calls[0][1].processingState);
      expect(savedState.status).toBe('processing');
      expect(savedState.phase).toBe('thinking');
    });
  });

  describe('setInterrupted', () => {
    test('transitions to interrupted state', async () => {
      await manager.setInterrupted();

      const state = manager.getState();
      expect(state.status).toBe('interrupted');
    });

    test('resets streaming phase tracking', async () => {
      await manager.setProcessing('msg-1', 'streaming');
      await manager.setInterrupted();

      expect(manager.getIsCompacting()).toBe(false);
    });

    test('persists interrupted state to database', async () => {
      await manager.setInterrupted();

      expect(updateSessionMock).toHaveBeenCalled();

      const savedState = JSON.parse(updateSessionMock.mock.calls[0][1].processingState);
      expect(savedState.status).toBe('interrupted');
    });
  });

  describe('setWaitingForInput', () => {
    const pendingQuestion: PendingUserQuestion = {
      toolUseId: 'tool-123',
      questions: [
        {
          questionText: 'What would you like to do?',
          options: [{ optionText: 'Option A' }, { optionText: 'Option B' }],
        },
      ],
    };

    test('transitions to waiting_for_input state', async () => {
      await manager.setWaitingForInput(pendingQuestion);

      const state = manager.getState();
      expect(state.status).toBe('waiting_for_input');
      expect(manager.isWaitingForInput()).toBe(true);
    });

    test('stores pending question', async () => {
      await manager.setWaitingForInput(pendingQuestion);

      const stored = manager.getPendingQuestion();
      expect(stored).toEqual(pendingQuestion);
    });

    test('persists waiting_for_input state to database', async () => {
      await manager.setWaitingForInput(pendingQuestion);

      expect(updateSessionMock).toHaveBeenCalled();

      const savedState = JSON.parse(updateSessionMock.mock.calls[0][1].processingState);
      expect(savedState.status).toBe('waiting_for_input');
      expect(savedState.pendingQuestion.toolUseId).toBe('tool-123');
    });

    test('returns null for getPendingQuestion when not waiting', () => {
      expect(manager.getPendingQuestion()).toBeNull();
    });
  });

  describe('updateQuestionDraft', () => {
    const pendingQuestion: PendingUserQuestion = {
      toolUseId: 'tool-456',
      questions: [
        {
          questionText: 'Select items:',
          options: [{ optionText: 'Item 1' }, { optionText: 'Item 2' }],
        },
      ],
    };

    test('updates draft responses when in waiting_for_input state', async () => {
      await manager.setWaitingForInput(pendingQuestion);

      const draftResponses = [{ questionIndex: 0, selectedOptionIndices: [0] }];
      await manager.updateQuestionDraft(draftResponses);

      const question = manager.getPendingQuestion();
      expect(question?.draftResponses).toEqual(draftResponses);
    });

    test('persists draft updates to database', async () => {
      await manager.setWaitingForInput(pendingQuestion);

      const draftResponses = [{ questionIndex: 0, selectedOptionIndices: [1] }];
      await manager.updateQuestionDraft(draftResponses);

      // Should have been called for both setWaitingForInput and updateQuestionDraft
      expect(updateSessionMock).toHaveBeenCalledTimes(2);
    });

    test('emits session.updated event with updated state', async () => {
      await manager.setWaitingForInput(pendingQuestion);
      emitMock.mockClear();

      const draftResponses = [{ questionIndex: 0, selectedOptionIndices: [0, 1] }];
      await manager.updateQuestionDraft(draftResponses);

      expect(emitMock).toHaveBeenCalledWith(
        'session.updated',
        expect.objectContaining({
          sessionId,
          source: 'processing-state',
          processingState: expect.objectContaining({
            status: 'waiting_for_input',
            pendingQuestion: expect.objectContaining({
              draftResponses,
            }),
          }),
        })
      );
    });

    test('does nothing when not in waiting_for_input state', async () => {
      emitMock.mockClear();
      updateSessionMock.mockClear();

      await manager.updateQuestionDraft([{ questionIndex: 0, selectedOptionIndices: [] }]);

      expect(emitMock).not.toHaveBeenCalled();
      expect(updateSessionMock).not.toHaveBeenCalled();
    });
  });

  describe('setCompacting', () => {
    test('sets compacting to true', async () => {
      await manager.setProcessing('msg-1');
      await manager.setCompacting(true);

      expect(manager.getIsCompacting()).toBe(true);
    });

    test('sets compacting to false', async () => {
      await manager.setProcessing('msg-1');
      await manager.setCompacting(true);
      await manager.setCompacting(false);

      expect(manager.getIsCompacting()).toBe(false);
    });

    test('updates processing state when compacting changes during processing', async () => {
      await manager.setProcessing('msg-1');
      emitMock.mockClear();

      await manager.setCompacting(true);

      expect(emitMock).toHaveBeenCalledWith(
        'session.updated',
        expect.objectContaining({
          sessionId,
          processingState: expect.objectContaining({
            isCompacting: true,
          }),
        })
      );
    });

    test('does not emit event when not processing', async () => {
      await manager.setCompacting(true);

      // Only the initial setCompacting should set the internal flag
      expect(manager.getIsCompacting()).toBe(true);
    });
  });

  describe('updatePhase', () => {
    test('updates phase during processing', async () => {
      await manager.setProcessing('msg-1', 'initializing');
      await manager.updatePhase('thinking');

      const state = manager.getState();
      expect(state.phase).toBe('thinking');
    });

    test('transitions to streaming phase', async () => {
      await manager.setProcessing('msg-1', 'thinking');
      await manager.updatePhase('streaming');

      const state = manager.getState();
      expect(state.phase).toBe('streaming');
      expect(state.streamingStartedAt).toBeDefined();
    });

    test('transitions to finalizing phase', async () => {
      await manager.setProcessing('msg-1', 'streaming');
      await manager.updatePhase('finalizing');

      const state = manager.getState();
      expect(state.phase).toBe('finalizing');
    });

    test('does nothing when not processing', async () => {
      emitMock.mockClear();

      await manager.updatePhase('thinking');

      expect(emitMock).not.toHaveBeenCalled();
    });

    test('persists phase update to database', async () => {
      await manager.setProcessing('msg-1', 'initializing');
      updateSessionMock.mockClear();

      await manager.updatePhase('thinking');

      expect(updateSessionMock).toHaveBeenCalled();
    });
  });

  describe('detectPhaseFromMessage', () => {
    test('does nothing when not processing', async () => {
      const message = { type: 'stream_event' } as SDKMessage;
      await manager.detectPhaseFromMessage(message);

      // Should not throw and state should remain idle
      expect(manager.getState().status).toBe('idle');
    });

    test('transitions to streaming phase on stream_event', async () => {
      await manager.setProcessing('msg-1', 'thinking');

      const message = {
        type: 'stream_event',
        event: { type: 'content_block_delta' },
      } as unknown as SDKMessage;
      await manager.detectPhaseFromMessage(message);

      expect(manager.getState().phase).toBe('streaming');
    });

    test('transitions to thinking phase on assistant message with tool use', async () => {
      await manager.setProcessing('msg-1', 'initializing');

      const message = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'test_tool', input: {} }],
        },
      } as unknown as SDKMessage;
      await manager.detectPhaseFromMessage(message);

      expect(manager.getState().phase).toBe('thinking');
    });

    test('transitions to thinking phase on assistant message with text only', async () => {
      await manager.setProcessing('msg-1', 'initializing');

      const message = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello!' }],
        },
      } as unknown as SDKMessage;
      await manager.detectPhaseFromMessage(message);

      expect(manager.getState().phase).toBe('thinking');
    });

    test('transitions to finalizing phase on result message', async () => {
      await manager.setProcessing('msg-1', 'streaming');

      const message = {
        type: 'result',
        result: { status: 'success' },
      } as unknown as SDKMessage;
      await manager.detectPhaseFromMessage(message);

      expect(manager.getState().phase).toBe('finalizing');
    });

    test('does not transition when already in target phase', async () => {
      await manager.setProcessing('msg-1', 'streaming');
      emitMock.mockClear();

      const message = {
        type: 'stream_event',
        event: { type: 'content_block_delta' },
      } as unknown as SDKMessage;
      await manager.detectPhaseFromMessage(message);

      // Should not emit since already in streaming phase
      expect(emitMock).not.toHaveBeenCalled();
    });
  });

  describe('restoreFromDatabase', () => {
    test('restores idle state from database', () => {
      mockDb.getSession = mock(() => ({
        processingState: JSON.stringify({ status: 'idle' }),
      }));

      manager.restoreFromDatabase();

      expect(manager.getState().status).toBe('idle');
    });

    test('restores waiting_for_input state from database', () => {
      const pendingQuestion: PendingUserQuestion = {
        toolUseId: 'restored-tool',
        questions: [],
      };
      mockDb.getSession = mock(() => ({
        processingState: JSON.stringify({
          status: 'waiting_for_input',
          pendingQuestion,
        }),
      }));

      manager.restoreFromDatabase();

      expect(manager.getState().status).toBe('waiting_for_input');
      expect(manager.getPendingQuestion()?.toolUseId).toBe('restored-tool');
    });

    test('resets processing state to idle after restart', () => {
      mockDb.getSession = mock(() => ({
        processingState: JSON.stringify({
          status: 'processing',
          messageId: 'old-msg',
          phase: 'thinking',
        }),
      }));

      manager.restoreFromDatabase();

      // Processing state should be reset to idle
      expect(manager.getState().status).toBe('idle');
    });

    test('resets queued state to idle after restart', () => {
      mockDb.getSession = mock(() => ({
        processingState: JSON.stringify({
          status: 'queued',
          messageId: 'queued-msg',
        }),
      }));

      manager.restoreFromDatabase();

      expect(manager.getState().status).toBe('idle');
    });

    test('handles missing processingState gracefully', () => {
      mockDb.getSession = mock(() => null);

      // Should not throw
      manager.restoreFromDatabase();

      expect(manager.getState().status).toBe('idle');
    });

    test('handles invalid JSON gracefully', () => {
      mockDb.getSession = mock(() => ({
        processingState: 'invalid json',
      }));

      // Should not throw
      manager.restoreFromDatabase();

      expect(manager.getState().status).toBe('idle');
    });

    test('restores interrupted state', () => {
      mockDb.getSession = mock(() => ({
        processingState: JSON.stringify({ status: 'interrupted' }),
      }));

      manager.restoreFromDatabase();

      expect(manager.getState().status).toBe('interrupted');
    });
  });

  describe('state transition flow', () => {
    test('complete flow: idle -> queued -> processing -> idle', async () => {
      // Start idle
      expect(manager.getState().status).toBe('idle');

      // Queue message
      await manager.setQueued('msg-1');
      expect(manager.getState().status).toBe('queued');

      // Start processing
      await manager.setProcessing('msg-1', 'initializing');
      expect(manager.getState().status).toBe('processing');

      // Update phases
      await manager.updatePhase('thinking');
      expect(manager.getState().phase).toBe('thinking');

      await manager.updatePhase('streaming');
      expect(manager.getState().phase).toBe('streaming');

      await manager.updatePhase('finalizing');
      expect(manager.getState().phase).toBe('finalizing');

      // Back to idle
      await manager.setIdle();
      expect(manager.getState().status).toBe('idle');
    });

    test('flow with interrupt: idle -> processing -> interrupted -> idle', async () => {
      await manager.setProcessing('msg-1', 'streaming');
      expect(manager.getState().status).toBe('processing');

      await manager.setInterrupted();
      expect(manager.getState().status).toBe('interrupted');

      await manager.setIdle();
      expect(manager.getState().status).toBe('idle');
    });

    test('flow with waiting_for_input: idle -> processing -> waiting -> idle', async () => {
      await manager.setProcessing('msg-1', 'thinking');
      expect(manager.getState().status).toBe('processing');

      const question: PendingUserQuestion = {
        toolUseId: 'tool-1',
        questions: [],
      };
      await manager.setWaitingForInput(question);
      expect(manager.getState().status).toBe('waiting_for_input');
      expect(manager.isWaitingForInput()).toBe(true);

      await manager.setIdle();
      expect(manager.getState().status).toBe('idle');
    });
  });

  describe('database error handling', () => {
    test('handles database update failure gracefully', async () => {
      updateSessionMock = mock(() => {
        throw new Error('DB error');
      });
      mockDb = createMockDb();
      mockInternalEventBus = createMockInternalEventBus();
      manager = new ProcessingStateManager(sessionId, mockInternalEventBus, mockDb);

      // Should not throw
      await manager.setIdle();

      expect(manager.getState().status).toBe('idle');
    });
  });
});
