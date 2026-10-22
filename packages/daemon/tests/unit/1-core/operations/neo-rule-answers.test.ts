import { createNeoIntakeOperation } from '../../../../src/lib/neo/intake.ts';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { GlobalSettings, MessageHub } from '@hyperneo/shared';
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
let published: GlobalSettings[];
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const agent: OperationCaller = {
  source: 'mcp',
  sessionId: 'neo:10000000-0000-4000-8000-000000000002',
  role: 'neo',
};
const edit = { add: ['Ask before publishing.'], remove: ['Old synthetic rule.'] };
beforeEach(async () => {
  db = await createTestDb();
  db.createSession(createTestSession('neo:10000000-0000-4000-8000-000000000002'));
  published = [];
  service = new NeoService(
    db,
    {} as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>(),
    (settings) => published.push(settings)
  );
  service.deliverForward = async () => {};
  service.repo.reserveBinding({
    sessionId: 'neo:10000000-0000-4000-8000-000000000002',
    kind: 'neo',
    projectId: null,
  });
  db.updateGlobalSettings({ neo: { standingRules: ['Old synthetic rule.', 'Keep this rule.'] } });
  service.todos.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo:10000000-0000-4000-8000-000000000002',
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
const saved = () => db.getGlobalSettings().neo?.standingRules;
async function propose(requestId = 'request', change = edit) {
  const result = await invoke('neo.rule.ask', { askId: 'ask', requestId, ...change });
  expect(result).toMatchObject({ value: { ok: true } });
  return (result as { value: { questionId: string } }).value.questionId;
}
describe('human-approved standing rules', () => {
  test('a cited consumed human input authorizes only a complete text part from this conversation', async () => {
    const messageId = crypto.randomUUID();
    const content = 'Ask before publishing. Remove Old synthetic rule.';
    expect(
      await invoke(
        'neo.message.send',
        { sessionId: agent.sessionId, requestId: messageId, content },
        human
      )
    ).toMatchObject({ value: { ok: true } });
    const input = { ...edit, messageId, from: content };
    expect(await invoke('neo.rule.save', input)).toMatchObject({ value: { ok: false } });
    const repo = db.getSDKMessageRepo();
    repo.updateMessageStatus([repo.findMessageIdByUuid(agent.sessionId!, messageId)!], 'consumed');
    expect(
      await invoke('neo.rule.save', { ...input, from: 'Words absent from the human message.' })
    ).toMatchObject({ value: { ok: false } });
    for (const from of ['e', 'Ask before publishing.']) {
      expect(await invoke('neo.rule.save', { ...input, from })).toMatchObject({
        value: { ok: false },
      });
      expect(saved()).toEqual(['Old synthetic rule.', 'Keep this rule.']);
    }
    expect(await invoke('neo.rule.save', input)).toMatchObject({
      value: { ok: true, standingRules: ['Keep this rule.', ...edit.add] },
    });
    expect(saved()).toEqual(['Keep this rule.', ...edit.add]);
  });

  test.each(['add', 'remove'] as const)(
    'an unrelated received greeting cannot authorize a rule %s',
    async (kind) => {
      const messageId = crypto.randomUUID();
      await invoke(
        'neo.message.send',
        { sessionId: agent.sessionId, requestId: messageId, content: 'hi' },
        human
      );
      const repo = db.getSDKMessageRepo();
      repo.updateMessageStatus(
        [repo.findMessageIdByUuid(agent.sessionId!, messageId)!],
        'consumed'
      );
      const input = {
        messageId,
        from: 'hi',
        [kind]: [kind === 'add' ? 'Invented rule.' : 'Old synthetic rule.'],
      };
      expect(await invoke('neo.rule.save', input)).toMatchObject({ value: { ok: false } });
      expect(saved()).toEqual(['Old synthetic rule.', 'Keep this rule.']);
    }
  );

  test.each(['unknown', 'foreign', 'system', 'task', 'not-in-conversation'])(
    'refuses %s message ids without changing standing rules',
    async (kind) => {
      const messageId = crypto.randomUUID();
      const sessionId = kind === 'foreign' ? 'ordinary-session' : agent.sessionId!;
      if (kind === 'foreign') db.createSession(createTestSession(sessionId));
      if (kind !== 'unknown') {
        db.getSDKMessageRepo().saveUserMessage(sessionId, {
          type: 'user',
          uuid: messageId,
          session_id: sessionId,
          parent_tool_use_id: null,
          inputKind: kind === 'system' || kind === 'task' ? kind : 'human',
          message: { role: 'user', content: edit.add[0] },
        } as import('@hyperneo/shared/sdk').SDKUserMessage);
        if (kind !== 'not-in-conversation')
          service.asks.append({
            conversationId: service.repo.conversationId()!,
            requestId: messageId,
            askOrigin: { sessionId, messageId },
            content: edit.add[0],
          });
      }
      expect(
        await invoke('neo.rule.save', { ...edit, messageId, from: edit.add[0] })
      ).toMatchObject({ value: { ok: false } });
      expect(saved()).toEqual(['Old synthetic rule.', 'Keep this rule.']);
    }
  );

  test('a system-turn proposal changes nothing until human yes, then applies the exact edit', async () => {
    expect(await invoke('neo.rule.save', { add: edit.add, from: edit.add[0] })).toMatchObject({
      value: { ok: false },
    });
    const id = await propose();
    const text = service.todos.getQuestion(id)!.text;
    for (const rule of [...edit.add, ...edit.remove]) expect(text).toContain(JSON.stringify(rule));
    expect(saved()).toEqual(['Old synthetic rule.', 'Keep this rule.']);
    expect(await invoke('neo.rule.applyAnswer', { questionId: id })).toMatchObject({
      value: { ok: false },
    });
    expect(await invoke('neo.question.answer', { questionId: id, answer: 'yes' })).toMatchObject({
      value: { ok: false },
    });
    expect(
      await invoke('neo.question.answer', { questionId: id, answer: 'yes' }, human)
    ).toMatchObject({ value: { ok: true } });
    expect(await invoke('neo.question.get', { questionId: id })).toMatchObject({
      value: { answeredByHuman: true },
    });
    expect(saved()).toEqual(['Keep this rule.', ...edit.add]);
    await invoke('neo.rule.save', { add: ['A later human rule.'], remove: edit.add }, human);
    expect(await invoke('neo.rule.applyAnswer', { questionId: id })).toMatchObject({
      value: { ok: true },
    });
    expect(saved()).toEqual(['Keep this rule.', 'A later human rule.']);
  });
  test.each(['button', 'chat'])(
    '%s consent publishes current settings to connected clients once',
    async (surface) => {
      const id = await propose();
      const result =
        surface === 'button'
          ? await invoke('neo.question.answer', { questionId: id, answer: 'yes' }, human)
          : await invoke(
              'neo.message.send',
              {
                sessionId: 'neo:10000000-0000-4000-8000-000000000002',
                requestId: crypto.randomUUID(),
                content: 'yes',
                replyTo: { kind: 'question', id },
              },
              human
            );
      expect(result).toMatchObject({ value: { ok: true } });
      expect(published.map((settings) => settings.neo?.standingRules)).toEqual([
        ['Keep this rule.', ...edit.add],
      ]);
      expect(await invoke('neo.rule.applyAnswer', { questionId: id })).toMatchObject({
        value: { ok: true },
      });
      expect(published).toHaveLength(1);
    }
  );
  test('post-answer payload injection and proposal rebinding are refused', async () => {
    const id = await propose();
    await invoke('neo.question.answer', { questionId: id, answer: 'yes' }, human);
    const before = saved();
    expect(
      await invoke('neo.rule.applyAnswer', { questionId: id, add: ['Tampered.'] })
    ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    expect(
      await invoke('neo.rule.ask', { askId: 'ask', requestId: 'request', add: ['Tampered.'] })
    ).toMatchObject({ value: { ok: false } });
    expect(saved()).toEqual(before);
    expect(() =>
      db
        .getDatabase()
        .prepare("UPDATE neo_rule_proposals SET edit_json='{}' WHERE question_id=?")
        .run(id)
    ).toThrow();
  });
  test.each(['no', 'Change the wording'])('human %s leaves rules unchanged', async (answer) => {
    const before = saved();
    const id = await propose();
    if (answer === 'no') await invoke('neo.question.answer', { questionId: id, answer }, human);
    else service.todos.answerQuestion(service.todos.getQuestion(id)!, answer, 'chat', 2);
    expect(await invoke('neo.rule.applyAnswer', { questionId: id })).toMatchObject({
      value: { ok: false },
    });
    expect(saved()).toEqual(before);
  });
  test('a proposal can replace one of twenty rules without dropping the other nineteen', async () => {
    const rules = Array.from({ length: 20 }, (_, i) => `Synthetic rule ${i}.`);
    db.updateGlobalSettings({ neo: { standingRules: rules } });
    expect(
      await invoke('neo.rule.ask', { askId: 'ask', requestId: 'over', add: edit.add })
    ).toMatchObject({ value: { ok: false } });
    const id = await propose('replace', { add: edit.add, remove: [rules[0]] });
    service.todos.answerQuestion(service.todos.getQuestion(id)!, 'yes', 'chat', 2);
    expect(saved()).toEqual([...rules.slice(1), ...edit.add]);
  });
  test('pending retries keep identity, closed retries require a new request', async () => {
    const id = await propose();
    expect(await propose()).toBe(id);
    await invoke('neo.question.answer', { questionId: id, answer: 'no' }, human);
    expect(
      await invoke('neo.rule.ask', { askId: 'ask', requestId: 'request', ...edit })
    ).toMatchObject({ value: { ok: false, reason: 'question_closed' } });
    expect(await propose('new-request')).not.toBe(id);
  });
  test('a stale cap records consent without discarding another rule', async () => {
    const id = await propose('cap-change', {
      add: [...edit.add, 'One more rule.'],
      remove: edit.remove,
    });
    const current = [
      'Old synthetic rule.',
      ...Array.from({ length: 19 }, (_, i) => `Other rule ${i}.`),
    ];
    db.updateGlobalSettings({ neo: { standingRules: current } });
    expect(
      await invoke('neo.question.answer', { questionId: id, answer: 'yes' }, human)
    ).toMatchObject({ value: { ok: true } });
    expect(saved()).toEqual(current);
    expect(service.todos.getQuestion(id)?.state).toBe('answered');
    expect(await invoke('neo.rule.applyAnswer', { questionId: id })).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('At most 20 rules') },
    });
  });
  test('an unbound human yes and a changed question body cannot authorize rule edits', async () => {
    const before = saved();
    const id = await propose();
    db.getDatabase()
      .prepare("UPDATE neo_questions SET text='A different change' WHERE id=?")
      .run(id);
    expect(
      await invoke('neo.question.answer', { questionId: id, answer: 'yes' }, human)
    ).toMatchObject({ kind: 'failed' });
    expect(service.todos.getQuestion(id)?.state).toBe('open');
    service.todos.askQuestion(
      'unbound',
      'ask',
      {
        text: 'Unbound question',
        kind: 'yesno',
        options: null,
        multiple: false,
        noLabel: 'No',
        yesLabel: 'Yes',
        startTodos: null,
      },
      1
    );
    await invoke('neo.question.answer', { questionId: 'unbound', answer: 'yes' }, human);
    expect(await invoke('neo.rule.applyAnswer', { questionId: 'unbound' })).toMatchObject({
      value: { ok: false },
    });
    expect(saved()).toEqual(before);
  });
  test.each(['missing-removal', 'cap'])(
    'a chat yes to a %s stale proposal remains accepted and notifies Neo',
    async (kind) => {
      if (kind === 'cap')
        db.updateGlobalSettings({
          neo: { standingRules: Array.from({ length: 19 }, (_, i) => `Rule ${i}.`) },
        });
      const change = kind === 'cap' ? { add: ['First extra rule.'], remove: [] } : edit;
      const first = await propose('first', change);
      const second = await propose(
        'second',
        kind === 'cap' ? { add: ['Second extra rule.'], remove: [] } : edit
      );
      await invoke('neo.question.answer', { questionId: first, answer: 'yes' }, human);
      const before = saved();
      const notified: string[] = [];
      const operation = createNeoIntakeOperation(db, service.repo, (sessionId) =>
        notified.push(sessionId)
      );
      const requestId = crypto.randomUUID();
      const input = {
        sessionId: 'neo:10000000-0000-4000-8000-000000000002',
        requestId,
        content: 'yes',
        replyTo: { kind: 'question', id: second },
      };
      const send = () =>
        invokeOperation(createOperationRegistry([operation]), 'neo.message.send', input, human);
      expect(await send()).toMatchObject({ value: { ok: true, created: true } });
      expect(notified).toEqual(['neo:10000000-0000-4000-8000-000000000002']);
      expect(
        db
          .getSDKMessageRepo()
          .getStoredPromptsByUuid('neo:10000000-0000-4000-8000-000000000002', requestId)
      ).toHaveLength(1);
      expect(service.todos.getQuestion(second)).toMatchObject({
        state: 'answered',
        answer: 'yes',
        answeredBy: 'chat',
      });
      expect(await invoke('neo.rule.applyAnswer', { questionId: second })).toMatchObject({
        value: { ok: false },
      });
      expect(saved()).toEqual(before);
      expect(await send()).toMatchObject({ value: { ok: true, created: false } });
    }
  );
  test('application failure rolls back consent and all rule edits', async () => {
    const before = saved();
    const id = await propose();
    db.getDatabase().exec(
      "CREATE TRIGGER synthetic_rules_failure BEFORE INSERT ON global_settings BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END"
    );
    expect(
      await invoke('neo.question.answer', { questionId: id, answer: 'yes' }, human)
    ).toMatchObject({ kind: 'failed' });
    expect(service.todos.getQuestion(id)?.state).toBe('open');
    expect(saved()).toEqual(before);
  });
});
