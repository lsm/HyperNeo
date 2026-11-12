import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { globalSettingsWrites } from '../../../../src/storage/repositories/global-settings-writes.ts';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoQuestion } from '@hyperneo/shared/types/neo-ask';
import { createNeoRelayOperations } from '../../../../src/lib/neo/relay-answer.ts';
import { planNeoRelayAnswer } from '../../../../src/lib/neo/relay-plan.ts';
import { createNeoService } from '../../helpers/neo-service.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { planSessionDoorCall } from '../../../../src/lib/messaging/session-door.ts';
import { stampSessionMessage } from '../../../../src/lib/messaging/message-send.ts';

const human: OperationCaller = { source: 'rpc', principal: 'local' };
const sender = 'synthetic-worker';
const input = {
  questionId: 'card',
  where: 'a local discussion',
  when: 'Monday evening',
  words: '  Keep these words.\nExactly.  ',
};
const configured = [{ sender, name: 'Synthetic relay' }];
let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
let notes: string[];
const door = () => {
  const call = planSessionDoorCall({ sender, name: 'neo.question.relayAnswer', input });
  if ('reason' in call) throw new Error(call.reason);
  return call.value.caller;
};
const invoke = (name: string, value: unknown, caller = door()) =>
  invokeOperation(createOperationRegistry(createNeoRelayOperations(service)), name, value, caller);
function card(patch: Partial<NeoQuestion> = {}) {
  return service.todos.askQuestion(
    'card',
    'ask',
    {
      text: 'What should happen?',
      kind: 'reply',
      options: null,
      multiple: false,
      noLabel: null,
      yesLabel: null,
      startTodos: null,
      ...patch,
    },
    1
  );
}
beforeEach(async () => {
  db = await createTestDb();
  await db.createSession(createTestSession('neo:relay-test'));
  service = createNeoService(
    db,
    {} as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus()
  );
  notes = [];
  service.deliverForward = async (_session, _id, note) => {
    notes.push(String(note));
  };
  service.deliverQuestionAnswers = async () => {};
  service.todos.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo:relay-test',
    originMessageId: null,
    title: 'Synthetic card',
    request: 'Choose a result',
    createdAt: 1,
  });
});
afterEach(() => {
  service.dispose();
  db.close();
});
const configure = () => invoke('neo.relaySenders.set', { relaySenders: configured }, human);

