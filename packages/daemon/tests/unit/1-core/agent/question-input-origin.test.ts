import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { query, type Options, type PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { MessageHub, PendingUserQuestion, Provider } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import {
  projectQuestionInputOrigin,
  QuestionInputScope,
  requireQuestionInputScope,
  requireSingleQuestionInput,
} from '../../../../src/lib/agent/question-input-origin.ts';
import { QueryAttemptRegistry } from '../../../../src/lib/agent/query-attempt-token.ts';
import { initializeProviders } from '../../../../src/lib/providers/factory.ts';
import { resetSdkStartupGateForTests } from '../../../../src/lib/agent/sdk-startup-gate.ts';
import type { Database } from '../../../../src/storage/database.ts';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database.ts';

const origin = { sessionId: 'existing-manager', messageId: 'work-A' };
const input = (uuid: string, extra: object = {}) =>
  ({
    type: 'user',
    uuid,
    session_id: origin.sessionId,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: 'Read the approved draft' }] },
    ...extra,
  }) as SDKUserMessage & { internal?: boolean };

describe('question input origin admission', () => {
  test.each(['', '  '])('rejects missing session %j before single-input selection', (sessionId) => {
    expect(requireQuestionInputScope(sessionId, ['work-A'], true)).toEqual({ reason: null });
    expect(projectQuestionInputOrigin(sessionId, ['work-A'], true)).toBeNull();
  });
  test('retains exact opaque identities without mutating source values', () => {
    const messageIds = Object.freeze([' work-A · 研究 ']);
    const selected = { sessionId: ' manager ', messageIds };
    expect(requireQuestionInputScope(' manager ', messageIds, true)).toEqual({ value: selected });
    expect(requireSingleQuestionInput(selected)).toEqual({
      value: { sessionId: ' manager ', messageId: messageIds[0] },
    });
    expect(projectQuestionInputOrigin(' manager ', messageIds, true)).toEqual({
      sessionId: ' manager ',
      messageId: messageIds[0],
    });
    expect(messageIds).toEqual([' work-A · 研究 ']);
  });
  test.each(
    [[], ['', 'work-A'], [' '], ['work-A', 'work-B']].map((messageIds) => ({ messageIds }))
  )('never chooses the latest input from %j', ({ messageIds }) => {
    expect(requireSingleQuestionInput({ sessionId: origin.sessionId, messageIds })).toEqual({
      reason: null,
    });
    expect(projectQuestionInputOrigin(origin.sessionId, messageIds, true)).toBeNull();
  });
  test('an obsolete scope fails before valid identity or malformed second-stage reads', () => {
    expect(requireQuestionInputScope(origin.sessionId, ['work-A'], false)).toEqual({
      reason: null,
    });
    expect(projectQuestionInputOrigin(origin.sessionId, ['work-A'], false)).toBeNull();
    expect(
      projectQuestionInputOrigin(origin.sessionId, null as unknown as string[], true)
    ).toBeNull();
  });
});

