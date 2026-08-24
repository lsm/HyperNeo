import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type { TaskSchedule } from '@hyperneo/shared';
import { TASK_SCHEDULE_FIRE } from '../job-queue-constants.ts';
import { readSelfNagScheduleScopeId } from '../rpc-handlers/index.ts';
import { Logger } from '../logger.ts';
import { getNextRunAt } from '../space/schedule/cron-utils.ts';
import type { TaskScheduleRepository } from '../../storage/repositories/task-schedule-repository.ts';
import type { JobQueueRepository, Job } from '../../storage/repositories/job-queue-repository.ts';
import type { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { SpaceGoalService } from '../space/goals/goal-service.ts';
import type { GoalAutomationService } from '../space/goals/goal-automation-service.ts';
import type { SpaceGoalRepository } from '../../storage/repositories/space-goal-repository.ts';

const log = new Logger('task-schedule-fire-handler');

class ScheduleSupersededError extends Error {
  constructor(scheduleId: string, jobId: string) {
    super(`Schedule ${scheduleId} superseded; job ${jobId} no longer the pending fire`);
    this.name = 'ScheduleSupersededError';
  }
}

export interface TaskScheduleFirePayload extends Record<string, unknown> {
  scheduleId: string;
}

export interface TaskScheduleFireResult extends Record<string, unknown> {
  scheduleId: string;
  taskId: string | null;
  skipped: boolean;
  skipReason?: string;
  nextRunAt: number | null;
}

export interface TaskScheduleFireHandlerDeps {
  db: BunDatabase;
  scheduleRepo: TaskScheduleRepository;
  jobQueue: JobQueueRepository;
  spaceRepo: SpaceRepository;
  taskRepo: SpaceTaskRepository;
  goalService?: SpaceGoalService;
  goalRepo?: SpaceGoalRepository;
  goalAutomationService?: Pick<GoalAutomationService, 'onSelfNag'>;
  eventHub?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publish: (event: string, data: any) => Promise<unknown>;
  };
}

