import { ScheduleService } from '../../lib/schedule/schedule-service.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { Database } from '../sqlite-compat.ts';
import { JobQueueRepository } from './job-queue-repository.ts';
import { SpaceRepository } from './space-repository.ts';
import { TaskScheduleRepository } from './task-schedule-repository.ts';

class TaskScheduleDeleteWriter {
  constructor(
    private readonly db: Database,
    private readonly changes?: ReactiveDatabase
  ) {}

  delete(id: string): boolean {
    const deleted = new ScheduleService({
      db: this.db,
      scheduleRepo: new TaskScheduleRepository(this.db),
      jobQueue: new JobQueueRepository(this.db),
      spaceRepo: new SpaceRepository(this.db),
    }).deleteSchedule(id);
    if (deleted) {
      this.changes?.notifyChange('task_schedules');
      this.changes?.notifyChange('job_queue');
    }
    return deleted;
  }
}

export const taskScheduleDeleteWrites = defineRepositoryOp(
  'task.schedule.delete.write',
  'write',
  TaskScheduleDeleteWriter,
  ['delete'] as const
);
