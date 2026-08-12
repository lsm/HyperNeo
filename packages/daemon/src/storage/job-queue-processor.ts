import type { Job, JobQueueRepository, PayloadMatch } from './repositories/job-queue-repository';
import type { TableChangeScope } from './reactive-database';

export type JobHandler = (job: Job) => Promise<Record<string, unknown> | void>;

/** Derive a reactive change scope from a job's payload, when it carries one. */
function scopeFromJob(job: Job): TableChangeScope | undefined {
  const sessionId = typeof job.payload?.sessionId === 'string' ? job.payload.sessionId : undefined;
  const taskId = typeof job.payload?.taskId === 'string' ? job.payload.taskId : undefined;
  if (!sessionId && !taskId) return undefined;
  return { ...(sessionId ? { sessionId } : {}), ...(taskId ? { taskId } : {}) };
}

export interface JobQueueProcessorOptions {
  pollIntervalMs?: number;
  maxConcurrent?: number;
  staleThresholdMs?: number;
}

/**
 * Per-lane options for {@link JobQueueProcessor.register}.
 */
export interface RegisterOptions {
  /**
   * Jobs whose payload matches this predicate are claimed in a separate
   * "exempt" dequeue pass that is NOT subject to `maxConcurrent` — they run as
   * soon as claimed, even when every capped slot is held by a long-running job.
   *
   * `message_delivery` registers its steers here (`{ path: '$.role', equals:
   * 'steer' }`): a steer is short and must reach the live turn BEFORE that turn
   * ends, so it cannot wait behind a full pool of turns (at `maxConcurrent=1` or
   * once the default five slots are all driving turns, a queued steer would
   * otherwise sit until a turn ends and then be promoted to a later turn instead
   * of interleaving). Exempt jobs count against a separate budget so they can't
   * starve capped jobs either. See message-delivery-v2.md + Codex (#2587).
   */
  exemptJobs?: PayloadMatch;
  /**
   * Invoked when a job in this lane exhausts its retry budget and goes `dead`.
   * `message_delivery` uses this to terminalize the persisted message as
   * `failed` + publish the status change — otherwise the row stays `enqueued`,
   * which pagination hides, so the user's prompt vanishes without a terminal
   * error. Hook errors are swallowed so a dead-letter side-effect can never
   * break the processor. See message-delivery-v2.md + Codex (#2595).
   */
  onDead?: (job: Job) => void;
}

interface Registration {
  handler: JobHandler;
  exemptJobs?: PayloadMatch;
  onDead?: (job: Job) => void;
}

export class JobQueueProcessor {
  private handlers = new Map<string, Registration>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  // Capped jobs count toward `maxConcurrent` (turns, and all non-exempt lanes).
  private inFlightCapped = 0;
  // Exempt jobs (message_delivery steers) run on a separate budget so they can't
  // be starved by — nor starve — capped jobs. Both count toward `stop()` drain.
  private inFlightExempt = 0;
  private running = false;
  private changeNotifier: ((table: string, scope?: TableChangeScope) => void) | null = null;
  private readonly pollIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly staleThresholdMs: number;
  private lastStaleCheck = 0;
  private static readonly STALE_CHECK_INTERVAL = 60_000;

  constructor(
    private repo: JobQueueRepository,
    options?: JobQueueProcessorOptions
  ) {
    this.pollIntervalMs = options?.pollIntervalMs ?? 1000;
    this.maxConcurrent = options?.maxConcurrent ?? 1;
    this.staleThresholdMs = options?.staleThresholdMs ?? 5 * 60 * 1000;
  }

  register(queue: string, handler: JobHandler, options?: RegisterOptions): void {
    this.handlers.set(queue, {
      handler,
      exemptJobs: options?.exemptJobs,
      onDead: options?.onDead,
    });
  }

