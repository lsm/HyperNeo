import type { Database as BunDatabase } from '../../../storage/sqlite-compat';
import type {
  SpaceTaskPriority,
  TaskSchedule,
  TaskScheduleStatus,
  TaskScheduleTriggerType,
} from '@hyperneo/shared';
import type { TaskScheduleRepository } from '../../../storage/repositories/task-schedule-repository';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository';
import type { SpaceRepository } from '../../../storage/repositories/space-repository';
import { getNextRunAt, isValidCronExpression } from './cron-utils';
import { TASK_SCHEDULE_FIRE } from '../../job-queue-constants';
import type { TaskScheduleFirePayload } from '../../job-handlers/task-schedule-fire.handler';

export interface CreateScheduleInput {
  spaceId: string;
  title: string;
  description?: string;
  priority?: SpaceTaskPriority;
  preferredWorkflowId?: string | null;
  labels?: string[];
  metadata?: Record<string, unknown>;
  triggerType: TaskScheduleTriggerType;
  cronExpression?: string | null;
  runAt?: number | null;
  timezone?: string;
  createdByAgent?: string | null;
  createdBySession?: string | null;
}

export interface CreateGoalScheduleInput extends CreateScheduleInput {
  goalId: string;
}

export interface UpdateScheduleInput {
  title?: string;
  description?: string;
  priority?: SpaceTaskPriority;
  preferredWorkflowId?: string | null;
  labels?: string[];
  cronExpression?: string | null;
  runAt?: number | null;
  timezone?: string;
}

export interface ScheduleServiceDeps {
  db: BunDatabase;
  scheduleRepo: TaskScheduleRepository;
  jobQueue: JobQueueRepository;
  spaceRepo: SpaceRepository;
}

export class ScheduleService {
  constructor(private readonly deps: ScheduleServiceDeps) {}

  private validateCreateTrigger(input: CreateScheduleInput): void {
    if (!input.spaceId) throw new Error('spaceId is required');
    if (!input.title?.trim()) throw new Error('title is required');
    if (!input.triggerType) throw new Error('triggerType is required');

    if (input.triggerType === 'cron') {
      if (!input.cronExpression) throw new Error('cronExpression is required for cron triggers');
      if (!isValidCronExpression(input.cronExpression)) {
        throw new Error(`Invalid cron expression: ${input.cronExpression}`);
      }
    } else if (input.triggerType === 'at') {
      if (!input.runAt) throw new Error('runAt is required for at triggers');
      if (input.runAt < Date.now()) throw new Error('runAt must be in the future');
    } else {
      throw new Error(
        `Unsupported triggerType: ${String(input.triggerType)} (expected 'cron' or 'at')`
      );
    }
  }

  private computeInitialNextRun(input: CreateScheduleInput, tz: string): number {
    let nextRunAt: number | null;
    if (input.triggerType === 'cron') {
      nextRunAt = getNextRunAt(input.cronExpression as string, tz);
    } else {
      nextRunAt = input.runAt as number;
    }
    if (nextRunAt === null) {
      throw new Error('Could not compute next run time from the provided expression');
    }
    return nextRunAt;
  }

  createSchedule(input: CreateScheduleInput): TaskSchedule {
    return this.createScheduleInternal(input, null);
  }

  createGoalSchedule(input: CreateGoalScheduleInput): TaskSchedule {
    return this.createScheduleInternal(input, input.goalId);
  }

  private createScheduleInternal(input: CreateScheduleInput, goalId: string | null): TaskSchedule {
    this.validateCreateTrigger(input);

    const { spaceRepo, db, scheduleRepo, jobQueue } = this.deps;
    const space = spaceRepo.getSpace(input.spaceId);
    if (!space) throw new Error(`Space not found: ${input.spaceId}`);
    if (space.status !== 'active') {
      throw new Error(`Cannot create schedule in a non-active space (current: ${space.status})`);
    }

    const tz = input.timezone ?? 'UTC';
    const nextRunAt = this.computeInitialNextRun(input, tz);

    const scheduleId = db.transaction(() => {
      const schedule = scheduleRepo.create({
        spaceId: input.spaceId,
        title: input.title,
        description: input.description,
        priority: input.priority,
        preferredWorkflowId: input.preferredWorkflowId,
        labels: input.labels,
        metadata: input.metadata,
        triggerType: input.triggerType,
        cronExpression: input.cronExpression,
        runAt: input.runAt,
        timezone: tz,
        nextRunAt,
        createdByAgent: input.createdByAgent,
        createdBySession: input.createdBySession,
        goalId,
      });

      const job = jobQueue.enqueue({
        queue: TASK_SCHEDULE_FIRE,
        payload: { scheduleId: schedule.id } satisfies TaskScheduleFirePayload,
        runAt: nextRunAt,
      });

      scheduleRepo.updatePendingJobId(schedule.id, job.id);
      return schedule.id;
    })();

    return scheduleRepo.getById(scheduleId) as TaskSchedule;
  }

