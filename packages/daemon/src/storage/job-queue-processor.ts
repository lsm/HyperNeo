import {
  emitMessageDeliveryLifecycleEvent,
  fingerprintDeliveryClaim,
  type MessageDeliveryLifecycleFields,
} from '../lib/agent/message-delivery-metrics.ts';
import { Logger } from '../lib/logger.ts';
import type { TableChangeScope } from './reactive-database.ts';
import type {
  Job,
  JobQueueRepository,
  PayloadMatch,
  ReclaimedJobClaim,
} from './repositories/job-queue-repository.ts';

const log = new Logger('job-queue-processor');

function describeStorageError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const suffix = typeof code === 'string' ? ` (${code})` : '';
    return `${error.name}: ${error.message}${suffix}`;
  }
  return String(error);
}

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
  slotEvicted?: boolean;
}

export type JobHandler = (
  job: Job,
  context?: JobHandlerContext
) => Promise<Record<string, unknown> | void>;

export class DeadLetterImmediatelyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadLetterImmediatelyError';
  }
}

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
  jitterRandom?: () => number;
  settlementGraceMs?: number;
}

export interface SessionFifoDequeueMode {
  kind: 'session-fifo';
  sessionIdPath?: string;
  releasedPath?: string;
}

export interface RegisterOptions {
  exemptJobs?: PayloadMatch;
  onDead?: (job: Job) => void;
  dequeueMode?: SessionFifoDequeueMode;
}

interface Registration {
  handler: JobHandler;
  exemptJobs?: PayloadMatch;
  onDead?: (job: Job) => void;
  dequeueMode?: SessionFifoDequeueMode;
}

const SETTLEMENT_GRACE_MS = 10_000;

const STALE_RECLAIM_JITTER_STEP_MS = 2_000;

const STALE_RECLAIM_JITTER_MAX_MS = 30_000;

export function staleReclaimJitterDelays(count: number, random: () => number): number[] {
  if (count <= 1) return Array.from({ length: count }, () => 0);
  const windowMs = Math.min(count * STALE_RECLAIM_JITTER_STEP_MS, STALE_RECLAIM_JITTER_MAX_MS);
  const slotWidth = windowMs / count;
  const draw = (): number => {
    const value = random();
    return Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999_999_999_999) : 0;
  };
  const slots = Array.from({ length: count }, (_slot, i) => i);
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(draw() * (i + 1)));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  return slots.map((slot) => slot * slotWidth + draw() * slotWidth);
}

export function applyStaleReclaimJitter(
  repo: Pick<JobQueueRepository, 'reschedulePending'>,
  jobIds: string[],
  random: () => number,
  onRescheduleError?: (jobId: string, error: unknown) => void
): number {
  if (jobIds.length === 0) return 0;
  const delays = staleReclaimJitterDelays(jobIds.length, random);
  const jitteredAt = Date.now();
  let applied = 0;
  for (let i = 0; i < jobIds.length; i++) {
    try {
      if (repo.reschedulePending(jobIds[i], jitteredAt + delays[i])) applied++;
    } catch (error) {
      try {
        onRescheduleError?.(jobIds[i], error);
      } catch {}
    }
  }
  return applied;
}

export class JobQueueProcessor {
  private handlers = new Map<string, Registration>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private inFlightCapped = 0;
  private inFlightExempt = 0;
  private activeHandlers = 0;
  private running = false;
  private inFlightClaims = new Map<string, Map<string, InFlightClaimRecord>>();
  private settlingReclaimedJobIds = new Map<
    string,
    { claimToken: string | null; expireAt: number }
  >();
  private tickRequested = false;
  private changeNotifier: ((table: string, scope?: TableChangeScope) => void) | null = null;
  private readonly pollIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly staleThresholdMs: number;
  private readonly jitterRandom: () => number;
  private readonly settlementGraceMs: number;
  private readonly heartbeatIntervalMs: number;
  private lastStaleCheck = 0;
  private consecutivePollErrors = 0;
  private lastPollErrorLogAt = 0;
  private static readonly STALE_CHECK_INTERVAL = 60_000;
  private static readonly POLL_ERROR_LOG_INTERVAL_MS = 60_000;

