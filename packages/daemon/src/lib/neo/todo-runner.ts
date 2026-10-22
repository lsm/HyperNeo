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
  readDriverActivity,
  readDriverFollowUp,
  readDriverLive,
  readDriverOpenedPrs,
  readDriverSendBaseline,
  readDriverSent,
  readDriverTurnEnds,
  withWorkGoal,
} from './driver-work.ts';
import type { NeoPack, NeoTodoCheckResult, NeoTodoJudgement } from './pack-contract.ts';
import { type NeoDriverSettleDeps, settleNeoDriverWork } from './settle-driver-work.ts';
import { sameNeoTodoCheck } from './todo-completion.ts';
import { dispatchNeoInput } from './dispatch-input.ts';
import { neoMoveTodo, neoTodoRepo } from './todo-repo.ts';

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
type Startable = {
  todo: NeoTodo;
  ask: NeoAsk;
  target: Extract<NeoDriverTarget, { verb: 'start' | 'send' }>;
};

const fail = (reason: string): { reason: Rejection } => ({ reason: { ok: false, reason } });

export const NEO_TODO_CHECK_MS = 2 * 60_000;
export const NEO_TODO_IDLE_MS = 30 * 60_000;
export const NEO_TODO_IDLE_REMINDERS = 2;

export interface NeoTodoRunnerDeps {
  store: NeoAskTodoRepository;
  sessions: NeoTodoSessionRepository;
  invoke(
    caller: OperationCaller,
    name: string,
    input: Record<string, unknown>
  ): Promise<OperationOutcome>;
  packs(): readonly NeoPack[];
  tell(ask: NeoAsk, todo: NeoTodo, note: string, key?: string): Promise<void>;
  tellAsk(ask: NeoAsk, messageId: string, note: string): Promise<void>;
  changed(): void;
}

const CARD_STATUS: Record<NeoTodo['state'], NeoWork['status']> = {
  todo: 'proposed',
  doing: 'queued',
  blocked: 'queued',
  done: 'reported',
  failed: 'failed',
  removed: 'cancelled',
};

export function neoTodoCard(todo: NeoTodo, ask: NeoAsk, workerRules?: string): NeoWork {
  return {
    id: todo.id,
    requestKey: todo.id,
    projectId: ask.projectId,
    originSessionId: ask.sessionId,
    originMessageId: ask.originMessageId,
    title: todo.title,
    instruction: [todo.instruction ?? '', workerRules].filter(Boolean).join('\n\n'),
    sessionId: null,
    status: todo.state === 'doing' && todo.report ? 'reported' : CARD_STATUS[todo.state],
    report: todo.report,
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
  };
}

export function isNeoTodoStartable(todo: NeoTodo): boolean {
  return todo.state === 'todo' || (todo.state === 'blocked' && todo.blockedBy === 'question');
}

