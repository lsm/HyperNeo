import { ScheduleService } from '../../lib/schedule/schedule-service.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { Database } from '../sqlite-compat.ts';
import { JobQueueRepository } from './job-queue-repository.ts';
import { SpaceRepository } from './space-repository.ts';
import { TaskScheduleRepository } from './task-schedule-repository.ts';

class TaskSchedulePauseWriter {
  constructor(
    private readonly db: Database,
    private readonly changes?: ReactiveDatabase
  ) {}

  ensurePaused(id: string) {
    const schedule = new TaskScheduleRepository(this.db).getById(id);
    return schedule?.status === 'paused' ? schedule : this.pause(id);
  }

  pause(id: string) {
    const schedule = new ScheduleService({
      db: this.db,
      scheduleRepo: new TaskScheduleRepository(this.db),
      jobQueue: new JobQueueRepository(this.db),
      spaceRepo: new SpaceRepository(this.db),
    }).pauseSchedule(id);
    this.changes?.notifyChange('task_schedules');
    this.changes?.notifyChange('job_queue');
    return schedule;
  }
}

export const taskSchedulePauseWrites = defineRepositoryOp(
  'task.schedule.pause.write',
  'write',
  TaskSchedulePauseWriter,
  ['pause', 'ensurePaused'] as const
);
