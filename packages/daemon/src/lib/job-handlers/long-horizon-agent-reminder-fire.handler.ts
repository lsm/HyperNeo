/**
 * Job handler for the longHorizonAgentReminder.fire scanner queue.
 *
 * Periodically scans for due long-horizon agent reminders and fires each:
 *   1. Query active reminders with `next_run_at <= now` whose owning agent is
 *      active (the partial `idx_space_lh_agent_reminders_due` index serves the
 *      reminder-side predicate; the join skips paused/archived owners).
 *   2. For each reminder: re-check it is still active, deliver a formatted
 *      reminder message to the owning LH agent session, then advance the
 *      reminder. Cron reminders get `next_run_at` recomputed from the
 *      expression (status stays 'active'); one-shot `'at'` reminders flip to
 *      `status='fired'`.
 *   3. Self-schedule the next scan so the scanner keeps running every
 *      `NEXT_SCAN_DELAY_MS`.
 *
 * The scanner mirrors the self-scheduling pattern from
 * memory-consolidation.handler.ts and the guard/advance shape from
 * task-schedule-fire.handler.ts.
 *
 * Double-fire safety: each reminder is delivered then immediately advanced via
 * a compare-and-swap (`status='active' AND next_run_at=<the value we read>`).
 * A retried scan that re-selects the same reminder finds it already advanced
 * (or fired) and the CAS no-ops, so no second message is delivered. The job
 * processor is single-threaded and the daemon holds an exclusive DB lock, so
 * there is no cross-tick concurrency; the CAS is the belt-and-suspenders fence
 * for crash-retry races.
 *
 * Ordering note: delivery happens *before* the advance so a one-shot reminder
 * is never marked `fired` without having actually been delivered. If the
 * process crashes between deliver and advance for one reminder, that single
 * reminder may double-fire on the next scan — acceptable for a nag, and far
 * better than silently losing a one-shot.
 */

import type { SpaceLongHorizonAgentReminder } from '@hyperneo/shared';
import { LONG_HORIZON_AGENT_REMINDER_FIRE } from '../job-queue-constants';
import { Logger } from '../logger';
import { getNextRunAt } from '../space/schedule/cron-utils';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository';
import type { JobQueueRepository, Job } from '../../storage/repositories/job-queue-repository';

const log = new Logger('lh-agent-reminder-fire-handler');

/** How often the scanner re-runs. A near-future reminder fires within one window. */
const NEXT_SCAN_DELAY_MS = 30_000;

export interface LongHorizonAgentReminderFireResult extends Record<string, unknown> {
  scanned: number;
  fired: number;
  skipped: number;
  failed: number;
  nextScanAt: number;
}

export interface LongHorizonAgentReminderFireDeps {
  reminderRepo: SpaceLongHorizonAgentRepository;
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
  const { reminderRepo, jobQueue, deliver } = deps;
  const now = Date.now();
  const nextScanAt = now + NEXT_SCAN_DELAY_MS;
  // Schedule the next scan first so the chain survives a crash mid-scan.
  enqueueLongHorizonAgentReminderScanIfMissing(jobQueue, nextScanAt);

  const due = reminderRepo.listDueReminders(now);
  let fired = 0;
  let skipped = 0;
  let failed = 0;

  for (const reminder of due) {
    const outcome = await fireReminder(reminder, reminderRepo, deliver, now);
    if (outcome === 'fired') fired++;
    else if (outcome === 'skipped') skipped++;
    else failed++;
  }

  if (due.length > 0) {
    log.debug('lh-agent-reminder-fire: scan complete', {
      scanned: due.length,
      fired,
      skipped,
      failed,
    });
  }

  return { scanned: due.length, fired, skipped, failed, nextScanAt };
}

async function fireReminder(
  reminder: SpaceLongHorizonAgentReminder,
  reminderRepo: SpaceLongHorizonAgentRepository,
  deliver: LongHorizonAgentReminderFireDeps['deliver'],
  now: number
): Promise<'fired' | 'skipped' | 'failed'> {
  // Re-read: the reminder may have been paused/cancelled/fired between the
  // due-scan and now. A null next_run_at means it is no longer schedulable.
  const fresh = reminderRepo.getReminder(reminder.id);
  if (!fresh || fresh.status !== 'active' || fresh.nextRunAt === null) {
    return 'skipped';
  }

  const message = formatReminderMessage(fresh);
  // Deterministic per-fire idempotency key: scoped to this reminder and the
  // occurrence we are firing (its current next_run_at). A re-delivery of the
  // same occurrence reuses the key.
  const idempotencyKey = `reminder:${reminder.id}:${reminder.nextRunAt}`;

  let delivered: boolean;
  try {
    const result = await deliver({
      spaceId: reminder.spaceId,
      agentId: reminder.agentId,
      message,
      idempotencyKey,
    });
    delivered = result.delivered;
  } catch (err) {
    log.warn('lh-agent-reminder-fire: delivery threw', {
      reminderId: reminder.id,
      error: err instanceof Error ? err.message : err,
    });
    return 'failed';
  }

  // Delivery returned false (agent missing/paused/archived, or session could
  // not be ensured). Do NOT advance: a paused agent's reminder stays due and
  // fires when the agent is active again (the due-query filters paused agents
  // out, so there is no re-selection spam while it stays paused).
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
    log.debug('lh-agent-reminder-fire: advance CAS missed', { reminderId: reminder.id });
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
