import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { Database } from '../../src/storage/sqlite-compat.ts';
import { NeoAskTodoRepository } from '../../src/storage/repositories/neo-ask-todo-repository.ts';
import { SessionScheduleRepository } from '../../src/storage/repositories/session-schedule-repository.ts';
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
  new SessionScheduleRepository(db).recordWake(
    sessionId,
    messageId,
    { scheduleId, sourceKind: 'goal', sourceId: goal.id },
    Date.now()
  );
  const legacyInputs = new Set([messageId]);
  const saveInput = (uuid: string, content: string) => {
    sdk.saveUserMessage(
      sessionId,
      {
        type: 'user',
        uuid,
        message: { role: 'user', content },
        inputKind: 'system',
      } as SDKMessage,
      'enqueued',
      'system'
    );
    if (sdk.markDeliveryConsumedByUuids(sessionId, [uuid]).length !== 1)
      throw new Error('Wake fixture was not consumed');
    return db
      .prepare(
        'SELECT seq, consumed_seq AS consumed FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?'
      )
      .get(sessionId, uuid) as { seq: number; consumed: number };
  };
  const input = saveInput(messageId, 'PRIVATE_WAKE_INSTRUCTIONS');
  let boundInput = messageId;
  const nextInput = (steered = false) => {
    const uuid = crypto.randomUUID();
    if (!steered) boundInput = uuid;
    return saveInput(uuid, 'An unrelated next input.');
  };
  const continuation = (uuid: string) => {
    legacyInputs.add(uuid);
    boundInput = uuid;
    return saveInput(uuid, 'Continue the same wake.');
  };
  db.prepare('UPDATE sessions SET processing_state = ? WHERE id = ?').run(
    '{"status":"processing"}',
    sessionId
  );
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
  const finish = (text = 'Details first.\nGuide cycle complete.', stamped = true) => {
    const uuid = crypto.randomUUID();
    const message = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      uuid,
      session_id: sessionId,
    } as SDKMessage;
    if (
      !sdk.saveSDKMessage(
        sessionId,
        stamped
          ? {
              ...message,
              neoInputOrigin: { sessionId, messageId: boundInput },
              neoAskOrigin: {
                sessionId,
                messageId: legacyInputs.has(boundInput) ? messageId : boundInput,
              },
            }
          : message
      )
    )
      throw new Error('Terminal fixture rejected');
    const result = db
      .prepare(
        'SELECT consumed_seq AS consumed, timestamp FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?'
      )
      .get(sessionId, uuid) as { consumed: number; timestamp: string };
    return { ...result, uuid };
  };
  return { goal, scheduleId, messageId, expected, input, nextInput, continuation, finish };
}
