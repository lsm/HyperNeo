/**
 * Job handler for the longHorizonAgentReminder.fire scanner queue.
 *
 * Periodically scans for due long-horizon agent reminders and fires each:
 *   1. Query active reminders with `next_run_at <= now` whose owning agent is
 *      active AND whose owning space is active/not-paused/not-stopped (the
 *      partial `idx_space_lh_agent_reminders_due` index serves the reminder-
 *      side predicate; the agent/space joins skip non-deliverable states).
 *   2. For each reminder: re-check it is still active and due, re-check the
 *      space lifecycle, deliver a formatted reminder message to the owning LH
 *      agent session, then advance the reminder. Cron reminders get
 *      `next_run_at` recomputed from the expression (status stays 'active');
 *      one-shot `'at'` reminders flip to `status='fired'`.
 *   3. Self-schedule the next scan so the scanner keeps running every
 *      `NEXT_SCAN_DELAY_MS`.
 *
 * Mirrors the self-scheduling pattern from memory-consolidation.handler.ts and
 * the guard/advance shape from task-schedule-fire.handler.ts.
 *
 * Concurrency / double-delivery safety: the job processor runs with
 * `maxConcurrent` > 1, and this scanner pre-enqueues its own successor at the
 * start of each run (for crash resilience). Two scan jobs can therefore overlap
 * — a slow scan plus its due successor, or a reclaimed stale scan plus its
 * successor on restart — and both could select the same reminder. Because all
 * scan jobs run in a single daemon process (exclusive DB lock), an in-process
 * per-reminder lock (`reminderFireLocks`, same pattern as
 * SpaceRuntimeService.longTermAgentFlushes) serializes them: the second scan to
 * reach a reminder re-reads it after the first has advanced/ fired it and skips.
 * The compare-and-swap advance is a belt-and-suspenders fence for any path that
 * bypasses the lock.
 *
 * Delivery / advance contract: a reminder advances once its message has been
 * injected (deliver returned delivered:true) OR is already in the SDK pipeline
 * (the occurrence's sdk_messages row is send_status 'consumed'). It is
 * deferred — left due, not advanced, not re-injected — while a prior attempt's
 * row is still 'enqueued' (persisted but not consumed, e.g. a stuck SDK), so no
 * duplicate row is inserted and the row is drained by the SDK's turn_end
 * auto-send path. NB: for a nag, 'consumed' is treated as "handed to the SDK
 * pipeline" rather than a strict "the model yielded it this turn" — turn-end
 * cleanup (acknowledgeOldestQueuedUserOnTurnEnd) can mark an un-yielded user
 * row consumed, so a one-shot may advance with the message in the session
 * history (visible to the next turn) but not yet yielded to the model. This is
 * the deliberate, documented bar for a periodic nag; if a stricter guarantee
 * is ever needed, split the cleanup-consumed transition or key off a yield
 * receipt. If the process crashes between deliver and advance, that single
 * reminder may be re-delivered on the next scan — acceptable for a nag.
 *
 * Starvation safety: the scan pages through due reminders, excluding IDs it has
 * already attempted this tick, so a batch of poison (always-failing) reminders
 * cannot indefinitely block later, healthy ones.
 */

import type { SpaceLongHorizonAgentReminder } from '@hyperneo/shared';
import { LONG_HORIZON_AGENT_REMINDER_FIRE } from '../job-queue-constants';
import { Logger } from '../logger';
import { getNextRunAt } from '../space/schedule/cron-utils';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository';
import type { SpaceRepository } from '../../storage/repositories/space-repository';
import type { JobQueueRepository, Job } from '../../storage/repositories/job-queue-repository';

const log = new Logger('lh-agent-reminder-fire-handler');

/** How often the scanner re-runs. A near-future reminder fires within one window. */
const NEXT_SCAN_DELAY_MS = 30_000;
/** Due-reminders fetched per query page within a single scan. */
const PAGE_SIZE = 100;
/** Safety cap on reminders processed per scan (defends against pathological volume). */
const MAX_PER_SCAN = 5000;
/**
 * Per-scan wall-clock budget. A single slow delivery (e.g. a session that never
 * drains its message queue) can block on the message-queue timeout, and the job
 * processor's stop() awaits in-flight jobs with no timeout — so without a bound
 * a poison batch could stall graceful shutdown for minutes. Kept below
 * NEXT_SCAN_DELAY_MS so a scan normally finishes before its successor is due.
 */
