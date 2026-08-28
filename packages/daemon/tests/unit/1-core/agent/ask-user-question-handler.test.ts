import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
  AskUserQuestionHandler,
  type AskUserQuestionHandlerContext,
} from '../../../../src/lib/agent/ask-user-question-handler';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { DaemonHub } from '../../../../tests/helpers/daemon-hub';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Database } from '../../../../src/storage/database';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { PendingUserQuestion, AgentProcessingState, Session } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';

describe('AskUserQuestionHandler', () => {
  let handler: AskUserQuestionHandler;
  let mockStateManager: ProcessingStateManager;
  let mockDaemonHub: DaemonHub;
  let mockInternalEventBus: InternalEventBus<any>;
  let mockDb: Database;
  let mockMessageQueue: MessageQueue;
  let mockContext: AskUserQuestionHandlerContext;
  let emitSpy: ReturnType<typeof mock>;
  let setWaitingForInputSpy: ReturnType<typeof mock>;
  let setProcessingSpy: ReturnType<typeof mock>;
  let setIdleSpy: ReturnType<typeof mock>;
  let getStateSpy: ReturnType<typeof mock>;
  let releaseIdleWaitersSpy: ReturnType<typeof mock>;
  let updateQuestionDraftSpy: ReturnType<typeof mock>;
  let updateSessionSpy: ReturnType<typeof mock>;
  let enqueueWithIdSpy: ReturnType<typeof mock>;
  let ensureQueryStartedSpy: ReturnType<typeof mock>;
  const testSessionId = generateUUID();

  let currentState: AgentProcessingState;
  let mockSession: Session;

  beforeEach(() => {
    currentState = { status: 'idle' };

    emitSpy = mock(async () => {});
    mockInternalEventBus = {
      publish: emitSpy,
      publishAsync: emitSpy,
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;
    mockDaemonHub = {
      emit: emitSpy,
    } as unknown as DaemonHub;

    setWaitingForInputSpy = mock(async (pendingQuestion: PendingUserQuestion) => {
      currentState = { status: 'waiting_for_input', pendingQuestion };
    });
    setProcessingSpy = mock(async () => {
      currentState = {
        status: 'processing',
        messageId: 'test',
        phase: 'streaming',
      };
    });
    setIdleSpy = mock(async () => {
      currentState = { status: 'idle' };
    });
    getStateSpy = mock(() => currentState);
    releaseIdleWaitersSpy = mock(() => {});
    updateQuestionDraftSpy = mock(async () => {});

    mockStateManager = {
      setWaitingForInput: setWaitingForInputSpy,
      setProcessing: setProcessingSpy,
      setIdle: setIdleSpy,
      getState: getStateSpy,
      releaseIdleWaiters: releaseIdleWaitersSpy,
      updateQuestionDraft: updateQuestionDraftSpy,
    } as unknown as ProcessingStateManager;

    updateSessionSpy = mock(() => {});
    mockDb = {
      updateSession: updateSessionSpy,
    } as unknown as Database;

    enqueueWithIdSpy = mock(async () => {});
    mockMessageQueue = {
      enqueueWithId: enqueueWithIdSpy,
    } as unknown as MessageQueue;

    mockSession = {
      id: testSessionId,
      title: 'Test Session',
      workspacePath: '/test/workspace',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: { model: 'default', maxTokens: 8192, temperature: 1.0 },
      metadata: {},
    };

    ensureQueryStartedSpy = mock(async () => {});

    mockContext = {
      session: mockSession,
      db: mockDb,
      stateManager: mockStateManager,
      daemonHub: mockDaemonHub,
      internalEventBus: mockInternalEventBus,
      messageQueue: mockMessageQueue,
      ensureQueryStarted: ensureQueryStartedSpy,
    };

    handler = new AskUserQuestionHandler(mockContext);
  });

  describe('createCanUseToolCallback', () => {
    it('should return a function', () => {
      const callback = handler.createCanUseToolCallback();
      expect(typeof callback).toBe('function');
    });

    it('should allow non-AskUserQuestion tools', async () => {
      const callback = handler.createCanUseToolCallback();

      const result = await callback(
        'Bash',
        { command: 'ls' },
        { signal: new AbortController().signal, toolUseID: 'test-id' }
      );

      expect(result.behavior).toBe('allow');
      expect(result.updatedInput).toEqual({ command: 'ls' });
    });

    it('should intercept AskUserQuestion tool', async () => {
      const callback = handler.createCanUseToolCallback();

      const input = {
        questions: [
          {
            question: 'What do you prefer?',
            header: 'Preference',
            options: [
              { label: 'Option A', description: 'First option' },
              { label: 'Option B', description: 'Second option' },
            ],
            multiSelect: false,
          },
        ],
      };

      const resultPromise = callback('AskUserQuestion', input, {
        signal: new AbortController().signal,
        toolUseID: 'tool-123',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(setWaitingForInputSpy).toHaveBeenCalled();
      expect(emitSpy).toHaveBeenCalledWith('question.asked', expect.any(Object));

      await handler.handleQuestionResponse('tool-123', [
        { questionIndex: 0, selectedLabels: ['Option A'] },
      ]);

      const result = await resultPromise;
      expect(result.behavior).toBe('allow');
    });

    it('should pass through SDK toolUseID', async () => {
      const callback = handler.createCanUseToolCallback();

      const input = {
        questions: [
          {
            question: 'Test question',
            header: 'Test',
            options: [
              { label: 'Yes', description: 'Yes' },
              { label: 'No', description: 'No' },
            ],
            multiSelect: false,
          },
        ],
      };

      const toolUseID = 'sdk-tool-use-id-12345';
      const resultPromise = callback('AskUserQuestion', input, {
        signal: new AbortController().signal,
        toolUseID,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(setWaitingForInputSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolUseId: toolUseID,
        })
      );

      await handler.handleQuestionResponse(toolUseID, [
        { questionIndex: 0, selectedLabels: ['Yes'] },
      ]);

      await resultPromise;
    });
  });

  describe('handleQuestionResponse', () => {
    it('should throw when not waiting for input', async () => {
      currentState = { status: 'idle' };

      await expect(
        handler.handleQuestionResponse('tool-123', [{ questionIndex: 0, selectedLabels: ['A'] }])
      ).rejects.toThrow('agent is not waiting for input');
    });

    it('releases the durable turn waiter if the injected_as_tool_result publication rejects (Codex P1)', async () => {
      const pendingQuestion: PendingUserQuestion = {
        toolUseId: 'tool-123',
        questions: [
          {
            question: 'What do you want?',
            header: 'Choice',
            options: [
              { label: 'A', description: 'A' },
              { label: 'B', description: 'B' },
            ],
            multiSelect: false,
          },
        ],
        askedAt: Date.now(),
      };
      currentState = { status: 'waiting_for_input', pendingQuestion };
      (emitSpy as ReturnType<typeof mock>).mockImplementation(async (event: string) => {
        if (event === 'question.injected_as_tool_result') {
          throw new Error('subscriber rejected');
        }
      });

      await expect(
        handler.handleQuestionResponse('tool-123', [{ questionIndex: 0, selectedLabels: ['A'] }])
      ).rejects.toThrow('subscriber rejected');
      expect(releaseIdleWaitersSpy).toHaveBeenCalledTimes(1);
    });

    it('should queue answer + inject tool_result when no pending resolver (post-restart)', async () => {
      const pendingQuestion: PendingUserQuestion = {
        toolUseId: 'tool-123',
        questions: [
          {
            question: 'What do you want?',
            header: 'Choice',
            options: [
              { label: 'A', description: 'A' },
              { label: 'B', description: 'B' },
            ],
            multiSelect: false,
          },
        ],
        askedAt: Date.now(),
      };
      currentState = { status: 'waiting_for_input', pendingQuestion };

      await handler.handleQuestionResponse('tool-123', [
        { questionIndex: 0, selectedLabels: ['A'] },
      ]);

      expect(updateSessionSpy).toHaveBeenCalled();
      const updateCall = updateSessionSpy.mock.calls[0];
      expect(updateCall[1].metadata.resolvedQuestions['tool-123'].state).toBe('submitted');

      expect(setIdleSpy).toHaveBeenCalled();
      expect(setProcessingSpy).not.toHaveBeenCalled();

      const queued = handler.getQueuedAnswersForTesting();
      expect(queued.has('tool-123')).toBe(true);
      expect(queued.get('tool-123')!.behavior).toBe('allow');

      expect(enqueueWithIdSpy).toHaveBeenCalled();
      const enqueueCall = enqueueWithIdSpy.mock.calls[0];
      expect(enqueueCall[1]).toEqual([
        expect.objectContaining({
          type: 'tool_result',
          tool_use_id: 'tool-123',
          content: expect.stringContaining('A'),
        }),
      ]);

      expect(ensureQueryStartedSpy).toHaveBeenCalled();

      expect(emitSpy).toHaveBeenCalledWith(
        'question.injected_as_tool_result',
        expect.objectContaining({
          sessionId: testSessionId,
          toolUseId: 'tool-123',
          mode: 'submitted',
          via: 'tool_result',
        })
      );
    });

    it('queues the answer but does NOT call enqueueWithId when ensureQueryStarted is missing', async () => {
      const handlerNoStart = new AskUserQuestionHandler({
        ...mockContext,
        ensureQueryStarted: undefined,
      });

      const pendingQuestion: PendingUserQuestion = {
        toolUseId: 'tool-no-start',
        questions: [
          {
            question: 'Pick?',
            header: 'P',
            options: [{ label: 'A', description: 'A' }],
            multiSelect: false,
          },
        ],
        askedAt: Date.now(),
      };
      currentState = { status: 'waiting_for_input', pendingQuestion };

      await handlerNoStart.handleQuestionResponse('tool-no-start', [
        { questionIndex: 0, selectedLabels: ['A'] },
      ]);

      const queued = handlerNoStart.getQueuedAnswersForTesting();
      expect(queued.has('tool-no-start')).toBe(true);
      expect(queued.get('tool-no-start')!.behavior).toBe('allow');

      expect(setIdleSpy).toHaveBeenCalled();

      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      expect(ensureQueryStartedSpy).not.toHaveBeenCalled();
    });

    it('should throw on toolUseId mismatch', async () => {
      const callback = handler.createCanUseToolCallback();

      const input = {
        questions: [
          {
            question: 'Test?',
            header: 'Test',
            options: [
              { label: 'A', description: 'A' },
              { label: 'B', description: 'B' },
            ],
            multiSelect: false,
          },
        ],
      };

      const resultPromise = callback('AskUserQuestion', input, {
        signal: new AbortController().signal,
        toolUseID: 'correct-id',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await expect(
        handler.handleQuestionResponse('wrong-id', [{ questionIndex: 0, selectedLabels: ['A'] }])
      ).rejects.toThrow('Tool use ID mismatch');

      await handler.handleQuestionResponse('correct-id', [
        { questionIndex: 0, selectedLabels: ['A'] },
      ]);
      await resultPromise;
    });

    it('should format answers correctly for single select', async () => {
      const callback = handler.createCanUseToolCallback();

      const input = {
        questions: [
          {
            question: 'What is your choice?',
            header: 'Choice',
            options: [
              { label: 'Option A', description: 'First' },
              { label: 'Option B', description: 'Second' },
            ],
            multiSelect: false,
          },
        ],
      };

      const resultPromise = callback('AskUserQuestion', input, {
        signal: new AbortController().signal,
        toolUseID: 'format-test',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await handler.handleQuestionResponse('format-test', [
        { questionIndex: 0, selectedLabels: ['Option A'] },
      ]);

      const result = await resultPromise;
      expect(result.behavior).toBe('allow');
      expect(result.updatedInput).toEqual(
        expect.objectContaining({
          answers: {
            'What is your choice?': 'Option A',
          },
        })
      );
    });

    it('should format answers correctly for multi select', async () => {
      const callback = handler.createCanUseToolCallback();

      const input = {
        questions: [
          {
            question: 'Select all that apply',
            header: 'Multi',
            options: [
              { label: 'A', description: 'A' },
              { label: 'B', description: 'B' },
              { label: 'C', description: 'C' },
            ],
            multiSelect: true,
          },
        ],
      };

      const resultPromise = callback('AskUserQuestion', input, {
        signal: new AbortController().signal,
        toolUseID: 'multi-test',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await handler.handleQuestionResponse('multi-test', [
        { questionIndex: 0, selectedLabels: ['A', 'C'] },
      ]);

      const result = await resultPromise;
      expect(result.updatedInput).toEqual(
        expect.objectContaining({
          answers: {
            'Select all that apply': 'A, C',
          },
        })
      );
    });

    it('should handle custom text response', async () => {
      const callback = handler.createCanUseToolCallback();

      const input = {
        questions: [
          {
            question: 'What is your name?',
            header: 'Name',
            options: [
              { label: 'John', description: 'John' },
              { label: 'Jane', description: 'Jane' },
            ],
            multiSelect: false,
          },
        ],
      };

      const resultPromise = callback('AskUserQuestion', input, {
        signal: new AbortController().signal,
        toolUseID: 'custom-test',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await handler.handleQuestionResponse('custom-test', [
        { questionIndex: 0, selectedLabels: [], customText: 'Bob' },
      ]);

      const result = await resultPromise;
      expect(result.updatedInput).toEqual(
        expect.objectContaining({
          answers: {
            'What is your name?': 'Bob',
          },
        })
      );
    });

    it('should transition back to processing state', async () => {
      const callback = handler.createCanUseToolCallback();

      const input = {
        questions: [
          {
            question: 'Continue?',
            header: 'Confirm',
            options: [
              { label: 'Yes', description: 'Yes' },
              { label: 'No', description: 'No' },
            ],
            multiSelect: false,
          },
        ],
      };

      const resultPromise = callback('AskUserQuestion', input, {
        signal: new AbortController().signal,
        toolUseID: 'state-test',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await handler.handleQuestionResponse('state-test', [
        { questionIndex: 0, selectedLabels: ['Yes'] },
      ]);

      await resultPromise;

      expect(setProcessingSpy).toHaveBeenCalledWith('state-test', 'streaming');
    });

    it('should track resolved question in session metadata', async () => {
      const callback = handler.createCanUseToolCallback();

      const input = {
        questions: [
          {
            question: 'Track test?',
            header: 'Track',
            options: [
              { label: 'Yes', description: 'Yes' },
              { label: 'No', description: 'No' },
            ],
            multiSelect: false,
          },
        ],
      };

      const resultPromise = callback('AskUserQuestion', input, {
        signal: new AbortController().signal,
        toolUseID: 'track-test',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await handler.handleQuestionResponse('track-test', [
        { questionIndex: 0, selectedLabels: ['Yes'] },
      ]);

      await resultPromise;

      expect(updateSessionSpy).toHaveBeenCalled();
      const updateCall = updateSessionSpy.mock.calls[0];
      expect(updateCall[1].metadata.resolvedQuestions).toBeDefined();
      expect(updateCall[1].metadata.resolvedQuestions['track-test'].state).toBe('submitted');
    });

    it('should skip invalid question index', async () => {
      const callback = handler.createCanUseToolCallback();

      const input = {
        questions: [
          {
            question: 'Only question?',
            header: 'Only',
            options: [
              { label: 'A', description: 'A' },
              { label: 'B', description: 'B' },
            ],
            multiSelect: false,
          },
        ],
      };

      const resultPromise = callback('AskUserQuestion', input, {
        signal: new AbortController().signal,
        toolUseID: 'skip-test',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await handler.handleQuestionResponse('skip-test', [
        { questionIndex: 99, selectedLabels: ['A'] },
      ]);

      const result = await resultPromise;
      expect(result.behavior).toBe('allow');
    });
  });

  describe('handleQuestionCancel', () => {
    it('should throw when not waiting for input', async () => {
      currentState = { status: 'idle' };

      await expect(handler.handleQuestionCancel('tool-123')).rejects.toThrow(
        'agent is not waiting for input'
      );
    });

    it('should queue deny + inject cancellation tool_result when no pending resolver', async () => {
      const pendingQuestion: PendingUserQuestion = {
        toolUseId: 'tool-123',
        questions: [
          {
            question: 'Test?',
            header: 'Test',
            options: [{ label: 'A', description: 'A' }],
            multiSelect: false,
          },
        ],
        askedAt: Date.now(),
      };
      currentState = { status: 'waiting_for_input', pendingQuestion };

      await handler.handleQuestionCancel('tool-123');

      expect(updateSessionSpy).toHaveBeenCalled();
      const updateCall = updateSessionSpy.mock.calls[0];
      expect(updateCall[1].metadata.resolvedQuestions['tool-123'].state).toBe('cancelled');
      expect(updateCall[1].metadata.resolvedQuestions['tool-123'].cancelReason).toBe(
        'user_cancelled'
      );

      expect(setIdleSpy).toHaveBeenCalled();

      const queued = handler.getQueuedAnswersForTesting();
      expect(queued.has('tool-123')).toBe(true);
      expect(queued.get('tool-123')!.behavior).toBe('deny');

      expect(enqueueWithIdSpy).toHaveBeenCalled();
      expect(ensureQueryStartedSpy).toHaveBeenCalled();
      expect(emitSpy).toHaveBeenCalledWith(
        'question.injected_as_tool_result',
        expect.objectContaining({
          mode: 'cancelled',
          via: 'tool_result',
        })
      );
    });

    it('should throw on toolUseId mismatch', async () => {
      const callback = handler.createCanUseToolCallback();

      const input = {
        questions: [
          {
            question: 'Test?',
            header: 'Test',
            options: [
              { label: 'A', description: 'A' },
              { label: 'B', description: 'B' },
            ],
            multiSelect: false,
          },
        ],
      };

      const resultPromise = callback('AskUserQuestion', input, {
        signal: new AbortController().signal,
        toolUseID: 'correct-id',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await expect(handler.handleQuestionCancel('wrong-id')).rejects.toThrow(
        'Tool use ID mismatch'
      );

      await handler.handleQuestionCancel('correct-id');
      await resultPromise;
    });

    it('should deny tool and provide cancellation message', async () => {
      const callback = handler.createCanUseToolCallback();

      const input = {
        questions: [
          {
            question: 'Proceed?',
            header: 'Confirm',
            options: [
              { label: 'Yes', description: 'Yes' },
              { label: 'No', description: 'No' },
            ],
            multiSelect: false,
          },
        ],
      };

      const resultPromise = callback('AskUserQuestion', input, {
        signal: new AbortController().signal,
        toolUseID: 'cancel-test',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await handler.handleQuestionCancel('cancel-test');

      const result = await resultPromise;
      expect(result.behavior).toBe('deny');
      expect(result.message).toContain('cancelled');
    });

    it('should track cancelled question in session metadata', async () => {
      const callback = handler.createCanUseToolCallback();

      const input = {
        questions: [
          {
            question: 'Cancel track test?',
            header: 'CancelTrack',
            options: [
              { label: 'A', description: 'A' },
              { label: 'B', description: 'B' },
            ],
            multiSelect: false,
          },
        ],
      };

      const resultPromise = callback('AskUserQuestion', input, {
        signal: new AbortController().signal,
        toolUseID: 'cancel-track-test',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await handler.handleQuestionCancel('cancel-track-test');

      await resultPromise;

      expect(updateSessionSpy).toHaveBeenCalled();
      const updateCall = updateSessionSpy.mock.calls[0];
      expect(updateCall[1].metadata.resolvedQuestions).toBeDefined();
      expect(updateCall[1].metadata.resolvedQuestions['cancel-track-test'].state).toBe('cancelled');
    });

    it('should transition to processing state after cancel', async () => {
      const callback = handler.createCanUseToolCallback();

      const input = {
        questions: [
          {
            question: 'State test?',
            header: 'State',
            options: [
              { label: 'A', description: 'A' },
              { label: 'B', description: 'B' },
            ],
            multiSelect: false,
          },
        ],
      };

      const resultPromise = callback('AskUserQuestion', input, {
        signal: new AbortController().signal,
        toolUseID: 'state-cancel-test',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await handler.handleQuestionCancel('state-cancel-test');

      await resultPromise;

      expect(setProcessingSpy).toHaveBeenCalledWith('state-cancel-test', 'streaming');
    });
  });

  describe('updateQuestionDraft', () => {
    it('should delegate to state manager', async () => {
      const draftResponses = [{ questionIndex: 0, selectedLabels: ['A'] }];

      await handler.updateQuestionDraft(draftResponses);

      expect(updateQuestionDraftSpy).toHaveBeenCalledWith(draftResponses);
    });
  });

  describe('cleanup', () => {
    it('should reject pending resolver on cleanup', async () => {
      const callback = handler.createCanUseToolCallback();

      const input = {
        questions: [
          {
            question: 'Test?',
            header: 'Test',
            options: [
              { label: 'A', description: 'A' },
              { label: 'B', description: 'B' },
            ],
            multiSelect: false,
          },
        ],
      };

      const resultPromise = callback('AskUserQuestion', input, {
        signal: new AbortController().signal,
        toolUseID: 'cleanup-test',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      handler.cleanup();

      await expect(resultPromise).rejects.toThrow('Session cleanup');
    });

    it('should be safe to call cleanup when no pending resolver', () => {
      expect(() => handler.cleanup()).not.toThrow();
    });
  });

  describe('markQuestionOrphaned', () => {
    it('returns false when no question is pending', async () => {
      currentState = { status: 'idle' };
      const result = await handler.markQuestionOrphaned();
      expect(result).toBe(false);
      expect(emitSpy).not.toHaveBeenCalledWith('question.orphaned', expect.any(Object));
    });

    it('flips waiting_for_input to cancelled with agent_session_terminated reason', async () => {
      const pendingQuestion: PendingUserQuestion = {
        toolUseId: 'orphan-tool-1',
        questions: [
          {
            question: 'Pending?',
            header: 'Pending',
            options: [{ label: 'A', description: 'A' }],
            multiSelect: false,
          },
        ],
        askedAt: Date.now(),
      };
      currentState = { status: 'waiting_for_input', pendingQuestion };

      const result = await handler.markQuestionOrphaned('agent_session_terminated');
      expect(result).toBe(true);

      expect(updateSessionSpy).toHaveBeenCalled();
      const updateCall = updateSessionSpy.mock.calls[0];
      expect(updateCall[1].metadata.resolvedQuestions['orphan-tool-1'].state).toBe('cancelled');
      expect(updateCall[1].metadata.resolvedQuestions['orphan-tool-1'].cancelReason).toBe(
        'agent_session_terminated'
      );

      expect(setIdleSpy).toHaveBeenCalled();

      expect(emitSpy).toHaveBeenCalledWith(
        'question.orphaned',
        expect.objectContaining({
          sessionId: testSessionId,
          toolUseId: 'orphan-tool-1',
          reason: 'agent_session_terminated',
        })
      );
    });

    it('records rehydrate_failed reason when passed', async () => {
      const pendingQuestion: PendingUserQuestion = {
        toolUseId: 'orphan-tool-2',
        questions: [
          {
            question: '?',
            header: 'X',
            options: [{ label: 'A', description: 'A' }],
            multiSelect: false,
          },
        ],
        askedAt: Date.now(),
      };
      currentState = { status: 'waiting_for_input', pendingQuestion };

      await handler.markQuestionOrphaned('rehydrate_failed');

      const updateCall = updateSessionSpy.mock.calls[0];
      expect(updateCall[1].metadata.resolvedQuestions['orphan-tool-2'].cancelReason).toBe(
        'agent_session_terminated'
      );
      expect(emitSpy).toHaveBeenCalledWith(
        'question.orphaned',
        expect.objectContaining({ reason: 'rehydrate_failed' })
      );
    });

    it('clears any queued answers and rejects in-memory resolvers', async () => {
      const callback = handler.createCanUseToolCallback();
      const input = {
        questions: [
          {
            question: 'Test?',
            header: 'T',
            options: [
              { label: 'A', description: 'A' },
              { label: 'B', description: 'B' },
            ],
            multiSelect: false,
          },
        ],
      };
      const resultPromise = callback('AskUserQuestion', input, {
        signal: new AbortController().signal,
        toolUseID: 'orphan-with-resolver',
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      await handler.markQuestionOrphaned('agent_session_terminated');

      await expect(resultPromise).rejects.toThrow(/orphaned/i);

      expect(handler.getQueuedAnswersForTesting().has('orphan-with-resolver')).toBe(false);
    });
  });

  describe('createCanUseToolCallback queued-answer fast path', () => {
    it('consumes a queued allow without re-prompting and emits via=can_use_tool', async () => {
      const pendingQuestion: PendingUserQuestion = {
        toolUseId: 'replay-tool',
        questions: [
          {
            question: 'Pick?',
            header: 'P',
            options: [{ label: 'A', description: 'A' }],
            multiSelect: false,
          },
        ],
        askedAt: Date.now(),
      };
      currentState = { status: 'waiting_for_input', pendingQuestion };

      await handler.handleQuestionResponse('replay-tool', [
        { questionIndex: 0, selectedLabels: ['A'] },
      ]);

      currentState = { status: 'idle' };
      emitSpy.mockClear();
      setWaitingForInputSpy.mockClear();

      const callback = handler.createCanUseToolCallback();
      const result = await callback(
        'AskUserQuestion',
        { questions: pendingQuestion.questions },
        { signal: new AbortController().signal, toolUseID: 'replay-tool' }
      );

      expect(setWaitingForInputSpy).not.toHaveBeenCalled();

      expect(result.behavior).toBe('allow');
      expect(
        (result as { updatedInput: { answers: Record<string, string> } }).updatedInput.answers
      ).toEqual({ 'Pick?': 'A' });

      expect(emitSpy).toHaveBeenCalledWith(
        'question.injected_as_tool_result',
        expect.objectContaining({
          toolUseId: 'replay-tool',
          mode: 'submitted',
          via: 'can_use_tool',
        })
      );

      expect(handler.getQueuedAnswersForTesting().has('replay-tool')).toBe(false);
    });

    it('consumes a queued deny without re-prompting', async () => {
      const pendingQuestion: PendingUserQuestion = {
        toolUseId: 'replay-cancel',
        questions: [
          {
            question: 'Skip?',
            header: 'S',
            options: [{ label: 'A', description: 'A' }],
            multiSelect: false,
          },
        ],
        askedAt: Date.now(),
      };
      currentState = { status: 'waiting_for_input', pendingQuestion };

      await handler.handleQuestionCancel('replay-cancel');

      currentState = { status: 'idle' };
      setWaitingForInputSpy.mockClear();

      const callback = handler.createCanUseToolCallback();
      const result = await callback(
        'AskUserQuestion',
        { questions: pendingQuestion.questions },
        { signal: new AbortController().signal, toolUseID: 'replay-cancel' }
      );

      expect(setWaitingForInputSpy).not.toHaveBeenCalled();
      expect(result.behavior).toBe('deny');
      expect((result as { message: string }).message).toMatch(/cancel/i);
    });
  });

  describe('createPreToolUseHook (bypassPermissions interception channel)', () => {
    const SIGNAL = new AbortController().signal;
    const makeInput = (questionText = 'Pick?') => ({
      questions: [
        {
          question: questionText,
          header: 'Pick',
          options: [
            { label: 'A', description: 'First' },
            { label: 'B', description: 'Second' },
          ],
          multiSelect: false,
        },
      ],
    });
    const hookInput = (toolName: string, toolInput: unknown, toolUseId: string) =>
      ({
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: toolInput,
        tool_use_id: toolUseId,
        session_id: testSessionId,
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/tmp/repo',
      }) as Parameters<ReturnType<AskUserQuestionHandler['createPreToolUseHook']>>[0];

    it('passes non-AskUserQuestion tools through with no permission decision', async () => {
      const hook = handler.createPreToolUseHook();
      const result = await hook(hookInput('Bash', { command: 'ls' }, 'tool-x'), 'tool-x', {
        signal: SIGNAL,
      });
      expect(result).toEqual({});
      expect(setWaitingForInputSpy).not.toHaveBeenCalled();
    });

    it('intercepts AskUserQuestion, surfaces the card, and resolves allow+updatedInput on submit (the canUseTool callback is never consulted under bypassPermissions)', async () => {
      const hook = handler.createPreToolUseHook();
      const pending = hook(hookInput('AskUserQuestion', makeInput(), 'hook-1'), 'hook-1', {
        signal: SIGNAL,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(setWaitingForInputSpy).toHaveBeenCalledWith(
        expect.objectContaining({ toolUseId: 'hook-1' })
      );
      expect(currentState.status).toBe('waiting_for_input');

      await handler.handleQuestionResponse('hook-1', [{ questionIndex: 0, selectedLabels: ['A'] }]);

      const result = (await pending) as {
        hookSpecificOutput: {
          permissionDecision: string;
          updatedInput?: { answers?: Record<string, string> };
        };
      };
      expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
      expect(result.hookSpecificOutput.updatedInput?.answers).toEqual({ 'Pick?': 'A' });
    });

    it('resolves deny + permissionDecisionReason on user cancel', async () => {
      const hook = handler.createPreToolUseHook();
      const pending = hook(hookInput('AskUserQuestion', makeInput(), 'hook-2'), 'hook-2', {
        signal: SIGNAL,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      await handler.handleQuestionCancel('hook-2');

      const result = (await pending) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
      };
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason).toMatch(/User cancelled/);
    });

    it('consumes a queued answer without re-prompting (restart survival)', async () => {
      currentState = {
        status: 'waiting_for_input',
        pendingQuestion: { toolUseId: 'hook-3', questions: [], askedAt: Date.now() },
      };
      await handler.handleQuestionCancel('hook-3');
      expect(handler.getQueuedAnswersForTesting().has('hook-3')).toBe(true);
      currentState = { status: 'idle' };
      setWaitingForInputSpy.mockClear();

      const hook = handler.createPreToolUseHook();
      const result = (await hook(hookInput('AskUserQuestion', makeInput(), 'hook-3'), 'hook-3', {
        signal: SIGNAL,
      })) as { hookSpecificOutput: { permissionDecision: string } };

      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(setWaitingForInputSpy).not.toHaveBeenCalled();
      expect(emitSpy).toHaveBeenCalledWith(
        'question.injected_as_tool_result',
        expect.objectContaining({
          toolUseId: 'hook-3',
          mode: 'cancelled',
          via: 'pre_tool_use_hook',
        })
      );
    });

    it('denies malformed input (single-option question violates the SDK schema on the hook channel)', async () => {
      const hook = handler.createPreToolUseHook();
      const malformed = {
        questions: [
          {
            question: 'One option only',
            header: 'X',
            options: [{ label: 'A', description: 'A' }],
            multiSelect: false,
          },
        ],
      };
      const result = (await hook(hookInput('AskUserQuestion', malformed, 'hook-4'), 'hook-4', {
        signal: SIGNAL,
      })) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
      };

      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason).toMatch(/malformed/);
      expect(setWaitingForInputSpy).not.toHaveBeenCalled();

      const callback = handler.createCanUseToolCallback();
      const pending = callback('AskUserQuestion', malformed, {
        signal: SIGNAL,
        toolUseID: 'hook-4b',
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(setWaitingForInputSpy).toHaveBeenCalledWith(
        expect.objectContaining({ toolUseId: 'hook-4b' })
      );
      await handler.handleQuestionResponse('hook-4b', [
        { questionIndex: 0, selectedLabels: ['A'] },
      ]);
      const cuResult = (await pending) as { behavior: string };
      expect(cuResult.behavior).toBe('allow');
    });

    it('truncates oversized question strings in the persisted card and keys answers by the raw question text', async () => {
      const rawQuestion = 'Q'.repeat(2500);
      const hook = handler.createPreToolUseHook();
      const pending = hook(
        hookInput('AskUserQuestion', makeInput(rawQuestion), 'hook-5'),
        'hook-5',
        {
          signal: SIGNAL,
        }
      );

      await new Promise((resolve) => setTimeout(resolve, 10));
      const persisted = setWaitingForInputSpy.mock.calls[0][0] as PendingUserQuestion;
      expect(persisted.questions[0].question.length).toBe(2000);

      await handler.handleQuestionResponse('hook-5', [{ questionIndex: 0, selectedLabels: ['A'] }]);

      const result = (await pending) as {
        hookSpecificOutput: { updatedInput?: { answers?: Record<string, string> } };
      };
      expect(Object.keys(result.hookSpecificOutput.updatedInput?.answers ?? {})).toEqual([
        rawQuestion,
      ]);
    });

    it('dedupes a same-toolUseId re-entry from the other channel onto the shared promise', async () => {
      const hook = handler.createPreToolUseHook();
      const callback = handler.createCanUseToolCallback();
      const input = makeInput();

      const viaHook = hook(hookInput('AskUserQuestion', input, 'hook-6'), 'hook-6', {
        signal: SIGNAL,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const viaCallback = callback('AskUserQuestion', input, {
        signal: SIGNAL,
        toolUseID: 'hook-6',
      });

      expect(setWaitingForInputSpy).toHaveBeenCalledTimes(1);
      await handler.handleQuestionResponse('hook-6', [{ questionIndex: 0, selectedLabels: ['B'] }]);

      const hookResult = (await viaHook) as {
        hookSpecificOutput: { updatedInput?: { answers?: Record<string, string> } };
      };
      const callbackResult = (await viaCallback) as {
        updatedInput?: { answers?: Record<string, string> };
      };
      expect(hookResult.hookSpecificOutput.updatedInput?.answers).toEqual({ 'Pick?': 'B' });
      expect(callbackResult.updatedInput?.answers).toEqual({ 'Pick?': 'B' });
    });

    it('denies the older question when a newer AskUserQuestion supersedes it', async () => {
      const hook = handler.createPreToolUseHook();
      const older = hook(hookInput('AskUserQuestion', makeInput('Old?'), 'hook-7a'), 'hook-7a', {
        signal: SIGNAL,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const newer = hook(hookInput('AskUserQuestion', makeInput('New?'), 'hook-7b'), 'hook-7b', {
        signal: SIGNAL,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const olderResult = (await older) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
      };
      expect(olderResult.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(olderResult.hookSpecificOutput.permissionDecisionReason).toMatch(/Superseded/);

      await handler.handleQuestionResponse('hook-7b', [
        { questionIndex: 0, selectedLabels: ['A'] },
      ]);
      const newerResult = (await newer) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(newerResult.hookSpecificOutput.permissionDecision).toBe('allow');
    });

    it('drops the question.asked event when a question is superseded while setWaitingForInput is in flight', async () => {
      let releaseFirst: (() => void) | undefined;
      const setWaitingForInput = mock(async (pendingQuestion: PendingUserQuestion) => {
        currentState = { status: 'waiting_for_input', pendingQuestion };
        if (pendingQuestion.toolUseId === 'superseded-in-flight') {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
      });

      const h = new AskUserQuestionHandler({
        ...mockContext,
        stateManager: {
          ...mockStateManager,
          setWaitingForInput,
        } as unknown as ProcessingStateManager,
      });

      const input = (text: string) => ({
        questions: [
          {
            question: text,
            header: text,
            options: [{ label: 'A', description: 'A' }],
            multiSelect: false,
          },
        ],
      });
      const firstPromise = h.createCanUseToolCallback()('AskUserQuestion', input('Old?'), {
        signal: new AbortController().signal,
        toolUseID: 'superseded-in-flight',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      h.createCanUseToolCallback()('AskUserQuestion', input('New?'), {
        signal: new AbortController().signal,
        toolUseID: 'winner-in-flight',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      if (currentState.status === 'waiting_for_input') {
        expect(currentState.pendingQuestion.toolUseId).toBe('winner-in-flight');
      }

      const askedEvents = (
        emitSpy.mock.calls as [string, { pendingQuestion: PendingUserQuestion }][]
      ).filter(([event]) => event === 'question.asked');
      expect(askedEvents.map(([_, payload]) => payload.pendingQuestion.toolUseId)).toEqual([
        'winner-in-flight',
      ]);

      releaseFirst?.();

      const firstResult = await firstPromise;
      expect(firstResult.behavior).toBe('deny');
      expect((firstResult as { message: string }).message).toMatch(/Superseded/);
      if (currentState.status === 'waiting_for_input') {
        expect(currentState.pendingQuestion.toolUseId).toBe('winner-in-flight');
      }
    });

    it('preserves a response that arrives while setWaitingForInput is still publishing', async () => {
      let releaseFirst: (() => void) | undefined;
      const setWaitingForInput = mock(async (pendingQuestion: PendingUserQuestion) => {
        currentState = { status: 'waiting_for_input', pendingQuestion };
        if (pendingQuestion.toolUseId === 'response-in-flight') {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
      });
      const setProcessing = mock(async (messageId: string) => {
        currentState = { status: 'processing', messageId, phase: 'streaming' };
      });

      const h = new AskUserQuestionHandler({
        ...mockContext,
        stateManager: {
          ...mockStateManager,
          setWaitingForInput,
          setProcessing,
        } as unknown as ProcessingStateManager,
      });

      const input = {
        questions: [
          {
            question: 'In flight?',
            header: 'In flight?',
            options: [{ label: 'A', description: 'A' }],
            multiSelect: false,
          },
        ],
      };
      const resultPromise = h.createCanUseToolCallback()('AskUserQuestion', input, {
        signal: new AbortController().signal,
        toolUseID: 'response-in-flight',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      await h.handleQuestionResponse('response-in-flight', [
        { questionIndex: 0, selectedLabels: ['A'] },
      ]);

      releaseFirst?.();

      const result = await resultPromise;
      expect(result.behavior).toBe('allow');

      const askedEvents = (
        emitSpy.mock.calls as [string, { pendingQuestion: PendingUserQuestion }][]
      ).filter(([event]) => event === 'question.asked');
      expect(askedEvents).toHaveLength(0);
    });

    it('settles dead-attempt submits and cancels with deny without mutating the successor state', async () => {
      const input = {
        questions: [
          {
            question: 'Still live?',
            header: 'Still live?',
            options: [{ label: 'A', description: 'A' }],
            multiSelect: false,
          },
        ],
      };
      const ask = (h: AskUserQuestionHandler, token: { isLive(): boolean }, toolUseId: string) =>
        h.createCanUseToolCallback(token)('AskUserQuestion', input, {
          signal: new AbortController().signal,
          toolUseID: toolUseId,
        });

      const submitHandler = new AskUserQuestionHandler(mockContext);
      let submitLive = true;
      const submitPromise = ask(submitHandler, { isLive: () => submitLive }, 'attempt-dead-submit');
      await new Promise((resolve) => setTimeout(resolve, 10));
      submitLive = false;
      await submitHandler.handleQuestionResponse('attempt-dead-submit', [
        { questionIndex: 0, selectedLabels: ['A'] },
      ]);
      expect(setProcessingSpy).not.toHaveBeenCalled();
      expect(currentState.status).toBe('waiting_for_input');
      const submitResult = await submitPromise;
      expect(submitResult.behavior).toBe('deny');
      expect((submitResult as { message: string }).message).toContain('superseded');

      currentState = { status: 'idle' };

      const cancelHandler = new AskUserQuestionHandler(mockContext);
      let cancelLive = true;
      const cancelPromise = ask(cancelHandler, { isLive: () => cancelLive }, 'attempt-dead-cancel');
      await new Promise((resolve) => setTimeout(resolve, 10));
      cancelLive = false;
      await cancelHandler.handleQuestionCancel('attempt-dead-cancel');
      expect(setProcessingSpy).not.toHaveBeenCalled();
      expect(currentState.status).toBe('waiting_for_input');
      const cancelResult = await cancelPromise;
      expect(cancelResult.behavior).toBe('deny');
      expect((cancelResult as { message: string }).message).toContain('User cancelled');
    });

    it("patches the history record to cancelled when a superseded question's submit is dropped", async () => {
      const hook = handler.createPreToolUseHook();
      const first = hook(hookInput('AskUserQuestion', makeInput('First?'), 'hook-8a'), 'hook-8a', {
        signal: SIGNAL,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const second = hook(
        hookInput('AskUserQuestion', makeInput('Second?'), 'hook-8b'),
        'hook-8b',
        {
          signal: SIGNAL,
        }
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      await first;

      currentState = {
        status: 'waiting_for_input',
        pendingQuestion: {
          toolUseId: 'hook-8a',
          questions: [],
          askedAt: Date.now(),
        },
      };
      await handler.handleQuestionResponse('hook-8a', [
        { questionIndex: 0, selectedLabels: ['A'] },
      ]);

      const resolved = mockSession.metadata?.resolvedQuestions?.['hook-8a'];
      expect(resolved?.state).toBe('cancelled');

      currentState = {
        status: 'waiting_for_input',
        pendingQuestion: {
          toolUseId: 'hook-8b',
          questions: [],
          askedAt: Date.now(),
        },
      };
      await handler.handleQuestionResponse('hook-8b', [
        { questionIndex: 0, selectedLabels: ['A'] },
      ]);
      const newerResult = (await second) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(newerResult.hookSpecificOutput.permissionDecision).toBe('allow');
    });
  });
});