export async function handleTaskScheduleFire(
  job: Job,
  deps: TaskScheduleFireHandlerDeps
): Promise<TaskScheduleFireResult> {
  const { scheduleId } = job.payload as TaskScheduleFirePayload;
  const {
    db,
    scheduleRepo,
    jobQueue,
    spaceRepo,
    taskRepo,
    goalService,
    goalRepo,
    goalAutomationService,
    eventHub,
  } = deps;

  const schedule = scheduleRepo.getById(scheduleId);

  if (!schedule || schedule.status !== 'active') {
    log.debug('task-schedule-fire: skipping inactive/missing schedule', { scheduleId });
    return {
      scheduleId,
      taskId: null,
      skipped: true,
      skipReason: 'inactive_or_missing',
      nextRunAt: null,
    };
  }

  const space = spaceRepo.getSpace(schedule.spaceId);
  if (!space || space.status !== 'active' || space.paused || space.stopped) {
    log.debug('task-schedule-fire: skipping schedule for non-active space', {
      scheduleId,
      spaceId: schedule.spaceId,
      spaceStatus: space?.status,
      paused: space?.paused,
      stopped: space?.stopped,
    });

    try {
      db.transaction(() => {
        const fresh = scheduleRepo.getById(scheduleId);
        if (!fresh || fresh.status !== 'active') return;
        if (fresh.pendingJobId !== job.id) return;

        if (fresh.triggerType === 'cron' && fresh.cronExpression) {
          const next = getNextRunAt(fresh.cronExpression, fresh.timezone, Date.now());
          scheduleRepo.update(scheduleId, { nextRunAt: next ?? undefined });
          scheduleRepo.updatePendingJobId(scheduleId, null);
        } else {
          scheduleRepo.updatePendingJobId(scheduleId, null);
        }
      })();
    } catch (err) {
      log.error('task-schedule-fire: clearing pending linkage failed', {
        scheduleId,
        error: err instanceof Error ? err.message : err,
      });
    }

    return {
      scheduleId,
      taskId: null,
      skipped: true,
      skipReason: 'space_not_active',
      nextRunAt: null,
    };
  }

  if (schedule.pendingJobId !== null && schedule.pendingJobId !== job.id) {
    log.debug('task-schedule-fire: skipping — pendingJobId moved past this job', {
      scheduleId,
      jobId: job.id,
      currentPendingJobId: schedule.pendingJobId,
    });
    return {
      scheduleId,
      taskId: schedule.lastCreatedTaskId,
      skipped: true,
      skipReason: 'job_superseded',
      nextRunAt: schedule.nextRunAt,
    };
  }

  const now = Date.now();

  if (schedule.createdByAgent === 'goal-automation-service' && schedule.goalId) {
    return fireGoalAutomationSchedule({
      db,
      job,
      schedule,
      scheduleRepo,
      jobQueue,
      goalRepo,
      goalAutomationService,
      eventHub,
      now,
    });
  }

  let taskId: string | null = null;
  let nextRunAt: number | null = null;

  try {
    const result = db.transaction(() => {
      let computedNextRunAt: number | null = null;
      let pendingJobId: string | null = null;
      let nextStatus: 'active' | 'completed' = 'completed';

      if (schedule.triggerType === 'cron' && schedule.cronExpression) {
        computedNextRunAt = getNextRunAt(schedule.cronExpression, schedule.timezone, now);

        if (computedNextRunAt !== null) {
          const nextJob = jobQueue.enqueue({
            queue: TASK_SCHEDULE_FIRE,
            payload: { scheduleId } satisfies TaskScheduleFirePayload,
            runAt: computedNextRunAt,
          });
          pendingJobId = nextJob.id;
          nextStatus = 'active';
        }
      }

      if (goalService && schedule.goalId) {
        const claimCheck = goalService.canClaimScheduledTask({
          spaceId: schedule.spaceId,
          goalId: schedule.goalId,
        });
        if (!claimCheck.claimable) {
          const applied = scheduleRepo.updateAfterFireIfPending(scheduleId, job.id, {
            lastCreatedTaskId: schedule.lastCreatedTaskId,
            lastRunAt: now,
            nextRunAt: computedNextRunAt,
            status: nextStatus,
            pendingJobId,
          });
          if (!applied) {
            throw new ScheduleSupersededError(scheduleId, job.id);
          }
          if (claimCheck.goal && computedNextRunAt !== claimCheck.goal.nextCheckInAt) {
            goalService.updateScheduledCheckIn(claimCheck.goal.id, computedNextRunAt);
          }
          return { taskId: null, nextRunAt: computedNextRunAt, skipped: true as const };
        }
      }

      const task = taskRepo.createTask({
        spaceId: schedule.spaceId,
        title: schedule.title,
        description: schedule.description,
        priority: schedule.priority,
        preferredWorkflowId: schedule.preferredWorkflowId,
        labels: schedule.labels,
        createdByTaskScheduleId: schedule.id,
        goalId: schedule.goalId,
      });

      const applied = scheduleRepo.updateAfterFireIfPending(scheduleId, job.id, {
        lastCreatedTaskId: task.id,
        lastRunAt: now,
        nextRunAt: computedNextRunAt,
        status: nextStatus,
        pendingJobId,
      });
      if (!applied) {
        throw new ScheduleSupersededError(scheduleId, job.id);
      }
      if (goalService && schedule.goalId) {
        const claimed = goalService.claimScheduledTask(task.id, computedNextRunAt);
        if (!claimed.claimed) {
          throw new Error(`Goal ${schedule.goalId} already has an active task`);
        }
      }

      return { taskId: task.id, nextRunAt: computedNextRunAt, skipped: false as const };
    })();

    taskId = result.taskId;
    nextRunAt = result.nextRunAt;
    if (result.skipped) {
      log.debug('task-schedule-fire: skipped goal contention', { scheduleId, nextRunAt });
    } else {
      log.debug('task-schedule-fire: created task', { scheduleId, taskId, nextRunAt });
    }

    if (eventHub) {
      if (taskId) {
        const emittedTask = taskRepo.getTask(taskId);
        if (emittedTask) {
          eventHub
            .publish('space.task.created', {
              sessionId: 'global',
              spaceId: schedule.spaceId,
              taskId,
              task: emittedTask,
            })
            .catch(() => {});
        }
      }
      const emittedSchedule = scheduleRepo.getById(scheduleId);
      if (emittedSchedule) {
        eventHub
          .publish('space.schedule.updated', {
            sessionId: 'global',
            spaceId: schedule.spaceId,
            scheduleId,
            schedule: emittedSchedule,
          })
          .catch(() => {});
      }
    }
  } catch (err) {
    if (err instanceof ScheduleSupersededError) {
      log.debug('task-schedule-fire: skipping — superseded mid-flight', {
        scheduleId,
        jobId: job.id,
      });
      return {
        scheduleId,
        taskId: null,
        skipped: true,
        skipReason: 'job_superseded',
        nextRunAt: null,
      };
    }
    log.error('task-schedule-fire: transaction failed', {
      scheduleId,
      error: err instanceof Error ? err.message : err,
    });
    throw err;
  }

  if (taskId === null) {
    return {
      scheduleId,
      taskId: null,
      skipped: true,
      skipReason: 'goal_task_already_active',
      nextRunAt,
    };
  }

  return { scheduleId, taskId, skipped: false, nextRunAt };
}

