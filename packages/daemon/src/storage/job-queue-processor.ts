import {
  emitMessageDeliveryLifecycleEvent,
  fingerprintDeliveryClaim,
  type MessageDeliveryLifecycleFields,
} from '../lib/agent/message-delivery-metrics';
import type { TableChangeScope } from './reactive-database';
import type {
  Job,
  JobQueueRepository,
  PayloadMatch,
  ReclaimedJobClaim,
} from './repositories/job-queue-repository';

export interface JobHandlerStageDetails {
  generation?: number;
  outcome?: string;
  reason?: string;
  responseType?: string;
}

export interface JobHandlerContext {
  signal: AbortSignal;
  reportStage?: (stage: string, details?: JobHandlerStageDetails) => void;
}

export interface InFlightJobSnapshot {
  jobId: string;
  queue: string;
  claimFingerprint: string | null;
  slotClass: 'capped' | 'exempt';
  sessionId?: string;
  messageUuid?: string;
  role?: string;
  generation?: number;
  stage: string;
  ageMs: number;
  stageAgeMs: number;
  aborted: boolean;
}

export interface JobQueueProcessorSnapshot {
  running: boolean;
  maxConcurrent: number;
  inFlightCapped: number;
  inFlightExempt: number;
  inFlightTotal: number;
  activeControllers: number;
  oldestInFlightAgeMs: number | null;
  stageCounts: Record<string, number>;
  handlers: InFlightJobSnapshot[];
}

interface InFlightClaimRecord {
  job: Job;
  controller: AbortController;
  claimFingerprint: string | null;
  slotClass: 'capped' | 'exempt';
  startedAt: number;
  stage: string;
  stageChangedAt: number;
  generation?: number;
  lastLeaseLogAt: number;
  settlement?: string;
  /**
   * Set when the settling-grace expiry evicted this (wedged, non-settling)
   * reclaimed handler's slot so its replacement could claim capacity. The
   * handler's own finally then skips the second decrement. (Codex P2.)
   */
  slotEvicted?: boolean;
}

export type JobHandler = (
  job: Job,
  context?: JobHandlerContext
) => Promise<Record<string, unknown> | void>;

/**
 * Throw from a handler to force a job straight to `dead` (bypassing the retry
 * budget) while still firing the lane's `onDead` hook. Used by the
 * `message_delivery` lane for a turn that ended in a NON-recoverable error
 * (auth/permission/quota): retrying won't help, so the job dead-letters
 * immediately and `onDead` terminalizes the persisted message as `failed` (with
 * a Retry affordance) instead of burning all `maxRetries` attempts first. The
 * generic processor treats this as terminal without knowing anything about the
 * delivery domain. See docs/features/message-delivery-v2.md.
 */
export class DeadLetterImmediatelyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadLetterImmediatelyError';
  }
}

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
  /**
   * Grace for a stale-reclaimed handler to settle after its abort before its
   * replacement claim may proceed. Default {@link SETTLEMENT_GRACE_MS}. Lanes
   * whose abort path awaits a bounded-but-slow settlement — message_delivery
   * waits out the queue's 30s provider-owned acknowledgment when the admission
   * can no longer be revoked — must set this BEYOND that bound so an expired
   * deferral can never let a replacement claim overlap the still-settling
   * attempt's handoff. Still bounded, so a wedged non-cancellable handler
   * cannot suppress its replacement until restart. (Codex P1, PR #2499.)
   */
  settlementGraceMs?: number;
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

/** Default grace for a stale-reclaimed handler to settle after its abort
 * before its replacement claim may proceed. Aborting handlers settle within
 * microtasks; the bound exists for wedged handlers that never observe the
 * signal. See {@link JobQueueProcessorOptions.settlementGraceMs} for lanes
 * needing a longer, still-bounded window. */
const SETTLEMENT_GRACE_MS = 10_000;