const SCAN_DEADLINE_MS = 20_000;
/**
 * Per-delivery wall-clock bound. enqueueWithId's 30s timer only rejects
 * messages still in the in-memory queue — once the SDK shifts the message the
 * timer no-ops and the promise waits on `onSent` (run after `yield message`),
 * so a stuck SDK that never resumes its `for await` leaves enqueueWithId — and
 * thus `deliver` — unsettled forever. Racing against a deadline just past the
 * 30s in-queue timeout guarantees the per-reminder lock and the job slot are
 * released, so a single hung delivery can't pin the scanner (and, across
 * successive pre-enqueued scans, saturate maxConcurrent and stall unrelated
 * queues). On timeout the occurrence is treated as failed and retried next
 * scan; the orphaned deliver promise settles harmlessly if/when the SDK wakes.
 */
const DELIVERY_TIMEOUT_MS = 35_000;

/**
 * In-process per-reminder locks. Serializes overlapping scans (concurrent
 * processor slots, or a reclaimed stale scan + its successor) so two scans
 * never deliver the same reminder occurrence. Module-level because all scan
 * jobs share one daemon process.
 */
const reminderFireLocks = new Map<string, Promise<void>>();

/**
 * Outstanding delivery promises for reminders whose `deliver` call has not yet
 * settled. A delivery that times out before persisting (e.g. ensureQueryStarted
 * stalls before saveUserMessage) leaves no sdk_messages row, so the occurrence
 * probe reads 'absent' and a later scan would start ANOTHER delivery — stacking
 * overlapping deliveries (and, for the earliest stuck reminder, starving later
 * ones every scan). While a delivery for a reminder is pending here, the
 * scanner skips it (counts as 'skipped', not re-delivered). Entries clear when
 * the underlying delivery promise settles.
 */
const reminderDeliveriesInFlight = new Map<string, Promise<unknown>>();

export interface LongHorizonAgentReminderFireResult extends Record<string, unknown> {
  scanned: number;
  fired: number;
  skipped: number;
  failed: number;
  nextScanAt: number;
}

/** Persisted-message state for a reminder occurrence (see getOccurrenceDeliveryState). */
export type ReminderOccurrenceDeliveryState = 'absent' | 'enqueued' | 'consumed';

export interface LongHorizonAgentReminderFireDeps {
  reminderRepo: SpaceLongHorizonAgentRepository;
  spaceRepo: SpaceRepository;
  jobQueue: JobQueueRepository;
  /**
   * Deliver the reminder body to the owning LH agent session. Mirrors
   * SpaceRuntimeService.deliverLongHorizonAgentReminder (which in turn mirrors
   * deliverLongHorizonExternalEvent): re-checks the agent is present, in-space,
   * and `status === 'active'`, then ensures the session and injects the
   * message. Returns `delivered:false` (no throw) for a missing/paused/
   * archived agent so the scanner treats it as a skip.
   */
  deliver: (args: {
    spaceId: string;
    agentId: string;
    message: string;
    idempotencyKey: string;
  }) => Promise<{ delivered: boolean }>;
  /**
   * Optional pre-delivery guard against duplicate persisted messages AND the
   * advance-before-delivery trap. A prior attempt may have already persisted
   * the occurrence's sdk_messages row — `saveUserMessage` runs before
   * `enqueueWithId`, which can time out and throw, leaving the row durable
   * while the handler reports failure and retries. Re-injecting would insert a
   * duplicate row (new PK, same uuid; no unique constraint) and flood the agent
   * on replay. Tri-state, mirroring the row's send_status:
   *   - 'consumed': the occurrence's message is in the SDK pipeline (the row
   *     reached send_status 'consumed' via a genuine SDK yield OR turn-end
   *     cleanup of un-yielded rows) → advance without re-injecting. For a nag
   *     this is the "handed to the SDK" bar, not a strict yield guarantee (see
   *     the Delivery / advance contract in the header).
   *   - 'enqueued': persisted but not yet consumed (e.g. a stuck SDK that timed
   *     out on enqueue) → skip WITHOUT advancing and WITHOUT re-injecting; the
   *     SDK drains the row via its normal turn-end/startup paths and the
   *     scanner re-selects next tick until consumed. Avoids both amplification
   *     and marking a one-shot 'fired' before delivery.
   *   - 'absent': no prior row → deliver as usual. Also the effective value
   *     when this dep is unset.
   */
  getOccurrenceDeliveryState?: (
    spaceId: string,
    agentId: string,
    idempotencyKey: string
  ) => ReminderOccurrenceDeliveryState;
  /**
   * Per-delivery timeout override (mainly for tests); defaults to
   * DELIVERY_TIMEOUT_MS. Bounds a stuck SDK delivery so it can't pin the lock
   * or the job slot.
   */
  deliveryTimeoutMs?: number;
}