function fireGoalAutomationSchedule(params: {
  db: BunDatabase;
  job: Job;
  schedule: TaskSchedule;
  scheduleRepo: TaskScheduleRepository;
  jobQueue: JobQueueRepository;
  goalRepo?: SpaceGoalRepository;
  goalAutomationService?: Pick<GoalAutomationService, 'onSelfNag'>;
  eventHub?: TaskScheduleFireHandlerDeps['eventHub'];
  now: number;
}): TaskScheduleFireResult {
  const {
    db,
    job,
    schedule,
    scheduleRepo,
    jobQueue,
    goalRepo,
    goalAutomationService,
    eventHub,
    now,
  } = params;
  let computedNextRunAt: number | null = null;
  const goal = schedule.goalId ? goalRepo?.getById(schedule.goalId) : null;
  const automationDisabled =
    schedule.status !== 'active' ||
    schedule.goalId === null ||
    (goalRepo !== undefined && (!goal || goal.status !== 'active'));
  try {
    computedNextRunAt = db.transaction(() => {
      let nextRunAt: number | null = null;
      let pendingJobId: string | null = null;
      let nextStatus: 'active' | 'completed' | 'paused' = automationDisabled ? 'paused' : 'active';
      if (nextStatus === 'active' && schedule.triggerType === 'cron' && schedule.cronExpression) {
        nextRunAt = getNextRunAt(schedule.cronExpression, schedule.timezone, now);
        if (nextRunAt !== null) {
          const nextJob = jobQueue.enqueue({
            queue: TASK_SCHEDULE_FIRE,
            payload: { scheduleId: schedule.id } satisfies TaskScheduleFirePayload,
            runAt: nextRunAt,
          });
          pendingJobId = nextJob.id;
        } else {
          nextStatus = 'completed';
        }
      }
      const applied = scheduleRepo.updateAfterFireIfPending(schedule.id, job.id, {
        lastCreatedTaskId: schedule.lastCreatedTaskId,
        lastRunAt: now,
        nextRunAt,
        status: nextStatus,
        pendingJobId,
      });
      if (!applied) throw new ScheduleSupersededError(schedule.id, job.id);
      return nextRunAt;
    })();
  } catch (err) {
    if (err instanceof ScheduleSupersededError) {
      return {
        scheduleId: schedule.id,
        taskId: null,
        skipped: true,
        skipReason: 'job_superseded',
        nextRunAt: null,
      };
    }
    throw err;
  }
  const scopeId = readSelfNagScheduleScopeId(schedule);
  if (!automationDisabled) {
    try {
      goalAutomationService?.onSelfNag(
        schedule.goalId as string,
        schedule.id,
        scopeId ?? undefined
      );
    } catch (err) {
      log.warn('goal automation self-nag enqueue failed after schedule advance', err);
    }
  }
  const emittedSchedule = scheduleRepo.getById(schedule.id);
  if (eventHub && emittedSchedule) {
    eventHub
      .publish('space.schedule.updated', {
        sessionId: 'global',
        spaceId: schedule.spaceId,
        scheduleId: schedule.id,
        schedule: emittedSchedule,
      })
      .catch(() => {});
  }
  return { scheduleId: schedule.id, taskId: null, skipped: false, nextRunAt: computedNextRunAt };
}
