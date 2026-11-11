import superpipe, { type PipelineAPI } from 'superpipe';
import { neoDerivedId } from '../neo/derived-id.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import { type Job } from '../../storage/repositories/job-queue-repository.ts';
import {
  workerInputReads,
  workerInputWrites,
  type WorkerInput,
} from '../../storage/repositories/worker-input-worker.ts';
import type { JobQueueProcessor } from '../../storage/job-queue-processor.ts';
import {
  isWaitingOnPrompt,
  readDriverOutcome,
  readDriverLive,
  readDriverSent,
} from '../neo/driver-work.ts';
import type { OperationCaller } from '../operations/registry.ts';
import {
  isBusyWork,
  pickRoute,
  readWorkStatus,
  routeStatus,
  sendWork,
  workReplyInput,
  type WorkVerbDeps,
} from './work-operations.ts';

export function createWorkerInputDelivery(
  db: Database,
  deps: WorkVerbDeps,
  report: (id: string, detail: string, from: string) => Promise<void>
) {
  const gateway = gatewayFor(db);
  const read = async (job: Job) => {
    const stored = await gateway.call(workerInputReads, 'read', job);
    if (!stored.ref || stored.closed || !stored.head || stored.payload.dispatched || stored.outcome)
      return { ...stored, status: null };
    const route = routeStatus({ ref: stored.ref }, deps);
    const status =
      'reason' in route
        ? route.reason
        : await readWorkStatus(route.value, { ref: stored.ref }, deps).catch((error: unknown) => ({
            ok: false as const,
            reason: 'unreachable' as const,
            detail: String(error),
          }));
    return { ...stored, status };
  };
  type Facts = Awaited<ReturnType<typeof read>>;
  const reportId = (facts: Facts) =>
    facts.payload.idempotencyKey
      ? neoDerivedId(
          JSON.stringify(['worker-input-report', facts.payload.from, facts.payload.idempotencyKey])
        )
      : facts.payload.inputId;
  const decide = (
    facts: Facts
  ): { action: 'wait' | 'fail' | 'send' | 'uncertain'; detail: string; report?: true } => {
    if (facts.failure !== null) return { action: 'fail', detail: facts.failure };
    if (facts.payload.dispatched)
      return {
        action: 'uncertain',
        detail:
          'This input may not have reached the worker. Its dispatch was interrupted; inspect the worker before resending.',
      };
    if (facts.closed) return { action: 'fail', detail: 'The todo or its ask is no longer open.' };
    if (!facts.ref || !facts.head)
      return {
        action: 'wait',
        detail: 'Waiting for the worker to start or an earlier input to finish.',
      };
    if (facts.ref.daemon)
      return {
        action: 'fail',
        detail: 'A local queued input cannot be dispatched to a remote worker.',
      };
    const live = facts.status?.ok
      ? readDriverLive({ kind: 'completed', value: facts.status })
      : null;
    if (live && isWaitingOnPrompt(live))
      return { action: 'fail', detail: 'needs_you: its session is waiting on the human.' };
    if (facts.status && !facts.status.ok && ['not_found', 'not_open'].includes(facts.status.reason))
      return { action: 'fail', detail: facts.status.detail };
    if (!live || isBusyWork(live.status))
      return {
        action: 'wait',
        ...(!live ? { report: true as const } : {}),
        detail: live
          ? 'Waiting for the current worker turn to end.'
          : facts.status && !facts.status.ok
            ? facts.status.detail
            : 'Worker status is unavailable.',
      };
    return { action: 'send', detail: '' };
  };
  const reportFailure = async (
    job: Job,
    facts: Facts,
    outcome: Extract<ReturnType<typeof readDriverOutcome>, { failure: string }> & { notSent?: true }
  ) => {
    if (!(await gateway.call(workerInputWrites, 'recordFailure', job, outcome)))
      return { fenced: true };
    try {
      await report(reportId(facts), outcome.failure, facts.payload.from);
    } catch (error) {
      const detail = `Worker failure notification is pending: ${String(error)}`;
      await gateway.call(workerInputWrites, 'wait', job, detail);
      return { waiting: detail };
    }
    await gateway.call(workerInputWrites, 'settle', job, outcome);
    return { failure: outcome.failure };
  };
  const apply = async (job: Job, facts: Facts, plan: ReturnType<typeof decide>) => {
    if (plan.action === 'wait') {
      let reported = false;
      if (plan.report && !facts.payload.waitReported) {
        try {
          await report(`${reportId(facts)}:waiting`, plan.detail, facts.payload.from);
          reported = true;
        } catch {
          reported = false;
        }
      }
      await gateway.call(workerInputWrites, 'wait', job, plan.detail, reported);
      return { waiting: plan.detail };
    }
    if (plan.action === 'fail' || plan.action === 'uncertain')
      return reportFailure(job, facts, {
        failure: plan.detail,
        ...(plan.action === 'fail' && !facts.payload.dispatched ? { notSent: true as const } : {}),
      });
    const ref = facts.ref!;
    const route = pickRoute('send', ref, deps.adapters());
    if ('reason' in route) {
      await gateway.call(workerInputWrites, 'wait', job, route.reason.detail);
      return { waiting: route.reason.detail };
    }
    if (!(await gateway.call(workerInputWrites, 'dispatch', job))) {
      await gateway.call(
        workerInputWrites,
        'wait',
        job,
        'Worker input state changed before dispatch.'
      );
      return { waiting: 'state_changed' };
    }
    try {
      const input = workReplyInput(
        { ref, message: facts.message, idempotencyKey: facts.payload.idempotencyKey },
        facts.payload.from,
        facts.payload.caller,
        deps
      );
      const result = await sendWork(
        route.value,
        input,
        facts.payload.from,
        facts.payload.caller,
        deps
      );
      const outcome = readDriverOutcome(
        { verb: 'send', ref },
        { kind: 'completed', value: result }
      );
      if ('failure' in outcome)
        return reportFailure(job, facts, {
          ...outcome,
          ...(!result.ok && result.notSent ? { notSent: true as const } : {}),
        });
      const sent = facts.status
        ? readDriverSent(
            { kind: 'completed', value: facts.status },
            facts.message,
            facts.todo?.createdAt ?? 0
          )
        : null;
      await gateway.call(
        workerInputWrites,
        'settle',
        job,
        outcome,
        sent && 'ref' in outcome
          ? { ...sent, receipt: outcome.receipt, delivery: outcome.delivery }
          : null
      );
      return { inputId: facts.payload.inputId };
    } catch (error) {
      const detail = `This input may not have reached the worker: ${String(error)}`;
      return reportFailure(job, facts, { failure: detail });
    }
  };
  const deliver = (superpipe({})('deliver-worker-input') as PipelineAPI)
    .input(['job'])
    .pipe(read, 'job', 'facts')
    .pipe(decide, 'facts', 'plan')
    .pipe(apply, ['job', 'facts', 'plan'], 'result')
    .endAsync('result') as (job: Job) => Promise<Record<string, unknown>>;
  let active = false;
  const run = async (job: Job) => {
    if (active) {
      await gateway.call(workerInputWrites, 'wait', job, 'Waiting for the input dispatcher.');
      return { waiting: 'dispatcher' };
    }
    active = true;
    try {
      return await deliver(job);
    } finally {
      active = false;
    }
  };
  return {
    accept: (input: WorkerInput, from: string, caller: OperationCaller) =>
      gateway.call(workerInputWrites, 'accept', input, from, caller),
    run,
  };
}

export function registerWorkerInputDelivery(
  processor: JobQueueProcessor,
  delivery: ReturnType<typeof createWorkerInputDelivery>
) {
  processor.register('worker_input', delivery.run, { dequeueMode: { kind: 'session-fifo' } });
}
