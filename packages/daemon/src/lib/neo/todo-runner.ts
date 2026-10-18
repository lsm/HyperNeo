import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import superpipe, { type PipelineAPI } from 'superpipe';
import type {
  NeoAskTodoRepository,
  NeoTodoPatch,
} from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import type { WorkRef } from '../drivers/types.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import type { OperationCaller } from '../operations/registry.ts';
import {
  driverWorkCall,
  driverWorkCaller,
  messageOpening,
  neoCardSent,
  type NeoDriverTarget,
  readDriverOutcome,
  readDriverActivity,
  readDriverFollowUp,
  readDriverLive,
  readDriverOpenedPrs,
  readDriverSendBaseline,
  readDriverSent,
  withWorkGoal,
} from './driver-work.ts';
import type { NeoPack, NeoTodoCheckResult } from './packs/types.ts';
import { type NeoDriverSettleDeps, settleNeoDriverWork } from './settle-driver-work.ts';

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
type Startable = {
  todo: NeoTodo;
  ask: NeoAsk;
  target: Extract<NeoDriverTarget, { verb: 'start' | 'send' }>;
};

const fail = (reason: string): { reason: Rejection } => ({ reason: { ok: false, reason } });

export const NEO_TODO_CHECK_MS = 2 * 60_000;

export interface NeoTodoRunnerDeps {
  store: NeoAskTodoRepository;
  sessions: NeoTodoSessionRepository;
  invoke(
    caller: OperationCaller,
    name: string,
    input: Record<string, unknown>
  ): Promise<OperationOutcome>;
  packs(): readonly NeoPack[];
  tell(ask: NeoAsk, todo: NeoTodo, note: string): Promise<void>;
  tellAsk(ask: NeoAsk, messageId: string, note: string): Promise<void>;
  changed(): void;
}

const CARD_STATUS: Record<NeoTodo['state'], NeoWork['status']> = {
  todo: 'proposed',
  doing: 'queued',
  done: 'reported',
  failed: 'failed',
  removed: 'cancelled',
};

export function neoTodoCard(todo: NeoTodo, ask: NeoAsk): NeoWork {
  return {
    id: todo.id,
    requestKey: todo.id,
    projectId: ask.projectId,
    originSessionId: ask.sessionId,
    originMessageId: ask.originMessageId,
    title: todo.title,
    instruction: todo.instruction ?? '',
    sessionId: null,
    status: todo.state === 'doing' && todo.report ? 'reported' : CARD_STATUS[todo.state],
    report: todo.report,
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
  };
}

export function requireNeoTodoStartable(read: {
  todo: NeoTodo | null;
  ask: NeoAsk | null;
  target: NeoDriverTarget | null;
}): Gate<Startable> {
  const { todo, ask, target } = read;
  if (!todo || !ask) return fail('not_found: no such todo.');
  if (ask.status !== 'open') return fail(`ask_settled: this ask is ${ask.status}.`);
  if (todo.state !== 'todo') return fail(`already_started: this todo is ${todo.state}.`);
  if (!todo.instruction || !target)
    return fail('no_session: this todo has no instruction and target; the daemon checks it.');
  if (target.verb === 'read' || target.verb === 'adopt')
    return fail(`unsupported_target: a todo cannot ${target.verb} a session.`);
  return { value: { todo, ask, target } };
}

export function requireNeoTodoContinuable(read: {
  todo: NeoTodo | null;
  ask: NeoAsk | null;
  ref: WorkRef | null;
}): Gate<{ todo: NeoTodo; ask: NeoAsk; ref: WorkRef }> {
  const { todo, ask, ref } = read;
  if (!todo || !ask) return fail('not_found: no such todo.');
  if (ask.status !== 'open') return fail(`ask_settled: this ask is ${ask.status}.`);
  if (todo.state === 'todo' || todo.state === 'removed' || !ref)
    return fail(`not_started: this todo is ${todo.state} and has no session to continue.`);
  return { value: { todo, ask, ref } };
}