export class JobQueueProcessor {
  private handlers = new Map<string, Registration>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  // Capped jobs count toward `maxConcurrent` (turns, and all non-exempt lanes).
  private inFlightCapped = 0;
  // Exempt jobs (message_delivery steers) run on a separate budget so they can't
  // be starved by — nor starve — capped jobs. Both count toward `stop()` drain.
  private inFlightExempt = 0;
  private running = false;
  private inFlightClaims = new Map<string, Map<string, InFlightClaimRecord>>();
  // Job IDs whose stale-reclaimed predecessor handler was aborted but has not
  // settled yet, mapped to the reclaimed attempt's claim token and the moment
  // the deferral expires. Their rows are already back to `pending`, but
  // claiming them now (spare slots exist under a large budget) would overlap
  // the aborting attempt — the predecessor may have fed the SDK before
  // observing the abort. Cleared from processJob's finally when the settling
  // attempt's claim token matches, so the replacement claim lands once
  // cancellation has settled without a still-wedged earlier attempt (whose own
  // deferral already expired) lifting a newer attempt's deferral. The expiry
  // bounds the wait: a handler that never observes its abort signal would
  // otherwise suppress its replacement forever.
  private settlingReclaimedJobIds = new Map<
    string,
    { claimToken: string | null; expireAt: number }
  >();
  private tickRequested = false;
  private changeNotifier: ((table: string, scope?: TableChangeScope) => void) | null = null;
  private readonly pollIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly staleThresholdMs: number;
  private readonly settlementGraceMs: number;
  private readonly heartbeatIntervalMs: number;
  private lastStaleCheck = 0;
  private static readonly STALE_CHECK_INTERVAL = 60_000;

