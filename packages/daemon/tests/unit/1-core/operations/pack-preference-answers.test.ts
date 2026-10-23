import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
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
let service: ReturnType<typeof createNeoService>;
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
  service = createNeoService(
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
  expect(reply).toMatchObject({ value: { ok: true } });
  expect(typeof (reply as { value: { questionId: string } }).value.questionId).toBe('string');
  return (reply as { value: { questionId: string } }).value.questionId;
}
const saved = () => invoke('pack.preferences.list', {});

describe('immutable human settings proposals', () => {
  test('renders global and project settings without losing false, zero or literal paths', async () => {
    db.updateGlobalSettings({ language: 'en' });
    service.filePacks = [
      {
        id: 'synthetic',
        describe: 'Synthetic',
        instructions: () => null,
        preferences: {
          flag: {
            scope: 'project',
            type: { kind: 'boolean' },
            default: true,
            ask: 'Flag?',
            label: { en: 'Enabled', 'zh-Hans': '启用' },
            valueLabels: {
              false: { en: 'Off', 'zh-Hans': '关闭' },
              true: { en: 'On', 'zh-Hans': '开启' },
            },
          },
          count: {
            scope: 'project',
            type: { kind: 'number' },
            default: 1,
            ask: 'Count?',
            label: { en: 'Count', 'zh-Hans': '数量' },
            valueLabels: {},
          },
        },
      },
    ];
    const proposal = [
      { pack: 'coding', scope: { kind: 'global', key: '' }, key: 'mergePolicy', value: 'human' },
      {
        pack: 'synthetic',
        scope: { kind: 'project', key: 'Synthetic' },
        key: 'flag',
        value: false,
      },
      { pack: 'synthetic', scope: { kind: 'project', key: 'Synthetic' }, key: 'count', value: 0 },
      {
        pack: 'coding',
        scope: { kind: 'repo', key: 'synthetic/one' },
        key: 'humanSignoff',
        value: ['docs/a|b/**', 'docs/`draft`/**', 'docs\\windows/**'],
      },
    ];
    const result = await invoke('pack.preferences.ask', {
      askId: 'ask',
      requestId: 'literal-settings',
      values: proposal,
    });
    expect(result).toMatchObject({ value: { ok: true } });
    const questionId = (result as { value: { questionId: string } }).value.questionId;
    const text = service.todos.getQuestion(questionId)!.text;
    expect(text).toContain('### All repositories');
    expect(text).toContain('### Project: Synthetic');
    expect(text).toContain('| Enabled | Off |');
    expect(text).toContain('| Count | ` 0 ` |');
    expect(text).toContain('docs/a\\|b/**');
    expect(text).toContain('`` docs/`draft`/** ``');
    expect(text).toContain('docs\\windows/**');
    await invoke('neo.question.answer', { questionId, answer: 'yes' }, human);
    expect(await saved()).toMatchObject({
      value: {
        preferences: expect.arrayContaining(
          proposal.map((value) => expect.objectContaining(value))
        ),
      },
    });
  });
  test('one human tap applies exactly the bound proposal atomically with human provenance', async () => {
    const questionId = await propose();
    expect(await saved()).toMatchObject({ value: { preferences: [] } });
    const question = service.todos.getQuestion(questionId)!;
    expect(question.text).not.toContain(JSON.stringify(values[0]));
    expect(
      db
        .getDatabase()
        .prepare('SELECT values_json FROM neo_pack_preference_proposals WHERE question_id=?')
        .get(questionId)
    ).toEqual({ values_json: JSON.stringify(values) });
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
  test.each([
    [
      'en',
      'Apply these settings?',
      'Setting',
      'Value',
      'Merge policy',
      'CI and review bot approval',
      'Review bot',
      'CI passes',
      'Keep current settings',
      'Apply these settings',
    ],
    [
      'zh-Hans',
      '应用这些设置？',
      '设置',
      '值',
      '合并规则',
      'CI 通过且审查机器人批准',
      '审查机器人',
      'CI 通过',
      '保留当前设置',
      '应用这些设置',
    ],
  ] as const)(
    'renders the bound repo-grouped proposal in %s',
    async (language, title, setting, value, policy, review, bot, ci, noLabel, yesLabel) => {
      db.updateGlobalSettings({ language });
      const questionId = await propose();
      const question = service.todos.getQuestion(questionId)!;
      expect(question.text).toBe(
        [
          title,
          '',
          '### synthetic/one',
          '',
          `| ${setting} | ${value} |`,
          '| --- | --- |',
          `| ${policy} | ${review} |`,
          `| ${bot} | \` synthetic-bot \` |`,
          '',
          '### synthetic/two',
          '',
          `| ${setting} | ${value} |`,
          '| --- | --- |',
          `| ${policy} | ${ci} |`,
        ].join('\n')
      );
      expect(question).toMatchObject({ noLabel, yesLabel });
      db.updateGlobalSettings({ language: language === 'en' ? 'zh-Hans' : 'en' });
      expect(await propose()).toBe(questionId);
      expect(service.todos.getQuestion(questionId)!.text).toBe(question.text);
      expect(
        await invoke('neo.question.answer', { questionId, answer: 'yes' }, human)
      ).toMatchObject({ value: { ok: true } });
      expect(await saved()).toMatchObject({
        value: { preferences: values.map((v) => ({ ...v, setBy: 'human' })) },
      });
    }
  );

  test('labels every merge choice and empty sign-off paths without raw enum names', async () => {
    db.updateGlobalSettings({ language: 'zh-Hans' });
    const proposal = [
      ...values.slice(0, 1),
      { ...values[0], scope: { kind: 'repo', key: 'synthetic/two' }, value: 'human' },
      { ...values[0], key: 'humanSignoff', value: [] },
    ];
    const reply = await invoke('pack.preferences.ask', {
      askId: 'ask',
      requestId: 'labels',
      values: proposal,
    });
    const id = (reply as { value: { questionId: string } }).value.questionId;
    const text = service.todos.getQuestion(id)!.text;
    expect(text).toContain('| 合并规则 | 人工批准 |');
    expect(text).toContain('| 人工审批路径或标签 | 无额外人工审批路径或标签 |');
    expect(text).not.toContain('review_bot');
    expect(text).not.toContain('humanSignoff');
    expect(text).not.toContain('[]');
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
  test('a stored human chat yes applies the same immutable proposal', async () => {
    const questionId = await propose();
    service.todos.answerQuestion(service.todos.getQuestion(questionId)!, 'yes', 'chat', 2);
    expect(await invoke('neo.question.get', { questionId })).toMatchObject({
      value: { answeredByHuman: true },
    });
    expect(await saved()).toMatchObject({
      value: { preferences: values.map((value) => ({ ...value, setBy: 'human' })) },
    });
  });

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
  test.each(['no', 'yes', 'retired'])(
    'retry after %s reports a closed question and a new request reaches the human',
    async (answer) => {
      const questionId = await propose();
      if (answer === 'retired')
        service.todos.retireQuestion(service.todos.getQuestion(questionId)!, 'superseded', null, 2);
      else await invoke('neo.question.answer', { questionId, answer }, human);
      expect(
        await invoke('pack.preferences.ask', {
          askId: 'ask',
          requestId: 'synthetic-request',
          values,
        })
      ).toMatchObject({ value: { ok: false, reason: 'question_closed' } });
      const next = await invoke('pack.preferences.ask', {
        askId: 'ask',
        requestId: 'replacement-request',
        values,
      });
      expect(next).toMatchObject({ value: { ok: true } });
      const nextId = (next as { value: { questionId: string } }).value.questionId;
      expect(nextId).not.toBe(questionId);
      expect(service.todos.getQuestion(nextId)?.state).toBe('open');
    }
  );
  test('question/proposal creation rolls back together and changed question text cannot authorize old values', async () => {
    db.getDatabase().exec(
      `CREATE TRIGGER synthetic_proposal_failure BEFORE INSERT ON neo_pack_preference_proposals BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END`
    );
    expect(
      await invoke('pack.preferences.ask', { askId: 'ask', requestId: 'fail', values })
    ).toMatchObject({ kind: 'failed' });
    expect(service.todos.listQuestions('ask')).toEqual([]);
    db.getDatabase().exec('DROP TRIGGER synthetic_proposal_failure');
    const questionId = await propose();
    db.getDatabase()
      .prepare("UPDATE neo_questions SET text='Different proposal' WHERE id=?")
      .run(questionId);
    expect(await invoke('neo.question.answer', { questionId, answer: 'yes' }, human)).toMatchObject(
      { kind: 'failed' }
    );
    expect(service.todos.getQuestion(questionId)?.state).toBe('open');
    expect(await saved()).toMatchObject({ value: { preferences: [] } });
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
