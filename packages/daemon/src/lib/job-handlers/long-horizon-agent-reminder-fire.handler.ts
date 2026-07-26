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
 * Ordering note: delivery happens *before* the advance so a one-shot reminder
 * is never marked `fired` without having actually been delivered. If the
 * process crashes between deliver and advance for one reminder, that single
 * reminder may be re-delivered on the next scan — acceptable for a nag, and
 * far better than silently losing a one-shot.
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
 * In-process per-reminder locks. Serializes overlapping scans (concurrent
 * processor slots, or a reclaimed stale scan + its successor) so two scans
 * never deliver the same reminder occurrence. Module-level because all scan
 * jobs share one daemon process.
 */
const reminderFireLocks = new Map<string, Promise<void>>();

export interface LongHorizonAgentReminderFireResult extends Record<string, unknown> {
  scanned: number;
  fired: number;
  skipped: number;
  failed: number;
  nextScanAt: number;
}

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
}

export async function handleLongHorizonAgentReminderFire(
  _job: Job,
  deps: LongHorizonAgentReminderFireDeps
): Promise<LongHorizonAgentReminderFireResult> {
  const { reminderRepo, spaceRepo, jobQueue, deliver } = deps;
  const now = Date.now();
  const nextScanAt = now + NEXT_SCAN_DELAY_MS;
  // Schedule the next scan first so the chain survives a crash mid-scan.
  enqueueLongHorizonAgentReminderScanIfMissing(jobQueue, nextScanAt);

  let scanned = 0;
  let fired = 0;
  let skipped = 0;
  let failed = 0;
  const attempted = new Set<string>();

  // Page through due reminders, excluding ones already attempted this scan so a
  // poison batch cannot starve later, healthy reminders. Loop until a page is
  // short (drained) or the per-scan cap is reached.
  while (scanned < MAX_PER_SCAN) {
    const due = reminderRepo.listDueReminders(now, PAGE_SIZE, Array.from(attempted));
    if (due.length === 0) break;
    for (const reminder of due) {
      attempted.add(reminder.id);
      scanned++;
      let outcome: 'fired' | 'skipped' | 'failed';
      try {
        outcome = await fireReminderSerialized(reminder, reminderRepo, spaceRepo, deliver, now);
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
  reminderRepo: SpaceLongHorizonAgentRepository,
  spaceRepo: SpaceRepository,
  deliver: LongHorizonAgentReminderFireDeps['deliver'],
  now: number
): Promise<'fired' | 'skipped' | 'failed'> {
  const lockKey = reminder.id;
  const previous = reminderFireLocks.get(lockKey) ?? Promise.resolve();
  let outcome: 'fired' | 'skipped' | 'failed' = 'failed';
  const current = previous
    .catch(() => {})
    .then(async () => {
      outcome = await fireReminder(reminder, reminderRepo, spaceRepo, deliver, now);
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
  reminderRepo: SpaceLongHorizonAgentRepository,
  spaceRepo: SpaceRepository,
  deliver: LongHorizonAgentReminderFireDeps['deliver'],
  now: number
): Promise<'fired' | 'skipped' | 'failed'> {
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
  // keys on). This labels/traces the delivery and is passed as the SDK message
  // uuid — it is NOT a hard dedupe fence, since the SDK does not dedupe by
  // message uuid. The real double-delivery guard is the per-reminder lock plus
  // the CAS advance: once next_run_at moves forward, a peer/retried scan no
  // longer sees this occurrence as due.
  const idempotencyKey = `reminder:${fresh.id}:${fresh.nextRunAt}`;

  let delivered: boolean;
  try {
    const result = await deliver({
      spaceId: fresh.spaceId,
      agentId: fresh.agentId,
      message,
      idempotencyKey,
    });
    delivered = result.delivered;
  } catch (err) {
    log.warn('lh-agent-reminder-fire: delivery threw', {
      reminderId: fresh.id,
      error: err instanceof Error ? err.message : err,
    });
    return 'failed';
  }

  // Delivery returned false: the owning AGENT is missing/paused/disabled/
  // archived, or its session could not be ensured. (The reminder's own
  // paused/cancelled status is handled by the active-status guard above — this
  // branch is specifically an agent-state skip.) Do NOT advance: the reminder
  // stays due and fires when the agent is active again. The due-query filters
  // paused agents out, so there is no re-selection spam while it stays paused.
  if (!delivered) return 'skipped';

  // Compute the post-fire state: cron → recompute next run (stay active);
  // 'at' → terminal 'fired' with no future run. If a cron expression yields no
  // future occurrence, treat it as terminal too.
  const nextRunAt =
    fresh.triggerType === 'cron' && fresh.cronExpression
      ? getNextRunAt(fresh.cronExpression, fresh.timezone, now)
      : null;
  const updates =
    nextRunAt === null
      ? { status: 'fired' as const, nextRunAt: null, lastFiredAt: now }
      : { status: 'active' as const, nextRunAt, lastFiredAt: now };

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

function formatReminderMessage(reminder: SpaceLongHorizonAgentReminder): string {
  // `title` carries the reminder text (the create_agent_reminder tool stores
  // the caller's `message` there); `body` is optional detail.
  const parts = [`## Scheduled Reminder\n\n${reminder.title}`];
  if (reminder.body.trim()) {
    parts.push(`\n${reminder.body}`);
  }
  return parts.join('\n');
}
