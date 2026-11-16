import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { WorkSummarySchema, type WorkRef } from '../../../drivers/types.ts';
import type { OperationOutcome } from '../../../operations/invoke.ts';
import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import type { NeoTodoTarget } from '../../driver-work.ts';
import type { NeoWorkerTargetDecision } from '../../pack-contract.ts';
import {
  codingSessionAssignmentReads,
  codingSessionAssignmentWrites,
} from './session-assignments-worker.ts';
import { planCodingSessionDispatch } from './session-strategy.ts';
import { type CodingLines, rankCodingTargets } from './stage-lines.ts';

type Status = (ref: WorkRef) => Promise<OperationOutcome>;
type Pooled = { ref: WorkRef; name: string; held: boolean };
type Facts = {
  repo: string;
  strategy: Parameters<typeof planCodingSessionDispatch>[0]['strategy'];
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
    state: session.held && state !== 'unknown' && state !== 'archived' ? ('busy' as const) : state,
  };
}

const prUrl = (todo: NeoTodo) => {
  const urls = todo.check?.pack === 'coding' ? todo.check.params?.urls : undefined;
  return Array.isArray(urls) && urls.length === 1 && typeof urls[0] === 'string'
    ? urls[0]
    : undefined;
};

export const decideCodingSessionTarget = (superpipe({})('coding.session-target') as PipelineAPI)
  .input(['db', 'todo', 'target', 'status', 'lines'])
  .pipe(
    (db: Database, todo: NeoTodo, target: NeoTodoTarget) =>
      gatewayFor(db).call(codingSessionAssignmentReads, 'dispatchFacts', {
        todoId: todo.id,
        featureKey: todo.askId,
        adapter: target.verb === 'start' ? target.adapter : target.ref.adapter,
        prUrl: prUrl(todo),
      }),
    ['db', 'todo', 'target'],
    'facts'
  )
  .pipe(
    async (facts: Facts, todo: NeoTodo, target: NeoTodoTarget, status: Status): Promise<Plan> => {
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
        : await Promise.all(facts.pool.map((s) => sessionState(s, status)));
      return {
        ...planCodingSessionDispatch({
          strategy: facts.strategy,
          workType: (target.verb === 'start' && target.name) || 'dev',
          assigned,
          pool,
        }),
        ...(archived && owner?.session
          ? { takeover: { todoId: owner.todoId, ref: owner.session.ref } }
          : {}),
      };
    },
    ['facts', 'todo', 'target', 'status'],
    'plan'
  )
  .pipe(
    async (
      lines: CodingLines | undefined,
      facts: Facts,
      plan: Plan,
      todo: NeoTodo,
      target: NeoTodoTarget
    ) => {
      if (!lines || target.verb !== 'start' || (plan.verb !== 'start' && plan.verb !== 'keep'))
        return { value: true };
      const kind = todo.named?.workKind;
      const ranked = await rankCodingTargets(
        lines,
        typeof kind === 'string' ? kind : 'coding.write',
        [target],
        facts ? { repo: facts.repo } : {}
      );
      return 'reason' in ranked ? { reason: { reason: ranked.reason } } : { value: true };
    },
    ['lines', 'facts', 'plan', 'todo', 'target'],
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
    (plan: Plan, reserved: boolean, target: NeoTodoTarget): NeoWorkerTargetDecision => {
      if (plan.verb === 'keep') return { value: target };
      if (plan.verb === 'held' || plan.verb === 'wait' || !reserved) return { reason: WAIT };
      if (plan.verb !== 'start') return { value: { verb: 'send', ref: plan.ref } };
      if (target.verb !== 'start')
        return {
          reason:
            'session_start_needed: this work needs a new session; add it with a start target.',
        };
      return { value: plan.name ? { ...target, name: plan.name } : target };
    },
    ['plan', 'reserved', 'target'],
    'decision'
  )
  .endAsync('decision') as (
  db: Database,
  todo: NeoTodo,
  target: NeoTodoTarget,
  status: Status,
  lines?: CodingLines
) => Promise<NeoWorkerTargetDecision>;
