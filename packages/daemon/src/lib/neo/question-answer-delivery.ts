import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import { SendMessageResultSchema } from '../messaging/message-send.ts';
import { WorkDeliverySchema } from '../drivers/types.ts';
import { renderRemoteAddress } from '../mailbox/address.ts';
import { driverWorkCaller } from './driver-work.ts';
import { ReadWorkResultSchema } from '../drivers/read-operation.ts';
import { neoDerivedId } from './derived-id.ts';
import { neoQuestionAnsweredNote } from './question-operations.ts';
import type { NeoService } from './service.ts';
import type { NeoTodoRunner, NeoTodoRunnerDeps } from './todo-runner.ts';

type Route = ReturnType<NeoAskTodoRepository['questionAnswers']['pending']>[number];
const Sent = z.object({ ok: z.literal(true), value: WorkDeliverySchema });
const NotSent = z.union([
  z.object({ ok: z.literal(false), notSent: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum([
      'not_open',
      'not_found',
      'unsupported',
      'not_supported',
      'unknown_adapter',
      'busy',
    ]),
  }),
]);

export function createNeoQuestionAnswerDelivery(
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  invoke: NeoTodoRunnerDeps['invoke'],
  tell: NeoService['deliverForward'],
  resume: NeoTodoRunner['recompute'],
  warn: (error: unknown) => void
) {
  const deliver = (superpipe({})('neo.question.deliverAnswer') as PipelineAPI)
    .input(['route'])
    .pipe(
      (route: Route) => {
        const todo = store.getTodo(route.todoId);
        const ask = todo && store.getAsk(todo.askId);
        const assigned = sessions.readRef(route.todoId);
        const ref = route.sourceSession;
        return todo?.blockedBy === 'needs-human' &&
          ask?.status === 'open' &&
          assigned?.adapter === ref.adapter &&
          assigned.id === ref.id &&
          assigned.daemon === ref.daemon
          ? { value: { route, ask, ref } }
          : { reason: false };
      },
      'route',
      'result:outcome'
    )
    .pipe(
      (plan: { route: Route; ask: { sessionId: string }; ref: Route['sourceSession'] }) => {
        const key = neoDerivedId(
          JSON.stringify([plan.route.id, plan.ref.adapter, plan.ref.id, plan.ref.daemon])
        );
        const question = store.getQuestion(plan.route.questionId)!;
        const note = neoQuestionAnsweredNote(question, []);
        const marker = `[worker-answer:${key}]`;
        const text = plan.ref.adapter === 'hyperneo' ? `${note}\n${marker}` : `${marker}\n${note}`;
        return { ...plan, key, note, text };
      },
      'outcome',
      'delivery'
    )
    .pipe(
      async (delivery: {
        route: Route;
        ask: { sessionId: string };
        ref: Route['sourceSession'];
        key: string;
        note: string;
        text: string;
      }) => {
        const { route, ask, ref, key, note, text } = delivery;
        const caller = driverWorkCaller({ originSessionId: ask.sessionId });
        if (route.answeredBy !== 'chat')
          await tell(
            ask.sessionId,
            `neo-question:${route.questionId}`,
            note,
            ask.sessionId,
            'event'
          );
        const claimed = store.questionAnswers.claim(route.id, key);
        let receipt: string | null = null;
        if (ref.adapter === 'hyperneo') {
          const to = ref.daemon
            ? renderRemoteAddress({
                kind: 'remote-session',
                daemonId: ref.daemon,
                sessionId: ref.id,
              })
            : ref.id;
          const result = await invoke(caller, 'message.send', { to, text, idempotencyKey: key });
          const sent = SendMessageResultSchema.safeParse(
            result.kind === 'completed' ? result.value : null
          );
          receipt = sent.success && sent.data.kind === 'accepted' ? sent.data.messageId : null;
          if (receipt === null && claimed) store.questionAnswers.retry(route.id, key);
        } else if (claimed) {
          const result = await invoke(caller, 'work.send', { ref, message: text });
          const value = result.kind === 'completed' ? result.value : null;
          const sent = Sent.safeParse(value);
          if (sent.success && !sent.data.value.unconfirmed) receipt = key;
          else if (NotSent.safeParse(value).success) store.questionAnswers.retry(route.id, key);
        } else {
          const marker = `[worker-answer:${key}]`;
          const result = await invoke(caller, 'work.read', {
            sessionId: ref.id,
            ...(ref.daemon ? { daemon: ref.daemon } : {}),
            input: { adapter: ref.adapter, marker },
          });
          const read = ReadWorkResultSchema.safeParse(
            result.kind === 'completed' ? result.value : null
          );
          if (
            read.success &&
            read.data.ok &&
            read.data.value.sessionId === ref.id &&
            read.data.value.matchedInput?.adapter === ref.adapter &&
            read.data.value.matchedInput.marker === marker &&
            read.data.value.turns.some(
              (turn) =>
                turn.role === 'user' &&
                (turn.text === marker || turn.text.startsWith(`${marker}\n`))
            )
          )
            receipt = key;
        }
        return receipt !== null && store.questionAnswers.accept(route.id, receipt, Date.now(), key);
      },
      'delivery',
      'outcome'
    )
    .endAsync('outcome') as (route: Route) => Promise<boolean>;
  return async (questionId?: string) => {
    const todos = questionId
      ? store.questionAnswers.list(questionId).map((route) => store.getTodo(route.todoId))
      : store.listCheckable();
    for (const route of store.questionAnswers.pending(questionId)) await deliver(route).catch(warn);
    for (const todo of todos) if (todo?.blockedBy === 'needs-human') await resume(todo).catch(warn);
  };
}
