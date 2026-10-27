import { createWorkQueue } from '../work-queue/sweep.ts';
import type { RunDbOp } from '../../storage/db-gateway/db-op.ts';
import { neoTodoRunnerWrites } from '../../storage/repositories/neo-todo-runner-state.ts';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoWorkGoal } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import type {
  NeoAskTodoRepository,
  NeoTodoPatch,
} from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import type { Place, WorkRef } from '../drivers/types.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { dispatchNeoInput } from './dispatch-input.ts';
import {
  driverWorkCall,
  driverWorkCaller,
  messageOpening,
  type NeoDriverTarget,
  neoCardSent,
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
import { neoMoveTodo, neoTodoRepo } from './todo-repo.ts';
import { deliverNeoTurnReport } from './turn-report.ts';

type Rejection = { ok: false; reason: string };
type Recorded = { ok: true; todo: NeoTodo; records: string[] };
type Gate<T> = { value: T } | { reason: Rejection | Recorded };
const record = (todo: NeoTodo, reason: string): { reason: Recorded } => ({
  reason: { ok: true, todo, records: [reason] },
});
type Startable = {
  todo: NeoTodo;
  ask: NeoAsk;
  target: Extract<NeoDriverTarget, { verb: 'start' | 'send' }>;
};

const fail = (reason: string): { reason: Rejection } => ({ reason: { ok: false, reason } });

export interface NeoTodoRunnerDeps {
  write: RunDbOp;
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
  limits(): { running: number; perGroup: number };
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
  if (ask.status !== 'open')
    return record(todo, `ask_settled: this ask is ${ask.status}; no work was dispatched.`);
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
  if (ask.status !== 'open')
    return record(todo, `ask_settled: this ask is ${ask.status}; no work was dispatched.`);
  if (todo.state === 'todo' || todo.state === 'removed' || !ref)
    return record(todo, `not_started: this todo is ${todo.state} and has no session to continue.`);
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
  ask: NeoAsk | null;
}): Gate<NeoTodo> {
  const { todo, target } = read;
  if (!todo) return fail('not_found: no such todo.');
  if (read.ask && read.ask.status !== 'open')
    return record(todo, `ask_settled: this ask is ${read.ask.status}; no work was dispatched.`);
  if (read.interrupted)
    return fail(
      'start_uncertain: the start failed after the driver may have opened a session; find it with work.find before starting again.'
    );
  const failed =
    todo.state === 'failed' || (todo.state === 'blocked' && todo.blockedBy === 'failure');
  if (!failed || !target || !['start', 'send'].includes(target.verb))
    return record(
      todo,
      'not_retryable: no retry was needed or no worker target is recorded; no work was dispatched.'
    );
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

const NEO_TODO_STALL_NEXT = 'Continue it with new direction, reassign it, or close it.';

const idleMinutes = (incident: { since: number }, now: number) =>
  Math.round((now - incident.since) / 60_000);

const neoTodoIdleReason = (minutes: number) =>
  `its worker has been idle with no progress for ${minutes} min.`;

const neoTodoUnworkedNote = (todo: Pick<NeoTodo, 'id' | 'title' | 'doneWhen'>) =>
  `Todo "${todo.title}" (${todo.id}) is approved and ready, but nothing runs it: it has no instruction or target, so it only waits for its check (${todo.doneWhen}). If someone must do the work, give it an instruction and target with neo.todo.edit, or do it yourself.`;

const neoTodoStallNote = (todo: Pick<NeoTodo, 'title'>, reason: string) =>
  `Todo "${todo.title}" is stalled: ${reason}\nNext: ${NEO_TODO_STALL_NEXT}`;

const neoTodoMovedNote = (todo: Pick<NeoTodo, 'title'>, minutes: number) =>
  `Todo "${todo.title}" sat idle ${minutes} min with no progress, so the daemon moved it to a fresh worker.`;

const neoTodoHandoff = (todo: Pick<NeoTodo, 'title' | 'doneWhen'>) =>
  `Take over the todo "${todo.title}". It is done when: ${todo.doneWhen}. Its previous worker stopped making progress; read what it did, then finish the work.`;

export const neoTodoStalledCard = (todo: Pick<NeoTodo, 'title'>) =>
  `"${todo.title}" has nobody working on it, and HyperNeo cannot restart it on its own. Where should it continue, or should it close?`;

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
  if (!result || todo.state === 'done') return null;
  if (result.done && !result.failed)
    return { state: 'done', evidence: result.evidence, finishedAt: now };
  if (todo.state === 'failed' || todo.state === 'closed_unverified' || todo.blockedBy === 'held')
    return null;
  if (result.failed) return planNeoTodoFailure(todo, result.failed, now);
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
    instruction += `\n\nEven when told to stay quiet, report questions or blockers requiring a human decision with message.send {to: the sending Neo, kind: question or blocked, text: original report, question: {todoId: "${todo.id}", title: short question, options: 2–6 short options, language: en or zh-Hans}} in the human's configured language. Do not keep working while waiting for that answer.`;
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
  const recompute = (superpipe({})('neo.todo.recompute-committed') as PipelineAPI)
    .input(['todo', 'patch', 'now', 'judgement'])
    .pipe(
      (
        todo: NeoTodo,
        patch: NeoTodoPatch = {},
        now = Date.now(),
        judgement: NeoTodoJudgement = { state: 'no_opinion' }
      ) =>
        deps.write(neoTodoRunnerWrites, {
          method: 'recompute',
          args: [todo.id, todo.check, patch, now, judgement],
        }),
      ['todo', 'patch', 'now', 'judgement'],
      'receipt'
    )
    .pipe(
      async (
        receipt: ReturnType<InstanceType<typeof neoTodoRunnerWrites.Repository>['recompute']>,
        todo: NeoTodo
      ) => {
        if (receipt.changed) deps.changed();
        if (receipt.startNext) await advance();
        return receipt.todo ?? todo;
      },
      ['receipt', 'todo'],
      'todo'
    )
    .endAsync('todo') as (
    todo: NeoTodo,
    patch?: NeoTodoPatch,
    now?: number,
    judgement?: NeoTodoJudgement
  ) => Promise<NeoTodo>;
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
        checkKind: todo.check?.kind ?? null,
      },
      formatGoal
    );
    if (target.verb === 'start' && prepare?.prepareExecution)
      call.input.preparation = {
        pack: prepare.id,
        parameters: target.preparationParameters ?? {},
        ...(target.sandbox ? { sandbox: true } : {}),
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
      target,
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

  const claimAndDispatch = (superpipe({})('neo.todo.start') as PipelineAPI)
    .input(['todoId'])
    .pipe(
      (todoId: string) =>
        deps.write(neoTodoRunnerWrites, { method: 'claim', args: [todoId, Date.now()] }),
      'todoId',
      'receipt'
    )
    .pipe(
      (
        receipt: ReturnType<InstanceType<typeof neoTodoRunnerWrites.Repository>['claim']>
      ): Gate<Startable> => {
        if (receipt.changed) deps.changed();
        return !receipt.ok
          ? fail(receipt.reason)
          : receipt.ask && receipt.target
            ? { value: { todo: receipt.todo, ask: receipt.ask, target: receipt.target } }
            : { reason: { ok: true, todo: receipt.todo, records: receipt.records ?? [] } };
      },
      'receipt',
      'result:outcome'
    )
    .pipe(dispatch, 'outcome', 'outcome')
    .endAsync('outcome') as (
    todoId: string
  ) => Promise<{ ok: true; todo: NeoTodo; records?: string[] } | Rejection>;

  const queue = createWorkQueue<NudgeClaim>(
    {
      queue: () => sessions.read('queueFacts'),
      claim: (todoId, now, move) => nudge(todoId, now, move),
      act: (claim, now) => act(claim, now),
      start: (todoId) => start(todoId),
    },
    deps.limits
  );
  const fill = () => queue.fill();
  const noted = new Set<string>();
  const noteUnworked = (superpipe({})('neo.todo.note-unworked') as PipelineAPI)
    .input(['facts'])
    .pipe(
      (facts: { unworked: readonly string[] }) =>
        facts.unworked.filter((todoId) => !noted.has(todoId)),
      'facts',
      'todoIds'
    )
    .pipe(
      async (todoIds: readonly string[]) => {
        for (const todoId of todoIds) {
          const todo = store.getTodo(todoId);
          const ask = todo && store.getAsk(todo.askId);
          if (!todo || !ask) continue;
          await deps.tell(ask, todo, neoTodoUnworkedNote(todo), `neo-todo-unworked:${todo.id}`);
          noted.add(todoId);
        }
      },
      'todoIds',
      'told'
    )
    .endAsync('told') as (facts: { unworked: readonly string[] }) => Promise<void>;
  const advance = () => fill().catch(() => undefined);

  const start = async (todoId: string) => {
    const tracked = starting.has(todoId);
    starting.add(todoId);
    try {
      return await claimAndDispatch(todoId);
    } finally {
      if (!tracked) starting.delete(todoId);
    }
  };

  const recoverStart = (superpipe({})('neo.todo.recover-committed-start') as PipelineAPI)
    .input(['todoId'])
    .pipe(
      (todoId: string) =>
        deps.write(neoTodoRunnerWrites, { method: 'recover', args: [todoId, Date.now()] }),
      'todoId',
      'receipt'
    )
    .pipe(
      (receipt: ReturnType<InstanceType<typeof neoTodoRunnerWrites.Repository>['recover']>) => {
        if (receipt.changed) deps.changed();
        return receipt.recovery ? { value: receipt.recovery } : { reason: null };
      },
      'receipt',
      'result:recovery'
    )
    .pipe(
      async ({ todo, ask }: { todo: NeoTodo; ask: NeoAsk }) => {
        if (['done', 'failed', 'blocked'].includes(todo.state))
          await deps.tell(ask, todo, neoTodoNote(todo));
      },
      'recovery',
      'notified'
    )
    .endAsync('notified') as (todoId: string) => Promise<void | null>;

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
      const completion =
        judgement ??
        (result?.done && !result.failed
          ? { state: 'done' as const, evidence: result.evidence }
          : null);
      const live = store.getCheckable(todo.id);
      if (!live?.check || !sameNeoTodoCheck(todo, live)) continue;
      if (
        (live.state === 'failed' || live.state === 'closed_unverified') &&
        completion?.state !== 'done'
      )
        continue;
      const next = completion
        ? await recompute(live, {}, now, completion)
        : await finish(
            live,
            ask,
            planNeoTodoCheck(live, result, now, sessions.readRef(live.id) !== null),
            now
          );
      if (
        completion &&
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

  const restartLadder = (todoId: string, now: number) => {
    const prior = sessions.readNudge(todoId);
    sessions.recordNudge(todoId, {
      since: now,
      nudges: 0,
      ...(prior?.redispatched ? { redispatched: true } : {}),
    });
  };

  const follow = (superpipe({})('neo-todo-follow') as PipelineAPI)
    .input(['todo', 'now'])
    .pipe(
      (todo: NeoTodo) => {
        const ref = sessions.readRef(todo.id);
        const ask = store.getAsk(todo.askId);
        return ((todo.state === 'doing' && todo.report) ||
          (todo.state === 'blocked' && ['worker', 'stalled'].includes(todo.blockedBy ?? ''))) &&
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
          if (todo.blockedBy === 'stalled') restartLadder(todo.id, now);
          todo = store.updateTodo(todo, { state: 'doing' }, now);
        }
        deps.changed();
        const report = readDriverFollowUp(outcome, since, sent);
        if (report && report !== todo.report) {
          const current = store.getTodo(todo.id);
          if (current?.state !== todo.state || current.updatedAt !== todo.updatedAt) return;
          if (todo.blockedBy === 'stalled') restartLadder(todo.id, now);
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

  type NudgeClaim = NonNullable<ReturnType<typeof sessions.claimNudge>>;
  const releaseNudge = async ({ todo, incident, plan }: NudgeClaim, error: unknown) => {
    await sessions.write('finishNudge', todo.id, incident.since, plan.nudges, incident.nudges);
    throw error;
  };

  const stallTodo = (superpipe({})('neo.todo.stall') as PipelineAPI)
    .input(['claim', 'reason', 'now'])
    .pipe(
      (claim: NudgeClaim) =>
        ['done', 'closed_unverified', 'failed', 'removed'].includes(
          store.getTodo(claim.todo.id)?.state ?? 'removed'
        )
          ? { reason: null }
          : { value: claim },
      'claim',
      'result:claim'
    )
    .pipe(
      (claim: NudgeClaim, reason: string) =>
        deps
          .tell(
            claim.ask,
            claim.todo,
            neoTodoStallNote(claim.todo, reason),
            `neo-todo-stall:${claim.todo.id}:${claim.incident.since}`
          )
          .catch((error: unknown) => releaseNudge(claim, error)),
      ['claim', 'reason'],
      'told'
    )
    .pipe(
      ({ todo }: NudgeClaim, reason: string, now: number) => {
        const current = store.getTodo(todo.id) ?? todo;
        if (['done', 'closed_unverified', 'failed', 'removed'].includes(current.state))
          return current;
        return recompute(
          current,
          planNeoTodoBlocked(current, 'stalled', reason, NEO_TODO_STALL_NEXT) ?? {},
          now
        );
      },
      ['claim', 'reason', 'now'],
      'stalled'
    )
    .endAsync('stalled') as (claim: NudgeClaim, reason: string, now: number) => Promise<NeoTodo>;

  const redispatchTodo = (superpipe({})('neo.todo.redispatch') as PipelineAPI)
    .input(['claim', 'now'])
    .pipe(({ todo }: NudgeClaim) => stop(todo), 'claim', 'refused')
    .pipe(
      (refused: string | null) =>
        refused
          ? {
              reason: {
                stall: `It could not be stopped (${refused}), so no fresh worker took it.`,
              },
            }
          : { value: null },
      'refused',
      'result:moved'
    )
    .pipe(
      ({ todo }: NudgeClaim, now: number) =>
        store.updateTodo(todo, { state: 'todo', startedAt: null, finishedAt: null }, now),
      ['claim', 'now'],
      'reopened'
    )
    .pipe((reopened: NeoTodo) => start(reopened.id), 'reopened', 'started')
    .pipe(
      ({ todo }: NudgeClaim) => {
        const moved = store.getTodo(todo.id);
        return moved?.state === 'todo'
          ? { reason: { stall: 'No fresh worker could take it.' } }
          : moved?.state === 'doing'
            ? { value: moved }
            : { reason: null };
      },
      ['claim', 'started'],
      'result:moved'
    )
    .pipe(
      ({ ask, todo, incident }: NudgeClaim, now: number) =>
        deps.tell(
          ask,
          todo,
          neoTodoMovedNote(todo, idleMinutes(incident, now)),
          `neo-todo-redispatch:${todo.id}`
        ),
      ['claim', 'now'],
      'moved'
    )
    .endAsync('moved') as (
    claim: NudgeClaim,
    now: number
  ) => Promise<{ stall: string } | null | void>;

  const remindTodo = (superpipe({})('neo.todo.remind') as PipelineAPI)
    .input(['claim', 'now'])
    .pipe(
      ({ ask, ref, todo, incident }: NudgeClaim, now: number) =>
        deps
          .invoke(caller(ask), 'work.send', {
            ref,
            message: neoTodoIdleReminder(todo, idleMinutes(incident, now)),
          })
          .catch(() => null),
      ['claim', 'now'],
      'sent'
    )
    .pipe(
      (sent: OperationOutcome | null) => {
        const value =
          sent?.kind === 'completed'
            ? (sent.value as {
                ok?: boolean;
                detail?: string;
                reason?: string;
                notSent?: boolean;
              } | null)
            : null;
        if (value?.ok) return { reason: null };
        return {
          value: {
            bounced: value?.notSent === true,
            detail: value?.detail ?? value?.reason ?? null,
          },
        };
      },
      'sent',
      'result:unreached'
    )
    .pipe(
      (claim: NudgeClaim, unreached: { bounced: boolean; detail: string | null }, now: number) =>
        unreached.bounced
          ? stallTodo(
              claim,
              `${neoTodoIdleReason(idleMinutes(claim.incident, now))} The reminder did not reach its worker${unreached.detail ? ` (${unreached.detail})` : ''}.`,
              now
            )
          : deps
              .tell(
                claim.ask,
                claim.todo,
                `Todo "${claim.todo.title}" has made no progress for ${idleMinutes(claim.incident, now)} min, and its worker could not be reached.`,
                `neo-todo-remind:${claim.todo.id}:${claim.incident.since}:${claim.plan.nudges}`
              )
              .catch((error: unknown) => releaseNudge(claim, error)),
      ['claim', 'unreached', 'now'],
      'stalled'
    )
    .endAsync('stalled') as (claim: NudgeClaim, now: number) => Promise<unknown>;

  const act = async (claim: NudgeClaim, now: number) => {
    const idle = neoTodoIdleReason(idleMinutes(claim.incident, now));
    if (claim.plan.kind === 'stall') return void (await stallTodo(claim, idle, now));
    if (claim.plan.kind === 'remind') return void (await remindTodo(claim, now));
    const moved = await redispatchTodo(claim, now);
    if (moved && 'stall' in moved) await stallTodo(claim, `${idle} ${moved.stall}`, now);
  };

  type NudgeContext = NonNullable<ReturnType<typeof sessions.nudgeContext>>;
  const nudge = (superpipe({})('neo.todo.nudge') as PipelineAPI)
    .input(['todoId', 'now', 'mayMove'])
    .pipe((todoId: string) => sessions.read('nudgeContext', todoId), 'todoId', 'snapshot')
    .pipe(
      (snapshot: NudgeContext | null) => (snapshot ? { value: snapshot } : { reason: null }),
      'snapshot',
      'result:admission'
    )
    .pipe(
      async (context: NudgeContext) => {
        const live = readDriverLive(
          await deps.invoke(caller(context.ask), 'work.status', { ref: context.ref })
        );
        await sessions.write('noteWorkerStatus', context.todo.id, live?.status ?? 'unknown');
        return live;
      },
      ['admission'],
      'live'
    )
    .pipe(
      async (context: NudgeContext) => {
        for (const pack of deps.packs())
          if (
            (!context.todo.check || pack.id === context.todo.check.pack) &&
            (await pack.todos?.waiting?.(context.todo))
          )
            return { reason: null };
        return { value: context };
      },
      'admission',
      'result:admission'
    )
    .pipe((mayMove: () => Promise<boolean>) => mayMove(), 'mayMove', 'move')
    .pipe(
      async (
        context: NudgeContext,
        live: ReturnType<typeof readDriverLive>,
        now: number,
        move: boolean
      ) => {
        const claim =
          live &&
          (await sessions.write(
            'claimNudge',
            context.todo.id,
            context.ref,
            live,
            now,
            context.todo.updatedAt,
            move
          ));
        return claim ? { value: claim } : { reason: null };
      },
      ['admission', 'live', 'now', 'move'],
      'result:admission'
    )
    .endAsync('admission') as (
    todoId: string,
    now: number,
    mayMove: () => Promise<boolean>
  ) => Promise<NudgeClaim | null>;

  type Stalled = { todo: NeoTodo; ask: NeoAsk; ref: WorkRef };
  const carded = ({ todo, ask }: Stalled) =>
    store
      .listQuestions(ask.id)
      .some((q) => q.todoId === todo.id && (q.state === 'open' || q.createdAt >= todo.updatedAt));

  const cardTodo = (stalled: Stalled, now: number) => {
    if (carded(stalled)) return;
    const { todo, ask } = stalled;
    store.askQuestion(
      crypto.randomUUID(),
      ask.id,
      {
        text: neoTodoStalledCard(todo),
        kind: 'reply',
        options: null,
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos: null,
        todoId: todo.id,
      },
      now
    );
    deps.changed();
  };

  const findPlace = async ({ ask, ref }: Stalled) => {
    const found = await deps.invoke(caller(ask), 'work.find', {
      id: ref.id,
      adapters: [ref.adapter],
      includeClosed: true,
    });
    const groups =
      found.kind === 'completed'
        ? ((found.value as { places?: { work?: { ref: WorkRef; place?: Place }[] }[] }).places ??
          [])
        : [];
    return groups.flatMap((group) => group.work ?? []).find((work) => work.ref.id === ref.id)
      ?.place;
  };

  type Rescue = Stalled & { place: Place };
  const rescueTodo = (superpipe({})('neo.todo.rescue-stalled') as PipelineAPI)
    .input(['todo', 'now'])
    .pipe(
      (listed: NeoTodo): { value: Stalled } | { reason: null } => {
        const todo = store.getTodo(listed.id) ?? listed;
        const ask = store.getAsk(todo.askId);
        const ref = sessions.readRef(todo.id);
        return todo.state === 'blocked' &&
          todo.blockedBy === 'stalled' &&
          ask?.status === 'open' &&
          ref
          ? { value: { todo, ask, ref } }
          : { reason: null };
      },
      'todo',
      'result:rescue'
    )
    .pipe(
      (stalled: Stalled, now: number): { value: Stalled } | { reason: null } => {
        if (carded(stalled)) return { reason: null };
        if (
          !stalled.ask.originMessageId?.startsWith('neo-track:') &&
          !sessions.readNudge(stalled.todo.id)?.redispatched
        )
          return { value: stalled };
        cardTodo(stalled, now);
        return { reason: null };
      },
      ['rescue', 'now'],
      'result:rescue'
    )
    .pipe(
      async (stalled: Stalled, now: number) =>
        (await queue.takeMove(now)) ? { value: stalled } : { reason: null },
      ['rescue', 'now'],
      'result:rescue'
    )
    .pipe(
      async (stalled: Stalled, now: number): Promise<{ value: Rescue } | { reason: null }> => {
        const place = await findPlace(stalled);
        if (place) return { value: { ...stalled, place } };
        cardTodo(stalled, now);
        return { reason: null };
      },
      ['rescue', 'now'],
      'result:rescue'
    )
    .pipe(
      ({ todo }: Rescue, now: number) => {
        sessions.recordNudge(todo.id, { since: now, nudges: 0, redispatched: true });
        return store.updateTodo(todo, { state: 'doing', startedAt: now, finishedAt: null }, now);
      },
      ['rescue', 'now'],
      'reopened'
    )
    .pipe(
      ({ ask, ref, place }: Rescue, reopened: NeoTodo) =>
        dispatch({
          todo: { ...reopened, instruction: reopened.instruction ?? neoTodoHandoff(reopened) },
          ask,
          target: { verb: 'start', adapter: ref.adapter, place },
        }),
      ['rescue', 'reopened'],
      'dispatched'
    )
    .pipe(
      async (rescue: Rescue, now: number) => {
        const { ask, todo, ref } = rescue;
        const current = store.getTodo(todo.id);
        if (current?.state === 'doing' && sessions.readRef(todo.id)?.id !== ref.id)
          return deps.tell(
            ask,
            todo,
            `Todo "${todo.title}" was stalled, so the daemon started a fresh worker for it where its last worker ran.`,
            `neo-todo-rescue:${todo.id}`
          );
        if (
          current &&
          (current.state === 'failed' ||
            (current.state === 'blocked' && current.blockedBy === 'failure'))
        ) {
          const restored = await recompute(
            current,
            {
              state: 'blocked',
              blockedBy: 'stalled',
              blockedReason: `No fresh worker could start: ${current.reason ?? current.blockedReason ?? 'the start was refused'}`,
              nextAction: NEO_TODO_STALL_NEXT,
              finishedAt: null,
            },
            now
          );
          cardTodo({ ...rescue, todo: restored }, now);
        }
      },
      ['rescue', 'now', 'dispatched'],
      'rescued'
    )
    .endAsync('rescued') as (todo: NeoTodo, now: number) => Promise<void | null>;

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
      checkKind: todo.check?.kind ?? null,
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
    restartLadder(todo.id, Date.now());
    const next = store.updateTodo(
      todo,
      { state: 'doing', report: null, evidence: null, finishedAt: null },
      Date.now()
    );
    return { ok: true as const, todo: next };
  };

  type StopContext = NonNullable<ReturnType<NeoTodoSessionRepository['stopContext']>>;
  const stop = (superpipe({})('neo.todo.stop-current-worker') as PipelineAPI)
    .input(['todo'])
    .pipe((todo: NeoTodo) => sessions.read('stopContext', todo.id), 'todo', 'context')
    .pipe(
      (context: StopContext | null) =>
        context?.ref &&
        context.ask &&
        !context.adopted &&
        (context.todo.state === 'doing' ||
          !['done', 'failed', 'stopped'].includes(context.live ?? ''))
          ? { value: context as StopContext & { ask: NeoAsk; ref: WorkRef } }
          : { reason: null },
      'context',
      'result:outcome'
    )
    .pipe(
      ({ ask, ref }: StopContext & { ask: NeoAsk; ref: WorkRef }) =>
        deps
          .invoke(caller(ask), 'work.stop', { ref })
          .catch((error: unknown) => ({ kind: 'failed' as const, message: String(error) })),
      'outcome',
      'stopped'
    )
    .pipe(
      (stopped: OperationOutcome) => {
        if (stopped.kind !== 'completed')
          return {
            reason: `stop_failed: ${(stopped as { message?: string }).message ?? 'the stop did not complete'}`,
          };
        const value = stopped.value as { ok?: boolean; reason?: string; detail?: string } | null;
        return value?.ok === false && value.reason !== 'unsupported'
          ? { reason: `stop_failed: ${value.detail ?? value.reason ?? 'the driver refused'}` }
          : { value: null };
      },
      'stopped',
      'result:outcome'
    )
    .endAsync('outcome') as (todo: NeoTodo) => Promise<string | null>;

  return {
    start,
    fill,
    advance,
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
      selection: readonly string[] | { questionId: string },
      warn: (message: string, error: unknown) => void
    ): Promise<void> {
      for (const todo of (await store.read('listCheckable')).filter((item) =>
        'questionId' in selection
          ? item.check?.pack === 'core' &&
            item.check.kind === 'human_confirmed' &&
            item.check.params.questionId === selection.questionId
          : selection.includes(item.id)
      )) {
        await check(todo, Date.now()).catch((error) => warn('Todo check pending', error));
      }
    },
    async refresh(warn: (message: string, error: unknown) => void): Promise<void> {
      for (const todoId of await sessions.read('unrecordedStarts')) {
        if (starting.has(todoId)) continue;
        await recoverStart(todoId).catch((error) => warn('Todo start recovery pending', error));
      }
      for (const { todoId, ref } of await sessions.read('awaitingReports'))
        await settle(todoId, ref).catch((error) => warn('Todo session refresh pending', error));
      for (const todo of await store.read('listCheckable')) {
        await follow(todo, Date.now()).catch((error) => warn('Todo follow pending', error));
        await check(store.getTodo(todo.id) ?? todo, Date.now()).catch((error) =>
          warn('Todo check pending', error)
        );
        await queue
          .followThrough(todo.id, Date.now())
          .catch((error) => warn('Todo nudge pending', error));
        await rescueTodo(todo, Date.now()).catch((error) =>
          warn('Stalled todo rescue pending', error)
        );
      }
      await fill().catch((error) => warn('Queued todo start pending', error));
      await sessions
        .read('queueFacts')
        .then(noteUnworked)
        .catch((error) => warn('Unworked todo note pending', error));
    },
  };
}

export type NeoTodoRunner = ReturnType<typeof createNeoTodoRunner>;
