import type { NeoWorkGoal } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
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
import { deliverNeoTurnReport } from './turn-report.ts';

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
type Startable = {
  todo: NeoTodo;
  ask: NeoAsk;
  target: Extract<NeoDriverTarget, { verb: 'start' | 'send' }>;
};

const fail = (reason: string): { reason: Rejection } => ({ reason: { ok: false, reason } });

export interface NeoTodoRunnerDeps {
  store: NeoAskTodoRepository;
  sessions: NeoTodoSessionRepository;
  invoke(
    caller: OperationCaller,
    name: string,
    input: Record<string, unknown>
  ): Promise<OperationOutcome>;
  packs(): readonly NeoPack[];
  tell(
    ask: NeoAsk,
    todo: NeoTodo,
    note: string,
    key?: string,
    kind?: 'focused_status' | 'quiet_heartbeat' | 'event'
  ): Promise<void>;
  changed(): void;
}

const CARD_STATUS: Record<NeoTodo['state'], NeoWork['status']> = {
  todo: 'proposed',
  doing: 'queued',
  blocked: 'queued',
  done: 'reported',
  closed_unverified: 'cancelled',
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
  const { todo, target } = read;
  if (!todo) return fail('not_found: no such todo.');
  if (read.interrupted)
    return fail(
      'start_uncertain: the start failed after the driver may have opened a session; find it with work.find before starting again.'
    );
  const failed =
    todo.state === 'failed' || (todo.state === 'blocked' && todo.blockedBy === 'failure');
  if (!failed || !target || !['start', 'send'].includes(target.verb))
    return fail('not_retryable: only a failed todo with a worker target can be retried.');
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

export function neoTodoIdleReminder(todo: Pick<NeoTodo, 'title' | 'doneWhen'>, minutes: number) {
  return `Todo "${todo.title}" is not done yet (done when: ${todo.doneWhen}), and your session has been stopped for ${minutes} min. Continue it, or report what blocks you.`;
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
  if (todo.state === 'closed_unverified')
    return `Todo "${todo.title}" is closed unverified, never done: ${todo.reason ?? 'Its outcome check has not passed.'}`;
  if (todo.state === 'doing')
    return `Todo "${todo.title}" reported, and nothing checks it: record evidence for "${todo.doneWhen}"; closing it without a passed outcome check is closed unverified, never done.\nIts report:\n${todo.report ?? ''}`;
  return `Todo "${todo.title}" is blocked: ${todo.blockedReason ?? ''}\nNext: ${
    todo.nextAction ?? ''
  }\nIts last report:\n${todo.report ?? '(none)'}`;
}

export function createNeoTodoRunner(deps: NeoTodoRunnerDeps) {
  const formatGoal = (instruction: string, goal: NeoWorkGoal | null) =>
    (deps.packs().find((pack) => pack.workGoal)?.workGoal ?? withWorkGoal)(instruction, goal);
  const { store, sessions } = deps;
  const workerBrief = (todo: NeoTodo, instruction: string, harness: string, existing = true) => {
    instruction += `\n\nEven when told to stay quiet, report questions or blockers with message.send {to: the sending Neo, kind: question or blocked, text: original report, question: {todoId: "${todo.id}", title: short question, options: 2–6 short options, language: en or zh-Hans}} in the human's configured language. Do not keep working while waiting for that answer.`;
    const pack = deps.packs().find((candidate) => candidate.id === todo.check?.pack);
    const recorded = existing ? sessions.readCard(todo.id) : null;
    return (
      pack?.workerBrief?.(instruction, {
        model: recorded?.model ?? null,
        effort: recorded?.effort ?? null,
        harness,
      }) ?? instruction
    );
  };
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
    card.instruction = workerBrief(
      todo,
      card.instruction,
      target.verb === 'start' ? target.adapter : target.ref.adapter,
      target.verb === 'send'
    );
    const call = driverWorkCall(
      target,
      card,
      {
        workId: todo.id,
        goal: null,
        doneWhen: todo.doneWhen,
      },
      formatGoal
    );
    if (target.verb === 'start' && prepare?.prepareExecution)
      call.input.preparation = {
        pack: prepare.id,
        parameters: target.preparationParameters ?? {},
      };
    if (target.verb === 'start') call.input.todoId = todo.id;
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
    const opening = messageOpening(message);
    const committed = await sessions.write('recordDispatch', {
      todoId: todo.id,
      askId: ask.id,
      ref: result.ref,
      startedAt: result.startedAt ?? ('queued' in result ? undefined : (baseline ?? undefined)),
      link: result.link,
      observed: { model: result.model, effort: result.effort },
      keepIdentity: target.verb === 'send',
      sent: probe
        ? probe.sent && { ...probe.sent, receipt: result.receipt, delivery: result.delivery }
        : opening
          ? { inputBefore: 0, opening, ...(result.receipt ? { receipt: result.receipt } : {}) }
          : null,
    });
    if (!committed.askOpen)
      await deps.invoke(caller(ask), 'work.stop', { ref: result.ref }).catch(() => null);
    deps.changed();
    return { ok: true as const, todo: committed.todo ?? todo };
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
    if (!live || live.status !== 'needs_you') return;
    const todo = await sessions.write('claimNeedsYou', todoId, Date.now());
    if (!todo) return;
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
    recordProgress: (id, progress, now) => sessions.write('recordProgress', id, progress, now),
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
    if (!packs.length || !ask) return;
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
      for (const pack of deps.packs())
        await pack.todos?.openedPrs?.(todo, readDriverOpenedPrs(outcome));
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
        await deliverNeoTurnReport(
          ask,
          todo,
          dispatch.id,
          ref,
          readDriverLive(outcome),
          turn,
          deps.tell,
          sessions.turnReports
        );
    }
  };

  const follow = (superpipe({})('neo-todo-follow') as PipelineAPI)
    .input(['todo', 'now'])
    .pipe(
      (todo: NeoTodo) => {
        const ref = sessions.readRef(todo.id);
        const ask = store.getAsk(todo.askId);
        return ((todo.state === 'doing' && todo.report) ||
          (todo.state === 'blocked' && todo.blockedBy === 'worker')) &&
          ref &&
          ask?.status === 'open'
          ? { value: { ref, ask } }
          : { reason: null };
      },
      'todo',
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
        await sessions.write(
          'recordProgress',
          todo.id,
          { landed: null, live, cardStatus: live?.status ?? null },
          now
        );
        await noteNeedsYou(todo.id, target.ask, live);
        if (
          todo.state === 'blocked' &&
          (live?.status === 'running' ||
            (live && live.status !== 'queued' && live.lastActivityAt > todo.updatedAt) ||
            sessions.doingTodoOn(target.ref, todo.updatedAt))
        ) {
          const current = store.getTodo(todo.id);
          if (current?.state !== todo.state || current.updatedAt !== todo.updatedAt) return;
          todo = store.updateTodo(todo, { state: 'doing' }, now);
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

  const nudge = (superpipe({})('neo.todo.nudge') as PipelineAPI)
    .input(['todoId', 'now'])
    .pipe((todoId: string) => sessions.read('nudgeContext', todoId), 'todoId', 'snapshot')
    .pipe(
      async (snapshot: Awaited<ReturnType<typeof sessions.nudgeContext>>) => {
        if (snapshot)
          for (const pack of deps.packs())
            if (
              (!snapshot.todo.check || pack.id === snapshot.todo.check.pack) &&
              (await pack.todos?.waiting?.(snapshot.todo))
            )
              return { reason: null };
        return snapshot ? { value: snapshot } : { reason: null };
      },
      'snapshot',
      'result:admission'
    )
    .pipe(
      async (context: NonNullable<ReturnType<typeof sessions.nudgeContext>>, now: number) => {
        const live = readDriverLive(
          await deps.invoke(caller(context.ask), 'work.status', { ref: context.ref })
        );
        const claim =
          live &&
          (await sessions.write(
            'claimNudge',
            context.todo.id,
            context.ref,
            live,
            now,
            context.todo.updatedAt
          ));
        return claim ? { value: claim } : { reason: null };
      },
      ['admission', 'now'],
      'result:admission'
    )
    .pipe(
      async (
        { todo, ask, ref, incident, plan }: NonNullable<ReturnType<typeof sessions.claimNudge>>,
        now: number
      ) => {
        const minutes = Math.round((now - incident.since) / 60_000);
        const sent =
          plan.kind === 'remind' &&
          (await deps
            .invoke(caller(ask), 'work.send', { ref, message: neoTodoIdleReminder(todo, minutes) })
            .catch(() => null));
        const delivered =
          sent && sent.kind === 'completed' && (sent.value as { ok?: boolean } | null)?.ok;
        if (!delivered) {
          await deps
            .tell(
              ask,
              todo,
              `Todo "${todo.title}" has made no progress for ${minutes} min; ${plan.kind === 'escalate' ? 'the reminder window elapsed without progress' : 'its worker could not be reached'}. Decide how to continue.`,
              `neo-todo-remind:${todo.id}:${incident.since}:${plan.nudges}`
            )
            .catch(async (error) => {
              await sessions.write(
                'finishNudge',
                todo.id,
                incident.since,
                plan.nudges,
                incident.nudges
              );
              throw error;
            });
          await sessions.write('finishNudge', todo.id, incident.since, plan.nudges, 3);
        }
      },
      ['admission', 'now'],
      'admission'
    )
    .endAsync('admission') as (todoId: string, now: number) => Promise<void | null>;

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
    const text = formatGoal(workerBrief(todo, message, ref.adapter), {
      workId: todo.id,
      goal: null,
      doneWhen: todo.doneWhen,
    });
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
      if (sessions.readRef(todoId)) {
        const result = await proceed(todoId, gate.value.instruction ?? 'Retry this todo.');
        if (result.ok) sessions.recordRetry(todoId);
        return result;
      }
      sessions.recordRetry(todoId);
      store.updateTodo(
        gate.value,
        { state: 'todo', startedAt: null, finishedAt: null },
        Date.now()
      );
      return start(todoId);
    },
    async checkNow(
      todoIds: readonly string[],
      warn: (message: string, error: unknown) => void
    ): Promise<void> {
      for (const todo of (await store.read('listCheckable')).filter((item) =>
        todoIds.includes(item.id)
      )) {
        await check(todo, Date.now()).catch((error) => warn('Todo check pending', error));
      }
    },
    async refresh(warn: (message: string, error: unknown) => void): Promise<void> {
      for (const todoId of await sessions.read('unrecordedStarts')) {
        const todo = store.getTodo(todoId);
        const ask = todo ? store.getAsk(todo.askId) : null;
        if (
          todo?.state !== 'doing' ||
          !ask ||
          starting.has(todoId) ||
          sessions.readRef(todoId) !== null
        )
          continue;
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
      for (const { todoId, ref } of await sessions.read('awaitingReports'))
        await settle(todoId, ref).catch((error) => warn('Todo session refresh pending', error));
      for (const todo of await store.read('listCheckable')) {
        await follow(todo, Date.now()).catch((error) => warn('Todo follow pending', error));
        await check(store.getTodo(todo.id) ?? todo, Date.now()).catch((error) =>
          warn('Todo check pending', error)
        );
        await nudge(todo.id, Date.now()).catch((error) => warn('Todo nudge pending', error));
      }
      const asks = await store.read('listOpenAsks');
      const todos = await store.read(
        'listTodosForAsks',
        asks.map((ask) => ask.id)
      );
      for (const ask of asks) {
        const completed = todos.find(
          (todo) => todo.askId === ask.id && ['done', 'closed_unverified'].includes(todo.state)
        );
        if (completed)
          await recompute(completed).catch((error) => warn('Todo plan advancement pending', error));
      }
    },
  };
}

export type NeoTodoRunner = ReturnType<typeof createNeoTodoRunner>;
