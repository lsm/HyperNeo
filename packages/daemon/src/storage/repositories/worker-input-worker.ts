import type { WorkRef } from '../../lib/drivers/types.ts';
import type { OperationCaller } from '../../lib/operations/registry.ts';
import { ChangeRecorder, defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { JobQueueRepository, type Job } from './job-queue-repository.ts';
import {
  acceptWorkDeliveryInput,
  WorkDeliveryInputRepository,
  recordWorkDeliveryOutcome,
} from './work-delivery-input-repository.ts';
import { NeoTodoSessionRepository, neoWorkerKey } from './neo-todo-session-repository.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
import { readDriverOutcome, type DriverSent } from '../../lib/neo/driver-work.ts';

export type WorkerInput = {
  message: string;
  todoId?: string;
  ref?: WorkRef;
  idempotencyKey?: string;
  continuation?: boolean;
};
export type WorkerInputPayload = {
  inputId: string;
  caller: OperationCaller;
  from: string;
  sessionId: string;
  idempotencyKey?: string;
  continuation?: boolean;
  initial?: boolean;
  dispatched?: boolean;
  waitReported?: boolean;
};

export class WorkerInputJobs {
  constructor(private readonly db: Database) {}

  accept(input: WorkerInput, from: string, caller: OperationCaller): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    const sessions = new NeoTodoSessionRepository(this.db);
    const queued =
      input.ref && input.todoId && !input.continuation && !sessions.readRef(input.todoId)
        ? sessions.queueOn(input.todoId, input.ref, input.message)
        : 'none';
    const ref = queued === 'none' ? input.ref : undefined;
    acceptWorkDeliveryInput.run(
      this.db,
      {
        id,
        todoId: input.todoId ?? null,
        originSessionId: from,
        target: ref ? { verb: 'send', ref } : { verb: 'todo', todoId: input.todoId! },
        message: input.message,
        now,
      },
      new ChangeRecorder()
    );
    this.db
      .prepare('UPDATE work_delivery_inputs SET deadline_at = ? WHERE id = ?')
      .run(Number.MAX_SAFE_INTEGER, id);
    new JobQueueRepository(this.db).enqueue({
      queue: 'worker_input',
      payload: {
        inputId: id,
        from,
        caller,
        sessionId: neoWorkerKey(ref) ?? `todo:${input.todoId}`,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.continuation || queued === 'instruction' ? { continuation: true } : {}),
        ...(queued === 'message' ? { initial: true } : {}),
      },
    });
    return id;
  }

  private resolveTarget(target: { verb: string; ref?: WorkRef; todoId?: string }): WorkRef | null {
    if (target.verb !== 'todo') return target.ref ?? null;
    const ref = new NeoTodoSessionRepository(this.db).readRef(target.todoId!);
    if (!ref) return null;
    const started = this.db
      .prepare(`SELECT 1 FROM work_delivery_inputs WHERE todo_id = ?
      AND json_extract(outcome, '$.ref.adapter') = ? AND json_extract(outcome, '$.ref.id') = ?
      AND json_extract(outcome, '$.ref.daemon') IS ? LIMIT 1`)
      .get(target.todoId!, ref.adapter, ref.id, ref.daemon ?? null);
    return started ? ref : null;
  }

  read(job: Job) {
    const payload = job.payload as WorkerInputPayload;
    const row = this.db
      .prepare(
        'SELECT message, target, todo_id AS todoId, outcome, accepted_at AS acceptedAt FROM work_delivery_inputs WHERE id = ?'
      )
      .get(payload.inputId) as {
      message: string;
      acceptedAt: number;
      target: string;
      todoId: string | null;
      outcome: string | null;
    };
    const target = JSON.parse(row.target);
    const ref = this.resolveTarget(target);
    const todos = new NeoAskTodoRepository(this.db);
    const todo = row.todoId ? todos.getTodo(row.todoId) : null;
    const ask = todo ? todos.getAsk(todo.askId) : null;
    const closed =
      !!row.todoId && (!todo || !ask || ask.status !== 'open' || todo.state === 'removed');
    const earlier = this.db
      .prepare(`SELECT i.id, i.target FROM work_delivery_inputs i
      JOIN job_queue j ON json_extract(j.payload, '$.inputId') = i.id
      WHERE j.queue = 'worker_input' AND j.status IN ('pending', 'processing') AND i.outcome IS NULL
      ORDER BY i.accepted_at, i.rowid`)
      .all() as { id: string; target: string }[];
    const first = earlier.findIndex((entry) => {
      const prior = JSON.parse(entry.target);
      const priorRef = this.resolveTarget(prior);
      return neoWorkerKey(priorRef) === neoWorkerKey(ref);
    });
    const head = first < 0 || earlier[first].id === payload.inputId;
    const outcome = row.outcome
      ? (JSON.parse(row.outcome) as ReturnType<typeof readDriverOutcome>)
      : null;
    const initialOutcome =
      payload.initial && ref
        ? (new WorkDeliveryInputRepository(this.db)
            .list(row.todoId!)
            .find(
              (entry) =>
                entry.id !== payload.inputId &&
                entry.observedAt !== null &&
                entry.observedAt >= row.acceptedAt &&
                entry.outcome &&
                'ref' in entry.outcome &&
                neoWorkerKey(entry.outcome.ref) === neoWorkerKey(ref)
            )?.outcome ?? null)
        : null;
    const failure = outcome && 'failure' in outcome ? outcome.failure : null;
    return { ...row, failure, payload, ref, closed, head, todo, initialOutcome };
  }

  wait(job: Job, detail: string | null, reported = false, delayMs = 60_000): void {
    const waiting = new JobQueueRepository(this.db).requeueWaiting(
      job.id,
      Date.now() + delayMs,
      job.claimToken!
    );
    if (waiting)
      this.db
        .prepare(`UPDATE job_queue SET error = COALESCE(?, error), payload = CASE WHEN ?
          THEN json_set(payload, '$.waitReported', json('true')) ELSE payload END WHERE id = ?`)
        .run(detail, reported ? 1 : 0, job.id);
  }

  dispatch(job: Job): boolean {
    const current = this.read(job);
    if (!current.head || current.closed || !current.ref) return false;
    const changed = this.db
      .prepare(`UPDATE job_queue SET payload = json_set(payload, '$.dispatched', json('true'))
      WHERE id = ? AND status = 'processing' AND json_extract(payload, '$.__claimToken') = ?
        AND COALESCE(json_extract(payload, '$.dispatched'), 0) = 0`)
      .run(job.id, job.claimToken).changes;
    if (!changed) return false;
    this.db
      .prepare('UPDATE work_delivery_inputs SET deadline_at = ? WHERE id = ? AND outcome IS NULL')
      .run(Date.now() + 30_000, job.payload.inputId as string);
    return true;
  }

  recordFailure(
    job: Job,
    outcome: Extract<ReturnType<typeof readDriverOutcome>, { failure: string }> & { notSent?: true }
  ): boolean {
    const current = new JobQueueRepository(this.db).getJob(job.id);
    if (current?.status !== 'processing' || current.claimToken !== job.claimToken) return false;
    if (!this.read(job).outcome)
      recordWorkDeliveryOutcome.run(
        this.db,
        { id: job.payload.inputId as string, outcome, now: Date.now() },
        new ChangeRecorder()
      );
    return true;
  }

  retireDead(job: Job): void {
    const current = new JobQueueRepository(this.db).getJob(job.id);
    if (current?.status !== 'dead') return;
    if (!this.read(current).outcome) {
      const detail = `Worker input delivery failed after infrastructure retries: ${current.error}`;
      recordWorkDeliveryOutcome.run(
        this.db,
        {
          id: current.payload.inputId as string,
          outcome: {
            failure:
              current.payload.dispatched || current.payload.initial
                ? `This input may not have reached the worker. ${detail}`
                : detail,
            ...(!current.payload.dispatched && !current.payload.initial
              ? { notSent: true as const }
              : {}),
          },
          now: Date.now(),
        },
        new ChangeRecorder()
      );
    }
    this.db
      .prepare(`UPDATE job_queue SET status = 'pending', retry_count = 0, run_at = ?,
      started_at = NULL, heartbeat_at = NULL, completed_at = NULL WHERE id = ? AND status = 'dead'`)
      .run(Date.now(), job.id);
  }

  settle(job: Job, outcome: ReturnType<typeof readDriverOutcome>, sent?: DriverSent | null): void {
    const jobs = new JobQueueRepository(this.db);
    if (!jobs.complete(job.id, {}, job.claimToken!)) return;
    if (!this.read(job).outcome)
      recordWorkDeliveryOutcome.run(
        this.db,
        { id: job.payload.inputId as string, outcome, now: Date.now() },
        new ChangeRecorder()
      );
    if (job.payload.continuation && 'ref' in outcome && !outcome.delivery?.unconfirmed) {
      new NeoTodoSessionRepository(this.db).completeFollowUp(
        this.read(job).todoId!,
        outcome,
        sent ?? null,
        Date.now()
      );
    }
  }
}

export const workerInputWrites = defineRepositoryOp(
  'work.workerInput.write',
  'write',
  WorkerInputJobs,
  ['accept', 'wait', 'dispatch', 'recordFailure', 'retireDead', 'settle']
);

export const workerInputReads = defineRepositoryOp(
  'work.workerInput.read',
  'read',
  WorkerInputJobs,
  ['read']
);
