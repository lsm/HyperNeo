import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import { WorkDeliverySchema } from '../drivers/types.ts';
import { driverWorkCaller } from './driver-work.ts';
import { WorkStatusResultSchema } from '../drivers/work-operations.ts';
import { ReadWorkInputSchema, ReadWorkResultSchema } from '../drivers/read-operation.ts';
import { neoDerivedId } from './derived-id.ts';
import { neoDaemonCardChoice, planNeoDaemonCardActions } from './daemon-cards.ts';
import { neoQuestionAnsweredNote } from './question-operations.ts';
import type { NeoService } from './service.ts';
import type { NeoTodoRunner, NeoTodoRunnerDeps } from './todo-runner.ts';

type Route = ReturnType<NeoAskTodoRepository['questionAnswers']['pending']>[number];
const Sent = z.object({ ok: z.literal(true), value: WorkDeliverySchema });
const Refused = z.object({ ok: z.literal(false), reason: z.string() });
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
        const queued = route.receipt
          ? await sessions.inputs.queuedFor(route.todoId, text, ref)
          : null;
        if (queued) {
          if (!queued.outcome) return false;
          if ('failure' in queued.outcome) {
            if (NotSent.safeParse({ ok: false, ...queued.outcome }).success) {
              store.questionAnswers.retry(route.id, key);
              return false;
            }
          } else if (!queued.outcome.delivery?.unconfirmed) {
            return store.questionAnswers.accept(route.id, key, Date.now(), key);
          }
        }
        const claimed = store.questionAnswers.claim(route.id, key);
        let receipt: string | null = null;
        if (claimed || (ref.adapter === 'hyperneo' && !queued)) {
          const result = await invoke(caller, 'work.send', {
            ref,
            message: text,
            todoId: route.todoId,
            idempotencyKey: key,
          });
          const value = result.kind === 'completed' ? result.value : null;
          const sent = Sent.safeParse(value);
          if (sent.success && !sent.data.value.unconfirmed && !sent.data.value.inputId)
            receipt = key;
          else if (NotSent.safeParse(value).success) store.questionAnswers.retry(route.id, key);
        } else if (
          !ReadWorkInputSchema.safeParse({
            sessionId: ref.id,
            input: { adapter: ref.adapter, marker: `[worker-answer:${key}]` },
          }).success
        ) {
          const marker = `[worker-answer:${key}]`;
          const result = await invoke(caller, 'work.status', {
            ref,
            since: Math.max(0, (route.attemptedAt ?? route.answeredAt ?? 0) - 1),
          });
          const status = WorkStatusResultSchema.safeParse(
            result.kind === 'completed' ? result.value : null
          );
          if (
            status.success &&
            status.data.ok &&
            status.data.value.ref.adapter === ref.adapter &&
            status.data.value.ref.id === ref.id &&
            status.data.value.recentInputs?.some(
              (input) =>
                input.text.split(/\s/, 1)[0] === marker ||
                (ref.adapter === 'hyperneo' && input.text.endsWith(`\n${marker}`))
            )
          )
            receipt = key;
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
  const apply = async (questionId: string) => {
    const card = store.getQuestion(questionId);
    if (!card) return;
    const [picked] = [card.answer].flat();
    for (const action of planNeoDaemonCardActions(card, store.listFamilyTodos(card.askId))) {
      const todo = store.getTodo(action.todoId);
      const ask = todo && store.getAsk(todo.askId);
      if (!ask) continue;
      const outcome = await invoke(
        driverWorkCaller({ originSessionId: ask.sessionId }),
        action.name,
        action.input
      ).catch((error: unknown) => ({ kind: 'failed' as const, message: String(error) }));
      const refused = Refused.safeParse(outcome.kind === 'completed' ? outcome.value : null);
      const reason = refused.success
        ? refused.data.reason
        : outcome.kind === 'failed'
          ? outcome.message
          : null;
      if (reason)
        await tell(
          ask.sessionId,
          `neo-card-refused:${card.id}:${action.todoId}`,
          `The human answered "${picked}" on the card for "${todo.title}", but ${action.name} was refused: ${reason}. Settle the todo or ask the human again.`,
          ask.sessionId,
          'event'
        );
    }
  };
  return async (questionId?: string) => {
    if (questionId && !store.questionAnswers.list(questionId).length) await apply(questionId);
    const todos = questionId
      ? store.questionAnswers.list(questionId).map((route) => store.getTodo(route.todoId))
      : store.listCheckable();
    for (const route of store.questionAnswers.pending(questionId)) {
      const card = store.getQuestion(route.questionId);
      if (!card || !neoDaemonCardChoice(card)) await deliver(route).catch(warn);
      else if (store.questionAnswers.claim(route.id, 'card-action')) await apply(card.id);
    }
    for (const todo of todos) if (todo?.blockedBy === 'needs-human') await resume(todo).catch(warn);
  };
}