  updateSchedule(scheduleId: string, input: UpdateScheduleInput): TaskSchedule {
    const { db, scheduleRepo, jobQueue } = this.deps;

    const existing = scheduleRepo.getById(scheduleId);
    if (!existing) throw new Error(`Schedule not found: ${scheduleId}`);

    if (input.title !== undefined && !input.title.trim()) {
      throw new Error('title must be a non-empty string');
    }

    if (
      existing.triggerType === 'cron' &&
      'cronExpression' in input &&
      input.cronExpression === null
    ) {
      throw new Error(
        'Cannot clear cronExpression on a cron schedule. Delete and recreate, or change triggerType.'
      );
    }

    if (input.cronExpression !== undefined && input.cronExpression !== null) {
      if (!isValidCronExpression(input.cronExpression)) {
        throw new Error(`Invalid cron expression: ${input.cronExpression}`);
      }
    }
    if (input.runAt !== undefined && input.runAt !== null) {
      if (input.runAt < Date.now()) throw new Error('runAt must be in the future');
    }

    const timingChanged =
      input.cronExpression !== undefined ||
      input.runAt !== undefined ||
      input.timezone !== undefined;

    const merged = {
      triggerType: existing.triggerType,
      cronExpression:
        input.cronExpression !== undefined ? input.cronExpression : existing.cronExpression,
      runAt: input.runAt !== undefined ? input.runAt : existing.runAt,
      timezone: input.timezone ?? existing.timezone,
    };

    let plannedNextRunAt: number | null = null;
    if (timingChanged) {
      if (merged.triggerType === 'cron' && merged.cronExpression) {
        plannedNextRunAt = getNextRunAt(merged.cronExpression, merged.timezone);
        if (plannedNextRunAt === null) {
          throw new Error(
            `Could not compute next run from cronExpression "${merged.cronExpression}" with timezone "${merged.timezone}"`
          );
        }
      } else if (merged.triggerType === 'at' && merged.runAt) {
        plannedNextRunAt = merged.runAt;
      } else {
        throw new Error(
          'Cannot apply update: resulting trigger configuration has no next run time.'
        );
      }
    }

    db.transaction(() => {
      const updateParams: Parameters<typeof scheduleRepo.update>[1] = {};
      if (input.title !== undefined) updateParams.title = input.title;
      if (input.description !== undefined) updateParams.description = input.description;
      if (input.priority !== undefined) updateParams.priority = input.priority;
      if ('preferredWorkflowId' in input) {
        updateParams.preferredWorkflowId = input.preferredWorkflowId;
      }
      if (input.labels !== undefined) updateParams.labels = input.labels;
      if ('cronExpression' in input) updateParams.cronExpression = input.cronExpression;
      if ('runAt' in input) updateParams.runAt = input.runAt;
      if (input.timezone !== undefined) updateParams.timezone = input.timezone;
      scheduleRepo.update(scheduleId, updateParams);

      if (existing.status === 'active' && timingChanged) {
        if (existing.pendingJobId) jobQueue.deleteJob(existing.pendingJobId);

        let pendingJobId: string | null = null;
        if (plannedNextRunAt !== null) {
          const job = jobQueue.enqueue({
            queue: TASK_SCHEDULE_FIRE,
            payload: { scheduleId } satisfies TaskScheduleFirePayload,
            runAt: plannedNextRunAt,
          });
          pendingJobId = job.id;
        }

        scheduleRepo.update(scheduleId, { nextRunAt: plannedNextRunAt ?? undefined });
        scheduleRepo.updatePendingJobId(scheduleId, pendingJobId);
      }
    })();

    return scheduleRepo.getById(scheduleId) as TaskSchedule;
  }

  pauseSchedule(scheduleId: string): TaskSchedule {
    const { scheduleRepo, jobQueue } = this.deps;
    const schedule = scheduleRepo.getById(scheduleId);
    if (!schedule) throw new Error(`Schedule not found: ${scheduleId}`);
    if (schedule.status !== 'active') {
      throw new Error(`Schedule is not active (current: ${schedule.status})`);
    }

    const observedPendingJobId = schedule.pendingJobId;
    if (observedPendingJobId) jobQueue.deleteJob(observedPendingJobId);

    const ok = scheduleRepo.pauseIfPending(scheduleId, 'active', observedPendingJobId);
    if (!ok) {
      const fresh = scheduleRepo.getById(scheduleId);
      if (!fresh) throw new Error(`Schedule not found: ${scheduleId}`);
      return fresh;
    }
    return scheduleRepo.getById(scheduleId) as TaskSchedule;
  }