export async function handleLongHorizonAgentReminderFire(
  _job: Job,
  deps: LongHorizonAgentReminderFireDeps
): Promise<LongHorizonAgentReminderFireResult> {
  const { reminderRepo, jobQueue } = deps;
  const now = Date.now();
  const nextScanAt = now + NEXT_SCAN_DELAY_MS;
  // Schedule the next scan first so the chain survives a crash mid-scan.
  enqueueLongHorizonAgentReminderScanIfMissing(jobQueue, nextScanAt);

  let scanned = 0;
  let fired = 0;
  let skipped = 0;
  let failed = 0;
  const attempted = new Set<string>();
  const scanStartedAt = now;

  // Page through due reminders, excluding ones already attempted this scan so a
  // poison batch cannot starve later, healthy reminders. Loop until a page is
  // short (drained), the per-scan cap is reached, or the wall-clock budget
  // expires (bounds shutdown latency — see SCAN_DEADLINE_MS).
  let deadlineHit = false;
  scanLoop: while (scanned < MAX_PER_SCAN) {
    const due = reminderRepo.listDueReminders(now, PAGE_SIZE, Array.from(attempted));
    if (due.length === 0) break;
    for (const reminder of due) {
      // Check the budget before EACH delivery, not just between pages: a single
      // stuck delivery can block for the message-queue timeout (~30s), so a
      // page of 100 could otherwise run for many minutes on one worker.
      if (Date.now() - scanStartedAt > SCAN_DEADLINE_MS) {
        deadlineHit = true;
        break scanLoop;
      }
      attempted.add(reminder.id);
      scanned++;
      let outcome: 'fired' | 'skipped' | 'failed';
      try {
        outcome = await fireReminderSerialized(reminder, deps, now);
      } catch (err) {
        outcome = 'failed';
        log.warn('lh-agent-reminder-fire: error firing reminder', {
          reminderId: reminder.id,
          error: err instanceof Error ? err.message : err,
        });
      }
      if (outcome === 'fired') fired++;
      else if (outcome === 'skipped') skipped++;
      else failed++;
    }
    if (due.length < PAGE_SIZE) break; // drained
  }

  if (scanned >= MAX_PER_SCAN) {
    // Not silent: if the cap is hit, some due reminders were deferred to a
    // later scan.
    log.warn('lh-agent-reminder-fire: per-scan cap reached; remaining due reminders deferred', {
      scanned,
    });
  }
  if (deadlineHit) {
    log.warn('lh-agent-reminder-fire: scan deadline reached; remaining due reminders deferred', {
      scanned,
      budgetMs: SCAN_DEADLINE_MS,
    });
  }
  if (scanned > 0) {
    log.debug('lh-agent-reminder-fire: scan complete', { scanned, fired, skipped, failed });
  }

  return { scanned, fired, skipped, failed, nextScanAt };
}

/**
 * Run fireReminder under a per-reminder in-process lock so overlapping scans
 * serialize on the same reminder. The loser re-reads the row after the winner
 * has advanced/fired it and skips. Mirrors longTermAgentFlushes.
 */
async function fireReminderSerialized(
  reminder: SpaceLongHorizonAgentReminder,
  deps: LongHorizonAgentReminderFireDeps,
  now: number
): Promise<'fired' | 'skipped' | 'failed'> {
  const lockKey = reminder.id;
  const previous = reminderFireLocks.get(lockKey) ?? Promise.resolve();
  let outcome: 'fired' | 'skipped' | 'failed' = 'failed';
  const current = previous
    .catch(() => {})
    .then(async () => {
      outcome = await fireReminder(reminder, deps, now);
    });
  reminderFireLocks.set(lockKey, current);
  try {
    await current;
  } finally {
    if (reminderFireLocks.get(lockKey) === current) reminderFireLocks.delete(lockKey);
  }
  return outcome;
}