test('an unlisted sender is refused without changes', async () => {
  card();
  expect(await invoke('neo.question.relayAnswer', input)).toMatchObject({
    value: { ok: false, reason: expect.stringContaining('sender_not_allowed') },
  });
  expect(service.todos.getQuestion('card')?.state).toBe('open');
  expect(notes).toEqual([]);
});
test('an allowed relay uses the chat answer write and persists exact words and provenance', async () => {
  card();
  await configure();
  expect(await invoke('neo.question.relayAnswer', input)).toMatchObject({ value: { ok: true } });
  const question = service.todos.getQuestion('card');
  expect(question).toMatchObject({
    state: 'answered',
    answeredBy: 'chat',
    answer: input.words.trim(),
    answerProvenance: {
      words: input.words,
      via: sender,
      viaName: 'Synthetic relay',
      where: input.where,
      when: input.when,
      at: expect.any(Number),
    },
  });
  const queued = db
    .getJobQueueRepo()
    .listActiveByPayload('mailbox', { 'to.sessionId': 'neo:relay-test' });
  expect(queued).toHaveLength(1);
  const note = (queued[0].payload as { message: { message: { content: string } } }).message.message
    .content;
  expect(note).toStartWith('Relayed by Synthetic relay, Monday evening, a local discussion:');
  expect(note).toContain(input.words);
  expect(await invoke('neo.question.relayAnswer', input)).toMatchObject({ value: { ok: false } });
  expect(service.todos.getQuestion('card')).toEqual(question);
});
test('a choice-letter relay maps the semantic answer and retains the exact words', async () => {
  card({ kind: 'choice', options: ['Alpha', 'Beta'] });
  await configure();
  const words = '  pick B  ';
  expect(await invoke('neo.question.relayAnswer', { ...input, words })).toMatchObject({
    value: { ok: true },
  });
  const question = service.todos.getQuestion('card');
  expect(question?.answer).toEqual(['Beta']);
  expect(question?.answerProvenance).toMatchObject({ words });
  const queued = db
    .getJobQueueRepo()
    .listActiveByPayload('mailbox', { 'to.sessionId': 'neo:relay-test' });
  expect(queued).toHaveLength(1);
  const note = (queued[0].payload as { message: { message: { content: string } } }).message.message
    .content;
  expect(note).toContain(`\n${words}\n`);
});
test.each(['rule', 'home', 'start', 'preference'])(
  '%s cards refuse relay without releasing a todo or writing preferences',
  async (kind) => {
    card({
      kind: kind === 'start' ? 'start' : 'yesno',
      ...(kind === 'start' ? { startTodos: ['held'] } : {}),
      ...(kind === 'home' ? { confirm: { path: 'direction.md', sha256: 'a'.repeat(64) } } : {}),
    });
    const sql = db.getDatabase();
    if (kind === 'rule')
      sql
        .prepare(
          'INSERT INTO neo_rule_proposals (question_id,request_id,edit_json,question_text) VALUES (?,?,?,?)'
        )
        .run('card', 'rule', '{"add":["Changed"],"remove":[]}', 'What should happen?');
    if (kind === 'preference')
      sql
        .prepare(
          'INSERT INTO neo_pack_preference_proposals (question_id,request_id,values_json,question_text) VALUES (?,?,?,?)'
        )
        .run(
          'card',
          'preference',
          '[{"pack":"synthetic","scope":{"kind":"global","key":""},"key":"choice","value":"changed"}]',
          'What should happen?'
        );
    service.todos.addTodo(
      'held',
      'ask',
      {
        title: 'Held work',
        doneWhen: 'Finished',
        instruction: 'Stay held',
        check: null,
        named: null,
      },
      1
    );
    service.todos.updateTodo(
      service.todos.getTodo('held')!,
      {
        state: 'blocked',
        blockedBy: 'question',
        approvalQuestionId: kind === 'start' ? 'card' : null,
      },
      1
    );
    const beforeTodo = service.todos.getTodo('held');
    const beforeSettings = db.getGlobalSettings();
    const beforePreferences = sql
      .prepare('SELECT * FROM neo_pack_preferences ORDER BY pack, scope_kind, scope_key, key')
      .all();
    await configure();
    expect(
      await invoke('neo.question.relayAnswer', {
        ...input,
        words: kind === 'start' ? 'held' : 'yes',
      })
    ).toMatchObject({
      value: { ok: false },
    });
    expect(service.todos.getQuestion('card')).toMatchObject({ state: 'open', answer: null });
    expect(service.todos.getTodo('held')).toEqual(beforeTodo);
    expect(db.getGlobalSettings().neo?.standingRules).toEqual(beforeSettings.neo?.standingRules);
    expect(
      sql
        .prepare('SELECT * FROM neo_pack_preferences ORDER BY pack, scope_kind, scope_key, key')
        .all()
    ).toEqual(beforePreferences);
    expect(notes).toEqual([]);
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'neo:relay-test' })
    ).toHaveLength(0);
  }
);
test.each(['where', 'when', 'words'])('missing %s refuses relay', async (field) => {
  const question = card();
  const plan = planNeoRelayAnswer({ relaySenders: configured }, question, {
    ...input,
    sender,
    at: 1,
    [field]: '  ',
  });
  expect(plan).toHaveProperty('reason');
  await configure();
  expect(await invoke('neo.question.relayAnswer', { ...input, [field]: '' })).toMatchObject({
    value: { ok: false },
  });
  expect(service.todos.getQuestion('card')?.state).toBe('open');
});
test('only a local RPC user can set relay senders', async () => {
  for (const caller of [
    door(),
    { source: 'mcp', role: 'neo', sessionId: sender } as const,
    { source: 'rpc', principal: 'remote' } as const,
  ]) {
    expect(
      await invoke('neo.relaySenders.set', { relaySenders: configured }, caller)
    ).toMatchObject({ kind: 'failed', code: 'forbidden' });
  }
  expect(db.getGlobalSettings().neo?.relaySenders ?? []).toEqual([]);
  expect(await configure()).toMatchObject({ value: { ok: true } });
  await gatewayFor(db.getDatabase()).call(globalSettingsWrites, 'apply', {
    neo: { relaySenders: [] },
  });
  expect(db.getGlobalSettings().neo?.relaySenders).toEqual(configured);
});
test('MCP and RPC cannot relay, and ordinary session messages remain task input', async () => {
  card();
  await configure();
  for (const caller of [human, { source: 'mcp', sessionId: sender, role: 'neo' } as const]) {
    expect(await invoke('neo.question.relayAnswer', input, caller)).toMatchObject({
      value: { ok: false },
    });
  }
  const stamped = await stampSessionMessage(
    {
      sessionId: 'neo:relay-test',
      message: { type: 'user', parent_tool_use_id: null, message: { content: 'yes' } },
    },
    `session:${sender}`,
    async () => 'Synthetic relay'
  );
  expect(stamped.message.inputKind).toBe('task');
  expect(service.todos.getQuestion('card')?.state).toBe('open');
});

test('a session message to the front is wrapped as an ordinary session message', async () => {
  const message = {
    type: 'user' as const,
    parent_tool_use_id: null,
    message: { content: 'Found it' },
  };
  const stamped = await stampSessionMessage(
    { sessionId: 'front', message },
    `session:${sender}`,
    async () => 'Synthetic relay'
  );
  expect(stamped.message.message.content).toContain('<session-message');
  expect(stamped.message.message.content).toContain('Synthetic relay');
  expect(stamped.message.message.content).not.toContain('background');
});

test('concurrent relays commit one answer and one durable notification', async () => {
  card();
  await configure();
  const results = await Promise.all([
    invoke('neo.question.relayAnswer', input),
    invoke('neo.question.relayAnswer', { ...input, words: 'Other words' }),
  ]);
  expect(
    results.filter((r) => r.kind === 'completed' && (r.value as { ok: boolean }).ok)
  ).toHaveLength(1);
  expect(
    db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'neo:relay-test' })
  ).toHaveLength(1);
});
test('a failed notification enqueue rolls back the answer and provenance', async () => {
  card();
  await configure();
  db.getDatabase().exec(
    "CREATE TRIGGER fail_relay_queue BEFORE INSERT ON job_queue BEGIN SELECT RAISE(ABORT, 'synthetic_queue_failure'); END"
  );
  expect(await invoke('neo.question.relayAnswer', input)).toMatchObject({ kind: 'failed' });
  expect(service.todos.getQuestion('card')).toMatchObject({ state: 'open', answer: null });
  expect(service.todos.getQuestion('card')?.answerProvenance).toBeUndefined();
});