export function requireNeoTodoRetryable(read: {
  todo: NeoTodo | null;
  ref: WorkRef | null;
  target: NeoDriverTarget | null;
  interrupted: boolean;
}): Gate<NeoTodo> {
  const { todo, ref, target } = read;
  if (!todo) return fail('not_found: no such todo.');
  if (read.interrupted)
    return fail(
      'start_uncertain: the start failed after the driver may have opened a session; find it with work.find before starting again.'
    );
  if (todo.state !== 'failed' || ref || !target)
    return fail('not_retryable: only a todo that failed before its session started goes again.');
  return { value: todo };
}

export function planNeoTodoSettled(
  settled: { status: 'reported' | 'failed'; report: string },
  now: number
): NeoTodoPatch {
  return settled.status === 'failed'
    ? { state: 'failed', reason: settled.report, finishedAt: now }
    : { report: settled.report };
}

export function planNeoTodoCheck(
  todo: NeoTodo,
  result: NeoTodoCheckResult | null,
  now: number
): NeoTodoPatch | null {
  return result?.done && todo.state !== 'done'
    ? { state: 'done', evidence: result.evidence, finishedAt: now }
    : null;
}

export function neoTodoNote(todo: NeoTodo): string {
  if (todo.state === 'failed') return `Todo "${todo.title}" failed: ${todo.reason ?? ''}`;
  if (todo.state === 'done' && todo.evidence)
    return `Todo "${todo.title}" is done: ${todo.evidence}`;
  if (todo.state === 'done')
    return `Todo "${todo.title}" reported and is done:\n${todo.report ?? ''}`;
  return `Todo "${todo.title}": its session stopped, which is not completion; the todo stays doing ${
    todo.check ? 'until its check passes' : 'until it is ticked with evidence'
  }. Its last report:\n${todo.report ?? '(none)'}`;
}

export function neoAskIdleNote(
  ask: NeoAsk,
  todos: readonly NeoTodo[],
  questions: readonly NeoQuestion[]
): string | null {
  if (todos.some((todo) => todo.state === 'doing')) return null;
  if (questions.some((question) => question.state === 'open')) return null;
  const listed = todos.filter((todo) => todo.state !== 'removed');
  return `Ask "${ask.title}" is open, but no todo is running and no question is open. Todos: ${
    listed.map((todo) => `"${todo.title}" ${todo.state}`).join(', ') || 'none'
  }.`;
}

