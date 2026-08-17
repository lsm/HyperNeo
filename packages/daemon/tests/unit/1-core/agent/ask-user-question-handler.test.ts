/**
 * AskUserQuestionHandler Tests
 *
 * Tests the handling of the AskUserQuestion tool via canUseTool callback.
 */

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

    // Create mock DaemonHub
    emitSpy = mock(async () => {});
    mockInternalEventBus = {
      publish: emitSpy,
      publishAsync: emitSpy,
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;
    mockDaemonHub = {
      emit: emitSpy,
    } as unknown as DaemonHub;

    // Create mock ProcessingStateManager
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

    // Create mock Database
    updateSessionSpy = mock(() => {});
    mockDb = {
      updateSession: updateSessionSpy,
    } as unknown as Database;

    // Create mock MessageQueue
    enqueueWithIdSpy = mock(async () => {});
    mockMessageQueue = {
      enqueueWithId: enqueueWithIdSpy,
    } as unknown as MessageQueue;

    // Create mock session
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

    // Create context
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

      // Start the callback but don't await - it will block waiting for user input
      const resultPromise = callback('AskUserQuestion', input, {
        signal: new AbortController().signal,
        toolUseID: 'tool-123',
      });

      // Give the callback time to set up
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should have transitioned to waiting_for_input
      expect(setWaitingForInputSpy).toHaveBeenCalled();
      expect(emitSpy).toHaveBeenCalledWith('question.asked', expect.any(Object));

      // Simulate user response to unblock
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

      // Verify the pending question uses SDK's toolUseID
      expect(setWaitingForInputSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolUseId: toolUseID,
        })
      );

      // Respond with matching toolUseId
      await handler.handleQuestionResponse(toolUseID, [
        { questionIndex: 0, selectedLabels: ['Yes'] },
      ]);

      await resultPromise;
    });

    it('allows a single-option AskUserQuestion via the canUseTool channel (ACP has no min-2 contract)', async () => {
      const callback = handler.createCanUseToolCallback();

      // The @minItems 2 guard is enforced on the PreToolUse hook channel only;
      // the canUseTool channel also feeds ACP permission input, which maps
      // params.options directly and has NO min-2 contract — a 1-option request
      // must prompt, not be denied (denial auto-cancels a legitimate prompt).
      const resultPromise = callback(
        'AskUserQuestion',
        {
          questions: [
            {
              question: 'Approve?',
              header: 'ACP approval',
              options: [{ label: 'Allow', description: 'allow' }],
              multiSelect: false,
            },
          ],
        },
        { signal: new AbortController().signal, toolUseID: 'acp-1' }
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Not denied — the interception proceeded to prompt.
      expect(setWaitingForInputSpy).toHaveBeenCalled();

      await handler.handleQuestionResponse('acp-1', [
        { questionIndex: 0, selectedLabels: ['Allow'] },
      ]);
      const result = (await resultPromise) as { behavior: string };
      expect(result.behavior).toBe('allow');

      // Same asymmetry on the max: ACP can legitimately offer >4 options, so
      // the canUseTool channel must not deny a >4-option request either.
      const manyOptions = Array.from({ length: 6 }, (_, i) => ({
        label: `O${i}`,
        description: `O${i}`,
      }));
      const manyResultPromise = callback(
        'AskUserQuestion',
        {
          questions: [
            { question: 'Pick many?', header: 'ACP', options: manyOptions, multiSelect: false },
          ],
        },
        { signal: new AbortController().signal, toolUseID: 'acp-2' }
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(setWaitingForInputSpy).toHaveBeenCalledTimes(2);
      await handler.handleQuestionCancel('acp-2');
      const manyResult = (await manyResultPromise) as { behavior: string };
      expect(manyResult.behavior).toBe('deny');
    });
  });

  describe('createPreToolUseHook', () => {
    // The PreToolUse hook is the PRIMARY AskUserQuestion interception channel:
    // the CLI invokes it in every permission mode — including
    // bypassPermissions, where the canUseTool callback is shadowed by
    // auto-approval — and an allow decision carrying updatedInput with the
    // answers satisfies the tool's user-interaction requirement.
    const askInput = {
      questions: [
        {
          question: 'What is your favorite color?',
          header: 'Color',
          options: [
            { label: 'Red', description: 'Red' },
            { label: 'Blue', description: 'Blue' },
          ],
          multiSelect: false,
        },
      ],
    };

    function preToolUseInput(toolName: string, toolUseId: string) {
      return {
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: toolName === 'AskUserQuestion' ? askInput : { command: 'ls' },
        tool_use_id: toolUseId,
      };
    }

    it('intercepts AskUserQuestion, waits for the user, and resolves with an allow+answers envelope', async () => {
      const hook = handler.createPreToolUseHook();

      const resultPromise = hook(preToolUseInput('AskUserQuestion', 'hook-tool-1'), 'hook-tool-1', {
        signal: new AbortController().signal,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Question surfaced to the UI
      expect(setWaitingForInputSpy).toHaveBeenCalledWith(
        expect.objectContaining({ toolUseId: 'hook-tool-1' })
      );
      expect(emitSpy).toHaveBeenCalledWith('question.asked', expect.any(Object));

      // User answers; the hook resolves with the hook-shaped envelope
      await handler.handleQuestionResponse('hook-tool-1', [
        { questionIndex: 0, selectedLabels: ['Blue'] },
      ]);

      const result = (await resultPromise) as {
        hookSpecificOutput: {
          hookEventName: string;
          permissionDecision: string;
          updatedInput?: Record<string, unknown>;
        };
      };
      expect(result.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
      expect(result.hookSpecificOutput.updatedInput).toEqual(
        expect.objectContaining({
          answers: { 'What is your favorite color?': 'Blue' },
        })
      );
      expect(setProcessingSpy).toHaveBeenCalledWith('hook-tool-1', 'streaming');
    });

    it('resolves with a deny envelope carrying the cancellation reason when the user skips', async () => {
      const hook = handler.createPreToolUseHook();

      const resultPromise = hook(preToolUseInput('AskUserQuestion', 'hook-tool-2'), 'hook-tool-2', {
        signal: new AbortController().signal,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      await handler.handleQuestionCancel('hook-tool-2');

      const result = (await resultPromise) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
      };
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason).toContain('cancelled');
    });

    it('passes non-AskUserQuestion tools through without touching state', async () => {
      const hook = handler.createPreToolUseHook();

      const result = (await hook(preToolUseInput('Bash', 'hook-tool-3'), 'hook-tool-3', {
        signal: new AbortController().signal,
      })) as Record<string, unknown>;

      expect(result).toEqual({});
      expect(setWaitingForInputSpy).not.toHaveBeenCalled();
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it('ignores non-PreToolUse events', async () => {
      const hook = handler.createPreToolUseHook();

      const result = (await hook(
        { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' },
        undefined,
        { signal: new AbortController().signal }
      )) as Record<string, unknown>;

      expect(result).toEqual({});
      expect(setWaitingForInputSpy).not.toHaveBeenCalled();
    });

    it('consumes a queued answer without re-prompting (restart-survival fast path)', async () => {
      // Post-restart: the persisted question was answered while no live SDK
      // query existed, so the answer sits in queuedAnswers. When the resumed
      // SDK re-issues AskUserQuestion, the hook must return it immediately.
      const pendingQuestion: PendingUserQuestion = {
        toolUseId: 'hook-replay',
        questions: [
          {
            question: 'Pick?',
            header: 'P',
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
      await handler.handleQuestionResponse('hook-replay', [
        { questionIndex: 0, selectedLabels: ['A'] },
      ]);

      currentState = { status: 'idle' };
      emitSpy.mockClear();
      setWaitingForInputSpy.mockClear();

      const hook = handler.createPreToolUseHook();
      const result = (await hook(preToolUseInput('AskUserQuestion', 'hook-replay'), 'hook-replay', {
        signal: new AbortController().signal,
      })) as {
        hookSpecificOutput: { permissionDecision: string; updatedInput?: Record<string, unknown> };
      };

      // No re-prompt — the queued answer came straight back
      expect(setWaitingForInputSpy).not.toHaveBeenCalled();
      expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
      // The merge restores the live input's schema fields alongside the
      // queued answers — on the hook channel updatedInput REPLACES the tool
      // input, so dropping the merge would ship schema-less input.
      expect(result.hookSpecificOutput.updatedInput).toEqual(
        expect.objectContaining({
          answers: { 'Pick?': 'A' },
          questions: expect.any(Array),
        })
      );
      expect(emitSpy).toHaveBeenCalledWith(
        'question.injected_as_tool_result',
        expect.objectContaining({ toolUseId: 'hook-replay', via: 'pre_tool_use_hook' })
      );
      expect(handler.getQueuedAnswersForTesting().has('hook-replay')).toBe(false);
    });

    it('denies malformed tool_input (missing questions) instead of throwing', async () => {
      const hook = handler.createPreToolUseHook();

      const result = (await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: { questions: 'not-an-array' },
          tool_use_id: 'hook-malformed',
        },
        'hook-malformed',
        { signal: new AbortController().signal }
      )) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
      };

      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason).toContain('malformed');
      expect(setWaitingForInputSpy).not.toHaveBeenCalled();

      // The questions.length >= 1 branch: an empty array is equally malformed.
      const empty = (await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: { questions: [] },
          tool_use_id: 'hook-empty',
        },
        'hook-empty',
        { signal: new AbortController().signal }
      )) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(empty.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(setWaitingForInputSpy).not.toHaveBeenCalled();
    });

    it('denies malformed tool_input (question entry without an options array)', async () => {
      const hook = handler.createPreToolUseHook();

      const result = (await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: {
            questions: [
              { question: 'Q?', header: 'H', options: 'not-an-array', multiSelect: false },
            ],
          },
          tool_use_id: 'hook-malformed-options',
        },
        'hook-malformed-options',
        { signal: new AbortController().signal }
      )) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
      };

      // q.options.map would throw one level deeper than the array guard —
      // same deny-with-reason outcome instead of an aborted tool call.
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason).toContain('malformed');
      expect(setWaitingForInputSpy).not.toHaveBeenCalled();
    });

    it('denies malformed tool_input (option entry without a label)', async () => {
      const hook = handler.createPreToolUseHook();

      // q.options.map((o) => o.label) would throw on a null / non-object /
      // label-less option — under bypass an errored hook is non-blocking, so
      // without the guard the question would proceed with no interaction and
      // no card (the silent-drop failure this PR fixes). Empty and single-
      // option arrays also deny: the SDK schema requires @minItems 2, and a
      // sub-min option list would render an unanswerable card.
      for (const options of [
        [],
        [{ label: 'A', description: 'A' }],
        [null],
        [undefined],
        [{}],
        [{ label: 42 }],
      ]) {
        const result = (await hook(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'AskUserQuestion',
            tool_input: {
              questions: [{ question: 'Q?', header: 'H', options, multiSelect: false }],
            },
            tool_use_id: 'hook-malformed-option',
          },
          'hook-malformed-option',
          { signal: new AbortController().signal }
        )) as {
          hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
        };
        expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(result.hookSpecificOutput.permissionDecisionReason).toContain('malformed');
      }
      expect(setWaitingForInputSpy).not.toHaveBeenCalled();
    });

    it('denies malformed tool_input (non-boolean multiSelect, over-cap counts)', async () => {
      const hook = handler.createPreToolUseHook();

      // multiSelect must be a boolean — a model-supplied string would otherwise
      // flow untruncated into metadata + broadcast (the guard's type check is
      // the size cap for this field).
      const nonBooleanMultiSelect = {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            {
              question: 'Q?',
              header: 'H',
              options: [
                { label: 'A', description: 'A' },
                { label: 'B', description: 'B' },
              ],
              multiSelect: 'x'.repeat(5000),
            },
          ],
        },
        tool_use_id: 'hook-bad-multiselect',
      };
      const denied = (await hook(nonBooleanMultiSelect, 'hook-bad-multiselect', {
        signal: new AbortController().signal,
      })) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');

      // Questions/options counts mirror the SDK schema maxItems (4/4); hooks
      // see pre-schema-validation input, so the caps live here.
      const overCapQuestions = {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: Array.from({ length: 5 }, () => ({
            question: 'Q?',
            header: 'H',
            options: [
              { label: 'A', description: 'A' },
              { label: 'B', description: 'B' },
            ],
            multiSelect: false,
          })),
        },
        tool_use_id: 'hook-many-questions',
      };
      const tooMany = (await hook(overCapQuestions, 'hook-many-questions', {
        signal: new AbortController().signal,
      })) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(tooMany.hookSpecificOutput.permissionDecision).toBe('deny');

      const overCapOptions = {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            {
              question: 'Q?',
              header: 'H',
              options: Array.from({ length: 5 }, (_, i) => ({
                label: `O${i}`,
                description: `O${i}`,
              })),
              multiSelect: false,
            },
          ],
        },
        tool_use_id: 'hook-many-options',
      };
      const tooManyOptions = (await hook(overCapOptions, 'hook-many-options', {
        signal: new AbortController().signal,
      })) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(tooManyOptions.hookSpecificOutput.permissionDecision).toBe('deny');

      expect(setWaitingForInputSpy).not.toHaveBeenCalled();
    });

    it('truncates over-long question strings when building the UI structure', async () => {
      const hook = handler.createPreToolUseHook();

      const long = 'x'.repeat(10_000);
      const resultPromise = hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: {
            questions: [
              {
                question: long,
                header: long,
                options: [
                  { label: long, description: long },
                  { label: 'B', description: 'B' },
                ],
                multiSelect: false,
              },
            ],
          },
          tool_use_id: 'hook-long',
        },
        'hook-long',
        { signal: new AbortController().signal }
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      // The UI structure (persisted to metadata + broadcast) is capped so a
      // model-supplied multi-MB string cannot bloat the DB or amplify to every
      // connected client. Assert the guard allowed the call through first — a
      // guard regression would surface as a clear failure, not a TypeError.
      expect(setWaitingForInputSpy).toHaveBeenCalled();
      const pendingQuestion = setWaitingForInputSpy.mock.calls[0]?.[0] as {
        questions: Array<{
          question: string;
          header: string;
          options: Array<{ label: string; description: string }>;
        }>;
      };
      expect(pendingQuestion.questions[0].question.length).toBeLessThanOrEqual(2000);
      expect(pendingQuestion.questions[0].question).toBe('x'.repeat(2000));
      expect(pendingQuestion.questions[0].header).toBe('x'.repeat(2000));
      expect(pendingQuestion.questions[0].options[0].label).toBe('x'.repeat(2000));
      expect(pendingQuestion.questions[0].options[0].description).toBe('x'.repeat(2000));

      // Settle the hook promise so no dangling pending resolver leaks.
      await handler.handleQuestionCancel('hook-long');
      await resultPromise;
    });

    it('keys answers by the raw question text, not the truncated UI copy', async () => {
      const hook = handler.createPreToolUseHook();

      // A >2000-char question: the UI copy is truncated, but the live path
      // returns updatedInput: {...resolver.input, answers} where resolver.input
      // holds the original text — the SDK looks answers up by THAT key, so the
      // answers map must key by the raw text or the answer is silently dropped.
      const rawQuestion = 'Q' + 'x'.repeat(3000);
      const resultPromise = hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: {
            questions: [
              {
                question: rawQuestion,
                header: 'H',
                options: [
                  { label: 'A', description: 'A' },
                  { label: 'B', description: 'B' },
                ],
                multiSelect: false,
              },
            ],
          },
          tool_use_id: 'hook-raw',
        },
        'hook-raw',
        { signal: new AbortController().signal }
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      await handler.handleQuestionResponse('hook-raw', [
        { questionIndex: 0, selectedLabels: ['A'] },
      ]);

      const result = (await resultPromise) as {
        hookSpecificOutput: {
          permissionDecision: string;
          updatedInput?: { answers: Record<string, string> };
        };
      };
      expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
      // Keyed by the RAW 3000-char question text, not the 2000-char truncation.
      expect(result.hookSpecificOutput.updatedInput?.answers).toEqual({
        [rawQuestion]: 'A',
      });
      expect(result.hookSpecificOutput.updatedInput?.answers).not.toHaveProperty(
        rawQuestion.slice(0, 2000)
      );
    });

    it('settles the superseded call with a deny result when a second question arrives', async () => {
      const hook = handler.createPreToolUseHook();

      const firstPromise = hook(preToolUseInput('AskUserQuestion', 'hook-dup-1'), 'hook-dup-1', {
        signal: new AbortController().signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // A second AskUserQuestion call in the same turn replaces the first.
      const secondPromise = hook(preToolUseInput('AskUserQuestion', 'hook-dup-2'), 'hook-dup-2', {
        signal: new AbortController().signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // The first call settled with an explicit DENY (not a rejection and not
      // a hang): a rejection marshals as a channel error — non-blocking under
      // bypassPermissions — and can re-enter interception for the same
      // tool_use_id in 'default' mode, superseding the newer question.
      const first = (await firstPromise) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
      };
      expect(first.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(first.hookSpecificOutput.permissionDecisionReason).toContain('Superseded');

      // The second question is the live one and resolves normally.
      await handler.handleQuestionCancel('hook-dup-2');
      const second = (await secondPromise) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(second.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('does not cross-wire answers when a question is superseded mid-submit', async () => {
      const hook = handler.createPreToolUseHook();

      // First question is live.
      const firstPromise = hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: {
            questions: [
              {
                question: 'Pick?',
                header: 'P',
                options: [
                  { label: 'A', description: 'A' },
                  { label: 'B', description: 'B' },
                ],
                multiSelect: false,
              },
            ],
          },
          tool_use_id: 'race-1',
        },
        'race-1',
        { signal: new AbortController().signal }
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Block the processing transition so a second question can supersede
      // mid-submit.
      let releaseProcessing!: () => void;
      const processingGate = new Promise<void>((resolve) => {
        releaseProcessing = resolve;
      });
      setProcessingSpy.mockImplementationOnce(async () => {
        await processingGate;
        currentState = { status: 'processing', messageId: 'race-1', phase: 'streaming' };
      });

      // User submits the answer for race-1; it blocks inside the transition.
      const submitPromise = handler.handleQuestionResponse('race-1', [
        { questionIndex: 0, selectedLabels: ['A'] },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // The model issues a second question in the same turn; it supersedes
      // race-1's resolver while the submit is mid-transition.
      const secondPromise = hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: {
            questions: [
              {
                question: 'Pick 2?',
                header: 'P',
                options: [
                  { label: 'B', description: 'B' },
                  { label: 'C', description: 'C' },
                ],
                multiSelect: false,
              },
            ],
          },
          tool_use_id: 'race-2',
        },
        'race-2',
        { signal: new AbortController().signal }
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Release the transition: handleQuestionResponse resumes and must detect
      // the supersede instead of resolving race-2 with race-1's answers.
      releaseProcessing();
      await submitPromise;

      // race-2's resolver is still pending (NOT resolved with race-1's 'A').
      // Cancel it — its outcome is a fresh deny, proving no cross-wire.
      await handler.handleQuestionCancel('race-2');
      const second = (await secondPromise) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(second.hookSpecificOutput.permissionDecision).toBe('deny');

      // race-1 was superseded — its resolver was denied by the supersede block.
      const first = (await firstPromise) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
      };
      expect(first.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(first.hookSpecificOutput.permissionDecisionReason).toContain('Superseded');
    });

    it('does not cancel the newer question when a cancel is superseded mid-transition', async () => {
      const hook = handler.createPreToolUseHook();

      const askHookInput = (toolUseId: string, question: string, label: string) => ({
        hook_event_name: 'PreToolUse' as const,
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            {
              question,
              header: 'P',
              options: [
                { label, description: label },
                { label: 'B', description: 'B' },
              ],
              multiSelect: false,
            },
          ],
        },
        tool_use_id: toolUseId,
      });

      // First question is live.
      const firstPromise = hook(askHookInput('race-1', 'Pick?', 'A'), 'race-1', {
        signal: new AbortController().signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Block the processing transition so a second question can supersede
      // mid-cancel.
      let releaseProcessing!: () => void;
      const processingGate = new Promise<void>((resolve) => {
        releaseProcessing = resolve;
      });
      setProcessingSpy.mockImplementationOnce(async () => {
        await processingGate;
        currentState = { status: 'processing', messageId: 'race-1', phase: 'streaming' };
      });

      // User cancels race-1; it blocks inside the transition.
      const cancelPromise = handler.handleQuestionCancel('race-1');
      await new Promise((resolve) => setTimeout(resolve, 10));

      // The model issues a second question in the same turn; it supersedes
      // race-1's resolver while the cancel is mid-transition.
      const secondPromise = hook(askHookInput('race-2', 'Pick 2?', 'B'), 'race-2', {
        signal: new AbortController().signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      releaseProcessing();
      await cancelPromise;

      // race-2's resolver must STILL be pending — the superseded cancel must
      // not have resolved it with race-1's cancel intent.
      let secondSettled = false;
      secondPromise.then(() => {
        secondSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(secondSettled).toBe(false);

      // race-2 is live and cancels normally.
      await handler.handleQuestionCancel('race-2');
      const second = (await secondPromise) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(second.hookSpecificOutput.permissionDecision).toBe('deny');

      // race-1 was superseded — its resolver was denied by the supersede block.
      const first = (await firstPromise) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
      };
      expect(first.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(first.hookSpecificOutput.permissionDecisionReason).toContain('Superseded');
    });

    it('stores the resolver before the state transition so a mid-transition submit is not mis-routed', async () => {
      const hook = handler.createPreToolUseHook();

      const askHookInput = (toolUseId: string, question: string, label: string) => ({
        hook_event_name: 'PreToolUse' as const,
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            {
              question,
              header: 'P',
              options: [
                { label, description: label },
                { label: 'B', description: 'B' },
              ],
              multiSelect: false,
            },
          ],
        },
        tool_use_id: toolUseId,
      });

      // Question A is live.
      const firstPromise = hook(askHookInput('race-1', 'Pick?', 'A'), 'race-1', {
        signal: new AbortController().signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Gate setWaitingForInput so B's transition is mid-flight: the state is
      // set synchronously, the real-I/O broadcast is still pending — the exact
      // window the resolver store used to fall in.
      let releaseWaiting!: () => void;
      const waitingGate = new Promise<void>((resolve) => {
        releaseWaiting = resolve;
      });
      setWaitingForInputSpy.mockImplementationOnce(async (pendingQuestion) => {
        currentState = { status: 'waiting_for_input', pendingQuestion };
        await waitingGate;
      });

      // B's interception stores its resolver SYNCHRONOUSLY, then blocks on
      // setWaitingForInput(B).
      const secondPromise = hook(askHookInput('race-2', 'Pick 2?', 'B'), 'race-2', {
        signal: new AbortController().signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Mid-transition: a submit for B must see resolver === B (stored before
      // the await) — keyed by B's raw text and resolved normally, NOT dropped
      // or routed down the restart path against A's input.
      await handler.handleQuestionResponse('race-2', [{ questionIndex: 0, selectedLabels: ['B'] }]);

      releaseWaiting();
      await new Promise((resolve) => setTimeout(resolve, 10));

      const second = (await secondPromise) as {
        hookSpecificOutput: {
          permissionDecision: string;
          updatedInput?: { answers: Record<string, string> };
        };
      };
      expect(second.hookSpecificOutput.permissionDecision).toBe('allow');
      expect(second.hookSpecificOutput.updatedInput?.answers).toEqual({ 'Pick 2?': 'B' });

      // race-1 was superseded by race-2 — denied by the supersede block.
      const first = (await firstPromise) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
      };
      expect(first.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(first.hookSpecificOutput.permissionDecisionReason).toContain('Superseded');
    });

    it('clears the stored resolver and rethrows when setWaitingForInput fails', async () => {
      setWaitingForInputSpy.mockImplementationOnce(async () => {
        throw new Error('db write failed');
      });
      const hook = handler.createPreToolUseHook();

      const input = {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            {
              question: 'Q?',
              header: 'H',
              options: [
                { label: 'A', description: 'A' },
                { label: 'B', description: 'B' },
              ],
              multiSelect: false,
            },
          ],
        },
        tool_use_id: 'hook-fail',
      };
      await expect(
        hook(input, 'hook-fail', { signal: new AbortController().signal })
      ).rejects.toThrow('db write failed');

      // No stale resolver: a fresh interception for the same toolUseId
      // proceeds (prompts again) and resolves normally.
      const second = hook(input, 'hook-fail', { signal: new AbortController().signal });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(setWaitingForInputSpy).toHaveBeenCalledTimes(2);
      await handler.handleQuestionCancel('hook-fail');
      const secondResult = (await second) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(secondResult.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('drops a submit for a question whose resolver was superseded (does not queue to restart path)', async () => {
      const hook = handler.createPreToolUseHook();
      const askHookInput = (toolUseId: string, question: string, label: string) => ({
        hook_event_name: 'PreToolUse' as const,
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            {
              question,
              header: 'P',
              options: [
                { label, description: label },
                { label: 'B', description: 'B' },
              ],
              multiSelect: false,
            },
          ],
        },
        tool_use_id: toolUseId,
      });

      // Question A is live (state = race-1, resolver = race-1).
      const firstPromise = hook(askHookInput('race-1', 'Pick?', 'A'), 'race-1', {
        signal: new AbortController().signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // B's interception stores resolver = race-2 but its setWaitingForInput
      // is gated and does NOT update state — so state = race-1 while the
      // resolver = race-2 (the shifted-window state the drop branch guards).
      let releaseWaiting!: () => void;
      const waitingGate = new Promise<void>((resolve) => {
        releaseWaiting = resolve;
      });
      setWaitingForInputSpy.mockImplementationOnce(async (pendingQuestion) => {
        await waitingGate;
        currentState = { status: 'waiting_for_input', pendingQuestion };
      });
      const secondPromise = hook(askHookInput('race-2', 'Pick 2?', 'C'), 'race-2', {
        signal: new AbortController().signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Submit for race-1: a resolver exists (race-2) but does not match — the
      // submit is DROPPED, not queued down the restart path.
      await handler.handleQuestionResponse('race-1', [{ questionIndex: 0, selectedLabels: ['A'] }]);
      expect(handler.getQueuedAnswersForTesting().size).toBe(0);

      releaseWaiting();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // race-2 is the live question and resolves normally.
      await handler.handleQuestionCancel('race-2');
      const second = (await secondPromise) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(second.hookSpecificOutput.permissionDecision).toBe('deny');

      // race-1 was superseded by race-2 — denied by the supersede block.
      const first = (await firstPromise) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
      };
      expect(first.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(first.hookSpecificOutput.permissionDecisionReason).toContain('Superseded');
    });

    it('drops a cancel for a question whose resolver was superseded (does not queue to restart path)', async () => {
      const hook = handler.createPreToolUseHook();
      const askHookInput = (toolUseId: string, question: string, label: string) => ({
        hook_event_name: 'PreToolUse' as const,
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            {
              question,
              header: 'P',
              options: [
                { label, description: label },
                { label: 'B', description: 'B' },
              ],
              multiSelect: false,
            },
          ],
        },
        tool_use_id: toolUseId,
      });

      const firstPromise = hook(askHookInput('race-1', 'Pick?', 'A'), 'race-1', {
        signal: new AbortController().signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      let releaseWaiting!: () => void;
      const waitingGate = new Promise<void>((resolve) => {
        releaseWaiting = resolve;
      });
      setWaitingForInputSpy.mockImplementationOnce(async (pendingQuestion) => {
        await waitingGate;
        currentState = { status: 'waiting_for_input', pendingQuestion };
      });
      const secondPromise = hook(askHookInput('race-2', 'Pick 2?', 'C'), 'race-2', {
        signal: new AbortController().signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Cancel for race-1: resolver = race-2 (mismatch) — the cancel is DROPPED.
      await handler.handleQuestionCancel('race-1');
      expect(handler.getQueuedAnswersForTesting().size).toBe(0);

      releaseWaiting();
      await new Promise((resolve) => setTimeout(resolve, 10));

      await handler.handleQuestionCancel('race-2');
      const second = (await secondPromise) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(second.hookSpecificOutput.permissionDecision).toBe('deny');

      const first = (await firstPromise) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
      };
      expect(first.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(first.hookSpecificOutput.permissionDecisionReason).toContain('Superseded');
    });

    it('dedupes a same-toolUseId re-entry to share the pending promise (no supersede, no second card)', async () => {
      const hook = handler.createPreToolUseHook();
      const input = {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            {
              question: 'Pick?',
              header: 'P',
              options: [
                { label: 'A', description: 'A' },
                { label: 'B', description: 'B' },
              ],
              multiSelect: false,
            },
          ],
        },
        tool_use_id: 'dup-1',
      };

      // The PreToolUse hook intercepts first.
      const firstPromise = hook(input, 'dup-1', { signal: new AbortController().signal });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(setWaitingForInputSpy).toHaveBeenCalledTimes(1);

      // canUseTool re-enters for the SAME toolUseId (hook + canUseTool both
      // fire for one AskUserQuestion call in non-bypass modes). It must NOT
      // supersede the live resolver (a question can never supersede itself) or
      // install a second card.
      const callback = handler.createCanUseToolCallback();
      const secondPromise = callback(
        'AskUserQuestion',
        { questions: input.tool_input.questions },
        { signal: new AbortController().signal, toolUseID: 'dup-1' }
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(setWaitingForInputSpy).toHaveBeenCalledTimes(1);

      // Both channels resolve with the same user answer.
      await handler.handleQuestionResponse('dup-1', [{ questionIndex: 0, selectedLabels: ['A'] }]);
      const first = (await firstPromise) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      // The canUseTool channel returns a raw PermissionResult (no envelope).
      const second = (await secondPromise) as {
        behavior: string;
        updatedInput?: { answers: Record<string, string> };
      };
      expect(first.hookSpecificOutput.permissionDecision).toBe('allow');
      expect(second.behavior).toBe('allow');
      expect(second.updatedInput?.answers).toEqual({ 'Pick?': 'A' });
    });

    it('settles the shared promise when setWaitingForInput fails after a same-ID dedupe', async () => {
      // If setWaitingForInput throws (a rejecting session.updated subscriber),
      // the hook channel's interception rejects — but a canUseTool channel that
      // already deduped onto the shared promise must NOT await forever.
      // Gate the throw so the dedupe lands BEFORE the failure fires.
      let releaseFailure!: () => void;
      const failureGate = new Promise<void>((resolve) => {
        releaseFailure = resolve;
      });
      setWaitingForInputSpy.mockImplementationOnce(async () => {
        await failureGate;
        throw new Error('session.updated subscriber failed');
      });
      const hook = handler.createPreToolUseHook();
      const input = {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            {
              question: 'Q?',
              header: 'H',
              options: [
                { label: 'A', description: 'A' },
                { label: 'B', description: 'B' },
              ],
              multiSelect: false,
            },
          ],
        },
        tool_use_id: 'fail-1',
      };

      // Hook fires (resolver stored, setWaitingForInput gated), then canUseTool
      // dedupes onto the same pending promise.
      const firstPromise = hook(input, 'fail-1', { signal: new AbortController().signal });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const callback = handler.createCanUseToolCallback();
      const secondPromise = callback(
        'AskUserQuestion',
        { questions: input.tool_input.questions },
        { signal: new AbortController().signal, toolUseID: 'fail-1' }
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Now let setWaitingForInput fail.
      releaseFailure();

      // The hook channel rejects (setWaitingForInput threw).
      await expect(firstPromise).rejects.toThrow('session.updated subscriber failed');

      // The deduped canUseTool channel resolves with a deny — not forever-pending.
      const second = (await secondPromise) as { behavior: string };
      expect(second.behavior).toBe('deny');
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
      // The publish sits between the suppressed idle and the reinjection try; a
      // rejecting subscriber would stop execution before the reinjection catch's
      // terminal idle, leaving the suppressed waiter pending (the question is
      // already resolved, so nothing retries it). The wrap releases the waiter.
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
      // Simulate persisted waiting_for_input state with no in-memory resolver
      // (this is the post-restart scenario — task #138).
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

      // Should mark resolved-question metadata (submitted)
      expect(updateSessionSpy).toHaveBeenCalled();
      const updateCall = updateSessionSpy.mock.calls[0];
      expect(updateCall[1].metadata.resolvedQuestions['tool-123'].state).toBe('submitted');

      // Should drop waiting_for_input via setIdle (NOT setProcessing — let
      // ensureQueryStarted resume cleanly).
      expect(setIdleSpy).toHaveBeenCalled();
      expect(setProcessingSpy).not.toHaveBeenCalled();

      // Should queue the answer for canUseTool re-fire
      const queued = handler.getQueuedAnswersForTesting();
      expect(queued.has('tool-123')).toBe(true);
      expect(queued.get('tool-123')!.behavior).toBe('allow');

      // Should inject tool_result into the message queue
      expect(enqueueWithIdSpy).toHaveBeenCalled();
      const enqueueCall = enqueueWithIdSpy.mock.calls[0];
      expect(enqueueCall[1]).toEqual([
        expect.objectContaining({
          type: 'tool_result',
          tool_use_id: 'tool-123',
          content: expect.stringContaining('A'),
        }),
      ]);

      // Should restart the query
      expect(ensureQueryStartedSpy).toHaveBeenCalled();

      // Should emit injected_as_tool_result telemetry
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
      // Some unit-test contexts (and a few legacy code paths) construct the
      // handler without an `ensureQueryStarted` on the context. Verify the
      // post-restart delivery path falls back to queue-only without calling
      // MessageQueue.enqueueWithId — a future canUseTool fire can still
      // consume the queued answer.
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

      await handlerNoStart.handleQuestionResponse('tool-no-start', [
        { questionIndex: 0, selectedLabels: ['A'] },
      ]);

      // Answer is queued for a future canUseTool fire
      const queued = handlerNoStart.getQueuedAnswersForTesting();
      expect(queued.has('tool-no-start')).toBe(true);
      expect(queued.get('tool-no-start')!.behavior).toBe('allow');

      // State dropped from waiting_for_input
      expect(setIdleSpy).toHaveBeenCalled();

      // But: no SDK injection — the warn path returns before
      // enqueueWithId / ensureQueryStarted are touched.
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

      // Try to respond with wrong toolUseId
      await expect(
        handler.handleQuestionResponse('wrong-id', [{ questionIndex: 0, selectedLabels: ['A'] }])
      ).rejects.toThrow('Tool use ID mismatch');

      // Cleanup - respond with correct ID
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

      // Should have updated session with resolved question
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

      // Respond with invalid question index (out of bounds)
      await handler.handleQuestionResponse('skip-test', [
        { questionIndex: 99, selectedLabels: ['A'] },
      ]);

      const result = await resultPromise;
      // Should still allow, but with empty answers since the index was invalid
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
      // Same post-restart scenario as the response test, but for the cancel
      // (Skip) path.
      const pendingQuestion: PendingUserQuestion = {
        toolUseId: 'tool-123',
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

      // Try to cancel with wrong toolUseId
      await expect(handler.handleQuestionCancel('wrong-id')).rejects.toThrow(
        'Tool use ID mismatch'
      );

      // Cleanup - cancel with correct ID
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

      // Should have updated session with resolved question marked as cancelled
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
      // Should not throw
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

      const result = await handler.markQuestionOrphaned('agent_session_terminated');
      expect(result).toBe(true);

      // Persisted as cancelled with the right reason
      expect(updateSessionSpy).toHaveBeenCalled();
      const updateCall = updateSessionSpy.mock.calls[0];
      expect(updateCall[1].metadata.resolvedQuestions['orphan-tool-1'].state).toBe('cancelled');
      expect(updateCall[1].metadata.resolvedQuestions['orphan-tool-1'].cancelReason).toBe(
        'agent_session_terminated'
      );

      // Drops waiting_for_input
      expect(setIdleSpy).toHaveBeenCalled();

      // Telemetry
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

      await handler.markQuestionOrphaned('rehydrate_failed');

      const updateCall = updateSessionSpy.mock.calls[0];
      expect(updateCall[1].metadata.resolvedQuestions['orphan-tool-2'].cancelReason).toBe(
        'agent_session_terminated'
      );
      // Note: persisted reason is always agent_session_terminated for the UI;
      // the telemetry event carries the more granular reason.
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

      // Force-orphan while resolver is live
      await handler.markQuestionOrphaned('agent_session_terminated');

      // Live SDK promise should reject
      await expect(resultPromise).rejects.toThrow(/orphaned/i);

      // queuedAnswers map should be empty for that toolUseId
      expect(handler.getQueuedAnswersForTesting().has('orphan-with-resolver')).toBe(false);
    });
  });

  describe('createCanUseToolCallback queued-answer fast path', () => {
    it('consumes a queued allow without re-prompting and emits via=can_use_tool', async () => {
      // Pre-populate the queued-answer map by simulating a post-restart
      // handleQuestionResponse that ran before the SDK re-issued the
      // AskUserQuestion call.
      const pendingQuestion: PendingUserQuestion = {
        toolUseId: 'replay-tool',
        questions: [
          {
            question: 'Pick?',
            header: 'P',
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

      await handler.handleQuestionResponse('replay-tool', [
        { questionIndex: 0, selectedLabels: ['A'] },
      ]);

      // SDK now re-issues the canUseTool call (post-restart replay).
      currentState = { status: 'idle' };
      emitSpy.mockClear();
      setWaitingForInputSpy.mockClear();

      const callback = handler.createCanUseToolCallback();
      const result = await callback(
        'AskUserQuestion',
        { questions: pendingQuestion.questions },
        { signal: new AbortController().signal, toolUseID: 'replay-tool' }
      );

      // Should not re-transition to waiting_for_input
      expect(setWaitingForInputSpy).not.toHaveBeenCalled();

      // Should resolve immediately with the queued allow result
      expect(result.behavior).toBe('allow');
      expect(
        (result as { updatedInput: { answers: Record<string, string> } }).updatedInput.answers
      ).toEqual({ 'Pick?': 'A' });
      // The merge restores the live input's schema fields alongside the
      // queued answers (the queued result only carried `answers`).
      expect((result as { updatedInput: { questions: unknown[] } }).updatedInput.questions).toEqual(
        expect.any(Array)
      );

      // Telemetry should record via=can_use_tool on consume
      expect(emitSpy).toHaveBeenCalledWith(
        'question.injected_as_tool_result',
        expect.objectContaining({
          toolUseId: 'replay-tool',
          mode: 'submitted',
          via: 'can_use_tool',
        })
      );

      // Queue should now be empty for that toolUseId
      expect(handler.getQueuedAnswersForTesting().has('replay-tool')).toBe(false);
    });

    it('consumes a queued deny without re-prompting', async () => {
      const pendingQuestion: PendingUserQuestion = {
        toolUseId: 'replay-cancel',
        questions: [
          {
            question: 'Skip?',
            header: 'S',
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
});