  start(): void {
    this.running = true;
    // Eagerly reclaim stale jobs from a previous crash before the first poll tick,
    // so crash-recovery is instant rather than delayed by up to STALE_CHECK_INTERVAL.
    this.repo.reclaimStale(Date.now() - this.staleThresholdMs);
    this.lastStaleCheck = Date.now();
    this.pollTimer = setInterval(() => {
      this.tick();
    }, this.pollIntervalMs);
    this.tick();
  }

  /** Stop claiming new work without waiting for in-flight handlers to drain. */
  stopPolling(): void {
    this.running = false;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  stop(): Promise<void> {
    this.stopPolling();
    return new Promise<void>((resolve) => {
      if (this.inFlightCapped === 0 && this.inFlightExempt === 0) {
        resolve();
        return;
      }
      const check = setInterval(() => {
        if (this.inFlightCapped === 0 && this.inFlightExempt === 0) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });
  }

  async tick(): Promise<number> {
    this.checkStaleJobs();

    let claimed = 0;

    // Capped pass: subject to maxConcurrent. For lanes with an exempt spec,
    // exclude exempt jobs (steers) so they're left for the exempt pass below and
    // don't consume a turn slot.
    let cappedSlots = this.maxConcurrent - this.inFlightCapped;
    if (cappedSlots > 0) {
      for (const [queue, reg] of this.handlers) {
        if (cappedSlots <= 0) break;
        const jobs = this.repo.dequeue(queue, cappedSlots, reg.exemptJobs);
        for (const job of jobs) {
          void this.processJob(job, false);
        }
        claimed += jobs.length;
        cappedSlots -= jobs.length;
      }
    }

    // Exempt pass: NOT subject to maxConcurrent. Runs even when capped slots are
    // full, so urgent jobs (steers) reach their target before it ends. Bounded
    // by a separate budget (also maxConcurrent) so exempt jobs can't starve the
    // capped pass either.
    let exemptSlots = this.maxConcurrent - this.inFlightExempt;
    if (exemptSlots > 0) {
      for (const [queue, reg] of this.handlers) {
        if (exemptSlots <= 0) break;
        if (!reg.exemptJobs) continue;
        const jobs = this.repo.dequeueExempt(queue, reg.exemptJobs, exemptSlots);
        for (const job of jobs) {
          void this.processJob(job, true);
        }
        claimed += jobs.length;
        exemptSlots -= jobs.length;
      }
    }

    return claimed;
  }

  private async processJob(job: Job, exempt: boolean): Promise<void> {
    if (exempt) this.inFlightExempt++;
    else this.inFlightCapped++;
    const reg = this.handlers.get(job.queue);
    const scope = scopeFromJob(job);
    try {
      if (!reg) {
        this.repo.fail(job.id, `No handler registered for queue: ${job.queue}`);
        this.notifyChange(scope);
        return;
      }
      const result = await reg.handler(job);
      // message_delivery parks/promotes by requeueing the job itself; the
      // auto-complete here is then a no-op (row no longer 'processing').
      this.repo.complete(job.id, result ?? undefined, job.claimToken);
      this.notifyChange(scope);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const updated = this.repo.fail(job.id, message, job.claimToken);
      if (updated && updated.status === 'dead' && reg?.onDead) {
        try {
          reg.onDead(updated);
        } catch {
          // A dead-letter side-effect must never break the processor loop.
        }
      }
      this.notifyChange(scope);
    } finally {
      if (exempt) this.inFlightExempt--;
      else this.inFlightCapped--;
    }
  }

  setChangeNotifier(notifier: (table: string, scope?: TableChangeScope) => void): void {
    this.changeNotifier = notifier;
  }

  private notifyChange(scope?: TableChangeScope): void {
    if (this.changeNotifier) {
      this.changeNotifier('job_queue', scope);
    }
  }

  private checkStaleJobs(): void {
    const now = Date.now();
    if (now - this.lastStaleCheck < JobQueueProcessor.STALE_CHECK_INTERVAL) return;
    this.repo.reclaimStale(now - this.staleThresholdMs);
    this.lastStaleCheck = now;
  }
}
