import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { Database } from '../../src/storage/sqlite-compat.ts';
import { NeoAskTodoRepository } from '../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoInputOriginRepository } from '../../src/storage/repositories/neo-input-origin-repository.ts';
import { NeoPublicationRepository } from '../../src/storage/repositories/neo-publication-repository.ts';
import { SDKMessageRepository } from '../../src/storage/repositories/sdk-message-repository.ts';
import { SessionGoalRepository } from '../../src/storage/repositories/session-goal-repository.ts';

export function seedNeoWake(db: Database, conversationId: string, additions = true) {
  const sessionId = `neo:${conversationId}`;
  const goals = new SessionGoalRepository(db);
  const goal = goals.create(
    sessionId,
    { title: 'Publish the guide', doneTest: 'Published' },
    'neo',
    Date.now()
  );
  const scheduleId = crypto.randomUUID();
  const messageId = `schedule:${scheduleId}:${Date.now()}`;
  const sdk = new SDKMessageRepository(db);
  new NeoInputOriginRepository(db).record(
    { sessionId, messageId },
    { sessionId, messageId },
    Date.now(),
    `scheduled_wake:${JSON.stringify({ scheduleId, sourceKind: 'goal', sourceId: goal.id })}`
  );
  if (
    !sdk.saveSDKMessage(
      sessionId,
      {
        type: 'user',
        uuid: messageId,
        message: { role: 'user', content: 'PRIVATE_WAKE_INSTRUCTIONS' },
        inputKind: 'system',
      } as SDKMessage,
      'system'
    )
  )
    throw new Error('Wake fixture rejected');
  db.prepare('UPDATE sessions SET processing_state = ? WHERE id = ?').run(
    '{"status":"processing"}',
    sessionId
  );
  const input = db
    .prepare('SELECT seq FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?')
    .get(sessionId, messageId) as { seq: number };
  db.prepare('UPDATE sdk_messages SET consumed_seq = ? WHERE seq = ?').run(input.seq, input.seq);
  db.exec('UPDATE delivery_consumed_seq SET next_seq = MAX(next_seq, 1000)');
  const expected: { kind: string; id: string; label: string }[] = [];
  if (additions) {
    const store = new NeoAskTodoRepository(db);
    const ask = store.openAsk({
      id: crypto.randomUUID(),
      projectId: null,
      goalId: goal.id,
      sessionId,
      originMessageId: messageId,
      title: 'Publish guide',
      request: 'Publish it',
      createdAt: Date.now(),
    });
    const todo = store.addTodo(
      crypto.randomUUID(),
      ask.id,
      { title: 'Review guide', doneWhen: 'Reviewed', instruction: null, named: null, check: null },
      Date.now()
    );
    const question = store.askQuestion(
      crypto.randomUUID(),
      ask.id,
      {
        text: 'Which language?',
        kind: 'reply',
        options: null,
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos: null,
      },
      Date.now()
    );
    const publicationId = crypto.randomUUID();
    const publication = new NeoPublicationRepository(db).append({
      conversationId,
      publicationId,
      askOrigin: { sessionId, messageId },
      producerInput: { sessionId, messageId },
      shortText: 'Guide ready.',
      fullText: 'The guide is ready.',
      links: [],
    });
    if (!publication.accepted) throw new Error('Publication fixture rejected');
    const journal = goals.appendJournal(
      goal.id,
      sessionId,
      {
        runId: messageId,
        done: 'Reviewed',
        effect: 'Guide ready.',
        evidence: [],
        worked: 'Read the guide',
      },
      Date.now()
    );
    expected.push(
      { kind: 'ask', id: ask.id, label: ask.title },
      { kind: 'todo', id: todo.id, label: todo.title },
      { kind: 'question', id: question.id, label: question.text },
      { kind: 'publication', id: publicationId, label: 'Guide ready.' },
      { kind: 'journal', id: journal.id, label: journal.effect }
    );
    store.openAsk({
      id: crypto.randomUUID(),
      projectId: null,
      goalId: goal.id,
      sessionId,
      originMessageId: 'other-turn',
      title: 'Not from this wake',
      request: 'Other turn',
      createdAt: Date.now(),
    });
  }
  const finish = (shareInput = true, text = 'Details first.\nGuide cycle complete.') => {
    const uuid = crypto.randomUUID();
    if (
      !sdk.saveSDKMessage(sessionId, {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: text,
        uuid,
        session_id: sessionId,
      } as SDKMessage)
    )
      throw new Error('Terminal fixture rejected');
    const result = db
      .prepare(
        'SELECT consumed_seq AS consumed, timestamp FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?'
      )
      .get(sessionId, uuid) as { consumed: number; timestamp: string };
    if (shareInput)
      db.prepare('UPDATE sdk_messages SET consumed_seq = ? WHERE seq = ?').run(
        result.consumed,
        input.seq
      );
    return { ...result, uuid };
  };
  return { goal, scheduleId, messageId, expected, input, finish };
}