describe('QuestionInputScope', () => {
  test('captures its own input, ignores tool results and retains a previously captured value', () => {
    const scope = new QuestionInputScope(origin.sessionId, () => true);
    expect(scope.origin()).toBeNull();
    const message = Object.freeze(input('work-A'));
    scope.recordInput(message);
    const captured = scope.origin();
    expect(captured).toEqual(origin);
    scope.recordInput(input('tool-result', { parent_tool_use_id: 'question-A' }));
    scope.recordInput(input('work-A'));
    expect(scope.origin()).toEqual(origin);
    scope.endTurn();
    expect(scope.origin()).toBeNull();
    scope.recordInput(input('work-B'));
    expect(scope.origin()).toEqual({ ...origin, messageId: 'work-B' });
    expect(captured).toEqual(origin);
    expect(message).toEqual(input('work-A'));
  });
  test.each([{ internal: true }, { uuid: undefined }])(
    'keeps interrupted or identity-free prompt context unknown: %j',
    (extra) => {
      const scope = new QuestionInputScope(origin.sessionId, () => true);
      scope.recordInput(input('work-A'));
      scope.recordInput(input('compact', extra));
      expect(scope.origin()).toBeNull();
      scope.endTurn();
      scope.recordInput(input('work-B'));
      expect(scope.origin()).toEqual({ ...origin, messageId: 'work-B' });
    }
  );
  test('multiple distinct prompts stay unknown, even after a repeated original prompt', () => {
    const scope = new QuestionInputScope(origin.sessionId, () => true);
    for (let i = 0; i < 200; i++) scope.recordInput(input(`work-${i}`));
    scope.recordInput(input('work-0'));
    expect(scope.origin()).toBeNull();
    scope.endTurn();
    scope.recordInput(input('work-A'));
    expect(scope.origin()).toEqual(origin);
  });
  test('a replacement attempt cannot lend its input to its predecessor', () => {
    const attempts = new QueryAttemptRegistry();
    const first = attempts.allocate();
    const previous = new QuestionInputScope(origin.sessionId, () => first.isLive());
    previous.recordInput(input('work-A'));
    expect(previous.origin()).toEqual(origin);
    const second = attempts.allocate();
    const current = new QuestionInputScope(origin.sessionId, () => second.isLive());
    current.recordInput(input('work-B'));
    expect(previous.origin()).toBeNull();
    expect(current.origin()).toEqual({ ...origin, messageId: 'work-B' });
    attempts.invalidate(second);
    expect(current.origin()).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('runtime-owned native question provenance', () => {
  const providerId = 'custom:question-origin-unit';
  let db: Database;
  let agent: AgentSession;
  let questionReady: ReturnType<typeof deferred<PendingUserQuestion>>;
  let questionNext: ReturnType<typeof deferred<PendingUserQuestion>>;
  let firstResult: ReturnType<typeof deferred<void>>;
  let readyForSecond: ReturnType<typeof deferred<void>>;
  let streamDone: ReturnType<typeof deferred<void>>;
  let optionsSeen: Options;
  let mode: 'single' | 'multiple' | 'successor';
  let channel: 'hook' | 'callback';
  let admitted: Promise<void>[];
  beforeEach(async () => {
    resetSdkStartupGateForTests();
    db = await createTestDb();
    const session = createTestSession(origin.sessionId);
    session.workspacePath = null;
    session.config = { model: 'unit', provider: providerId };
    db.createSession(session);
    initializeProviders().register({
      id: providerId,
      displayName: 'Question origin unit',
      isAvailable: async () => true,
      getAuthStatus: async () => ({ isAuthenticated: true, method: 'api_key' }),
      buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
    } as unknown as Provider);
    const bus = await createTestInternalEventBus();
    questionReady = deferred<PendingUserQuestion>();
    questionNext = deferred<PendingUserQuestion>();
    firstResult = deferred<void>();
    readyForSecond = deferred<void>();
    streamDone = deferred<void>();
    mode = 'single';
    channel = 'callback';
    admitted = [];
    bus.subscribe(
      'question.asked',
      ({ pendingQuestion }) =>
        (pendingQuestion.toolUseId === 'choice-A' ? questionReady : questionNext).resolve(
          pendingQuestion
        ),
      { subscriberName: 'question-origin-unit' }
    );
    agent = new AgentSession(
      session,
      db,
      { event: mock(() => {}) } as unknown as MessageHub,
      bus,
      async () => 'unit-key'
    );
    spyOn(agent.optionsBuilder, 'build').mockImplementation(async (overrides) => ({
      model: 'unit',
      canUseTool: overrides?.canUseTool,
      hooks: { PreToolUse: [{ hooks: [overrides!.askUserQuestionHook!] }] },
    }));
    spyOn(agent, 'onSDKMessage').mockImplementation(async (message) => {
      if (message.type === 'result') firstResult.resolve();
    });
    (query as unknown as ReturnType<typeof mock>).mockImplementation(
      (args: Parameters<typeof query>[0]) => ({
        close: () => {},
        interrupt: async () => {},
        [Symbol.asyncIterator]: async function* () {
          optionsSeen = args.options;
          const feed = (args.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
          expect((await feed.next()).value?.uuid).toBe('work-A');
          if (mode === 'multiple') expect((await feed.next()).value?.uuid).toBe('work-B');
          yield { type: 'system', subtype: 'init', session_id: origin.sessionId };
          await ask('choice-A');
          yield { type: 'result', subtype: 'success', uuid: crypto.randomUUID() };
          if (mode === 'successor') {
            readyForSecond.resolve();
            expect((await feed.next()).value?.uuid).toBe('work-B');
            await ask('choice-B');
            yield { type: 'result', subtype: 'success', uuid: crypto.randomUUID() };
          }
          await streamDone.promise;
          await feed.return?.();
        },
      })
    );
  });
  afterEach(async () => {
    agent.setCleaningUp(true);
    streamDone.resolve();
    const state = agent.stateManager.getState();
    if (state.status === 'waiting_for_input')
      await agent.handleQuestionCancel(state.pendingQuestion.toolUseId);
    agent.messageQueue.stop();
    await agent.queryPromise;
    for (const result of await Promise.allSettled(admitted))
      if (result.status === 'rejected') expect(result.reason.message).toBe('Interrupted by user');
    await agent.cleanup();
    initializeProviders().unregister(providerId);
    db.close();
    resetSdkStartupGateForTests();
  });
  async function ask(toolUseId: string) {
    const toolInput = {
      questions: [
        {
          question: 'Choose the draft only',
          header: 'Draft',
          options: [
            { label: 'Keep draft', description: 'No execution' },
            { label: 'Stop', description: 'Do not change anything' },
          ],
          multiSelect: false,
        },
      ],
      inputOrigin: { sessionId: 'forged-session', messageId: 'newest-human-ask' },
    };
    if (channel === 'hook')
      return optionsSeen.hooks!.PreToolUse![0].hooks[0](
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_use_id: toolUseId,
          tool_input: toolInput,
        } as PreToolUseHookInput,
        undefined,
        { signal: new AbortController().signal }
      );
    return optionsSeen.canUseTool!('AskUserQuestion', toolInput, {
      signal: new AbortController().signal,
      toolUseID: toolUseId,
    });
  }
  async function start() {
    admit('work-A', 'Approved draft A');
    if (mode === 'multiple') admit('work-B', 'Separate draft B');
    await agent.ensureQueryStarted();
    return questionReady.promise;
  }
  function admit(id: string, text: string) {
    const delivery = agent.messageQueue.admitWithId(id, text, false, { durable: true });
    delivery.catch(() => {});
    admitted.push(delivery);
  }
  const answer = (id: string) =>
    agent.handleQuestionResponse(id, [{ questionIndex: 0, selectedLabels: ['Keep draft'] }]);
  test.each(['hook', 'callback'] as const)(
    'binds the actual prompt feed through %s and persists its descriptive origin',
    async (via) => {
      channel = via;
      const pending = await start();
      expect(pending.inputOrigin).toEqual(origin);
      expect(pending.toolUseId).toBe('choice-A');
      expect(pending.questions[0].question).toBe('Choose the draft only');
      expect(JSON.parse(db.getSession(origin.sessionId)!.processingState!)).toMatchObject({
        status: 'waiting_for_input',
        pendingQuestion: { inputOrigin: origin },
      });
      await answer('choice-A');
      expect(
        db.getSession(origin.sessionId)?.metadata?.resolvedQuestions?.['choice-A'].question
          .inputOrigin
      ).toEqual(origin);
      expect(pending).not.toHaveProperty('permission');
    }
  );
  test('multiple active native inputs remain unknown instead of borrowing the latest work', async () => {
    mode = 'multiple';
    const pending = await start();
    expect(pending.inputOrigin).toBeNull();
    await answer('choice-A');
    expect(
      db.getSession(origin.sessionId)?.metadata?.resolvedQuestions?.['choice-A'].question
    ).toMatchObject({ inputOrigin: null });
  });
  test('a terminal result clears the first input before another native question in the same query', async () => {
    mode = 'successor';
    const pending = await start();
    await answer('choice-A');
    await firstResult.promise;
    await readyForSecond.promise;
    admit('work-B', 'Approved draft B');
    const next = await questionNext.promise;
    expect(next.inputOrigin).toEqual({ ...origin, messageId: 'work-B' });
    expect(pending.inputOrigin).toEqual(origin);
    await answer('choice-B');
  });
});