  resumeSchedule(scheduleId: string): TaskSchedule {
    const { scheduleRepo, jobQueue } = this.deps;
    const schedule = scheduleRepo.getById(scheduleId);
    if (!schedule) throw new Error(`Schedule not found: ${scheduleId}`);
    if (schedule.status !== 'paused') {
      throw new Error(`Schedule is not paused (current: ${schedule.status})`);
    }

    const tz = schedule.timezone;
    let nextRunAt: number | null;
    if (schedule.triggerType === 'cron' && schedule.cronExpression) {
      nextRunAt = getNextRunAt(schedule.cronExpression, tz);
      if (nextRunAt === null) {
        throw new Error(
          `Cannot resume cron schedule: no next run computable from "${schedule.cronExpression}" with timezone "${tz}". Fix the trigger config and try again.`
        );
      }
    } else if (schedule.triggerType === 'at' && schedule.runAt) {
      nextRunAt = schedule.runAt < Date.now() ? null : schedule.runAt;
    } else {
      nextRunAt = null;
    }

    if (nextRunAt === null && schedule.triggerType === 'at') {
      const ok = scheduleRepo.resumeIfPaused(scheduleId, {
        nextRunAt: null,
        pendingJobId: null,
        status: 'completed',
      });
      if (!ok) {
        const fresh = scheduleRepo.getById(scheduleId);
        if (!fresh) throw new Error(`Schedule not found: ${scheduleId}`);
        return fresh;
      }
      return scheduleRepo.getById(scheduleId) as TaskSchedule;
    }

    const job = jobQueue.enqueue({
      queue: TASK_SCHEDULE_FIRE,
      payload: { scheduleId } satisfies TaskScheduleFirePayload,
      runAt: nextRunAt as number,
    });

    const ok = scheduleRepo.resumeIfPaused(scheduleId, {
      nextRunAt,
      pendingJobId: job.id,
      status: 'active',
    });
    if (!ok) {
      jobQueue.deleteJob(job.id);
      const fresh = scheduleRepo.getById(scheduleId);
      if (!fresh) throw new Error(`Schedule not found: ${scheduleId}`);
      return fresh;
    }
    return scheduleRepo.getById(scheduleId) as TaskSchedule;
  }

  deleteSchedule(scheduleId: string): boolean {
    const { scheduleRepo, jobQueue } = this.deps;
    const schedule = scheduleRepo.getById(scheduleId);
    if (!schedule) return false;
    const observedPendingJobId = schedule.pendingJobId;
    if (observedPendingJobId) jobQueue.deleteJob(observedPendingJobId);
    const ok = scheduleRepo.deleteIfPending(scheduleId, observedPendingJobId);
    if (!ok) {
      return false;
    }
    return true;
  }

  getSchedule(scheduleId: string): TaskSchedule | null {
    return this.deps.scheduleRepo.getById(scheduleId);
  }

  listSchedules(spaceId: string, status?: TaskScheduleStatus): TaskSchedule[] {
    return this.deps.scheduleRepo.listBySpace(spaceId, status);
  }

  recoverSchedulesForSpace(spaceId: string): number {
    const { db, scheduleRepo, jobQueue } = this.deps;

    const schedules = scheduleRepo.listActiveBySpace(spaceId);
    let recovered = 0;

    for (const candidate of schedules) {
      if (candidate.pendingJobId) continue;

      db.transaction(() => {
        const schedule = scheduleRepo.getById(candidate.id);
        if (!schedule) return;
        if (schedule.status !== 'active') return;
        if (schedule.pendingJobId) return;

        if (schedule.triggerType === 'cron' && schedule.cronExpression) {
          const next = getNextRunAt(schedule.cronExpression, schedule.timezone);
          if (next === null) {
            return;
          }
          const job = jobQueue.enqueue({
            queue: TASK_SCHEDULE_FIRE,
            payload: { scheduleId: schedule.id } satisfies TaskScheduleFirePayload,
            runAt: next,
          });
          scheduleRepo.update(schedule.id, { nextRunAt: next });
          scheduleRepo.updatePendingJobId(schedule.id, job.id);
          recovered++;
          return;
        }

        if (schedule.triggerType === 'at' && schedule.runAt) {
          if (schedule.runAt < Date.now()) {
            scheduleRepo.updateStatus(schedule.id, 'completed');
            return;
          }
          const job = jobQueue.enqueue({
            queue: TASK_SCHEDULE_FIRE,
            payload: { scheduleId: schedule.id } satisfies TaskScheduleFirePayload,
            runAt: schedule.runAt,
          });
          scheduleRepo.updatePendingJobId(schedule.id, job.id);
          recovered++;
        }
      })();
    }

    return recovered;
  }
}
