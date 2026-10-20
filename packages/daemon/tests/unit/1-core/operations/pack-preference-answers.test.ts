import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
let db: Awaited<ReturnType<typeof createTestDb>>;
let service: NeoService;
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const agent: OperationCaller = { source: 'mcp', sessionId: 'neo:root', role: 'neo' };
const values = [
  {
    pack: 'coding',
    scope: { kind: 'repo', key: 'synthetic/one' },
    key: 'mergePolicy',
    value: 'review_bot',
  },
  {
    pack: 'coding',
    scope: { kind: 'repo', key: 'synthetic/one' },
    key: 'reviewBot',
    value: 'synthetic-bot',
  },
  {
    pack: 'coding',
    scope: { kind: 'repo', key: 'synthetic/two' },
    key: 'mergePolicy',
    value: 'ci_only',
  },
];
beforeEach(async () => {
  db = await createTestDb();
  db.createSession(createTestSession('neo:root'));
  service = new NeoService(
    db,
    {} as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  service.deliverForward = async () => {};
  service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
  service.todos.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo:root',
    originMessageId: null,
    title: 'Settings',
    request: 'Synthetic proposal',
    createdAt: 1,
  });
});
afterEach(() => {
  service.dispose();
  db.close();
});
const invoke = (name: string, input: unknown, caller = agent) =>
  invokeOperation(createOperationRegistry(createNeoOperations(service)), name, input, caller);
async function propose() {
  const reply = await invoke('pack.preferences.ask', {
    askId: 'ask',
    requestId: 'synthetic-request',
    values,
  });
  expect(reply).toMatchObject({ value: { ok: true, questionId: expect.any(String) } });
  return (reply as { value: { questionId: string } }).value.questionId;
}
const saved = () => invoke('pack.preferences.list', {});

describe('immutable human settings proposals', () => {
  test('one human tap applies exactly the bound proposal atomically with human provenance', async () => {
    const questionId = await propose();
    expect(await saved()).toMatchObject({ value: { preferences: [] } });
    const question = service.todos.getQuestion(questionId)!;
    for (const value of values) expect(question.text).toContain(JSON.stringify(value));
    expect(await invoke('pack.preferences.applyAnswer', { questionId })).toMatchObject({
      value: { ok: false },
    });
    expect(await invoke('neo.question.answer', { questionId, answer: 'yes' }, human)).toMatchObject(
      { value: { ok: true } }
    );
    expect(await saved()).toMatchObject({
      value: {
        preferences: values.map((value) => ({
          ...value,
          setBy: 'human',
          setAt: expect.any(Number),
        })),
      },
    });
    await invoke('pack.preferences.set', { ...values[0], value: 'human' }, human);
    expect(await invoke('pack.preferences.applyAnswer', { questionId })).toMatchObject({
      value: { ok: true },
    });
    expect(await invoke('pack.preferences.get', values[0])).toMatchObject({
      value: { preference: { value: 'human' } },
    });
  });
  test('agent post-answer payload injection and rebinding are refused', async () => {
    const questionId = await propose();
    await invoke('neo.question.answer', { questionId, answer: 'yes' }, human);
    const before = await saved();
    expect(
      await invoke('pack.preferences.applyAnswer', {
        questionId,
        values: [{ ...values[0], value: 'ci_only' }],
      })
    ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    expect(
      await invoke('pack.preferences.ask', {
        askId: 'ask',
        requestId: 'synthetic-request',
        values: [{ ...values[0], value: 'ci_only' }],
      })
    ).toMatchObject({ value: { ok: false } });
    expect(await invoke('pack.preferences.set', { ...values[0], value: 'ci_only' })).toMatchObject({
      kind: 'failed',
      code: 'forbidden',
    });
    expect(await saved()).toEqual(before);
  });
  test.each(['no', 'Please change the proposal'])(
    'human %s never writes settings',
    async (answer) => {
      const questionId = await propose();
      if (answer === 'no') await invoke('neo.question.answer', { questionId, answer }, human);
      else service.todos.answerQuestion(service.todos.getQuestion(questionId)!, answer, 'chat', 2);
      expect(await invoke('pack.preferences.applyAnswer', { questionId })).toMatchObject({
        value: { ok: false },
      });
      expect(await saved()).toMatchObject({ value: { preferences: [] } });
    }
  );
  test('agents cannot answer; legacy/unbound human yes has no settings effect', async () => {
    const questionId = await propose();
    expect(await invoke('neo.question.answer', { questionId, answer: 'yes' })).toMatchObject({
      value: { ok: false },
    });
    const legacy = service.todos.askQuestion(
      'legacy',
      'ask',
      {
        text: 'Legacy',
        kind: 'yesno',
        options: null,
        multiple: false,
        noLabel: 'No',
        yesLabel: 'Yes',
        startTodos: null,
      },
      1
    );
    service.todos.answerQuestion(legacy, 'yes', 'button', 2);
    expect(await invoke('pack.preferences.applyAnswer', { questionId: 'legacy' })).toMatchObject({
      value: { ok: false },
    });
    expect(await saved()).toMatchObject({ value: { preferences: [] } });
  });
  test('invalid values leave neither question nor proposal; retry preserves question identity', async () => {
    expect(
      await invoke('pack.preferences.ask', {
        askId: 'ask',
        requestId: 'bad',
        values: [{ ...values[0], value: 'invalid' }],
      })
    ).toMatchObject({ value: { ok: false } });
    expect(service.todos.listQuestions('ask')).toEqual([]);
    const id = await propose();
    expect(await propose()).toBe(id);
    expect(service.todos.listQuestions('ask')).toHaveLength(1);
  });
  test('stored proposal fields cannot be edited, and application failure rolls back the human answer and all values', async () => {
    const questionId = await propose();
    expect(() =>
      db
        .getDatabase()
        .prepare(
          "UPDATE neo_pack_preference_proposals SET values_json = '[]' WHERE question_id = ?"
        )
        .run(questionId)
    ).toThrow();
    db.getDatabase().exec(
      `CREATE TRIGGER synthetic_write_failure BEFORE INSERT ON neo_pack_preferences WHEN NEW.scope_key='synthetic/two' BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END`
    );
    expect(await invoke('neo.question.answer', { questionId, answer: 'yes' }, human)).toMatchObject(
      { kind: 'failed' }
    );
    expect(service.todos.getQuestion(questionId)?.state).toBe('open');
    expect(await saved()).toMatchObject({ value: { preferences: [] } });
  });
});