  constructor(
    private repo: JobQueueRepository,
    options?: JobQueueProcessorOptions
  ) {
    this.pollIntervalMs = options?.pollIntervalMs ?? 1000;
    this.maxConcurrent = options?.maxConcurrent ?? 1;
    this.staleThresholdMs = options?.staleThresholdMs ?? 5 * 60 * 1000;
    this.settlementGraceMs = options?.settlementGraceMs ?? SETTLEMENT_GRACE_MS;
    this.heartbeatIntervalMs = Math.max(10, Math.floor(this.staleThresholdMs / 3));
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
    this.reclaimStaleClaims(Date.now() - this.staleThresholdMs);
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
    // Exclude just-reclaimed jobs whose aborting handler hasn't settled, minus
    // any whose deferral grace expired (a wedged non-cancellable handler would
    // otherwise starve its replacement forever).
    let excludeIds: string[] | undefined;
    if (this.settlingReclaimedJobIds.size > 0) {
      const now = Date.now();
      for (const [jobId, entry] of this.settlingReclaimedJobIds) {
        if (entry.expireAt <= now) {
          // Grace expiry alone does not free capacity: the wedged predecessor
          // still counts toward maxConcurrent, so a saturated processor
          // (e.g. maxConcurrent=1 held by a handler that never observes the
          // abort) could never claim the replacement. Evict its slot too —
          // its much-later finally skips the second decrement via slotEvicted.
          // (Codex P2, PR #2499.)
          this.evictWedgedClaimSlot(jobId, entry.claimToken);
          this.settlingReclaimedJobIds.delete(jobId);
        }
      }
      if (this.settlingReclaimedJobIds.size > 0) {
        excludeIds = [...this.settlingReclaimedJobIds.keys()];
      }
    }

    // Capped pass: subject to maxConcurrent. For lanes with an exempt spec,
    // exclude exempt jobs (steers) so they're left for the exempt pass below and
    // don't consume a turn slot.
    let cappedSlots = this.maxConcurrent - this.inFlightCapped;
    if (cappedSlots > 0) {
      for (const [queue, reg] of this.handlers) {
        if (cappedSlots <= 0) break;
        const jobs = this.repo.dequeue(queue, cappedSlots, reg.exemptJobs, excludeIds);
        for (const job of jobs) {
          this.emitLifecycle('claim', job, 'capped');
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
        const jobs = this.repo.dequeueExempt(queue, reg.exemptJobs, exemptSlots, excludeIds);
        for (const job of jobs) {
          this.emitLifecycle('claim', job, 'exempt');
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
    const controller = new AbortController();
    const record = this.trackInFlightClaim(job, controller, exempt ? 'exempt' : 'capped');
    this.emitLifecycle('slot_acquired', job, record.slotClass, { stage: record.stage });
    const heartbeat = setInterval(() => {
      if (!this.repo.heartbeat(job.id, job.claimToken)) {
        this.emitLifecycle('old_handler_aborted', job, record.slotClass, {
          stage: record.stage,
          reason: 'heartbeat_rejected',
        });
        controller.abort();
        return;
      }
      const now = Date.now();
      if (now - record.lastLeaseLogAt >= 60_000 || record.lastLeaseLogAt === 0) {
        record.lastLeaseLogAt = now;
        this.emitLifecycle('lease_renewed', job, record.slotClass, {
          stage: record.stage,
          elapsedMs: now - record.startedAt,
        });
      }
    }, this.heartbeatIntervalMs);
    if (typeof (heartbeat as { unref?: () => void }).unref === 'function') {
      (heartbeat as { unref: () => void }).unref();
    }
    try {
      if (!reg) {
        this.repo.fail(job.id, `No handler registered for queue: ${job.queue}`);
        record.settlement = 'failed';
        this.notifyChange(scope);
        return;
      }
      const reportStage = (stage: string, details?: JobHandlerStageDetails): void => {
        if (this.getInFlightClaim(job) !== record) return;
        record.stage = stage;
        record.stageChangedAt = Date.now();
        if (details?.generation !== undefined) record.generation = details.generation;
        if (isLifecycleEventName(stage)) {
          this.emitLifecycle(stage, job, record.slotClass, {
            stage,
            generation: record.generation,
            outcome: details?.outcome,
            reason: details?.reason,
            responseType: details?.responseType,
            elapsedMs: Date.now() - record.startedAt,
          });
        }
      };
      const result = await reg.handler(job, { signal: controller.signal, reportStage });
      // message_delivery parks/promotes by requeueing the job itself; the
      // auto-complete here is then a no-op (row no longer 'processing').
      const completed = this.repo.complete(job.id, result ?? undefined, job.claimToken);
      if (completed) {
        record.settlement = 'completed';
        this.emitLifecycle('settled', job, record.slotClass, {
          stage: record.stage,
          outcome: safeHandlerOutcome(result),
        });
      } else {
        record.settlement = classifyNonterminalSettlement(result);
        if (this.repo.isClaimOwnedByAnother(job.id, job.claimToken)) {
          this.emitLifecycle('fenced_completion_rejected', job, record.slotClass, {
            stage: record.stage,
            reason: 'claim_replaced',
          });
        }
      }
      this.notifyChange(scope);
    } catch (err) {
      // A reclaimed predecessor lost ownership; cancellation is not a job
      // failure and must not burn retries or invoke the dead-letter hook.
      if (controller.signal.aborted) {
        record.settlement = 'aborted';
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      // A handler throws `DeadLetterImmediatelyError` to terminalize without
      // burning the retry budget (e.g. a delivery turn that ended in a
      // non-recoverable error). Force `dead` and fire `onDead` just like
      // retry-exhaustion would.
      const updated =
        err instanceof DeadLetterImmediatelyError
          ? this.repo.markDead(job.id, message, job.claimToken)
          : this.repo.fail(job.id, message, job.claimToken);
      record.settlement = updated?.status ?? 'fenced';
      if (updated) {
        this.emitLifecycle('settled', job, record.slotClass, {
          stage: record.stage,
          outcome: updated.status,
        });
      } else if (this.repo.isClaimOwnedByAnother(job.id, job.claimToken)) {
        this.emitLifecycle('fenced_completion_rejected', job, record.slotClass, {
          stage: record.stage,
          reason: 'claim_replaced',
        });
      }
      if (updated && updated.status === 'dead' && reg?.onDead) {
        try {
          reg.onDead(updated);
        } catch {
          // A dead-letter side-effect must never break the processor loop.
        }
      }
      this.notifyChange(scope);
    } finally {
      clearInterval(heartbeat);
      this.untrackInFlightClaim(job, record);
      // The handler settled — any replacement claim for this job (deferred by
      // the settling exclusion after a stale reclaim) may proceed. Match on
      // claim token: this finally may belong to an earlier attempt whose own
      // deferral already expired and was superseded — deleting unconditionally
      // would drop the CURRENT attempt's deferral and let a third claim
      // overlap the still-settling replacement.
      const settlingEntry = this.settlingReclaimedJobIds.get(job.id);
      if (settlingEntry?.claimToken === job.claimToken) {
        this.settlingReclaimedJobIds.delete(job.id);
      }
      if (exempt) {
        if (!record.slotEvicted) this.inFlightExempt--;
      } else {
        if (!record.slotEvicted) this.inFlightCapped--;
      }
      this.emitLifecycle('slot_released', job, record.slotClass, {
        stage: record.stage,
        outcome: record.settlement,
        elapsedMs: Date.now() - record.startedAt,
      });
      this.requestTick();
    }
  }

  private trackInFlightClaim(
    job: Job,
    controller: AbortController,
    slotClass: 'capped' | 'exempt'
  ): InFlightClaimRecord {
    const now = Date.now();
    const record: InFlightClaimRecord = {
      job,
      controller,
      claimFingerprint: fingerprintDeliveryClaim(job.claimToken),
      slotClass,
      startedAt: now,
      stage: 'slot_acquired',
      stageChangedAt: now,
      lastLeaseLogAt: 0,
    };
    if (!job.claimToken) return record;
    let claims = this.inFlightClaims.get(job.id);
    if (!claims) {
      claims = new Map();
      this.inFlightClaims.set(job.id, claims);
    }
    claims.set(job.claimToken, record);
    return record;
  }

  private getInFlightClaim(job: Job): InFlightClaimRecord | undefined {
    if (!job.claimToken) return undefined;
    return this.inFlightClaims.get(job.id)?.get(job.claimToken);
  }

  /**
   * Stop counting a wedged reclaimed handler toward its slot budget once the
   * settlement grace expires (see tick). The record stays tracked for its
   * identity checks — only the capacity accounting is released, once.
   */
  private evictWedgedClaimSlot(jobId: string, claimToken: string | null): void {
    if (!claimToken) return;
    const record = this.inFlightClaims.get(jobId)?.get(claimToken);
    if (!record || record.slotEvicted) return;
    record.slotEvicted = true;
    if (record.slotClass === 'exempt') this.inFlightExempt--;
    else this.inFlightCapped--;
  }

  private untrackInFlightClaim(job: Job, record: InFlightClaimRecord): void {
    if (!job.claimToken) return;
    const claims = this.inFlightClaims.get(job.id);
    if (claims?.get(job.claimToken) !== record) return;
    claims.delete(job.claimToken);
    if (claims.size === 0) this.inFlightClaims.delete(job.id);
  }

  private reclaimStaleClaims(staleBefore: number): void {
    // Scoped to this processor's registered lanes: only the owner of a queue's
    // in-flight claims can abort their handlers, so a processor must not sweep
    // another processor's shared-repository lanes (its reclaim would flip the
    // row to pending while the owner's handler keeps running until its next
    // heartbeat, overlapping a replacement claim).
    for (const claim of this.repo.reclaimStale(staleBefore, [...this.handlers.keys()])) {
      const record = claim.claimToken
        ? this.inFlightClaims.get(claim.jobId)?.get(claim.claimToken)
        : undefined;
      const reclaimedJob = record?.job ?? jobFromReclaimedClaim(claim);
      this.emitLifecycle('stale_reclaimed', reclaimedJob, record?.slotClass, {
        stage: record?.stage,
      });
      if (!record) continue;
      this.emitLifecycle('old_handler_aborted', record.job, record.slotClass, {
        stage: record.stage,
        reason: 'stale_reclaim',
      });
      record.controller.abort();
      // Aborting is asynchronous — the handler settles on a later microtask.
      // Defer this job's replacement claim until then (see tick()'s dequeue
      // exclusion) so the two attempts never overlap, bounded by a grace
      // window for handlers that never observe the abort signal. Keyed to the
      // aborted attempt's claim token so only THAT attempt's settlement lifts
      // the deferral (processJob's finally matches on it).
      this.settlingReclaimedJobIds.set(claim.jobId, {
        claimToken: claim.claimToken,
        expireAt: Date.now() + this.settlementGraceMs,
      });
    }
  }

  snapshot(queue?: string): JobQueueProcessorSnapshot {
    const now = Date.now();
    const handlers: InFlightJobSnapshot[] = [];
    for (const claims of this.inFlightClaims.values()) {
      for (const record of claims.values()) {
        if (queue && record.job.queue !== queue) continue;
        handlers.push({
          jobId: record.job.id,
          queue: record.job.queue,
          claimFingerprint: record.claimFingerprint,
          slotClass: record.slotClass,
          sessionId: stringPayload(record.job, 'sessionId'),
          messageUuid: stringPayload(record.job, 'messageUuid'),
          role: stringPayload(record.job, 'role'),
          generation: record.generation,
          stage: record.stage,
          ageMs: Math.max(0, now - record.startedAt),
          stageAgeMs: Math.max(0, now - record.stageChangedAt),
          aborted: record.controller.signal.aborted,
        });
      }
    }
    const stageCounts: Record<string, number> = {};
    for (const handler of handlers) {
      stageCounts[handler.stage] = (stageCounts[handler.stage] ?? 0) + 1;
    }
    const capped = handlers.filter((handler) => handler.slotClass === 'capped').length;
    const exempt = handlers.length - capped;
    return {
      running: this.running,
      maxConcurrent: this.maxConcurrent,
      inFlightCapped: queue ? capped : this.inFlightCapped,
      inFlightExempt: queue ? exempt : this.inFlightExempt,
      inFlightTotal: handlers.length,
      activeControllers: handlers.length,
      oldestInFlightAgeMs:
        handlers.length > 0 ? Math.max(...handlers.map((handler) => handler.ageMs)) : null,
      stageCounts,
      handlers,
    };
  }

  private emitLifecycle(
    event: Parameters<typeof emitMessageDeliveryLifecycleEvent>[0],
    job: Job,
    slotClass?: 'capped' | 'exempt',
    details: Partial<MessageDeliveryLifecycleFields> = {}
  ): void {
    if (job.queue !== 'message_delivery') return;
    emitMessageDeliveryLifecycleEvent(event, {
      jobId: job.id,
      queue: job.queue,
      claimFingerprint: fingerprintDeliveryClaim(job.claimToken),
      slotClass,
      sessionId: stringPayload(job, 'sessionId'),
      messageUuid: stringPayload(job, 'messageUuid'),
      role: stringPayload(job, 'role'),
      ...details,
    });
  }

  private requestTick(): void {
    if (!this.running || this.tickRequested) return;
    this.tickRequested = true;
    queueMicrotask(() => {
      this.tickRequested = false;
      if (this.running) void this.tick();
    });
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
    this.reclaimStaleClaims(now - this.staleThresholdMs);
    this.lastStaleCheck = now;
  }
}

function jobFromReclaimedClaim(claim: ReclaimedJobClaim): Job {
  return {
    id: claim.jobId,
    queue: claim.queue,
    status: 'pending',
    payload: {
      ...(claim.sessionId ? { sessionId: claim.sessionId } : {}),
      ...(claim.messageUuid ? { messageUuid: claim.messageUuid } : {}),
      ...(claim.role ? { role: claim.role } : {}),
    },
    result: null,
    error: null,
    priority: 0,
    maxRetries: 0,
    retryCount: 0,
    runAt: 0,
    createdAt: 0,
    startedAt: null,
    heartbeatAt: null,
    completedAt: null,
    claimToken: claim.claimToken,
  };
}

function stringPayload(job: Job, key: string): string | undefined {
  return typeof job.payload[key] === 'string' ? job.payload[key] : undefined;
}

function isLifecycleEventName(
  stage: string
): stage is Parameters<typeof emitMessageDeliveryLifecycleEvent>[0] {
  return stage === 'query_ready' || stage === 'sdk_admitted' || stage === 'first_sdk_response';
}

function safeHandlerOutcome(result: Record<string, unknown> | void): string {
  if (!result) return 'completed';
  if (typeof result.outcome === 'string') return result.outcome;
  if (typeof result.parked === 'string') return 'parked';
  return 'completed';
}

function classifyNonterminalSettlement(result: Record<string, unknown> | void): string {
  if (!result) return 'not_completed';
  if (typeof result.parked === 'string') return 'parked';
  if (result.promoted !== undefined) return 'promoted';
  if (result.outcome === 'superseded') return 'superseded';
  return 'not_completed';
}