async function fireReminder(
  reminder: SpaceLongHorizonAgentReminder,
  deps: LongHorizonAgentReminderFireDeps,
  now: number
): Promise<'fired' | 'skipped' | 'failed'> {
  const { reminderRepo, spaceRepo, deliver, getOccurrenceDeliveryState } = deps;
  // Re-read: the reminder may have been paused/cancelled/fired/advanced between
  // the due-scan and now (e.g. by a serialized peer scan). A null or future
  // next_run_at means it is no longer schedulable for this tick.
  const fresh = reminderRepo.getReminder(reminder.id);
  if (!fresh || fresh.status !== 'active' || fresh.nextRunAt === null || fresh.nextRunAt > now) {
    return 'skipped';
  }

  // Space lifecycle guard: never fire (and never let delivery recreate a
  // session) for a paused/stopped/archived space — mirrors task-schedule-fire's
  // space contract. The due-query already filters this, but a space can be
  // stopped between select and fire.
  const space = spaceRepo.getSpace(fresh.spaceId);
  if (!space || space.status !== 'active' || space.paused || space.stopped) {
    return 'skipped';
  }

  const message = formatReminderMessage(fresh);
  // Per-fire idempotency key derived from `fresh` (the same row the CAS below
  // keys on). Passed as the SDK message uuid.
  const idempotencyKey = `reminder:${fresh.id}:${fresh.nextRunAt}`;

  // Pre-delivery idempotency against a prior attempt that already persisted
  // this occurrence's sdk_messages row (saveUserMessage runs before
  // enqueueWithId, which can time out and throw). Tri-state:
  //   'enqueued' — persisted but not yet consumed (e.g. a stuck SDK). Skip
  //     WITHOUT advancing and WITHOUT re-injecting: re-injecting would
  //     duplicate the row, and advancing would mark a one-shot 'fired' before
  //     delivery (violating the deliver-before-advance invariant). The SDK
  //     drains the row via its normal paths; the scanner re-selects next tick
  //     and re-checks until consumed.
  //   'consumed' — message is in the SDK pipeline; advance without re-injecting.
  //   'absent'   — no prior row; deliver as usual.
  const occurrenceState =
    getOccurrenceDeliveryState?.(fresh.spaceId, fresh.agentId, idempotencyKey) ?? 'absent';
  if (occurrenceState === 'enqueued') {
    log.debug('lh-agent-reminder-fire: occurrence enqueued, deferring', { reminderId: fresh.id });
    return 'skipped';
  }

  let delivered: boolean;
  if (occurrenceState === 'consumed') {
    log.debug('lh-agent-reminder-fire: occurrence already consumed, advancing', {
      reminderId: fresh.id,
    });
    delivered = true;
  } else {
    // A prior delivery that timed out before persisting (no row → 'absent')
    // may still be pending in the background. Don't stack another — skip and
    // let the scanner retry once it settles (or, if the SDK is wedged, the
    // in-flight entry clears on process restart). This keeps a stuck earliest
    // reminder from being retried every scan and starving later ones.
    if (reminderDeliveriesInFlight.has(fresh.id)) {
      log.debug('lh-agent-reminder-fire: delivery already in flight, deferring', {
        reminderId: fresh.id,
      });
      return 'skipped';
    }
    const delivery = deliver({
      spaceId: fresh.spaceId,
      agentId: fresh.agentId,
      message,
      idempotencyKey,
    });
    reminderDeliveriesInFlight.set(fresh.id, delivery);
    delivery.finally(() => {
      if (reminderDeliveriesInFlight.get(fresh.id) === delivery) {
        reminderDeliveriesInFlight.delete(fresh.id);
      }
    });
    try {
      // Bound the delivery: a stuck SDK can leave enqueueWithId (and thus
      // deliver) unsettled forever. On timeout, treat as failed so the lock
      // and job slot release; the reminder retries next scan. The underlying
      // delivery promise stays in reminderDeliveriesInFlight until it actually
      // settles, preventing a re-delivery in the meantime. See
      // DELIVERY_TIMEOUT_MS.
      const result = await withTimeout(
        delivery,
        deps.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS,
        'reminder delivery'
      );
      delivered = result.delivered;
    } catch (err) {
      log.warn('lh-agent-reminder-fire: delivery threw or timed out', {
        reminderId: fresh.id,
        error: err instanceof Error ? err.message : err,
      });
      return 'failed';
    }

    // Delivery returned false: the owning AGENT is missing/paused/disabled/
    // archived, or its session could not be ensured, or the space was
    // paused/stopped during delivery (the inject-path lifecycle recheck).
    // (The reminder's own paused/cancelled status is handled by the active-
    // status guard above.) Do NOT advance: the reminder stays due and fires
    // when deliverable again.
    if (!delivered) return 'skipped';
  }

  // Compute the post-fire state from a FRESH timestamp (not the scan-wide
  // `now`): a slow scan may deliver this reminder well after the scan started,
  // and computing the cron's next occurrence from a stale `now` could persist a
  // next_run_at that is already overdue → an immediate re-fire. cron →
  // recompute next run (stay active); 'at' → terminal 'fired' with no future
  // run. If a cron expression yields no future occurrence, treat it as terminal.
  const firedAt = Date.now();
  const nextRunAt =
    fresh.triggerType === 'cron' && fresh.cronExpression
      ? getNextRunAt(fresh.cronExpression, fresh.timezone, firedAt)
      : null;
  const updates =
    nextRunAt === null
      ? { status: 'fired' as const, nextRunAt: null, lastFiredAt: firedAt }
      : { status: 'active' as const, nextRunAt, lastFiredAt: firedAt };

  const applied = reminderRepo.advanceReminderAfterFire(fresh.id, fresh.nextRunAt, updates);
  if (!applied) {
    // The reminder changed under us (paused/rescheduled/fired by another path)
    // between our read and the CAS. We already delivered — leave the row as the
    // winning mutation left it; nothing more to do.
    log.debug('lh-agent-reminder-fire: advance CAS missed', { reminderId: fresh.id });
  }
  return 'fired';
}