export function requireNeoTodoStartable(read: {
  todo: NeoTodo | null;
  ask: NeoAsk | null;
  target: NeoDriverTarget | null;
}): Gate<Startable> {
  const { todo, ask, target } = read;
  if (!todo || !ask) return fail('not_found: no such todo.');
  if (ask.status !== 'open') return fail(`ask_settled: this ask is ${ask.status}.`);
  if (!isNeoTodoStartable(todo)) return fail(`already_started: this todo is ${todo.state}.`);
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

export function neoTodoNeedsYouNote(
  todo: Pick<NeoTodo, 'title'>,
  live: { waitingFor?: string; link?: string; remoteLink?: string }
): string {
  const link = live.remoteLink ?? live.link;
  return `Todo "${todo.title}": its session is waiting on the human (${live.waitingFor ?? 'a prompt or question'}). Ask the human once to answer it there${link ? `: ${link}` : ''}. Do not send to it until it runs again.`;
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
  const failed =
    todo.state === 'failed' || (todo.state === 'blocked' && todo.blockedBy === 'failure');
  if (!failed || ref || !target)
    return fail('not_retryable: only a todo that failed before its session started goes again.');
  return { value: todo };
}

function planNeoTodoBlocked(
  todo: NeoTodo,
  blockedBy: NonNullable<NeoTodo['blockedBy']>,
  blockedReason: string,
  nextAction: string
): NeoTodoPatch | null {
  return todo.state === 'blocked' &&
    todo.blockedBy === blockedBy &&
    todo.blockedReason === blockedReason
    ? null
    : { state: 'blocked', blockedBy, blockedReason, nextAction };
}

export function planNeoTodoAwaitingStart(todo: NeoTodo): NeoTodoPatch | null {
  return planNeoTodoBlocked(
    todo,
    'question',
    'Waiting for the human to start it.',
    'The human answers the start question.'
  );
}

export function planNeoTodoIdle(
  read: { since: number; nudges: number },
  now: number
): { kind: 'remind'; nudges: number } | { kind: 'block' } | null {
  const due = Math.floor((now - read.since) / NEO_TODO_IDLE_MS);
  if (read.nudges > NEO_TODO_IDLE_REMINDERS || due <= read.nudges) return null;
  return read.nudges < NEO_TODO_IDLE_REMINDERS
    ? { kind: 'remind', nudges: read.nudges + 1 }
    : { kind: 'block' };
}

export function neoTodoIdleReminder(todo: Pick<NeoTodo, 'title' | 'doneWhen'>, minutes: number) {
  return `Todo "${todo.title}" is not done yet (done when: ${todo.doneWhen}), and your session has been stopped for ${minutes} min. Continue it, or report what blocks you.`;
}

export function neoTodoUntickedReminder(
  todo: Pick<NeoTodo, 'title' | 'doneWhen'>,
  minutes: number
) {
  return `Todo "${todo.title}" stopped ${minutes} min ago and nobody ticked it (done when: ${todo.doneWhen}). Tick it done with evidence, continue it with neo.todo.continue, or close it.`;
}

export function planNeoTodoFailure(
  todo: NeoTodo,
  reason: string,
  now: number
): NeoTodoPatch | null {
  return todo.reason === reason
    ? planNeoTodoBlocked(
        todo,
        'failure',
        `Failed twice: ${reason}`,
        'Ask the human how to go on, or take another approach.'
      )
    : { state: 'failed', reason, finishedAt: now };
}

export function planNeoTodoSettled(
  todo: NeoTodo,
  settled: { status: 'reported' | 'failed'; report: string },
  now: number
): NeoTodoPatch | null {
  if (settled.status === 'failed') return planNeoTodoFailure(todo, settled.report, now);
  return todo.report === settled.report ? null : { report: settled.report };
}

export function planNeoTodoCheck(
  todo: NeoTodo,
  result: NeoTodoCheckResult | null,
  now: number,
  started: boolean
): NeoTodoPatch | null {
  if (!result || todo.state === 'done' || todo.state === 'failed') return null;
  if (result.failed) return planNeoTodoFailure(todo, result.failed, now);
  if (result.done) return { state: 'done', evidence: result.evidence, finishedAt: now };
  if (result.blocked)
    return todo.state === 'blocked' && todo.blockedBy !== 'check'
      ? null
      : planNeoTodoBlocked(todo, 'check', result.blocked.reason, result.blocked.nextAction);
  return todo.state === 'blocked' && todo.blockedBy === 'check'
    ? { state: started ? 'doing' : 'todo' }
    : null;
}

export function neoTodoNote(todo: NeoTodo): string {
  if (todo.state === 'failed') return `Todo "${todo.title}" failed: ${todo.reason ?? ''}`;
  if (todo.state === 'done' && todo.evidence)
    return `Todo "${todo.title}" is done: ${todo.evidence}`;
  if (todo.state === 'done')
    return `Todo "${todo.title}" reported and is done:\n${todo.report ?? ''}`;
  if (todo.state === 'doing')
    return `Todo "${todo.title}" reported, and nothing checks it: tick it done with evidence once "${todo.doneWhen}" holds, or let it go on.\nIts report:\n${todo.report ?? ''}`;
  return `Todo "${todo.title}" is blocked: ${todo.blockedReason ?? ''}\nNext: ${
    todo.nextAction ?? ''
  }\nIts last report:\n${todo.report ?? '(none)'}`;
}

export function neoAskIdleNote(
  ask: NeoAsk,
  todos: readonly NeoTodo[],
  questions: readonly NeoQuestion[]
): string | null {
  if (todos.some((todo) => todo.state === 'doing' || todo.state === 'blocked')) return null;
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
  const recompute = async (
    todo: NeoTodo,
    patch: NeoTodoPatch = {},
    now = Date.now(),
    judgement: NeoTodoJudgement = { state: 'no_opinion' }
  ) => store.recompute(todo, patch, now, judgement, (id) => start(id));
  const finish = async (todo: NeoTodo, ask: NeoAsk, patch: NeoTodoPatch | null, now: number) => {
    if (!patch) return todo;
    const next = await recompute(todo, patch, now);
    if (next.state === 'done' || next.state === 'failed' || next.state === 'blocked')
      await deps.tell(ask, next, neoTodoNote(next));
    return next;
  };

  const relocate = (id: string) => {
    const todo = store.getTodo(id);
    const repo = todo && neoTodoRepo({ ...todo, target: sessions.get(id) }, deps.packs(), todo);
    if (todo && neoMoveTodo(store, todo, repo)) deps.changed();
    return store.getTodo(id) ?? todo;
  };

  const dispatch = async ({ todo, ask, target }: Startable) => {
    const prepare = deps.packs().find((pack) => pack.id === todo.check?.pack);
    const card = neoTodoCard(todo, ask, prepare?.workerRules);
    const call = driverWorkCall(target, card, {
      workId: todo.id,
      goal: null,
      doneWhen: todo.doneWhen,
    });
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
    const result = await dispatchNeoInput(
      sessions.inputs,
      todo.id,
      ask.sessionId,
      target,
      call,
      deps.invoke,
      caller(ask)
    );
    if (!('ref' in result) && !result.reason) sessions.recordStartInterrupted(todo.id);
    if (!('ref' in result))
      return {
        ok: true as const,
        todo: await finish(
          todo,
          ask,
          result.reason === 'needs_you'
            ? planNeoTodoBlocked(
                todo,
                'failure',
                `Could not start: ${result.failure}`,
                'Ask the human to open Claude Desktop, then retry this todo.'
              )
            : planNeoTodoFailure(todo, `Could not start: ${result.failure}`, Date.now()),
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
        ? probe.sent && { ...probe.sent, receipt: result.receipt, delivery: result.delivery }
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
        const todo = claimed && relocate(claimed.id);
        return todo
          ? { value: { ...plan, todo, ask: store.getAsk(todo.askId) ?? plan.ask } }
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

  const noteNeedsYou = async (
    todoId: string,
    ask: NeoAsk,
    live: ReturnType<typeof readDriverLive>
  ) => {
    if (!live) return;
    const since = sessions.readNeedsYouSince(todoId);
    if (live.status !== 'needs_you') {
      if (since !== null) sessions.recordNeedsYouSince(todoId, null);
      return;
    }
    const todo = store.getTodo(todoId);
    const followed =
      todo?.state === 'doing' || (todo?.state === 'blocked' && todo.blockedBy === 'worker');
    if (since !== null || !todo || !followed) return;
    sessions.recordNeedsYouSince(todoId, Date.now());
    await deps.tell(ask, todo, neoTodoNeedsYouNote(todo, live));
  };

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
      await observe(card.id, outcome, ref);
      return outcome;
    },
    recordStartedAt: (id, at) => sessions.recordStartedAt(id, at),
    recordLive: (id, status, live) => {
      if (status !== 'needs_you' && sessions.readNeedsYouSince(id) !== null)
        sessions.recordNeedsYouSince(id, null);
      return sessions.recordLive(id, status, live.link, live.remoteLink);
    },
    recordCheck: (id, read, now) => {
      sessions.recordCardCheck(id, { checkedAt: now, unchecked: !read });
      return false;
    },
    notifyChanged: () => deps.changed(),
    noteUnsettled: (card, _ref, outcome) => noteNeedsYou(card.id, ask, readDriverLive(outcome)),
    forgetActivity: () => {},
    transition: (card, settled) => {
      const todo = store.getTodo(card.id);
      if (!todo || todo.state !== 'doing' || todo.updatedAt !== card.updatedAt) return null;
      const now = Date.now();
      const patch = planNeoTodoSettled(todo, settled, now);
      return patch ? neoTodoCard(store.updateTodo(todo, patch, now), ask) : null;
    },
    anchorFollow: (id, at) => sessions.recordFollowAnchor(id, at),
    returnReport: async (card) => {
      const todo = store.getTodo(card.id);
      if (todo && (todo.state !== 'doing' || !todo.check))
        await deps.tell(ask, todo, neoTodoNote(todo));
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
    for (const rule of packs) {
      const pack =
        todo.check && deps.packs().find((candidate) => candidate.id === todo.check?.pack);
      const judgement =
        pack && pack.readFacts && pack.judge ? pack.judge(todo, await pack.readFacts(todo)) : null;
      const result = judgement ? null : await rule.check(todo);
      const live = store.getCheckable(todo.id);
      if (!live?.check || !sameNeoTodoCheck(todo, live)) continue;
      const next = judgement
        ? await recompute(live, {}, now, judgement)
        : await finish(
            live,
            ask,
            planNeoTodoCheck(live, result, now, sessions.readRef(live.id) !== null),
            now
          );
      if (
        judgement &&
        next.state !== live.state &&
        ['done', 'failed', 'blocked'].includes(next.state)
      )
        await deps.tell(ask, next, neoTodoNote(next));
    }
    relocate(todo.id);
    deps.changed();
  };

  const observe = async (id: string, outcome: OperationOutcome, ref: WorkRef) => {
    const todo = store.getTodo(id);
    if (todo)
      for (const pack of deps.packs()) pack.todos?.openedPrs?.(todo, readDriverOpenedPrs(outcome));
    if (todo) relocate(id);
    const turns = readDriverTurnEnds(outcome);
    if (!turns.length) return;
    const ask = todo && store.getAsk(todo.askId);
    const current = sessions.readRef(id);
    if (
      !todo ||
      !ask ||
      ask.status !== 'open' ||
      !['doing', 'blocked'].includes(todo.state) ||
      current?.adapter !== ref.adapter ||
      current.id !== ref.id ||
      current.daemon !== ref.daemon
    )
      return;
    const inputs = sessions.inputs.list(id);
    for (const turn of turns) {
      const dispatch = inputs.findLast((input) => {
        const result = input.outcome;
        return (
          input.acceptedAt <= turn.at &&
          result &&
          'ref' in result &&
          result.ref.adapter === ref.adapter &&
          result.ref.id === ref.id &&
          result.ref.daemon === ref.daemon
        );
      });
      if (dispatch)
        await deps.tell(
          ask,
          todo,
          `Worker turn report (todo ${id}, dispatch ${dispatch.id}):\n\n${turn.message || 'worker ended its turn with no reply'}`,
          `neo-todo-turn:${id}:${dispatch.id}:${turn.id}`
        );
    }
  };

  const follow = (superpipe({})('neo-todo-follow') as PipelineAPI)
    .input(['todo', 'now'])
    .pipe(
      (todo: NeoTodo, now: number) => {
        const ref = sessions.readRef(todo.id);
        const ask = store.getAsk(todo.askId);
        return ((todo.state === 'doing' && todo.report) ||
          (todo.state === 'blocked' && todo.blockedBy === 'worker')) &&
          ref &&
          ask?.status === 'open' &&
          (todo.state === 'blocked' || now - (checked.get(todo.id) ?? 0) >= NEO_TODO_CHECK_MS)
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
        await observe(todo.id, outcome, target.ref);
        const live = readDriverLive(outcome);
        if (live) sessions.recordLive(todo.id, live.status, live.link, live.remoteLink);
        await noteNeedsYou(todo.id, target.ask, live);
        sessions.recordCardCheck(todo.id, { checkedAt: now, unchecked: !live });
        if (
          todo.state === 'blocked' &&
          (live?.status === 'running' ||
            (live && live.status !== 'queued' && live.lastActivityAt > todo.updatedAt) ||
            sessions.doingTodoOn(target.ref, todo.updatedAt))
        ) {
          const current = store.getTodo(todo.id);
          if (current?.state !== todo.state || current.updatedAt !== todo.updatedAt) return;
          todo = store.updateTodo(todo, { state: 'doing' }, now);
          idle.delete(todo.id);
          checked.delete(todo.id);
        }
        deps.changed();
        const report = readDriverFollowUp(outcome, since, sent);
        if (report && report !== todo.report) {
          const current = store.getTodo(todo.id);
          if (current?.state !== todo.state || current.updatedAt !== todo.updatedAt) return;
          store.updateTodo(
            todo,
            {
              report: [report, todo.report].filter(Boolean).join('\n\n'),
              ...(todo.state === 'blocked' ? { state: 'doing' } : {}),
            },
            now
          );
          sessions.recordFollowAnchor(todo.id, readDriverActivity(outcome)?.lastActivityAt ?? now);
        }
      },
      ['todo', 'target', 'now'],
      'followed'
    )
    .endAsync('followed') as (todo: NeoTodo, now: number) => Promise<void>;

  const idle = new Map<string, { since: number; nudges: number }>();
  const nudge = async (todo: NeoTodo, now: number) => {
    const ref = sessions.readRef(todo.id);
    const ask = store.getAsk(todo.askId);
    const waiting = deps
      .packs()
      .some((pack) => (!todo.check || pack.id === todo.check.pack) && pack.todos?.waiting?.(todo));
    if (
      todo.state !== 'doing' ||
      !todo.instruction ||
      !todo.report ||
      !ref ||
      ask?.status !== 'open' ||
      waiting
    ) {
      idle.delete(todo.id);
      return;
    }
    const seen = idle.get(todo.id);
    const read = seen?.since === todo.updatedAt ? seen : { since: todo.updatedAt, nudges: 0 };
    idle.set(todo.id, read);
    const plan = planNeoTodoIdle(read, now);
    if (!plan) return;
    const live = readDriverLive(await deps.invoke(caller(ask), 'work.status', { ref }));
    if (!live || !['done', 'stopped'].includes(live.status)) return;
    const minutes = Math.round((now - read.since) / 60_000);
    if (plan.kind === 'remind' && !todo.check) {
      await deps.tell(
        ask,
        todo,
        neoTodoUntickedReminder(todo, minutes),
        `neo-todo-remind:${todo.id}:${read.since}:${plan.nudges}`
      );
      idle.set(todo.id, { since: read.since, nudges: plan.nudges });
      return;
    }
    if (plan.kind === 'remind') {
      const sent = await deps.invoke(caller(ask), 'work.send', {
        ref,
        message: neoTodoIdleReminder(todo, minutes),
      });
      if (sent.kind === 'completed' && (sent.value as { ok?: unknown } | null)?.ok === true) {
        idle.set(todo.id, { since: read.since, nudges: plan.nudges });
        return;
      }
    }
    idle.delete(todo.id);
    await finish(
      todo,
      ask,
      planNeoTodoBlocked(
        todo,
        'worker',
        plan.kind === 'remind'
          ? `Its session stopped ${minutes} min ago and could not be reached.`
          : todo.check
            ? `Its session stopped ${minutes} min ago and did not continue after ${NEO_TODO_IDLE_REMINDERS} reminders.`
            : `Its session stopped ${minutes} min ago and nobody ticked it after ${NEO_TODO_IDLE_REMINDERS} reminders.`,
        todo.check
          ? 'Continue the session with neo.todo.continue, or close the todo.'
          : 'Tick it done with evidence, continue the session, or close it.'
      ),
      now
    );
  };

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
    if (readDriverLive(status)?.status === 'needs_you')
      return fail(
        'needs_you: its session is waiting on the human; ask them to answer it there, then continue.'
      ).reason;
    const baseline = readDriverSendBaseline(status, Date.now(), !!ref.daemon);
    const sent = readDriverSent(status, text, todo.createdAt);
    const delivered = await dispatchNeoInput(
      sessions.inputs,
      todo.id,
      ask.sessionId,
      { verb: 'send', ref },
      { name: 'work.send', input: { ref, message: text } },
      deps.invoke,
      caller(ask)
    );
    if (!('ref' in delivered)) return { ok: false as const, reason: delivered.failure };
    sessions.recordStartedAt(
      todo.id,
      'queued' in delivered ? null : (delivered.startedAt ?? baseline)
    );
    sessions.recordSent(
      todo.id,
      sent && { ...sent, receipt: delivered.receipt, delivery: delivered.delivery }
    );
    const next = store.updateTodo(
      todo,
      { state: 'doing', report: null, evidence: null, finishedAt: null },
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
    const adopted = sessions.get(todo.id)?.verb === 'adopt';
    if (!ref || !ask || adopted || (todo.state !== 'doing' && settled)) return null;
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
    recompute,
    proceed,
    stop,
    async retry(todoId: string) {
      const gate = requireNeoTodoRetryable(read(todoId));
      if ('reason' in gate) return gate.reason;
      sessions.recordRetry(todoId);
      store.updateTodo(
        gate.value,
        { state: 'todo', startedAt: null, finishedAt: null },
        Date.now()
      );
      return start(todoId);
    },
    recheck(todoIds: readonly string[]) {
      for (const id of todoIds) checked.delete(id);
    },
    async checkNow(
      todoIds: readonly string[],
      warn: (message: string, error: unknown) => void,
      force = true
    ): Promise<void> {
      for (const todo of store.listCheckable().filter((item) => todoIds.includes(item.id))) {
        if (force) checked.delete(todo.id);
        await check(todo, Date.now()).catch((error) => warn('Todo check pending', error));
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
          planNeoTodoFailure(
            todo,
            'Start was interrupted; a session may have started without being recorded.',
            Date.now()
          ),
          Date.now()
        ).catch((error) => warn('Todo start recovery pending', error));
      }
      for (const { todoId, ref } of sessions.awaitingReports())
        await settle(todoId, ref).catch((error) => warn('Todo session refresh pending', error));
      for (const todo of store.listCheckable()) {
        await follow(todo, Date.now()).catch((error) => warn('Todo follow pending', error));
        await nudge(store.getTodo(todo.id) ?? todo, Date.now()).catch((error) =>
          warn('Todo nudge pending', error)
        );
        await check(store.getTodo(todo.id) ?? todo, Date.now()).catch((error) =>
          warn('Todo check pending', error)
        );
      }
      for (const ask of store.listOpenAsks()) {
        const completed = store.listTodos(ask.id).find((todo) => todo.state === 'done');
        if (completed)
          await recompute(completed).catch((error) => warn('Todo plan advancement pending', error));
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
