import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { WorkSummarySchema, type WorkRef } from '../../../drivers/types.ts';
import type { OperationOutcome } from '../../../operations/invoke.ts';
import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import type { NeoTodoTarget } from '../../driver-work.ts';
import type { NeoLineScope, NeoPack, NeoWorkerTargetDecision } from '../../pack-contract.ts';
import {
  codingSessionAssignmentReads,
  codingSessionAssignmentWrites,
} from './session-assignments-worker.ts';
import { planCodingSessionDispatch, planCodingStrategyQuestion } from './session-strategy.ts';
import { codingStageTargetReads } from './stage-target-db.ts';
import {
  type CodingLines,
  codingCandidateLine,
  codingStartAlternatives,
  rankCodingTargets,
  lineText,
  rankedHere,
} from './stage-lines.ts';

type Status = (ref: WorkRef) => Promise<OperationOutcome>;
type AskSetting = Parameters<NonNullable<NeoPack['workerTarget']>>[3];
type Pooled = { ref: WorkRef; name: string; held: boolean; terminalOnly: boolean };
type Facts = {
  repo: string;
  strategy: Parameters<typeof planCodingSessionDispatch>[0]['strategy'];
  strategySaved: boolean;
  owner: { todoId: string; session: Pooled | null } | null;
  feature: { todoId: string; session: Pooled | null } | null;
  successors: { todoId: string; session: Pooled | null }[];
  pool: Pooled[];
} | null;
type Plan = (ReturnType<typeof planCodingSessionDispatch> | { verb: 'keep' } | { verb: 'held' }) & {
  takeover?: { todoId: string; ref: WorkRef };
};

const WAIT = 'session_unknown: the session for this work is starting or unreachable; wait.';
const LIVE_BUSY = new Set(['queued', 'running', 'needs_you']);

async function sessionState(session: Pooled, status: Status) {
  const outcome = await status(session.ref);
  const reply =
    outcome.kind === 'completed' ? (outcome.value as { ok?: boolean; value?: unknown }) : null;
  const live = reply?.ok ? WorkSummarySchema.safeParse(reply.value) : null;
  const state: 'available' | 'busy' | 'unknown' | 'archived' = !live?.success
    ? 'unknown'
    : live.data.archived
      ? 'archived'
      : live.data.busy || LIVE_BUSY.has(live.data.status)
        ? 'busy'
        : 'available';
  return {
    ref: session.ref,
    name: session.name,
    terminalOnly: session.terminalOnly,
    state: session.held && state !== 'unknown' && state !== 'archived' ? ('busy' as const) : state,
    line: {
      provider: (live?.success && live.data.provider) || '',
      model: (live?.success && live.data.model) || '',
      harness: session.ref.adapter,
    },
  };
}

const lineScope = (db: Database, todoId: string, repo?: string) =>
  gatewayFor(db).call(codingStageTargetReads, 'lineScope', { todoId, ...(repo ? { repo } : {}) });

const workKind = (todo: NeoTodo) =>
  typeof todo.named?.workKind === 'string' ? todo.named.workKind : 'coding.write';

async function routedPool(
  pool: Awaited<ReturnType<typeof sessionState>>[],
  lines: CodingLines | undefined,
  scope: () => Promise<NeoLineScope>,
  kind: string
) {
  if (!lines?.active()) return pool;
  return Promise.all(
    pool.map(async (session) => {
      const routed = session.ref.adapter === 'hyperneo' && !session.ref.daemon;
      if (!routed || session.state !== 'available') return session;
      const line = session.line.provider
        ? session.line
        : (
            await codingCandidateLine(lines, {
              adapter: session.ref.adapter,
              ...(session.line.model ? { model: session.line.model } : {}),
            })
          ).line;
      const ranking = await lines.rank(kind, [line], await scope());
      return ranking.ranked.length ? session : { ...session, state: 'busy' as const };
    })
  );
}

