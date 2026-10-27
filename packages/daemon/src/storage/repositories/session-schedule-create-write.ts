import { requireNextRun } from '../../lib/scheduler/session-schedule-cadence.ts';
import { SESSION_SCHEDULE_FIRE } from '../../lib/job-queue-constants.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { JobQueueRepository } from './job-queue-repository.ts';
import {
  type NewSessionSchedule,
  type SessionSchedule,
  SessionScheduleRepository,
} from './session-schedule-repository.ts';

class SessionScheduleCreator {
  constructor(private readonly db: Database) {}

  create(input: NewSessionSchedule, now: number): SessionSchedule {
    const schedules = new SessionScheduleRepository(this.db);
    const existing = schedules.getBySource(input.sourceKind, input.sourceId);
    if (existing) return existing;
    const nextRunAt = requireNextRun(input.cadence, now);
    const created = schedules.create(input, nextRunAt, now);
    const job = new JobQueueRepository(this.db).enqueue({
      queue: SESSION_SCHEDULE_FIRE,
      payload: { scheduleId: created.id },
      runAt: nextRunAt,
    });
    schedules.setPending(created.id, null, job.id, nextRunAt);
    return schedules.get(created.id) as SessionSchedule;
  }
}

export const sessionScheduleCreateWrites = defineRepositoryOp(
  'session.schedule.create.write',
  'write',
  SessionScheduleCreator,
  ['create'] as const
);
