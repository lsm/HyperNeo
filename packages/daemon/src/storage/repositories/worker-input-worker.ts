import type { WorkRef } from '../../lib/drivers/types.ts';
import type { OperationCaller } from '../../lib/operations/registry.ts';
import { ChangeRecorder, defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { JobQueueRepository, type Job } from './job-queue-repository.ts';
import {
  acceptWorkDeliveryInput,
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
  dispatched?: boolean;
};

export class WorkerInputJobs {
  constructor(private readonly db: Database) {}

  accept(input: WorkerInput, from: string, caller: OperationCaller): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    acceptWorkDeliveryInput.run(
      this.db,
      {
        id,
        todoId: input.todoId ?? null,
        originSessionId: from,
        target: input.ref
          ? { verb: 'send', ref: input.ref }
          : { verb: 'todo', todoId: input.todoId! },
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
        sessionId: neoWorkerKey(input.ref) ?? `todo:${input.todoId}`,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.continuation ? { continuation: true } : {}),
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
        'SELECT message, target, todo_id AS todoId, outcome FROM work_delivery_inputs WHERE id = ?'
      )
      .get(payload.inputId) as {
      message: string;
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
    const failure = outcome && 'failure' in outcome ? outcome.failure : null;
    return { ...row, failure, payload, ref, closed, head, todo };
  }

  wait(job: Job, detail: string): void {
    const waiting = new JobQueueRepository(this.db).requeueWaiting(
      job.id,
      Date.now() + 1000,
      job.claimToken!
    );
    if (waiting) this.db.prepare('UPDATE job_queue SET error = ? WHERE id = ?').run(detail, job.id);
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
    outcome: Extract<ReturnType<typeof readDriverOutcome>, { failure: string }>
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
  ['accept', 'wait', 'dispatch', 'recordFailure', 'settle']
);

export const workerInputReads = defineRepositoryOp(
  'work.workerInput.read',
  'read',
  WorkerInputJobs,
  ['read']
);