const prUrl = (todo: NeoTodo) => {
  const urls = todo.check?.pack === 'coding' ? todo.check.params?.urls : undefined;
  return Array.isArray(urls) && urls.length === 1 && typeof urls[0] === 'string'
    ? urls[0]
    : undefined;
};

const strategyAsks = new Map<string, Promise<unknown>>();

function askStrategyOnce(db: Database, repo: string, askSetting: AskSetting) {
  const key = repo.toLowerCase();
  const asked = (strategyAsks.get(key) ?? Promise.resolve()).then(async () => {
    const plan = async () =>
      planCodingStrategyQuestion({
        repo,
        nonce: crypto.randomUUID(),
        ...(await gatewayFor(db).call(codingSessionAssignmentReads, 'strategyQuestions', repo)),
      });
    let outcome: Awaited<ReturnType<AskSetting>> | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = await plan();
      if (!next?.ask) return next;
      outcome = await askSetting(next.ask);
      const reply = outcome.kind === 'completed' ? (outcome.value as { ok?: boolean }) : null;
      if (reply?.ok) return next;
    }
    return { refused: outcome };
  });
  strategyAsks.set(
    key,
    asked.catch(() => null)
  );
  return asked;
}

const readFacts = (db: Database, todo: NeoTodo, target: NeoTodoTarget) =>
  gatewayFor(db).call(codingSessionAssignmentReads, 'dispatchFacts', {
    todoId: todo.id,
    featureKey: todo.askId,
    adapter: target.verb === 'start' ? target.adapter : target.ref.adapter,
    prUrl: prUrl(todo),
  });