export function createNeoTodoRunner(deps: NeoTodoRunnerDeps) {
  const { store, sessions } = deps;
  const checked = new Map<string, number>();
  const starting = new Set<string>();
  const caller = (ask: NeoAsk) => driverWorkCaller({ originSessionId: ask.sessionId });
  const finish = async (todo: NeoTodo, ask: NeoAsk, patch: NeoTodoPatch, now: number) => {
    const next = store.updateTodo(todo, patch, now);
    await deps.tell(ask, next, neoTodoNote(next));
    return next;
  };

  const dispatch = async ({ todo, ask, target }: Startable) => {
    const card = neoTodoCard(todo, ask);
    const call = driverWorkCall(target, card, {
      workId: todo.id,
      goal: null,
      doneWhen: todo.doneWhen,
    });
    const prepare = deps.packs().find((pack) => pack.id === todo.check?.pack);
    if (target.verb === 'start' && prepare?.prepareExecution)
      call.input.preparation = {
        pack: prepare.id,
        parameters: target.preparationParameters ?? {},
      };
    const message = String(call.input.message);
    const probe =
      target.verb === 'send'
        ? await deps.invoke(caller(ask), 'work.status', { ref: target.ref }).then((outcome) => ({
            baseline: readDriverSendBaseline(outcome, Date.now(), !!target.ref.daemon),
            sent: readDriverSent(outcome, message, todo.createdAt),
          }))
        : null;
    const baseline = probe ? probe.baseline : Date.now();
    const result = readDriverOutcome(target, await deps.invoke(caller(ask), call.name, call.input));
    if (!('ref' in result) && !result.reason) sessions.recordStartInterrupted(todo.id);
    if (!('ref' in result))
      return {
        ok: true as const,
        todo: await finish(
          todo,
          ask,
          { state: 'failed', reason: `Could not start: ${result.failure}`, finishedAt: Date.now() },
          Date.now()
        ),
      };
    sessions.recordRef(
      todo.id,
      result.ref,
      result.startedAt ?? ('queued' in result ? undefined : (baseline ?? undefined)),
      result.link,
      { model: result.model, effort: result.effort }
    );
    const opening = messageOpening(message);
    sessions.recordSent(
      todo.id,
      probe
        ? probe.sent && { ...probe.sent, receipt: result.receipt }
        : opening
          ? { inputBefore: 0, opening, ...(result.receipt ? { receipt: result.receipt } : {}) }
          : null
    );
    if (store.getAsk(ask.id)?.status !== 'open')
      await deps.invoke(caller(ask), 'work.stop', { ref: result.ref }).catch(() => null);
    deps.changed();
    return { ok: true as const, todo: store.getTodo(todo.id) ?? todo };
  };

  const start = (superpipe({})('neo.todo.start') as PipelineAPI)
    .input(['todoId'])
    .pipe(
      (todoId: string) => {
        const todo = store.getTodo(todoId);
        return {
          todo,
          ask: todo ? store.getAsk(todo.askId) : null,
          target: todo ? sessions.get(todo.id) : null,
        };
      },
      'todoId',
      'read'
    )
    .pipe(requireNeoTodoStartable, 'read', 'result:outcome')
    .pipe(
      (plan: Startable): Gate<Startable> => {
        const claimed = store.claimStart(plan.todo, Date.now());
        return claimed
          ? { value: { ...plan, todo: claimed } }
          : fail('already_started: this todo started.');
      },
      'outcome',
      'result:outcome'
    )
    .pipe(
      async (plan: Startable) => {
        starting.add(plan.todo.id);
        try {
          return await dispatch(plan);
        } finally {
          starting.delete(plan.todo.id);
        }
      },
      'outcome',
      'outcome'
    )
    .endAsync('outcome') as (todoId: string) => Promise<{ ok: true; todo: NeoTodo } | Rejection>;

  const settleDeps = (ask: NeoAsk): NeoDriverSettleDeps => ({
    readStartedAt: (id) => sessions.readStartedAt(id),
    readSent: (id) => {
      const todo = store.getTodo(id);
      return neoCardSent(sessions.readSent(id), todo ? neoTodoCard(todo, ask) : null);
    },
    readLiveStatus: (id) => sessions.readLiveStatus(id),
    isContinuing: (id) =>
      sessions.get(id)?.verb === 'send' || sessions.readFollowAnchor(id) !== null,
    readStatus: async (card, ref, since, receipt) => {
      const outcome = await deps.invoke(caller(ask), 'work.status', {
        ref,
        ...(since !== null ? { since } : {}),
        ...(receipt ? { receipt } : {}),
      });
      observe(card.id, outcome);
      return outcome;
    },
    recordStartedAt: (id, at) => sessions.recordStartedAt(id, at),
    recordLive: (id, status, live) => sessions.recordLive(id, status, live.link, live.remoteLink),
    recordCheck: (id, read, now) => {
      sessions.recordCardCheck(id, { checkedAt: now, unchecked: !read });
      return false;
    },
    notifyChanged: () => deps.changed(),
    noteUnsettled: async () => {},
    forgetActivity: () => {},
    transition: (card, settled) => {
      const todo = store.getTodo(card.id);
      if (!todo || todo.state !== 'doing' || todo.report || todo.updatedAt !== card.updatedAt)
        return null;
      const now = Date.now();
      return neoTodoCard(store.updateTodo(todo, planNeoTodoSettled(settled, now), now), ask);
    },
    anchorFollow: (id, at) => sessions.recordFollowAnchor(id, at),
    returnReport: async (card) => {
      const todo = store.getTodo(card.id);
      if (todo) await deps.tell(ask, todo, neoTodoNote(todo));
    },
  });

  const settle = async (todoId: string, ref: WorkRef) => {
    const todo = store.getTodo(todoId);
    const ask = todo ? store.getAsk(todo.askId) : null;
    if (todo && ask) await settleNeoDriverWork(settleDeps(ask), neoTodoCard(todo, ask), ref);
  };

  const check = async (todo: NeoTodo, now: number) => {
    const packs = deps
      .packs()
      .filter((candidate) => !todo.check || candidate.id === todo.check.pack)
      .flatMap((candidate) => candidate.todos ?? []);
    const ask = store.getAsk(todo.askId);
    if (!packs.length || !ask || now - (checked.get(todo.id) ?? 0) < NEO_TODO_CHECK_MS) return;
    checked.set(todo.id, now);
    for (const pack of packs) {
      const result = await pack.check(todo);
      const patch = todo.check ? planNeoTodoCheck(todo, result, now) : null;
      if (patch) await finish(todo, ask, patch, now);
    }
    deps.changed();
  };

  const observe = (id: string, outcome: OperationOutcome) => {
    const todo = store.getTodo(id);
    if (todo)
      for (const pack of deps.packs()) pack.todos?.openedPrs?.(todo, readDriverOpenedPrs(outcome));
  };

  const follow = (superpipe({})('neo-todo-follow') as PipelineAPI)
    .input(['todo', 'now'])
    .pipe(
      (todo: NeoTodo, now: number) => {
        const ref = sessions.readRef(todo.id);
        const ask = store.getAsk(todo.askId);
        return todo.state === 'doing' &&
          todo.report &&
          ref &&
          ask?.status === 'open' &&
          now - (checked.get(todo.id) ?? 0) >= NEO_TODO_CHECK_MS
          ? { value: { ref, ask } }
          : { reason: null };
      },
      ['todo', 'now'],
      'result:target'
    )
    .pipe(
      async (todo: NeoTodo, target: { ref: WorkRef; ask: NeoAsk }, now: number) => {
        const since = sessions.readFollowAnchor(todo.id) ?? todo.updatedAt;
        const sent = sessions.readSent(todo.id);
        const outcome = await deps.invoke(caller(target.ask), 'work.status', {
          ref: target.ref,
          since: sent?.inputBefore ?? since,
          ...(sent?.receipt ? { receipt: sent.receipt } : {}),
        });
        observe(todo.id, outcome);
        const live = readDriverLive(outcome);
        if (live) sessions.recordLive(todo.id, live.status, live.link, live.remoteLink);
        sessions.recordCardCheck(todo.id, { checkedAt: now, unchecked: !live });
        deps.changed();
        const report = readDriverFollowUp(outcome, since, sent);
        if (report) {
          const current = store.getTodo(todo.id);
          if (current?.state !== 'doing' || current.updatedAt !== todo.updatedAt) return;
          store.updateTodo(todo, { report: `${report}\n\n${todo.report}`.slice(0, 12_000) }, now);
          sessions.recordFollowAnchor(todo.id, readDriverActivity(outcome)?.lastActivityAt ?? now);
        }
      },
      ['todo', 'target', 'now'],
      'followed'
    )
    .endAsync('followed') as (todo: NeoTodo, now: number) => Promise<void>;

  const read = (todoId: string) => {
    const todo = store.getTodo(todoId);
    return {
      todo,
      ask: todo ? store.getAsk(todo.askId) : null,
      ref: todo ? sessions.readRef(todo.id) : null,
      target: todo ? sessions.get(todo.id) : null,
      interrupted: todo ? sessions.readStartInterrupted(todo.id) : false,
    };
  };

  const proceed = async (todoId: string, message: string) => {
    const gate = requireNeoTodoContinuable(read(todoId));
    if ('reason' in gate) return gate.reason;
    const { todo, ask, ref } = gate.value;
    const text = withWorkGoal(message, { workId: todo.id, goal: null, doneWhen: todo.doneWhen });
    const status = await deps.invoke(caller(ask), 'work.status', { ref });
    const baseline = readDriverSendBaseline(status, Date.now(), !!ref.daemon);
    const sent = readDriverSent(status, text, todo.createdAt);
    const delivered = readDriverOutcome(
      { verb: 'send', ref },
      await deps.invoke(caller(ask), 'work.send', { ref, message: text })
    );
    if (!('ref' in delivered)) return { ok: false as const, reason: delivered.failure };
    sessions.recordStartedAt(
      todo.id,
      'queued' in delivered ? null : (delivered.startedAt ?? baseline)
    );
    sessions.recordSent(todo.id, sent && { ...sent, receipt: delivered.receipt });
    const next = store.updateTodo(
      todo,
      { state: 'doing', report: null, evidence: null, reason: null, finishedAt: null },
      Date.now()
    );
    checked.delete(todo.id);
    return { ok: true as const, todo: next };
  };

  const stop = async (todo: NeoTodo) => {
    const ref = sessions.readRef(todo.id);
    const ask = store.getAsk(todo.askId);
    const live = sessions.readLiveStatus(todo.id);
    const settled = live === 'done' || live === 'failed' || live === 'stopped';
    if (!ref || !ask || (todo.state !== 'doing' && settled)) return null;
    const stopped = await deps
      .invoke(caller(ask), 'work.stop', { ref })
      .catch((error: unknown) => ({ kind: 'failed' as const, message: String(error) }));
    if (stopped.kind !== 'completed')
      return `stop_failed: ${(stopped as { message?: string }).message ?? 'the stop did not complete'}`;
    const value = stopped.value as { ok?: boolean; reason?: string; detail?: string } | null;
    return value?.ok === false && value.reason !== 'unsupported'
      ? `stop_failed: ${value.detail ?? value.reason ?? 'the driver refused'}`
      : null;
  };

  return {
    start,
    proceed,
    stop,
    async retry(todoId: string) {
      const gate = requireNeoTodoRetryable(read(todoId));
      if ('reason' in gate) return gate.reason;
      sessions.recordRetry(todoId);
      store.updateTodo(
        gate.value,
        { state: 'todo', reason: null, startedAt: null, finishedAt: null },
        Date.now()
      );
      return start(todoId);
    },
    recheck(todoIds: readonly string[]) {
      for (const id of todoIds) checked.delete(id);
    },
    async checkNow(todoIds: readonly string[]): Promise<void> {
      for (const id of todoIds) {
        checked.delete(id);
        const todo = store.getTodo(id);
        if (todo) await check(todo, Date.now());
      }
    },
    async refresh(warn: (message: string, error: unknown) => void): Promise<void> {
      for (const todoId of sessions.unrecordedStarts()) {
        const todo = store.getTodo(todoId);
        const ask = todo ? store.getAsk(todo.askId) : null;
        if (!todo || !ask || starting.has(todoId)) continue;
        sessions.recordStartInterrupted(todoId);
        await finish(
          todo,
          ask,
          {
            state: 'failed',
            reason: 'Start was interrupted; a session may have started without being recorded.',
            finishedAt: Date.now(),
          },
          Date.now()
        ).catch((error) => warn('Todo start recovery pending', error));
      }
      for (const { todoId, ref } of sessions.awaitingReports())
        await settle(todoId, ref).catch((error) => warn('Todo session refresh pending', error));
      for (const todo of store.listCheckable()) {
        await follow(todo, Date.now()).catch((error) => warn('Todo follow pending', error));
        await check(store.getTodo(todo.id) ?? todo, Date.now()).catch((error) =>
          warn('Todo check pending', error)
        );
      }
      for (const ask of store.listOpenAsks()) {
        const note = neoAskIdleNote(ask, store.listTodos(ask.id), store.listQuestions(ask.id));
        if (note)
          await deps
            .tellAsk(ask, `neo-ask-idle:${ask.id}:${ask.updatedAt}`, note)
            .catch((error) => warn('Idle ask note pending', error));
      }
    },
  };
}

export type NeoTodoRunner = ReturnType<typeof createNeoTodoRunner>;