  constructor(
    private repo: JobQueueRepository,
    options?: JobQueueProcessorOptions
  ) {
    this.pollIntervalMs = options?.pollIntervalMs ?? 1000;
    this.maxConcurrent = options?.maxConcurrent ?? 1;
    this.staleThresholdMs = options?.staleThresholdMs ?? 5 * 60 * 1000;
    this.jitterRandom = options?.jitterRandom ?? Math.random;
    this.settlementGraceMs = options?.settlementGraceMs ?? SETTLEMENT_GRACE_MS;
    this.heartbeatIntervalMs = Math.max(10, Math.floor(this.staleThresholdMs / 3));
  }

  register(queue: string, handler: JobHandler, options?: RegisterOptions): void {
    const dequeueMode = options?.dequeueMode;
    if (
      dequeueMode?.kind === 'session-fifo' &&
      options?.exemptJobs &&
      (dequeueMode.releasedPath !== undefined ||
        (dequeueMode.sessionIdPath !== undefined && dequeueMode.sessionIdPath !== '$.sessionId'))
    ) {
      throw new Error(
        `session-fifo dequeue mode with exemptJobs requires the default sessionId path and no ` +
          `releasedPath, because exempt admission gates on payload.sessionId and ignores the ` +
          `release flag (queue: ${queue})`
      );
    }
    this.handlers.set(queue, {
      handler,
      exemptJobs: options?.exemptJobs,
      onDead: options?.onDead,
      dequeueMode: options?.dequeueMode,
    });
  }

