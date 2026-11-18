import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub, Session } from '@hyperneo/shared';
import { createNeoOperations } from '../../helpers/neo-service.ts';
import { createNeoService } from '../../helpers/neo-service.ts';
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
import { openHumanCard } from '../../../../src/lib/neo/human-card.ts';
let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
let promptUpdated: (() => void) | undefined;
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const agent: OperationCaller = {
  source: 'mcp',
  sessionId: 'neo:10000000-0000-4000-8000-000000000003',
  role: 'neo',
};
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
  promptUpdated = undefined;
  await db.createSession(createTestSession('neo:10000000-0000-4000-8000-000000000003'));
  service = createNeoService(
    db,
    {
      updateSession: async (id: string, updates: Partial<Session>) => {
        await db.updateSession(id, updates);
        promptUpdated?.();
      },
    } as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  service.deliverForward = async () => {};
  service.repo.reserveBinding({
    sessionId: 'neo:10000000-0000-4000-8000-000000000003',
    kind: 'neo',
    projectId: null,
  });
  service.todos.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo:10000000-0000-4000-8000-000000000003',
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
const option = (questionId: string, index: number) =>
  service.todos.getQuestion(questionId)!.options![index];
const chat = (questionId: string, content: string) =>
  invoke(
    'neo.message.send',
    {
      sessionId: 'neo:10000000-0000-4000-8000-000000000003',
      requestId: crypto.randomUUID(),
      content,
      replyTo: { kind: 'question', id: questionId },
    },
    human
  );
const saved = async () => {
  const result = await invoke('pack.preferences.list', {});
  if (result.kind !== 'completed') return result;
  const value = result.value as { preferences: { key: string }[] };
  return {
    ...result,
    value: { preferences: value.preferences.filter((row) => row.key !== 'watchedRepos') },
  };
};

describe('immutable human settings proposals', () => {
  test('delegation choices do not repeat labels and explain the unsaved default', async () => {
    db.updateGlobalSettings({ language: 'en' });
    const choice = (value: string) => ({
      pack: 'delegation',
      scope: { kind: 'global', key: '' },
      key: 'signIn',
      value,
    });
    const ask = (requestId: string) =>
      invoke('pack.preferences.ask', {
        askId: 'ask',
        requestId,
        alternatives: [[choice('self')], [choice('saved')]],
        hold: false,
      });
    const reply = await ask('delegation-unsaved');
    const question = service.todos.getQuestion(
      (reply as { value: { questionId: string } }).value.questionId
    )!;
    expect(question.text).toContain('- I sign in\n');
    expect(question.text).not.toContain('I sign in: I sign in');
    expect(question.text).toContain('Work continues using the default until you answer.');
    await invoke(
      'neo.question.answer',
      { questionId: question.id, answer: question.options![0] },
      human
    );
    const saved = await ask('delegation-saved');
    const next = service.todos.getQuestion(
      (saved as { value: { questionId: string } }).value.questionId
    )!;
    expect(next.text).not.toContain('Work continues using the default until you answer.');
    expect(next.options?.at(-1)).toBe('Keep current settings');
  });

  test('a settings choice explains each option without a table', async () => {
    db.updateGlobalSettings({ language: 'en' });
    const declaration = {
      scope: 'global' as const,
      type: { kind: 'enum' as const, values: ['one', 'two'] },
      default: 'one',
      ask: 'Choose a setting',
      label: { en: 'Setting', 'zh-Hans': '设置' },
      question: { en: 'Which setting?', 'zh-Hans': '选择哪个设置？' },
      valueLabels: {
        one: { en: 'One', 'zh-Hans': '一' },
        two: { en: 'Two', 'zh-Hans': '二' },
      },
      valueDescriptions: {
        one: { en: 'First behavior', 'zh-Hans': '第一个行为' },
        two: { en: 'Second behavior', 'zh-Hans': '第二个行为' },
      },
    };
    service.filePacks = [
      {
        id: 'synthetic',
        describe: 'Synthetic',
        instructions: () => null,
        preferences: { mode: declaration },
      },
    ];
    const choice = (value: string) => ({
      pack: 'synthetic',
      scope: { kind: 'global', key: '' },
      key: 'mode',
      value,
    });
    const reply = await invoke('pack.preferences.ask', {
      askId: 'ask',
      requestId: 'described-choice',
      alternatives: [[choice('one')], [choice('two')]],
    });
    const question = service.todos.getQuestion(
      (reply as { value: { questionId: string } }).value.questionId
    )!;
    expect(question.text).toContain('Which setting?');
    expect(question.text).toContain('First behavior');
    expect(question.text).toContain('Second behavior');
    expect(question.text).not.toContain('| --- |');
    expect(question.options).toEqual(['One', 'Two', 'Use the default for now']);

    db.updateGlobalSettings({ language: 'system' });
    db.getDatabase()
      .prepare(`INSERT INTO neo_conversation_asks
      (conversation_id, request_id, payload_json, created_at) VALUES (?, ?, ?, ?)`)
      .run(
        'synthetic',
        'last-human',
        JSON.stringify({ content: '请使用中文' }),
        new Date().toISOString()
      );
    const chinese = await invoke('pack.preferences.ask', {
      askId: 'ask',
      requestId: 'chinese-choice',
      alternatives: [[choice('one')], [choice('two')]],
      hold: false,
    });
    const translated = service.todos.getQuestion(
      (chinese as { value: { questionId: string } }).value.questionId
    )!;
    expect(translated.text).toContain('选择哪个设置？');
    expect(translated.text).toContain('第一个行为');
    expect(translated.text).toContain('回答之前，工作将继续使用默认设置。');
    expect(translated.options).toEqual(['一', '二', '暂时使用默认设置']);
  });

  test('a settings question holds the ask work unless it is asked with hold false', async () => {
    const work = service.todos.addTodo(
      'held-work',
      'ask',
      { title: 'Work', doneWhen: 'Done', check: null, instruction: 'Do it', named: null },
      1
    );
    const held = service.todos.getQuestion(await propose())!;
    expect(held.todos).toEqual([work.id]);
    const reply = await invoke('pack.preferences.ask', {
      askId: 'ask',
      requestId: 'free-request',
      values: [values[0]],
      hold: false,
    });
    const free = service.todos.getQuestion(
      (reply as { value: { questionId: string } }).value.questionId
    )!;
    expect(free.todos).toEqual([]);
    expect(
      await invoke('pack.preferences.ask', {
        askId: 'ask',
        requestId: 'free-request',
        values: [values[0]],
      })
    ).toMatchObject({ value: { ok: false, reason: 'proposal_is_immutable' } });
    expect(
      await invoke('pack.preferences.ask', {
        askId: 'ask',
        requestId: 'synthetic-request',
        values,
        hold: false,
      })
    ).toMatchObject({ value: { ok: false, reason: 'proposal_is_immutable' } });
  });

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
    await invoke('neo.question.answer', { questionId, answer: option(questionId, 0) }, human);
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
    const updated = Promise.withResolvers<void>();
    promptUpdated = updated.resolve;
    expect(
      await invoke('neo.question.answer', { questionId, answer: option(questionId, 0) }, human)
    ).toMatchObject({ value: { ok: true } });
    expect(await saved()).toMatchObject({
      value: {
        preferences: values.map((value) => ({
          ...value,
          setBy: 'human',
          setAt: expect.any(Number),
        })),
      },
    });
    await updated.promise;
    expect(
      db.getSession('neo:10000000-0000-4000-8000-000000000003')?.config.systemPrompt
    ).toContain(
      '"scope":{"kind":"repo","key":"synthetic/one"},"key":"reviewBot","value":"synthetic-bot"'
    );
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
      'Apply these settings',
      'Keep current settings',
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
      '应用这些设置',
      '保留当前设置',
    ],
  ] as const)(
    'renders the bound repo-grouped proposal in %s',
    async (language, title, setting, value, policy, review, bot, ci, apply, keep) => {
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
      expect(question).toMatchObject({ kind: 'choice', options: [apply, keep], multiple: false });
      db.updateGlobalSettings({ language: language === 'en' ? 'zh-Hans' : 'en' });
      expect(await propose()).toBe(questionId);
      expect(service.todos.getQuestion(questionId)!.text).toBe(question.text);
      expect(
        await invoke('neo.question.answer', { questionId, answer: option(questionId, 0) }, human)
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
    await invoke('neo.question.answer', { questionId, answer: option(questionId, 0) }, human);
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
  test.each(['button keep', 'B', 'yes', 'Please change the proposal'])(
    'human %s never writes settings',
    async (answer) => {
      const questionId = await propose();
      if (answer === 'button keep')
        await invoke('neo.question.answer', { questionId, answer: option(questionId, 1) }, human);
      else await chat(questionId, answer);
      expect(service.todos.getQuestion(questionId)?.state).toBe('answered');
      expect(await invoke('pack.preferences.applyAnswer', { questionId })).toMatchObject({
        value: { ok: false },
      });
      expect(await saved()).toMatchObject({ value: { preferences: [] } });
    }
  );
  test.each(['A', 'the apply option'])(
    'a human chat %s applies the same immutable proposal',
    async (words) => {
      const questionId = await propose();
      await chat(questionId, words === 'A' ? words : option(questionId, 0));
      expect(await invoke('neo.question.get', { questionId })).toMatchObject({
        value: { answeredByHuman: true },
      });
      expect(await saved()).toMatchObject({
        value: { preferences: values.map((value) => ({ ...value, setBy: 'human' })) },
      });
    }
  );

  test('agents cannot answer; legacy/unbound human yes has no settings effect', async () => {
    const questionId = await propose();
    expect(
      await invoke('neo.question.answer', { questionId, answer: option(questionId, 0) })
    ).toMatchObject({
      kind: 'failed',
      code: 'forbidden',
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
      },
      1
    );
    service.todos.answerQuestion(legacy, 'yes', 'button', 2);
    expect(await invoke('pack.preferences.applyAnswer', { questionId: 'legacy' })).toMatchObject({
      value: { ok: false },
    });
    expect(await saved()).toMatchObject({ value: { preferences: [] } });
  });
  test.each(['button', 'chat', 'applyAnswer'])(
    'a yes/no proposal answered yes saves nothing by %s',
    async (surface) => {
      const questionId = 'legacy-settings';
      openHumanCard(
        service.todos,
        questionId,
        'ask',
        {
          text: 'Apply these settings?',
          kind: 'yesno',
          options: null,
          multiple: false,
          noLabel: 'Keep current settings',
          yesLabel: 'Apply these settings',
        },
        1
      );
      db.getDatabase()
        .prepare(
          'INSERT INTO neo_pack_preference_proposals (question_id, request_id, values_json, question_text) VALUES (?, ?, ?, ?)'
        )
        .run(questionId, 'legacy', JSON.stringify(values), 'Apply these settings?');
      if (surface === 'chat') await chat(questionId, 'yes');
      else await invoke('neo.question.answer', { questionId, answer: 'yes' }, human);
      if (surface === 'applyAnswer')
        expect(await invoke('pack.preferences.applyAnswer', { questionId })).toMatchObject({
          value: { ok: false },
        });
      expect(await saved()).toMatchObject({ value: { preferences: [] } });
    }
  );
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
  test.each([1, 0, 'retired'] as const)(
    'retry after %s reports a closed question and a new request reaches the human',
    async (answer) => {
      const questionId = await propose();
      if (answer === 'retired')
        service.todos.retireQuestion(service.todos.getQuestion(questionId)!, 'superseded', null, 2);
      else
        await invoke(
          'neo.question.answer',
          { questionId, answer: option(questionId, answer) },
          human
        );
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
    expect(
      await invoke('neo.question.answer', { questionId, answer: option(questionId, 0) }, human)
    ).toMatchObject({ kind: 'failed' });
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
    expect(
      await invoke('neo.question.answer', { questionId, answer: option(questionId, 0) }, human)
    ).toMatchObject({ kind: 'failed' });
    expect(service.todos.getQuestion(questionId)?.state).toBe('open');
    expect(await saved()).toMatchObject({ value: { preferences: [] } });
  });

  test('a choice between alternatives applies only the option the human picks', async () => {
    db.updateGlobalSettings({ language: 'en' });
    const strategy = (value: string) => ({
      pack: 'coding',
      scope: { kind: 'repo', key: 'synthetic/one' },
      key: 'sessionStrategy',
      value,
    });
    const ask = (requestId: string) =>
      invoke('pack.preferences.ask', {
        askId: 'ask',
        requestId,
        alternatives: [[strategy('long_lived')], [strategy('per_task')], [strategy('per_pr')]],
      });
    const reply = await ask('strategy');
    expect(reply).toMatchObject({ value: { ok: true } });
    const questionId = (reply as { value: { questionId: string } }).value.questionId;
    expect(await ask('strategy')).toEqual(reply);
    expect(service.todos.getQuestion(questionId)!.text).toContain(
      'How should coding sessions be reused in this repository?'
    );
    db.updateGlobalSettings({ language: 'zh-Hans' });
    const translated = (await ask('strategy-chinese')) as { value: { questionId: string } };
    expect(service.todos.getQuestion(translated.value.questionId)!.text).toContain(
      '如何在此仓库复用编码会话？'
    );
    db.updateGlobalSettings({ language: 'en' });
    expect(service.todos.getQuestion(questionId)).toMatchObject({
      kind: 'choice',
      multiple: false,
      options: [
        'Long-lived work-type sessions',
        'One session per task',
        'One session per PR',
        'Use the default for now',
      ],
    });
    expect(await invoke('pack.preferences.applyAnswer', { questionId })).toMatchObject({
      value: { ok: false },
    });
    expect(await saved()).toMatchObject({ value: { preferences: [] } });
    await invoke('neo.question.answer', { questionId, answer: option(questionId, 1) }, human);
    expect(await saved()).toMatchObject({
      value: { preferences: [{ ...strategy('per_task'), setBy: 'human' }] },
    });

    const kept = (await ask('strategy-kept')) as { value: { questionId: string } };
    await invoke(
      'neo.question.answer',
      { questionId: kept.value.questionId, answer: option(kept.value.questionId, 3) },
      human
    );
    expect(await saved()).toMatchObject({
      value: { preferences: [{ ...strategy('per_task'), setBy: 'human' }] },
    });
  });

  test('a choice keeps every option, including keep, within chat letter replies', async () => {
    const choice = (count: number) =>
      invoke('pack.preferences.ask', {
        askId: 'ask',
        requestId: `letters-${count}`,
        alternatives: Array.from({ length: count }, (_, index) => [
          { ...values[2], value: index % 2 ? 'ci_only' : 'human' },
          { ...values[2], key: 'humanSignoff', value: [`docs/${index}/**`] },
        ]),
      });
    expect(await choice(6)).toMatchObject({ kind: 'failed' });
    const reply = (await choice(5)) as { value: { questionId: string } };
    const questionId = reply.value.questionId;
    expect(service.todos.getQuestion(questionId)!.options).toHaveLength(6);
    expect(service.todos.getQuestion(questionId)!.text).toContain('Choose one of these settings?');
    expect(service.todos.getQuestion(questionId)!.text).not.toContain('| --- |');
    await chat(questionId, 'F');
    expect(service.todos.getQuestion(questionId)).toMatchObject({
      state: 'answered',
      answer: ['Use the default for now'],
    });
    expect(await saved()).toMatchObject({ value: { preferences: [] } });
  });
});