export const decideCodingSessionTarget = (superpipe({})('coding.session-target') as PipelineAPI)
  .input(['db', 'todo', 'target', 'status', 'askSetting', 'lines'])
  .pipe(readFacts, ['db', 'todo', 'target'], 'asked')
  .pipe(
    (db: Database, asked: Facts, askSetting: AskSetting) =>
      asked && !asked.strategySaved ? askStrategyOnce(db, asked.repo, askSetting) : null,
    ['db', 'asked', 'askSetting'],
    'strategyQuestion'
  )
  .pipe(
    (db: Database, todo: NeoTodo, target: NeoTodoTarget, asked: Facts) =>
      asked && !asked.strategySaved ? readFacts(db, todo, target) : asked,
    ['db', 'todo', 'target', 'asked', 'strategyQuestion'],
    'facts'
  )
  .pipe(
    async (
      db: Database,
      lines: CodingLines | undefined,
      facts: Facts,
      todo: NeoTodo,
      target: NeoTodoTarget,
      status: Status
    ): Promise<Plan> => {
      if (!facts) return { verb: 'keep' };
      let { owner } = facts;
      if (owner && !owner.session && owner.todoId !== todo.id) return { verb: 'held' };
      let ownerState = owner?.session ? await sessionState(owner.session, status) : undefined;
      for (const next of ownerState?.state === 'archived' ? facts.successors : []) {
        if (!next.session || next.todoId === owner?.todoId) continue;
        const nextState = await sessionState(next.session, status);
        if (nextState.state === 'archived') continue;
        owner = next;
        ownerState = nextState;
        break;
      }
      if (
        ownerState?.state === 'archived' &&
        facts.feature &&
        facts.feature.todoId !== owner?.todoId
      ) {
        owner = facts.feature;
        if (!owner.session && owner.todoId !== todo.id) return { verb: 'held' };
        ownerState = owner.session ? await sessionState(owner.session, status) : undefined;
      }
      const archived = ownerState?.state === 'archived';
      const assigned = archived ? undefined : ownerState;
      const pool = assigned
        ? []
        : await routedPool(
            await Promise.all(facts.pool.map((s) => sessionState(s, status))),
            lines,
            () => lineScope(db, todo.id, facts.repo),
            workKind(todo)
          );
      const eligiblePool = pool.filter(
        (session) => session.state !== 'unknown' || !session.terminalOnly
      );
      return {
        ...planCodingSessionDispatch({
          strategy: facts.strategy,
          workType: (target.verb === 'start' && target.name) || 'dev',
          assigned,
          pool: eligiblePool,
        }),
        ...(archived && owner?.session
          ? { takeover: { todoId: owner.todoId, ref: owner.session.ref } }
          : {}),
      };
    },
    ['db', 'lines', 'facts', 'todo', 'target', 'status'],
    'plan'
  )
  .pipe(
    async (
      db: Database,
      lines: CodingLines | undefined,
      facts: Facts,
      plan: Plan,
      todo: NeoTodo,
      target: NeoTodoTarget
    ) => {
      if (target.verb !== 'start' || (plan.verb !== 'start' && plan.verb !== 'keep'))
        return { value: { target } };
      const saved =
        facts && rankedHere(target)
          ? await gatewayFor(db).call(codingStageTargetReads, 'stagePreference', {
              repo: facts.repo,
              stage: 'write',
            })
          : {};
      const usable = async (field: 'model' | 'effort') => {
        const value = !target[field] && saved[field];
        if (!value || !lines) return {};
        const resolved = await lines.resolve({ adapter: target.adapter, [field]: value });
        return resolved?.ok ? { [field]: value } : {};
      };
      const start = { ...target, ...(await usable('model')), ...(await usable('effort')) };
      if (!lines) return { value: { target: start } };
      const ranked = await rankCodingTargets(
        lines,
        workKind(todo),
        await codingStartAlternatives(start, lines),
        await lineScope(db, todo.id, facts?.repo)
      );
      if ('reason' in ranked) return { reason: { reason: ranked.reason } };
      const [chosen] = ranked.value;
      if (ranked.sources[0] === start) return { value: { target: chosen } };
      const [from, to] = await Promise.all(
        [start, chosen].map(async (entry) =>
          lineText((await codingCandidateLine(lines, entry)).line)
        )
      );
      const why = ranked.skipped.find((text) => text.startsWith(`${from}: `));
      const note = `Started on ${to} instead of ${why ?? `${from}: the route ranks it lower`}.`;
      return { value: { target: chosen, note } };
    },
    ['db', 'lines', 'facts', 'plan', 'todo', 'target'],
    'result:decision'
  )
  .pipe(
    async (db: Database, facts: Facts, plan: Plan, todo: NeoTodo, target: NeoTodoTarget) => {
      const binds =
        (plan.verb === 'send' && plan.bind) ||
        (plan.verb === 'start' && (!facts?.owner || plan.takeover) && target.verb === 'start');
      if (!facts || facts.strategy !== 'long_lived' || !binds) return true;
      const owner = await gatewayFor(db).call(codingSessionAssignmentWrites, 'reserveFeature', {
        repo: facts.repo,
        featureKey: todo.askId,
        todoId: todo.id,
        now: Date.now(),
        replace: plan.takeover,
      });
      return owner.todoId === todo.id;
    },
    ['db', 'facts', 'plan', 'todo', 'target'],
    'reserved'
  )
  .pipe(
    (
      plan: Plan,
      reserved: boolean,
      { target, note }: { target: NeoTodoTarget; note?: string }
    ): NeoWorkerTargetDecision => {
      const moved = note ? { note } : {};
      if (plan.verb === 'keep') return { value: target, ...moved };
      if (plan.verb === 'held' || plan.verb === 'wait' || !reserved) return { reason: WAIT };
      if (plan.verb !== 'start') return { value: { verb: 'send', ref: plan.ref } };
      if (target.verb !== 'start')
        return {
          reason:
            'session_start_needed: this work needs a new session; add it with a start target.',
        };
      return { value: plan.name ? { ...target, name: plan.name } : target, ...moved };
    },
    ['plan', 'reserved', 'decision'],
    'decision'
  )
  .endAsync('decision') as (
  db: Database,
  todo: NeoTodo,
  target: NeoTodoTarget,
  status: Status,
  askSetting: AskSetting,
  lines?: CodingLines
) => Promise<NeoWorkerTargetDecision>;
