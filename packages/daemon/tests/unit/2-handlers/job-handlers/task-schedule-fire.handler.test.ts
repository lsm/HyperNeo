import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { handleTaskScheduleFire } from '../../../../src/lib/job-handlers/task-schedule-fire.handler';
import { TASK_SCHEDULE_FIRE } from '../../../../src/lib/job-queue-constants';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { TaskScheduleRepository } from '../../../../src/storage/repositories/task-schedule-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceGoalRepository } from '../../../../src/storage/repositories/space-goal-repository';
import { ScheduleService } from '../../../../src/lib/space/schedule/schedule-service';
import { SpaceGoalService } from '../../../../src/lib/space/goals/goal-service';
import {
  createInternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus';
import { createSpaceTables } from '../../helpers/space-test-db';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    queue: TASK_SCHEDULE_FIRE,
    status: 'processing',
    payload: { scheduleId: 'placeholder' },
    result: null,
    error: null,
    priority: 0,
    maxRetries: 3,
    retryCount: 0,
    runAt: Date.now(),
    createdAt: Date.now(),
    startedAt: Date.now(),
    completedAt: null,
    ...overrides,
  };
}

describe('handleTaskScheduleFire', () => {
  let db: Database;
  let scheduleRepo: TaskScheduleRepository;
  let jobQueue: JobQueueRepository;
  let spaceRepo: SpaceRepository;
  let taskRepo: SpaceTaskRepository;
  let goalRepo: SpaceGoalRepository;
  let goalService: SpaceGoalService;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);

    db.exec(`
			CREATE TABLE IF NOT EXISTS job_queue (
				id TEXT PRIMARY KEY,
				queue TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
				payload TEXT NOT NULL DEFAULT '{}',
				result TEXT,
				error TEXT,
				priority INTEGER NOT NULL DEFAULT 0,
				max_retries INTEGER NOT NULL DEFAULT 3,
				retry_count INTEGER NOT NULL DEFAULT 0,
				run_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				heartbeat_at INTEGER,
				completed_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC);
		`);

    spaceRepo = new SpaceRepository(db as never);
    scheduleRepo = new TaskScheduleRepository(db as never);
    jobQueue = new JobQueueRepository(db as never);
    taskRepo = new SpaceTaskRepository(db as never);
    goalRepo = new SpaceGoalRepository(db as never);
    const scheduleService = new ScheduleService({
      db: db as never,
      scheduleRepo,
      jobQueue,
      spaceRepo,
    });
    goalService = new SpaceGoalService({
      goalRepo,
      taskRepo,
      spaceRepo,
      scheduleService,
      db: db as never,
    });

    const space = spaceRepo.createSpace({
      slug: 'test',
      workspacePath: '/workspace/test',
      name: 'Test',
      description: 'Test space',
    });
    spaceId = space.id;
  });

  afterEach(() => {
    db.close();
  });

  function makeDeps(eventHub?: { publish: (event: string, data: unknown) => Promise<unknown> }) {
    return { db: db as never, scheduleRepo, jobQueue, spaceRepo, taskRepo, eventHub };
  }

  function makeAutomationDeps(eventHub?: {
    publish: (event: string, data: unknown) => Promise<unknown>;
  }) {
    return { ...makeDeps(eventHub), goalRepo };
  }

  function makeGoalDeps(eventHub?: {
    publish: (event: string, data: unknown) => Promise<unknown>;
  }) {
    return { ...makeDeps(eventHub), goalService };
  }

  function createCronSchedule(goalId?: string): string {
    const future = Date.now() + 60_000;
    const schedule = scheduleRepo.create({
      spaceId,
      title: 'Daily Standup',
      description: 'Standup task',
      triggerType: 'cron',
      cronExpression: '0 9 * * 1-5',
      timezone: 'UTC',
      nextRunAt: future,
      goalId,
    });
    return schedule.id;
  }

  function createAtSchedule(runAt: number): string {
    const schedule = scheduleRepo.create({
      spaceId,
      title: 'One Shot',
      triggerType: 'at',
      runAt,
      nextRunAt: runAt,
    });
    return schedule.id;
  }

  it('routes goal automation self-nag by immutable schedule metadata', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Automation goal', type: 'recurring' });
    const scheduleId = scheduleRepo.create({
      spaceId,
      title: 'Forge self nag',
      description: 'Automation schedule',
      triggerType: 'cron',
      cronExpression: '0 9 * * 1-5',
      timezone: 'UTC',
      nextRunAt: Date.now() + 60_000,
      goalId: goal.id,
      labels: ['user-edited'],
      metadata: { goalAutomationScopeId: 'scope-stable' },
      createdByAgent: 'goal-automation-service',
    }).id;
    scheduleRepo.updatePendingJobId(scheduleId, 'job-1');
    const calls: unknown[][] = [];

    const result = await handleTaskScheduleFire(makeJob({ payload: { scheduleId } }), {
      ...makeDeps(),
      goalAutomationService: {
        onSelfNag: (...args: unknown[]) => {
          calls.push(args);
          return { enqueued: true, reason: 'queued' as const };
        },
      },
    });

    expect(result.skipped).toBe(false);
    expect(result.taskId).toBeNull();
    expect(calls).toEqual([[goal.id, scheduleId, 'scope-stable']]);
  });

  it('keeps schedule advancement when goal automation enqueue throws after commit', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Automation goal', type: 'recurring' });
    const scheduleId = scheduleRepo.create({
      spaceId,
      title: 'Forge self nag',
      description: 'Automation schedule',
      triggerType: 'cron',
      cronExpression: '0 9 * * 1-5',
      timezone: 'UTC',
      nextRunAt: Date.now() + 60_000,
      goalId: goal.id,
      metadata: { goalAutomationScopeId: 'scope-stable' },
      createdByAgent: 'goal-automation-service',
    }).id;
    scheduleRepo.updatePendingJobId(scheduleId, 'job-1');

    const result = await handleTaskScheduleFire(makeJob({ payload: { scheduleId } }), {
      ...makeAutomationDeps(),
      goalAutomationService: {
        onSelfNag: () => {
          throw new Error('synthetic self-nag failure');
        },
      },
    });

    expect(result.skipped).toBe(false);
    expect(result.nextRunAt).not.toBeNull();
    const updated = scheduleRepo.getById(scheduleId);
    expect(updated?.status).toBe('active');
    expect(updated?.pendingJobId).not.toBeNull();
    expect(updated?.pendingJobId).not.toBe('job-1');
    expect(updated?.lastRunAt).not.toBeNull();
  });

  it('completes self-nag schedule without re-enqueueing when goal is inactive', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Automation goal', type: 'recurring' });
    goalRepo.update(goal.id, { status: 'completed' });
    const scheduleId = scheduleRepo.create({
      spaceId,
      title: 'Forge self nag',
      description: 'Automation schedule',
      triggerType: 'cron',
      cronExpression: '0 9 * * 1-5',
      timezone: 'UTC',
      nextRunAt: Date.now() + 60_000,
      goalId: goal.id,
      metadata: { goalAutomationScopeId: 'scope-stable' },
      createdByAgent: 'goal-automation-service',
    }).id;
    scheduleRepo.updatePendingJobId(scheduleId, 'job-1');
    const beforeJobs = jobQueue.listJobs({}).length;
    const calls: unknown[][] = [];

    const result = await handleTaskScheduleFire(makeJob({ payload: { scheduleId } }), {
      ...makeAutomationDeps(),
      goalAutomationService: {
        onSelfNag: (...args: unknown[]) => {
          calls.push(args);
          return { enqueued: false, reason: 'disabled' as const };
        },
      },
    });

    expect(result.skipped).toBe(false);
    expect(result.nextRunAt).toBeNull();
    expect(calls).toEqual([]);
    expect(jobQueue.listJobs({})).toHaveLength(beforeJobs);
    const updated = scheduleRepo.getById(scheduleId);
    expect(updated?.status).toBe('paused');
    expect(updated?.pendingJobId).toBeNull();
  });

  it('creates a SpaceTask from the cron schedule template and re-enqueues itself', async () => {
    const scheduleId = createCronSchedule('goal-1');
    scheduleRepo.updatePendingJobId(scheduleId, 'job-1');

    const job = makeJob({ payload: { scheduleId } });
    const result = await handleTaskScheduleFire(job, makeDeps());

    expect(result.skipped).toBe(false);
    expect(result.taskId).not.toBeNull();
    expect(result.nextRunAt).not.toBeNull();

    const task = taskRepo.getTask(result.taskId as string);
    expect(task).not.toBeNull();
    expect(task?.createdByTaskScheduleId).toBe(scheduleId);
    expect(task?.goalId).toBe('goal-1');
    expect(task?.title).toBe('Daily Standup');

    const updated = scheduleRepo.getById(scheduleId);
    expect(updated?.pendingJobId).not.toBeNull();
    expect(updated?.pendingJobId).not.toBe('job-1');
    expect(updated?.lastCreatedTaskId).toBe(result.taskId);
    expect(updated?.status).toBe('active');
  });

  it('claims scheduled goal tasks and syncs the next check-in time', async () => {
    const goal = goalRepo.create({
      spaceId,
      title: 'Scheduled Goal',
      autoTriggerNext: true,
    });
    const scheduleId = createCronSchedule(goal.id);
    scheduleRepo.updatePendingJobId(scheduleId, 'job-1');
    goalRepo.setTaskScheduleId(goal.id, scheduleId);
    goalRepo.update(goal.id, { nextCheckInAt: Date.now() + 1_000 });

    const result = await handleTaskScheduleFire(
      makeJob({ payload: { scheduleId } }),
      makeGoalDeps()
    );

    expect(result.skipped).toBe(false);
    expect(result.taskId).not.toBeNull();
    const updated = goalRepo.getById(goal.id);
    expect(updated?.activeTaskId).toBe(result.taskId);
    expect(updated?.lastTaskId).toBe(result.taskId);
    expect(updated?.nextCheckInAt).toBe(result.nextRunAt);
  });

  it('stamps the goal workspace on schedule-spawned goal tasks', async () => {
    const goal = goalRepo.create({
      spaceId,
      title: 'Pinned Goal',
      workspacePath: '/secondary',
    });
    const scheduleId = createCronSchedule(goal.id);
    scheduleRepo.updatePendingJobId(scheduleId, 'job-1');

    const result = await handleTaskScheduleFire(makeJob({ payload: { scheduleId } }), {
      ...makeGoalDeps(),
      goalRepo,
    });

    expect(result.skipped).toBe(false);
    expect(taskRepo.getTask(result.taskId ?? '')?.workspacePath).toBe('/secondary');
  });

  it('stores a null workspace on schedule-spawned tasks for unpinned goals', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Unpinned Goal' });
    const scheduleId = createCronSchedule(goal.id);
    scheduleRepo.updatePendingJobId(scheduleId, 'job-1');

    const result = await handleTaskScheduleFire(makeJob({ payload: { scheduleId } }), {
      ...makeGoalDeps(),
      goalRepo,
    });

    expect(result.skipped).toBe(false);
    expect(taskRepo.getTask(result.taskId ?? '')?.workspacePath).toBeNull();
  });

  it('advances the schedule without creating a task when another goal task is active', async () => {
    const goal = goalRepo.create({
      spaceId,
      title: 'Busy Goal',
      autoTriggerNext: true,
    });
    const activeTask = taskRepo.createTask({
      spaceId,
      title: 'Existing goal task',
      goalId: goal.id,
    });
    expect(goalRepo.claimActiveTask(goal.id, activeTask.id)).toBe(true);

    const scheduleId = createCronSchedule(goal.id);
    scheduleRepo.updatePendingJobId(scheduleId, 'job-1');

    const result = await handleTaskScheduleFire(
      makeJob({ payload: { scheduleId } }),
      makeGoalDeps()
    );

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('goal_task_already_active');
    expect(result.taskId).toBeNull();
    expect(taskRepo.listBySpace(spaceId).map((task) => task.id)).toEqual([activeTask.id]);
    const updated = scheduleRepo.getById(scheduleId);
    expect(updated?.lastCreatedTaskId).toBeNull();
    expect(updated?.pendingJobId).not.toBe('job-1');
    expect(updated?.pendingJobId).not.toBeNull();
    expect(goalRepo.getById(goal.id)?.activeTaskId).toBe(activeTask.id);
  });

  it('marks one-shot schedule as completed and does not re-enqueue', async () => {
    const future = Date.now() + 60_000;
    const scheduleId = createAtSchedule(future);
    scheduleRepo.updatePendingJobId(scheduleId, 'job-1');

    const beforeJobs = jobQueue.listJobs({}).length;

    const job = makeJob({ payload: { scheduleId } });
    const result = await handleTaskScheduleFire(job, makeDeps());

    expect(result.skipped).toBe(false);
    expect(result.taskId).not.toBeNull();
    expect(result.nextRunAt).toBeNull();

    const updated = scheduleRepo.getById(scheduleId);
    expect(updated?.status).toBe('completed');
    expect(updated?.pendingJobId).toBeNull();

    const afterJobs = jobQueue.listJobs({}).length;
    expect(afterJobs).toBe(beforeJobs);
  });

  it('emits task and schedule events after a scheduled task fires', async () => {
    const scheduleId = createCronSchedule();
    scheduleRepo.updatePendingJobId(scheduleId, 'job-1');
    const internalEventBus = createInternalEventBus<DaemonInternalEventMap>();
    const emitted: Array<{ event: string; taskId?: string; scheduleId?: string }> = [];

    internalEventBus.subscribe(
      'space.task.created',
      (payload) => {
        emitted.push({ event: 'space.task.created', taskId: payload.taskId });
      },
      { subscriberName: 'test' }
    );
    internalEventBus.subscribe(
      'space.schedule.updated',
      (payload) => {
        emitted.push({ event: 'space.schedule.updated', scheduleId: payload.scheduleId });
      },
      { subscriberName: 'test' }
    );

    const result = await handleTaskScheduleFire(
      makeJob({ payload: { scheduleId } }),
      makeDeps({ publish: (event, data) => internalEventBus.publish(event, data as any) })
    );

    await Promise.resolve();

    expect(result.skipped).toBe(false);
    expect(emitted).toEqual([
      { event: 'space.task.created', taskId: result.taskId as string },
      { event: 'space.schedule.updated', scheduleId },
    ]);
  });

  it('skips when schedule is missing', async () => {
    const job = makeJob({ payload: { scheduleId: 'nonexistent' } });
    const result = await handleTaskScheduleFire(job, makeDeps());

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('inactive_or_missing');
    expect(result.taskId).toBeNull();
  });

  it('skips when schedule is paused', async () => {
    const scheduleId = createCronSchedule();
    scheduleRepo.updateStatus(scheduleId, 'paused');

    const job = makeJob({ payload: { scheduleId } });
    const result = await handleTaskScheduleFire(job, makeDeps());

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('inactive_or_missing');
  });

  it('skips when host space is archived (no task created)', async () => {
    const scheduleId = createCronSchedule();
    scheduleRepo.updatePendingJobId(scheduleId, 'job-1');
    spaceRepo.archiveSpace(spaceId);

    const job = makeJob({ payload: { scheduleId } });
    const result = await handleTaskScheduleFire(job, makeDeps());

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('space_not_active');
    expect(result.taskId).toBeNull();

    const after = scheduleRepo.getById(scheduleId);
    expect(after?.lastCreatedTaskId).toBeNull();
  });

  it('skips when host space is paused (no task created, pending linkage cleared)', async () => {
    const scheduleId = createCronSchedule();
    scheduleRepo.updatePendingJobId(scheduleId, 'job-1');
    spaceRepo.pauseSpace(spaceId);

    const job = makeJob({ payload: { scheduleId } });
    const result = await handleTaskScheduleFire(job, makeDeps());

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('space_not_active');
    expect(taskRepo.listBySpace(spaceId)).toHaveLength(0);

    const after = scheduleRepo.getById(scheduleId);
    expect(after?.pendingJobId).toBeNull();
    expect(after?.status).toBe('active');
  });

  it('skips when host space is stopped (no task created, pending linkage cleared)', async () => {
    const scheduleId = createCronSchedule();
    scheduleRepo.updatePendingJobId(scheduleId, 'job-1');
    spaceRepo.stopSpace(spaceId);

    const job = makeJob({ payload: { scheduleId } });
    const result = await handleTaskScheduleFire(job, makeDeps());

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('space_not_active');
    expect(taskRepo.listBySpace(spaceId)).toHaveLength(0);

    const after = scheduleRepo.getById(scheduleId);
    expect(after?.pendingJobId).toBeNull();
    expect(after?.status).toBe('active');
  });

  it('rolls back when a concurrent pause invalidates pendingJobId mid-fire', async () => {
    const scheduleId = createCronSchedule();
    scheduleRepo.updatePendingJobId(scheduleId, 'job-1');

    const wrappedScheduleRepo = new Proxy(scheduleRepo, {
      get(target, prop, recv) {
        if (prop === 'updateAfterFireIfPending') {
          return () => false;
        }
        return Reflect.get(target, prop, recv);
      },
    }) as typeof scheduleRepo;

    const result = await handleTaskScheduleFire(makeJob({ payload: { scheduleId } }), {
      ...makeDeps(),
      scheduleRepo: wrappedScheduleRepo,
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('job_superseded');
    expect(taskRepo.listBySpace(spaceId)).toHaveLength(0);
    const after = scheduleRepo.getById(scheduleId);
    expect(after?.lastCreatedTaskId).toBeNull();
    expect(after?.lastRunAt).toBeNull();
  });

  it('skips on retry once pendingJobId has been advanced past this job (idempotency fence)', async () => {
    const scheduleId = createCronSchedule();
    scheduleRepo.updatePendingJobId(scheduleId, 'job-1');

    const firstResult = await handleTaskScheduleFire(
      makeJob({ payload: { scheduleId } }),
      makeDeps()
    );
    expect(firstResult.skipped).toBe(false);
    const tasksAfterFirst = taskRepo.listBySpace(spaceId).length;

    const retryResult = await handleTaskScheduleFire(
      makeJob({ id: 'job-1', payload: { scheduleId } }),
      makeDeps()
    );
    expect(retryResult.skipped).toBe(true);
    expect(retryResult.skipReason).toBe('job_superseded');

    const tasksAfterRetry = taskRepo.listBySpace(spaceId).length;
    expect(tasksAfterRetry).toBe(tasksAfterFirst);
  });

  it('rolls back the transaction if any step throws (no half-fired state)', async () => {
    const scheduleId = createCronSchedule();
    scheduleRepo.updatePendingJobId(scheduleId, 'job-1');

    const brokenJobQueue = {
      ...jobQueue,
      enqueue: () => {
        throw new Error('synthetic enqueue failure');
      },
    } as unknown as typeof jobQueue;

    await expect(
      handleTaskScheduleFire(makeJob({ payload: { scheduleId } }), {
        db: db as never,
        scheduleRepo,
        jobQueue: brokenJobQueue,
        spaceRepo,
        taskRepo,
      })
    ).rejects.toThrow('synthetic enqueue failure');

    const after = scheduleRepo.getById(scheduleId);
    expect(after?.lastCreatedTaskId).toBeNull();
    expect(after?.status).toBe('active');
    expect(taskRepo.listBySpace(spaceId)).toHaveLength(0);
  });
});