  start(): void {
    this.running = true;
    try {
      this.reclaimStaleClaims(Date.now() - this.staleThresholdMs);
    } catch (error) {
      this.notePollError('start_reclaim', undefined, error);
    }
    this.lastStaleCheck = Date.now();
    this.pollTimer = setInterval(() => {
      this.tick();
    }, this.pollIntervalMs);
    this.tick();
  }

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
      if (this.activeHandlers === 0) {
        resolve();
        return;
      }
      const check = setInterval(() => {
        if (this.activeHandlers === 0) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });
  }

  async tick(): Promise<number> {
    let claimed = 0;
    let errored = false;
    try {
      try {
        this.checkStaleJobs();
      } catch (error) {
        errored = true;
        this.notePollError('stale_check', undefined, error);
      }

      let excludeIds: string[] | undefined;
      if (this.settlingReclaimedJobIds.size > 0) {
        const now = Date.now();
        for (const [jobId, entry] of this.settlingReclaimedJobIds) {
          if (entry.expireAt <= now) {
            this.evictWedgedClaimSlot(jobId, entry.claimToken);
            this.settlingReclaimedJobIds.delete(jobId);
          }
        }
        if (this.settlingReclaimedJobIds.size > 0) {
          excludeIds = [...this.settlingReclaimedJobIds.keys()];
        }
      }

      let cappedSlots = this.maxConcurrent - this.inFlightCapped;
      if (cappedSlots > 0) {
        for (const [queue, reg] of this.handlers) {
          if (cappedSlots <= 0) break;
          let jobs: Job[];
          const dequeueMode = reg.dequeueMode;
          try {
            jobs =
              dequeueMode?.kind === 'session-fifo'
                ? this.repo.dequeueSessionFifo(queue, cappedSlots, {
                    sessionIdPath: dequeueMode.sessionIdPath,
                    releasedPath: dequeueMode.releasedPath,
                    exclude: reg.exemptJobs,
                    excludeIds,
                  })
                : this.repo.dequeue(queue, cappedSlots, reg.exemptJobs, excludeIds);
          } catch (error) {
            errored = true;
            this.notePollError('dequeue', queue, error);
            continue;
          }
          for (const job of jobs) {
            this.emitLifecycle('claim', job, 'capped');
            void this.processJob(job, false);
          }
          claimed += jobs.length;
          cappedSlots -= jobs.length;
        }
      }

      let exemptSlots = this.maxConcurrent - this.inFlightExempt;
      if (exemptSlots > 0) {
        const inFlightExemptSessions = this.collectInFlightExemptSessions();
        for (const [queue, reg] of this.handlers) {
          if (exemptSlots <= 0) break;
          if (!reg.exemptJobs) continue;
          const admittedSessions = new Set<string>(inFlightExemptSessions);
          while (exemptSlots > 0) {
            let jobs: Job[];
            try {
              jobs = this.repo.dequeueExempt(queue, reg.exemptJobs, 1, excludeIds, [
                ...admittedSessions,
              ]);
            } catch (error) {
              errored = true;
              this.notePollError('dequeue_exempt', queue, error);
              break;
            }
            if (jobs.length === 0) break;
            const job = jobs[0];
            this.emitLifecycle('claim', job, 'exempt');
            void this.processJob(job, true);
            claimed++;
            exemptSlots--;
            const sessionId = job.payload.sessionId;
            if (typeof sessionId === 'string') admittedSessions.add(sessionId);
          }
        }
      }
    } catch (error) {
      errored = true;
      this.notePollError('tick', undefined, error);
    }
    if (!errored) this.notePollRecovery();
    return claimed;
  }

  private async processJob(job: Job, exempt: boolean): Promise<void> {
    if (exempt) this.inFlightExempt++;
    else this.inFlightCapped++;
    this.activeHandlers++;
    const reg = this.handlers.get(job.queue);
    const scope = scopeFromJob(job);
    const controller = new AbortController();
    const record = this.trackInFlightClaim(job, controller, exempt ? 'exempt' : 'capped');
    this.emitLifecycle('slot_acquired', job, record.slotClass, { stage: record.stage });
    const heartbeat = setInterval(() => {
      if (controller.signal.aborted) {
        clearInterval(heartbeat);
        return;
      }
      let alive: boolean;
      try {
        alive = this.repo.heartbeat(job.id, job.claimToken);
      } catch (error) {
        this.notePollError('heartbeat', job.queue, error);
        return;
      }
      if (!alive) {
        this.emitLifecycle('old_handler_aborted', job, record.slotClass, {
          stage: record.stage,
          reason: 'heartbeat_rejected',
        });
        controller.abort();
        clearInterval(heartbeat);
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
        if (isLifecycleEventName(stage) && isLifecycleEventName(record.stage)) {
          if (LIFECYCLE_STAGE_ORDER[record.stage] >= LIFECYCLE_STAGE_ORDER[stage]) {
            return;
          }
        }
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
      if (controller.signal.aborted) {
        record.settlement = 'aborted';
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      let updated: Job | null = null;
      try {
        updated =
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
      } catch (settleError) {
        record.settlement = 'settle_failed';
        this.notePollError('settle', job.queue, settleError);
      }
      if (updated && updated.status === 'dead' && reg?.onDead) {
        try {
          reg.onDead(updated);
        } catch {}
      }
      this.notifyChange(scope);
    } finally {
      clearInterval(heartbeat);
      this.untrackInFlightClaim(job, record);
      const settlingEntry = this.settlingReclaimedJobIds.get(job.id);
      if (settlingEntry?.claimToken === job.claimToken) {
        this.settlingReclaimedJobIds.delete(job.id);
      }
      if (exempt) {
        if (!record.slotEvicted) this.inFlightExempt--;
      } else {
        if (!record.slotEvicted) this.inFlightCapped--;
      }
      this.activeHandlers--;
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

  private evictWedgedClaimSlot(jobId: string, claimToken: string | null): void {
    if (!claimToken) return;
    const record = this.inFlightClaims.get(jobId)?.get(claimToken);
    if (!record || record.slotEvicted) return;
    record.slotEvicted = true;
    if (record.slotClass === 'exempt') this.inFlightExempt--;
    else this.inFlightCapped--;
    this.emitLifecycle('slot_released', record.job, record.slotClass, {
      stage: record.stage,
      reason: 'slot_evicted',
      elapsedMs: Date.now() - record.startedAt,
    });
  }

  private untrackInFlightClaim(job: Job, record: InFlightClaimRecord): void {
    if (!job.claimToken) return;
    const claims = this.inFlightClaims.get(job.id);
    if (claims?.get(job.claimToken) !== record) return;
    claims.delete(job.claimToken);
    if (claims.size === 0) this.inFlightClaims.delete(job.id);
  }

  private collectInFlightExemptSessions(): Set<string> {
    const sessions = new Set<string>();
    for (const claims of this.inFlightClaims.values()) {
      for (const record of claims.values()) {
        if (record.slotClass !== 'exempt' || record.slotEvicted) continue;
        const sessionId = record.job.payload.sessionId;
        if (typeof sessionId === 'string') sessions.add(sessionId);
      }
    }
    return sessions;
  }

  private reclaimStaleClaims(staleBefore: number): void {
    const claims = this.repo.reclaimStale(staleBefore, [...this.handlers.keys()]);
    if (claims.length > 0) {
      const claimByJobId = new Map(claims.map((claim) => [claim.jobId, claim] as const));
      applyStaleReclaimJitter(
        this.repo,
        claims.map((claim) => claim.jobId),
        this.jitterRandom,
        (jobId, error) => {
          const claim = claimByJobId.get(jobId);
          if (claim) {
            const cause = error instanceof Error ? error.message : String(error);
            this.emitLifecycle(
              'stale_reclaim_jitter_failed',
              jobFromReclaimedClaim(claim),
              undefined,
              {
                reason: `reschedule_failed: ${cause}`,
              }
            );
          }
        }
      );
    }
    for (const claim of claims) {
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
      this.settlingReclaimedJobIds.set(claim.jobId, {
        claimToken: claim.claimToken,
        expireAt: Date.now() + this.settlementGraceMs,
      });
    }
  }

  snapshot(queue?: string): JobQueueProcessorSnapshot {
    const now = Date.now();
    const handlers: InFlightJobSnapshot[] = [];
    let cappedAdmitted = 0;
    let exemptAdmitted = 0;
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
        if (!record.slotEvicted) {
          if (record.slotClass === 'capped') cappedAdmitted++;
          else exemptAdmitted++;
        }
      }
    }
    const stageCounts: Record<string, number> = {};
    for (const handler of handlers) {
      stageCounts[handler.stage] = (stageCounts[handler.stage] ?? 0) + 1;
    }
    return {
      running: this.running,
      maxConcurrent: this.maxConcurrent,
      inFlightCapped: queue ? cappedAdmitted : this.inFlightCapped,
      inFlightExempt: queue ? exemptAdmitted : this.inFlightExempt,
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
      try {
        this.changeNotifier('job_queue', scope);
      } catch (error) {
        this.notePollError('notify_change', undefined, error);
      }
    }
  }

  private notePollError(phase: string, queue: string | undefined, error: unknown): void {
    this.consecutivePollErrors++;
    const now = Date.now();
    if (
      this.consecutivePollErrors > 1 &&
      now - this.lastPollErrorLogAt < JobQueueProcessor.POLL_ERROR_LOG_INTERVAL_MS
    ) {
      return;
    }
    this.lastPollErrorLogAt = now;
    const scope = queue === undefined ? `phase=${phase}` : `phase=${phase} queue=${queue}`;
    log.error(
      `job queue poll error (${scope}, consecutive=${this.consecutivePollErrors}):` +
        ` ${describeStorageError(error)}`
    );
  }

  private notePollRecovery(): void {
    if (this.consecutivePollErrors === 0) return;
    log.info(`job queue poll recovered after ${this.consecutivePollErrors} consecutive error(s)`);
    this.consecutivePollErrors = 0;
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

type ObservableLifecycleStage = 'query_ready' | 'sdk_admitted' | 'first_sdk_response';

function isLifecycleEventName(stage: string): stage is ObservableLifecycleStage {
  return stage === 'query_ready' || stage === 'sdk_admitted' || stage === 'first_sdk_response';
}

const LIFECYCLE_STAGE_ORDER: Record<ObservableLifecycleStage, number> = {
  query_ready: 0,
  sdk_admitted: 1,
  first_sdk_response: 2,
};

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
