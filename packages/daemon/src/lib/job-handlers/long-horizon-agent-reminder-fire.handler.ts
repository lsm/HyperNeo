import type { SpaceLongHorizonAgentReminder } from '@hyperneo/shared';
import { LONG_HORIZON_AGENT_REMINDER_FIRE } from '../job-queue-constants.ts';
import { Logger } from '../logger.ts';
import { getNextRunAt } from '../space/schedule/cron-utils.ts';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import type { JobQueueRepository, Job } from '../../storage/repositories/job-queue-repository.ts';

const log = new Logger('lh-agent-reminder-fire-handler');

const NEXT_SCAN_DELAY_MS = 30_000;
const PAGE_SIZE = 100;
const MAX_PER_SCAN = 5000;
const SCAN_DEADLINE_MS = 20_000;
const DELIVERY_TIMEOUT_MS = 35_000;

const reminderFireLocks = new Map<string, Promise<void>>();

const reminderDeliveriesInFlight = new Map<string, Promise<unknown>>();

export interface LongHorizonAgentReminderFireResult extends Record<string, unknown> {
  scanned: number;
  fired: number;
  skipped: number;
  failed: number;
  nextScanAt: number;
}

export type ReminderOccurrenceDeliveryState = 'absent' | 'enqueued' | 'consumed';

export interface LongHorizonAgentReminderFireDeps {
  reminderRepo: SpaceLongHorizonAgentRepository;
  spaceRepo: SpaceRepository;
  jobQueue: JobQueueRepository;
  deliver: (args: {
    spaceId: string;
    agentId: string;
    message: string;
    idempotencyKey: string;
  }) => Promise<{ delivered: boolean }>;
  getOccurrenceDeliveryState?: (
    spaceId: string,
    agentId: string,
    idempotencyKey: string
  ) => ReminderOccurrenceDeliveryState;
  deliveryTimeoutMs?: number;
}

export async function handleLongHorizonAgentReminderFire(
  _job: Job,
  deps: LongHorizonAgentReminderFireDeps
): Promise<LongHorizonAgentReminderFireResult> {
  const { reminderRepo, jobQueue } = deps;
  const now = Date.now();
  const nextScanAt = now + NEXT_SCAN_DELAY_MS;
  enqueueLongHorizonAgentReminderScanIfMissing(jobQueue, nextScanAt);

  let scanned = 0;
  let fired = 0;
  let skipped = 0;
  let failed = 0;
  const attempted = new Set<string>();
  const scanStartedAt = now;

  let deadlineHit = false;
  scanLoop: while (scanned < MAX_PER_SCAN) {
    const due = reminderRepo.listDueReminders(now, PAGE_SIZE, Array.from(attempted));
    if (due.length === 0) break;
    for (const reminder of due) {
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
    if (due.length < PAGE_SIZE) break;
  }

  if (scanned >= MAX_PER_SCAN) {
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
  const fresh = reminderRepo.getReminder(reminder.id);
  if (!fresh || fresh.status !== 'active' || fresh.nextRunAt === null || fresh.nextRunAt > now) {
    return 'skipped';
  }

  const space = spaceRepo.getSpace(fresh.spaceId);
  if (!space || space.status !== 'active' || space.paused || space.stopped) {
    return 'skipped';
  }

  const message = formatReminderMessage(fresh);
  const idempotencyKey = `reminder:${fresh.id}:${fresh.nextRunAt}`;

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
    const clearInFlight = () => {
      if (reminderDeliveriesInFlight.get(fresh.id) === delivery) {
        reminderDeliveriesInFlight.delete(fresh.id);
      }
    };
    delivery.then(clearInFlight, clearInFlight);
    try {
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

    if (!delivered) return 'skipped';
  }

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
    log.debug('lh-agent-reminder-fire: advance CAS missed', { reminderId: fresh.id });
  }
  return 'fired';
}

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

export function backfillLongHorizonAgentReminderNextRunAt(
  reminderRepo: SpaceLongHorizonAgentRepository
): number {
  const stale = reminderRepo.listActiveRemindersWithNullNextRunAt();
  if (stale.length === 0) return 0;
  const now = Date.now();
  let count = 0;
  for (const reminder of stale) {
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
  const parts = [`## Scheduled Reminder\n\n${reminder.title}`];
  if (reminder.body.trim()) {
    parts.push(`\n${reminder.body}`);
  }
  return parts.join('\n');
}

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
