import { createHash } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { canonicalJson } from '../../lib/agent/prompt-comparison.ts';
import { parseAddress } from '../../lib/mailbox/address.ts';
import { enqueueMailboxEntry } from '../../lib/mailbox/enqueue.ts';
import { createMailboxEntry } from '../../lib/mailbox/entry.ts';
import type { Result, WorkWithdrawal } from '../../lib/drivers/types.ts';
import { reject } from '../../lib/drivers/work-operations.ts';
import { withBusyRetry } from '../busy-retry.ts';
import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { ClaudeDesktopBridgeRepository } from './claude-desktop-bridge-repository.ts';
import { JobQueueRepository, type Job } from './job-queue-repository.ts';

type Exchange = Parameters<ClaudeDesktopBridgeRepository['persist']>[0];
type Input = { kind: 'stop'; turnId: string } | { kind: 'submit'; text: string };
const InputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stop'), turnId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('submit'), text: z.string().refine((s) => !!s.trim()) }).strict(),
]);
const queue = (sessionId: string, kind: Input['kind']) =>
  `claude_desktop_mods:${sessionId}:${kind}`;
const WITHDRAWN = 'withdrawn-before-submit';
function validateInput(sessionId: string, from: string, input: Input) {
  return {
    sessionId: z.string().uuid().parse(sessionId),
    from: z.string().min(1).parse(from),
    ...InputSchema.parse(input),
  };
}
function enqueueInput(
  input: ReturnType<typeof validateInput>,
  repository: ClaudeDesktopOutboxRepository
) {
  return repository.jobs.enqueue({
    queue: queue(input.sessionId, input.kind),
    payload: input,
    maxRetries: 0,
  });
}
const enqueueCommand = (superpipe({})('enqueue-claude-desktop-outbox') as PipelineAPI)
  .input(['sessionId', 'from', 'input', 'repository'])
  .pipe(validateInput, ['sessionId', 'from', 'input'], 'command')
  .pipe(enqueueInput, ['command', 'repository'], 'job')
  .end('job') as (
  sessionId: string,
  from: string,
  input: Input,
  repository: ClaudeDesktopOutboxRepository
) => Job;
function ownedInput(
  sessionId: string,
  from: string,
  id: string,
  repository: ClaudeDesktopOutboxRepository
) {
  const job = repository.get(sessionId, from, id);
  return job?.payload.kind === 'submit'
    ? { value: job }
    : {
        reason: reject(
          'unsupported',
          'Only this sender’s HyperNeo outbox inputs can be withdrawn; native Desktop queue cancellation is unsupported.'
        ),
      };
}
function withdrawInput(
  job: Job,
  repository: ClaudeDesktopOutboxRepository
): Result<WorkWithdrawal> {
  const withdrawn =
    job.payload.instanceId === undefined &&
    ((job.status === 'dead' && job.error === WITHDRAWN) ||
      !!repository.jobs.markDeadIfActive(job.id, WITHDRAWN, ['pending']));
  return {
    ok: true,
    value: {
      queuedSubmissionId: job.id,
      withdrawn,
      ...(withdrawn ? {} : { reason: 'not_queued' as const }),
    },
  };
}
const withdrawCommand = (superpipe({})('withdraw-claude-desktop-outbox') as PipelineAPI)
  .input(['sessionId', 'from', 'id', 'repository'])
  .pipe(ownedInput, ['sessionId', 'from', 'id', 'repository'], 'result:outcome')
  .pipe(withdrawInput, ['outcome', 'repository'], 'outcome')
  .end('outcome') as (
  sessionId: string,
  from: string,
  id: string,
  repository: ClaudeDesktopOutboxRepository
) => Result<WorkWithdrawal>;
function persistFacts(
  exchange: Exchange,
  ownerPid: number,
  repository: ClaudeDesktopOutboxRepository
) {
  const previous = repository.journal.active(exchange.sessionId);
  const after = previous?.instanceId === exchange.instanceId ? previous.sequence : 0;
  const { ack } = repository.journal.persist(exchange, ownerPid);
  repository.applyFacts(exchange, after, ownerPid);
  return ack;
}
function selectCommand(
  exchange: Exchange,
  ownerPid: number,
  observedIdle: boolean,
  repository: ClaudeDesktopOutboxRepository
) {
  return repository.next(exchange, ownerPid, observedIdle);
}
const exchangeCommands = (superpipe({})('exchange-claude-desktop-outbox') as PipelineAPI)
  .input(['exchange', 'ownerPid', 'observedIdle', 'repository'])
  .pipe(persistFacts, ['exchange', 'ownerPid', 'repository'], 'ack')
  .pipe(selectCommand, ['exchange', 'ownerPid', 'observedIdle', 'repository'], 'command')
  .pipe(
    (ack: number, command: ReturnType<typeof selectCommand>) => ({
      ack,
      ...(command ? { command } : {}),
    }),
    ['ack', 'command'],
    'reply'
  )
  .end('reply') as (
  exchange: Exchange,
  ownerPid: number,
  observedIdle: boolean,
  repository: ClaudeDesktopOutboxRepository
) => { ack: number; command?: ReturnType<typeof selectCommand> };