/**
 * Enqueue the next reminder-fire scan if none is already pending. Called at
 * startup and at the start of every scan so the scanner keeps recurring.
 */
export function enqueueLongHorizonAgentReminderScanIfMissing(
  jobQueue: JobQueueRepository,
  runAt = Date.now()
): void {
  const pending = jobQueue.listJobs({
    queue: LONG_HORIZON_AGENT_REMINDER_FIRE,
    status: 'pending',
    limit: 1,
  });
  if (pending.length === 0) {
    jobQueue.enqueue({ queue: LONG_HORIZON_AGENT_REMINDER_FIRE, payload: {}, runAt });
  }
}

/**
 * Backfill `next_run_at` for active reminders that pre-date the scanner (their
 * create paths now seed it, so only rows created before this feature shipped
 * have a NULL value). cron → next occurrence from the expression; 'at' → run_at
 * (or now if unknown). Idempotent — only touches rows with a NULL next_run_at.
 * Returns the number of rows backfilled.
 */
export function backfillLongHorizonAgentReminderNextRunAt(
  reminderRepo: SpaceLongHorizonAgentRepository
): number {
  const stale = reminderRepo.listActiveRemindersWithNullNextRunAt();
  if (stale.length === 0) return 0;
  const now = Date.now();
  let count = 0;
  for (const reminder of stale) {
    // Only seed schedulable reminders. A malformed legacy row (cron with no
    // expression, or 'at' with no run_at) is left NULL rather than defaulted
    // to `now` — defaulting would immediately fire + mark fired a reminder
    // that was previously inert. An operator can repair or cancel it.
    const nextRunAt =
      reminder.triggerType === 'cron'
        ? reminder.cronExpression
          ? getNextRunAt(reminder.cronExpression, reminder.timezone || 'UTC', now)
          : null
        : (reminder.runAt ?? null);
    if (nextRunAt === null) continue;
    reminderRepo.setReminderNextRunAt(reminder.id, nextRunAt);
    count++;
  }
  return count;
}

function formatReminderMessage(reminder: SpaceLongHorizonAgentReminder): string {
  // `title` carries the reminder text (the create_agent_reminder tool stores
  // the caller's `message` there); `body` is optional detail.
  const parts = [`## Scheduled Reminder\n\n${reminder.title}`];
  if (reminder.body.trim()) {
    parts.push(`\n${reminder.body}`);
  }
  return parts.join('\n');
}

/**
 * Race a promise against a deadline. On timeout, rejects with a descriptive
 * error; the underlying promise is left to settle on its own (its result is
 * ignored). Used to bound delivery so a stuck SDK can't pin the scanner.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, scope: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${scope} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