export class ClaudeDesktopOutboxRepository {
  readonly jobs: JobQueueRepository;
  readonly journal: ClaudeDesktopBridgeRepository;
  constructor(private readonly db: Database) {
    this.jobs = new JobQueueRepository(db);
    this.journal = new ClaudeDesktopBridgeRepository(db);
  }
  enqueue(sessionId: string, from: string, input: Input): Job {
    return enqueueCommand(sessionId, from, input, this);
  }
  enqueueReported(sessionId: string, from: string, input: Input): Job {
    return this.immediate(() => {
      const job = this.enqueue(sessionId, from, input);
      this.report(sessionId);
      return job;
    });
  }
  withdrawReported(sessionId: string, from: string, id: string): Result<WorkWithdrawal> {
    return this.immediate(() => {
      const result = this.withdraw(sessionId, from, id);
      this.report(sessionId);
      return result;
    });
  }
  report(sessionId: string): void {
    this.reportChanges(sessionId, (job, fact) => {
      const to = parseAddress(String(job.payload.from));
      if (to?.kind !== 'session') throw new Error('Desktop mods report has no session destination');
      const outcome = enqueueMailboxEntry(
        this.jobs,
        createMailboxEntry({
          to,
          origin: `driver:claude-desktop:${sessionId}`,
          messageUuid: createHash('sha256')
            .update(`${job.id}:${JSON.stringify(fact)}`)
            .digest('hex'),
          message: {
            type: 'user',
            inputKind: 'system',
            parent_tool_use_id: null,
            message: {
              role: 'user',
              content: `Claude Desktop peer transport fact (API receipt is not proof of execution): ${JSON.stringify(fact)}`,
            },
          },
        })
      );
      if (outcome.kind === 'rejected') throw new Error(outcome.reason);
    });
  }
  write<K extends ClaudeDesktopOutboxWrite>(
    method: K,
    ...args: Parameters<ClaudeDesktopOutboxRepository[K]>
  ): Promise<ReturnType<ClaudeDesktopOutboxRepository[K]>> {
    return gatewayFor(this.db).run(claudeDesktopOutboxWrites, { method, args }) as Promise<
      ReturnType<ClaudeDesktopOutboxRepository[K]>
    >;
  }
  private immediate<T>(effect: () => T): T {
    return withBusyRetry(() => this.db.transaction(effect, 'immediate')());
  }
  withdraw(sessionId: string, from: string, id: string): Result<WorkWithdrawal> {
    return withBusyRetry(() =>
      this.db.transaction(() => withdrawCommand(sessionId, from, id, this), 'immediate')()
    );
  }
  exchange(exchange: Exchange, ownerPid: number, observedIdle = false) {
    return withBusyRetry(() =>
      this.db.transaction(
        () => exchangeCommands(exchange, ownerPid, observedIdle, this),
        'immediate'
      )()
    );
  }
  get(sessionId: string, from: string, id: string): Job | null {
    const job = this.jobs.getJob(id);
    return job &&
      job.payload.sessionId === sessionId &&
      job.payload.from === from &&
      (job.queue === queue(sessionId, 'stop') || job.queue === queue(sessionId, 'submit'))
      ? job
      : null;
  }
  reportChanges(sessionId: string, publish: (job: Job, fact: Record<string, unknown>) => void) {
    return withBusyRetry(() =>
      this.db.transaction(() => {
        const active = this.journal.active(sessionId);
        for (const kind of ['stop', 'submit'] as const) {
          let after: { createdAt: number; id: string } | undefined;
          for (;;) {
            const batch = this.jobs.listJobs({
              queue: queue(sessionId, kind),
              oldestFirst: true,
              after,
            });
            if (!batch.length) break;
            for (const job of batch) {
              if (job.payload.reportFinal) continue;
              const completedTurn =
                kind === 'stop' && typeof job.payload.instanceId === 'string'
                  ? this.journal
                      .events(sessionId, job.payload.instanceId)
                      .find(
                        (event) =>
                          event.kind === 'turn.complete' && event.turnId === job.payload.turnId
                      )
                  : undefined;
              const fact = {
                commandId: job.id,
                operation: kind,
                status: job.status,
                error: job.error,
                apiReceipt: job.result,
                sessionObservation: active?.state ?? null,
                ownerChanged:
                  typeof job.payload.instanceId === 'string' &&
                  job.payload.instanceId !== active?.instanceId,
                ...(completedTurn ? { completedTurn } : {}),
              };
              const state = canonicalJson(fact);
              if (job.payload.reportState === state) continue;
              publish(job, fact);
              const final =
                job.status === 'dead' ||
                (job.status === 'completed' &&
                  (kind === 'submit' || !!completedTurn || fact.ownerChanged));
              this.db
                .prepare(
                  "UPDATE job_queue SET payload = json_set(payload, '$.reportState', ?, '$.reportFinal', ?) WHERE id = ?"
                )
                .run(state, final ? 1 : 0, job.id);
            }
            const last = batch.at(-1)!;
            after = { createdAt: last.createdAt, id: last.id };
          }
        }
      }, 'immediate')()
    );
  }
  applyFacts(exchange: Exchange, after: number, ownerPid: number): void {
    for (const kind of ['stop', 'submit'] as const) {
      for (const job of this.jobs.listActiveByPayload(queue(exchange.sessionId, kind), {
        sessionId: exchange.sessionId,
      })) {
        if (
          (job.status === 'processing' &&
            (job.payload.instanceId !== exchange.instanceId ||
              job.payload.ownerPid !== ownerPid)) ||
          (job.status === 'pending' && job.payload.instanceId !== undefined)
        )
          this.jobs.markDeadIfActive(job.id, 'unknown-previous-dispatch; not replayed');
      }
    }
    for (const event of exchange.events.filter((entry) => entry.sequence > after)) {
      if (
        !event.commandId ||
        (event.kind !== 'command.resolved' && event.kind !== 'command.rejected')
      )
        continue;
      const job = this.jobs.getJob(event.commandId);
      if (
        !job ||
        job.status !== 'processing' ||
        job.payload.sessionId !== exchange.sessionId ||
        job.payload.instanceId !== exchange.instanceId ||
        job.payload.ownerPid !== ownerPid ||
        !['stop', 'submit'].includes(String(job.payload.kind)) ||
        job.queue !== queue(exchange.sessionId, job.payload.kind as Input['kind'])
      )
        continue;
      const drop =
        event.result !== null && typeof event.result === 'object' && 'drop' in event.result;
      if (event.kind === 'command.rejected' || drop)
        this.jobs.markDead(
          job.id,
          event.reason ??
            (drop
              ? `Desktop prompt dropped: ${String((event.result as { drop: unknown }).drop)}`
              : 'Desktop rejected the submitted prompt'),
          job.claimToken
        );
      else this.jobs.complete(job.id, { event }, job.claimToken);
    }
  }
  next(exchange: Exchange, ownerPid: number, observedIdle: boolean) {
    const state = this.journal.active(exchange.sessionId)!;
    if (state.state.phase === 'ended') return undefined;
    const control = this.take(exchange.sessionId, exchange.instanceId, ownerPid, 'stop');
    if (control) return control;
    const processing = this.jobs.listActiveByPayload(
      queue(exchange.sessionId, 'submit'),
      { instanceId: exchange.instanceId },
      ['processing']
    )[0];
    if (
      !processing &&
      state.state.phase !== 'idle' &&
      !(state.state.phase === 'unknown' && observedIdle)
    )
      return undefined;
    return this.take(exchange.sessionId, exchange.instanceId, ownerPid, 'submit');
  }
  private take(sessionId: string, instanceId: string, ownerPid: number, kind: Input['kind']) {
    const job =
      this.jobs.listActiveByPayload(queue(sessionId, kind), { instanceId }, ['processing'])[0] ??
      this.jobs.dequeueSessionFifo(queue(sessionId, kind), 1)[0];
    if (!job) return undefined;
    const bound = this.db
      .prepare(
        "UPDATE job_queue SET payload = json_set(payload, '$.instanceId', ?, '$.ownerPid', ?) WHERE id = ? AND status = 'processing' AND json_extract(payload, '$.__claimToken') = ?"
      )
      .run(instanceId, ownerPid, job.id, job.claimToken);
    if (bound.changes !== 1 || !this.jobs.heartbeat(job.id, job.claimToken))
      throw new Error('Desktop outbox claim changed before dispatch');
    const base = { id: job.id, instanceId };
    return kind === 'stop'
      ? { ...base, kind, turnId: job.payload.turnId as string }
      : { ...base, kind, from: job.payload.from as string, text: job.payload.text as string };
  }
}

type ClaudeDesktopOutboxWrite = 'enqueueReported' | 'withdrawReported' | 'report' | 'exchange';

export const claudeDesktopOutboxWrites = defineRepositoryOp(
  'claudeDesktop.outbox.write',
  'write',
  ClaudeDesktopOutboxRepository,
  ['enqueueReported', 'withdrawReported', 'report', 'exchange']
);
