import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from '../../../src/storage/sqlite-compat';
import { SpaceGoalService } from '../../../src/lib/space/goals/goal-service';
import { ScheduleService } from '../../../src/lib/space/schedule/schedule-service';
import { JobQueueRepository } from '../../../src/storage/repositories/job-queue-repository';
import { SpaceGoalEventRepository } from '../../../src/storage/repositories/space-goal-event-repository';
import { SpaceGoalOutcomeNotificationRepository } from '../../../src/storage/repositories/space-goal-outcome-notification-repository';
import { SpaceGoalRepository } from '../../../src/storage/repositories/space-goal-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository';
import { TaskScheduleRepository } from '../../../src/storage/repositories/task-schedule-repository';
import { createSpaceTables } from '../helpers/space-test-db';

function createJobQueueTable(db: Database): void {
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
}

describe('SpaceGoalService', () => {
  let db: Database;
  let goalRepo: SpaceGoalRepository;
  let goalEventRepo: SpaceGoalEventRepository;
  let taskRepo: SpaceTaskRepository;
  let notificationRepo: SpaceGoalOutcomeNotificationRepository;
  let spaceRepo: SpaceRepository;
  let scheduleRepo: TaskScheduleRepository;
  let scheduleService: ScheduleService;
  let service: SpaceGoalService;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    createJobQueueTable(db);

    goalRepo = new SpaceGoalRepository(db as never);
    goalEventRepo = new SpaceGoalEventRepository(db as never);
    taskRepo = new SpaceTaskRepository(db as never);
    notificationRepo = new SpaceGoalOutcomeNotificationRepository(db as never);
    spaceRepo = new SpaceRepository(db as never);
    scheduleRepo = new TaskScheduleRepository(db as never);
    scheduleService = new ScheduleService({
      db: db as never,
      scheduleRepo,
      jobQueue: new JobQueueRepository(db as never),
      spaceRepo,
    });
    service = new SpaceGoalService({
      goalRepo,
      goalEventRepo,
      taskRepo,
      spaceRepo,
      scheduleService,
      db: db as never,
      outcomeNotificationRepo: notificationRepo,
    });

    const space = spaceRepo.createSpace({
      slug: 'test',
      workspacePath: '/workspace/test',
      name: 'Test Space',
    });
    spaceId = space.id;
  });

  afterEach(() => {
    db.close();
  });

  it('creates a goal with rolling state and an optional recurring check-in schedule', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Improve onboarding',
      description: 'Make first-run experience smoother',
      type: 'recurring',
      priority: 'high',
      labels: ['product'],
      metrics: { activated: 10 },
      summary: 'Initial state',
      progress: 35,
      nextSteps: ['Audit current flow'],
      preferredWorkflowId: 'workflow-1',
      checkInCronExpression: '0 9 * * 1',
      checkInTimezone: 'UTC',
    });

    expect(goal.title).toBe('Improve onboarding');
    expect(goal.type).toBe('recurring');
    expect(goal.priority).toBe('high');
    expect(goal.labels).toEqual(['product']);
    expect(goal.metrics).toEqual({ activated: 10 });
    expect(goal.summary).toBe('Initial state');
    expect(goal.progress).toBe(35);
    expect(goal.nextSteps).toEqual(['Audit current flow']);
    expect(goal.taskScheduleId).toBeString();
    expect(goal.nextCheckInAt).not.toBeNull();

    const schedule = scheduleRepo.getById(goal.taskScheduleId as string);
    expect(schedule?.goalId).toBe(goal.id);
    expect(schedule?.preferredWorkflowId).toBe('workflow-1');
    expect(schedule?.labels).toEqual(['goal', `goal:${goal.id}`, 'product']);

    const createdEvent = goalEventRepo
      .listByGoal(goal.id)
      .find((event) => event.eventType === 'created');
    expect(createdEvent?.newState?.taskScheduleId).toBe(goal.taskScheduleId);
    expect(createdEvent?.newState?.nextCheckInAt).toBe(goal.nextCheckInAt);
  });

  it('paginates same-timestamp goal events with id cursor', () => {
    const goal = service.createGoal({ spaceId, title: 'Cursor goal' });
    const timestamp = Date.now() + 1000;
    const first = goalEventRepo.create({
      spaceId,
      goalId: goal.id,
      eventType: 'updated',
      source: 'system',
      createdAt: timestamp,
      note: 'first',
    });
    const second = goalEventRepo.create({
      spaceId,
      goalId: goal.id,
      eventType: 'updated',
      source: 'system',
      createdAt: timestamp,
      note: 'second',
    });
    const third = goalEventRepo.create({
      spaceId,
      goalId: goal.id,
      eventType: 'updated',
      source: 'system',
      createdAt: timestamp,
      note: 'third',
    });
    const ordered = [first, second, third].sort((a, b) => b.id.localeCompare(a.id));

    const page1 = goalEventRepo.listByGoal(goal.id, { limit: 1, before: timestamp, beforeId: '~' });
    expect(page1.map((event) => event.id)).toEqual([ordered[0]!.id]);
    const page2 = goalEventRepo.listByGoal(goal.id, {
      limit: 2,
      before: page1[0]!.createdAt,
      beforeId: page1[0]!.id,
    });
    expect(page2.map((event) => event.id)).toEqual([ordered[1]!.id, ordered[2]!.id]);

    const timestampOnlyGoalPage = goalEventRepo.listByGoal(goal.id, { before: timestamp });
    expect(timestampOnlyGoalPage.every((event) => event.createdAt < timestamp)).toBe(true);
    expect(timestampOnlyGoalPage.map((event) => event.id)).not.toContain(first.id);
    expect(timestampOnlyGoalPage.map((event) => event.id)).not.toContain(second.id);
    expect(timestampOnlyGoalPage.map((event) => event.id)).not.toContain(third.id);
    const timestampOnlySpacePage = goalEventRepo.listBySpace(spaceId, { before: timestamp });
    expect(timestampOnlySpacePage.every((event) => event.createdAt < timestamp)).toBe(true);
    expect(timestampOnlySpacePage.map((event) => event.id)).not.toContain(first.id);
    expect(timestampOnlySpacePage.map((event) => event.id)).not.toContain(second.id);
    expect(timestampOnlySpacePage.map((event) => event.id)).not.toContain(third.id);
  });

  it('ignores progress updates and omits progress event state for recurring goals', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Keep releases healthy',
      type: 'recurring',
      progress: 25,
    });

    const updated = service.updateGoal(goal.id, {
      summary: 'Release train green',
      progress: 90,
      metrics: { build_health: 'green' },
      nextSteps: ['Watch flaky tests'],
    });

    expect(updated.progress).toBe(25);
    expect(goalRepo.getById(goal.id)?.progress).toBe(25);
    expect(updated.summary).toBe('Release train green');
    expect(updated.metrics).toEqual({ build_health: 'green' });
    expect(updated.nextSteps).toEqual(['Watch flaky tests']);
    const updateEvent = goalEventRepo
      .listByGoal(goal.id)
      .find((event) => event.eventType === 'updated');
    expect(updateEvent?.newState?.progress).toBeUndefined();
    expect(updateEvent?.diff?.progress).toBeUndefined();
  });

  it('preserves supplied progress when converting a recurring goal to a non-recurring type', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Convert me',
      type: 'recurring',
      progress: 25,
    });

    const updated = service.updateGoal(goal.id, { type: 'one_shot', progress: 80 });

    expect(updated.type).toBe('one_shot');
    expect(updated.progress).toBe(80);
    expect(goalRepo.getById(goal.id)?.progress).toBe(80);
    const updateEvent = goalEventRepo
      .listByGoal(goal.id)
      .find((event) => event.eventType === 'updated');
    expect(updateEvent?.previousState?.progress).toBeUndefined();
    expect(updateEvent?.newState?.progress).toBe(80);
    expect(updateEvent?.diff?.progress).toEqual({ previous: 25, current: 80 });
  });

  it('does not record a synthetic progress diff when leaving recurring type without progress', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Convert without progress',
      type: 'recurring',
      progress: 25,
    });

    const updated = service.updateGoal(goal.id, { type: 'one_shot' });

    expect(updated.type).toBe('one_shot');
    expect(updated.progress).toBe(25);
    const updateEvent = goalEventRepo
      .listByGoal(goal.id)
      .find((event) => event.eventType === 'updated');
    expect(updateEvent?.previousState?.progress).toBeUndefined();
    expect(updateEvent?.newState?.progress).toBe(25);
    expect(updateEvent?.diff?.progress).toBeUndefined();
  });

  it('records goal update, status, task, and schedule events', () => {
    const goal = service.createGoal({ spaceId, title: 'Audit me', autoTriggerNext: true });
    const createdEvents = goalEventRepo.listByGoal(goal.id);
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]?.eventType).toBe('created');
    expect(createdEvents[0]?.newState?.title).toBe('Audit me');

    const updated = service.updateGoal(
      goal.id,
      { summary: 'Moved forward', progress: 50 },
      { source: 'space_agent_tool', sourceSessionId: 'session-1' }
    );
    expect(updated.progress).toBe(50);

    const paused = service.pauseGoal(goal.id, { source: 'rpc' });
    expect(paused.status).toBe('paused');
    service.resumeGoal(goal.id, { source: 'rpc' });
    service.updateScheduledCheckIn(goal.id, Date.now() + 60_000);

    const first = service.createImmediateTask(goal.id);
    service.createImmediateTask(goal.id);
    taskRepo.updateTask(first.task!.id, { status: 'done' });
    service.handleTaskTerminal(first.task!.id);

    const events = goalEventRepo.listByGoal(goal.id, { limit: 20 });
    expect(events.map((event) => event.eventType)).toContain('created');
    expect(events.map((event) => event.eventType)).toContain('updated');
    expect(events.map((event) => event.eventType)).toContain('status_changed');
    expect(events.map((event) => event.eventType)).toContain('schedule_updated');
    expect(events.map((event) => event.eventType)).toContain('task_triggered');
    expect(events.map((event) => event.eventType)).toContain('task_queued');
    expect(events.map((event) => event.eventType)).toContain('task_terminal');
    const updateEvent = events.find((event) => event.eventType === 'updated');
    expect(updateEvent?.source).toBe('space_agent_tool');
    expect(updateEvent?.sourceSessionId).toBe('session-1');
    expect(updateEvent?.diff?.progress).toEqual({ previous: 0, current: 50 });
    const terminalEvent = events.find((event) => event.eventType === 'task_terminal');
    expect(terminalEvent?.sourceTaskId).toBe(first.task?.id);
  });

  it('publishes triggerImmediately task-created events after create transaction commits', () => {
    const visibleDuringPublish: boolean[] = [];
    service = new SpaceGoalService({
      goalRepo,
      goalEventRepo,
      taskRepo,
      spaceRepo,
      scheduleService: new ScheduleService({
        db: db as never,
        scheduleRepo,
        jobQueue: new JobQueueRepository(db as never),
        spaceRepo,
      }),
      db: db as never,
      eventHub: {
        publish: async (_event, data) => {
          visibleDuringPublish.push(Boolean(taskRepo.getTask((data as { taskId: string }).taskId)));
        },
      },
    });

    const goal = service.createGoal({ spaceId, title: 'Trigger now', triggerImmediately: true });

    expect(goal.activeTaskId).toBeString();
    expect(visibleDuringPublish).toEqual([true]);
  });

  it('creates an immediate goal task and queues concurrent triggers', () => {
    const events: Array<{ event: string; taskId?: string }> = [];
    service = new SpaceGoalService({
      goalRepo,
      goalEventRepo,
      taskRepo,
      spaceRepo,
      scheduleService: new ScheduleService({
        db: db as never,
        scheduleRepo,
        jobQueue: new JobQueueRepository(db as never),
        spaceRepo,
      }),
      db: db as never,
      eventHub: {
        publish: async (event, data) => {
          events.push({ event, taskId: (data as { taskId?: string }).taskId });
        },
      },
    });
    const goal = service.createGoal({
      spaceId,
      title: 'Ship docs',
      labels: ['docs'],
      preferredWorkflowId: 'workflow-docs',
      autoTriggerNext: true,
    });

    const first = service.createImmediateTask(goal.id);
    expect(first.queued).toBe(false);
    expect(first.task?.goalId).toBe(goal.id);
    expect(first.task?.preferredWorkflowId).toBe('workflow-docs');
    expect(first.task?.labels).toEqual(['goal', `goal:${goal.id}`, 'docs']);
    expect(first.goal.activeTaskId).toBe(first.task?.id);
    expect(events).toEqual([{ event: 'space.task.created', taskId: first.task?.id }]);

    const second = service.createImmediateTask(goal.id);
    expect(second.queued).toBe(true);
    expect(second.task).toBeNull();
    expect(second.goal.pendingNextRun).toBe(true);
  });

  it('rejects concurrent manual triggers when auto-trigger is disabled', () => {
    const goal = service.createGoal({ spaceId, title: 'Manual only' });
    const first = service.createImmediateTask(goal.id);
    expect(first.task).not.toBeNull();

    expect(() => service.createImmediateTask(goal.id)).toThrow(
      'Goal already has an active task and autoTriggerNext is disabled'
    );
    expect(goalRepo.getById(goal.id)?.pendingNextRun).toBe(false);
  });

  it('blocks immediate and auto-triggered goal tasks when host space is paused', () => {
    const manualGoal = service.createGoal({ spaceId, title: 'Paused manual task' });
    spaceRepo.pauseSpace(spaceId);
    expect(() => service.createImmediateTask(manualGoal.id)).toThrow(
      'Cannot create goal task in a non-active space'
    );

    spaceRepo.resumeSpace(spaceId);
    const autoGoal = service.createGoal({
      spaceId,
      title: 'Paused auto task',
      autoTriggerNext: true,
    });
    const first = service.createImmediateTask(autoGoal.id);
    expect(first.task).not.toBeNull();
    service.createImmediateTask(autoGoal.id);
    spaceRepo.pauseSpace(spaceId);
    taskRepo.updateTask(first.task!.id, { status: 'done' });

    const terminal = service.handleTaskTerminal(first.task!.id);
    expect(terminal?.nextTask).toBeNull();
    expect(goalRepo.getById(autoGoal.id)?.activeTaskId).toBeNull();
    expect(taskRepo.listBySpace(spaceId).map((task) => task.id)).toEqual([first.task!.id]);
  });

  it('auto-triggers one queued task after the active task reaches a terminal status', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Keep improving',
      autoTriggerNext: true,
    });
    const first = service.createImmediateTask(goal.id);
    expect(first.task).not.toBeNull();
    service.createImmediateTask(goal.id);

    taskRepo.updateTask(first.task!.id, { status: 'done' });
    const terminal = service.handleTaskTerminal(first.task!.id);

    expect(terminal?.nextTask).not.toBeNull();
    expect(terminal?.nextTask?.goalId).toBe(goal.id);
    const updated = goalRepo.getById(goal.id);
    expect(updated?.activeTaskId).toBe(terminal?.nextTask?.id);
    expect(updated?.pendingNextRun).toBe(false);
  });

  it('clears active task pointer for all terminal statuses', () => {
    for (const status of ['done', 'blocked', 'cancelled', 'archived'] as const) {
      const goal = service.createGoal({ spaceId, title: `Terminal ${status}` });
      const created = service.createImmediateTask(goal.id);
      expect(created.task).not.toBeNull();

      taskRepo.updateTask(created.task!.id, { status });
      const terminal = service.handleTaskTerminal(created.task!.id);

      expect(terminal?.goal.id).toBe(goal.id);
      expect(goalRepo.getById(goal.id)?.activeTaskId).toBeNull();
    }
  });

  it('ignores terminal and scheduled tasks linked to goals in another space', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Scoped goal',
    });
    const otherSpace = spaceRepo.createSpace({
      slug: 'other',
      workspacePath: '/workspace/other',
      name: 'Other Space',
    });
    const task = taskRepo.createTask({
      spaceId: otherSpace.id,
      title: 'Cross-space task',
      goalId: goal.id,
    });
    expect(goalRepo.claimActiveTask(goal.id, task.id)).toBe(true);

    taskRepo.updateTask(task.id, { status: 'done' });

    expect(service.handleTaskTerminal(task.id)).toBeNull();
    expect(service.canClaimScheduledTask({ spaceId: otherSpace.id, goalId: goal.id })).toEqual({
      goal: null,
      claimable: false,
    });
    expect(service.claimScheduledTask(task.id, Date.now() + 60_000)).toEqual({
      goal: null,
      claimed: false,
    });
    expect(goalRepo.getById(goal.id)?.activeTaskId).toBe(task.id);
  });

  it('clears stale active task pointers before claiming scheduled goal tasks', () => {
    const goal = service.createGoal({ spaceId, title: 'Recover stale active task' });
    const staleTask = taskRepo.createTask({
      spaceId,
      title: 'Already finished',
      goalId: goal.id,
    });
    expect(goalRepo.claimActiveTask(goal.id, staleTask.id)).toBe(true);
    taskRepo.updateTask(staleTask.id, { status: 'done' });

    const scheduledTask = taskRepo.createTask({
      spaceId,
      title: 'Scheduled follow-up',
      goalId: goal.id,
    });

    expect(service.canClaimScheduledTask({ spaceId, goalId: goal.id }).claimable).toBe(true);
    expect(service.claimScheduledTask(scheduledTask.id, Date.now() + 60_000).claimed).toBe(true);
    expect(goalRepo.getById(goal.id)?.activeTaskId).toBe(scheduledTask.id);
  });

  it('keeps linked schedules in sync with goal lifecycle changes', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Weekly check-in',
      checkInCronExpression: '0 9 * * 1',
    });
    const scheduleId = goal.taskScheduleId as string;

    const paused = service.pauseGoal(goal.id);
    expect(paused.status).toBe('paused');
    expect(paused.nextCheckInAt).toBeNull();
    expect(scheduleRepo.getById(scheduleId)?.status).toBe('paused');

    const resumed = service.resumeGoal(goal.id);
    expect(resumed.status).toBe('active');
    expect(resumed.nextCheckInAt).not.toBeNull();
    expect(scheduleRepo.getById(scheduleId)?.status).toBe('active');

    const completed = service.updateGoal(goal.id, { status: 'completed' });
    expect(completed.status).toBe('completed');
    expect(completed.nextCheckInAt).toBeNull();
    expect(scheduleRepo.getById(scheduleId)?.status).toBe('paused');

    const reactivated = service.updateGoal(goal.id, { status: 'active' });
    expect(reactivated.status).toBe('active');
    expect(reactivated.nextCheckInAt).not.toBeNull();
    expect(scheduleRepo.getById(scheduleId)?.status).toBe('active');
  });

  it('syncs linked schedule template fields after goal updates', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Weekly check-in',
      description: 'Old description',
      labels: ['old'],
      preferredWorkflowId: 'workflow-old',
      checkInCronExpression: '0 9 * * 1',
    });
    const scheduleId = goal.taskScheduleId as string;

    service.updateGoal(goal.id, {
      title: 'Updated check-in',
      description: 'New description',
      priority: 'high',
      labels: ['new'],
      summary: 'Fresh state',
      nextSteps: ['Do next thing'],
      preferredWorkflowId: 'workflow-new',
    });

    const schedule = scheduleRepo.getById(scheduleId);
    expect(schedule?.title).toBe('Goal check-in: Updated check-in');
    expect(schedule?.description).toContain('New description');
    expect(schedule?.description).toContain('Fresh state');
    expect(schedule?.description).toContain('Do next thing');
    expect(schedule?.priority).toBe('high');
    expect(schedule?.labels).toEqual(['goal', `goal:${goal.id}`, 'new']);
    expect(schedule?.preferredWorkflowId).toBe('workflow-new');

    service.updateGoal(goal.id, { title: 'Title only' });
    const titleOnlySchedule = scheduleRepo.getById(scheduleId);
    expect(titleOnlySchedule?.description).toContain('Do next thing');
    expect(titleOnlySchedule?.preferredWorkflowId).toBe('workflow-new');
  });

  it('clears a missing linked schedule instead of blocking lifecycle changes', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Schedule drift',
      checkInCronExpression: '0 9 * * 1',
    });
    scheduleRepo.delete(goal.taskScheduleId as string);

    const paused = service.pauseGoal(goal.id);
    expect(paused.status).toBe('paused');
    expect(paused.taskScheduleId).toBeNull();
  });

  it('clears a missing linked schedule instead of blocking template updates', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Template drift',
      checkInCronExpression: '0 9 * * 1',
    });
    scheduleRepo.delete(goal.taskScheduleId as string);

    const updated = service.updateGoal(goal.id, { title: 'Updated after drift' });
    expect(updated.title).toBe('Updated after drift');
    expect(updated.taskScheduleId).toBeNull();
  });

  it('skips linked schedule template sync when update omits template fields', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Schedule drift update',
      checkInCronExpression: '0 9 * * 1',
    });
    scheduleRepo.delete(goal.taskScheduleId as string);

    const updated = service.updateGoal(goal.id, { autoTriggerNext: true });
    expect(updated.autoTriggerNext).toBe(true);
    expect(updated.taskScheduleId).toBe(goal.taskScheduleId);
  });

  it('preserves completedAt when completed goals are updated again', () => {
    const goal = service.createGoal({ spaceId, title: 'Complete once' });
    const completed = service.updateGoal(goal.id, { status: 'completed' });
    const completedAt = completed.completedAt;
    expect(completedAt).not.toBeNull();

    const updated = service.updateGoal(goal.id, { status: 'completed', summary: 'More detail' });
    expect(updated.completedAt).toBe(completedAt);
  });

  it('preserves completedAt when completed goals are archived', () => {
    const goal = service.createGoal({ spaceId, title: 'Archive after completion' });
    const completed = service.updateGoal(goal.id, { status: 'completed' });
    const completedAt = completed.completedAt;
    expect(completedAt).not.toBeNull();

    const archived = service.updateGoal(goal.id, { status: 'archived' });
    expect(archived.status).toBe('archived');
    expect(archived.completedAt).toBe(completedAt);
  });

  it('preserves completedAt when archived completed goals are edited again', () => {
    const goal = service.createGoal({ spaceId, title: 'Edit archived completion' });
    const completed = service.updateGoal(goal.id, { status: 'completed' });
    const completedAt = completed.completedAt;
    expect(completedAt).not.toBeNull();

    service.updateGoal(goal.id, { status: 'archived' });
    const edited = service.updateGoal(goal.id, {
      status: 'archived',
      summary: 'Archived goal still has completion timestamp',
    });

    expect(edited.status).toBe('archived');
    expect(edited.completedAt).toBe(completedAt);
  });

  function pendingFireJobCount(scheduleId: string): number {
    const row = db
      .prepare(
        `SELECT COUNT(*) as n FROM job_queue
          WHERE queue = 'taskSchedule.fire' AND status = 'pending'
            AND json_extract(payload, '$.scheduleId') = ?`
      )
      .get(scheduleId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  it('updates a recurring goal cron in place (twice daily → hourly) preserving identity', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Recurring',
      type: 'recurring',
      checkInCronExpression: '0 0,12 * * *',
      checkInTimezone: 'UTC',
    });
    const scheduleId = goal.taskScheduleId as string;
    const originalJobId = scheduleRepo.getById(scheduleId)?.pendingJobId;
    expect(originalJobId).toBeString();

    const updated = service.updateGoal(goal.id, { checkInCronExpression: '0 * * * *' });

    expect(updated.id).toBe(goal.id);
    expect(updated.taskScheduleId).toBe(scheduleId);
    expect(updated.activeTaskId).toBeNull();
    expect(updated.lastTaskId).toBeNull();
    expect(updated.pendingNextRun).toBe(false);
    const schedule = scheduleRepo.getById(scheduleId);
    expect(schedule?.cronExpression).toBe('0 * * * *');
    expect(updated.nextCheckInAt).not.toBeNull();
    expect((updated.nextCheckInAt as number) - Date.now()).toBeLessThan(60 * 60 * 1000 + 5000);
    expect(pendingFireJobCount(scheduleId)).toBe(1);
    expect(schedule?.pendingJobId).toBeString();
    expect(schedule?.pendingJobId).not.toBe(originalJobId);
    expect(db.prepare(`SELECT id FROM job_queue WHERE id = ?`).get(originalJobId)).toBeFalsy();
  });

  it('recomputes nextCheckInAt when only the timezone changes', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'TZ goal',
      type: 'recurring',
      checkInCronExpression: '0 9 * * *',
      checkInTimezone: 'UTC',
    });
    const originalNext = goal.nextCheckInAt;

    const updated = service.updateGoal(goal.id, { checkInTimezone: 'Asia/Tokyo' });

    expect(scheduleRepo.getById(goal.taskScheduleId as string)?.timezone).toBe('Asia/Tokyo');
    expect(updated.nextCheckInAt).not.toBe(originalNext);
    expect(pendingFireJobCount(goal.taskScheduleId as string)).toBe(1);
  });

  it('updates a paused goal schedule without enqueuing a job, applying cadence on resume', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Paused cadence',
      type: 'recurring',
      checkInCronExpression: '0 9 * * 1',
    });
    service.pauseGoal(goal.id);
    const scheduleId = goal.taskScheduleId as string;
    expect(scheduleRepo.getById(scheduleId)?.status).toBe('paused');
    expect(pendingFireJobCount(scheduleId)).toBe(0);

    const updated = service.updateGoal(goal.id, { checkInCronExpression: '0 * * * *' });

    const schedule = scheduleRepo.getById(scheduleId);
    expect(schedule?.status).toBe('paused');
    expect(schedule?.cronExpression).toBe('0 * * * *');
    expect(updated.nextCheckInAt).toBeNull();
    expect(pendingFireJobCount(scheduleId)).toBe(0);

    const resumed = service.resumeGoal(goal.id);
    expect(resumed.nextCheckInAt).not.toBeNull();
    expect(scheduleRepo.getById(scheduleId)?.status).toBe('active');
    expect(pendingFireJobCount(scheduleId)).toBe(1);
  });

  it('keeps nextCheckInAt null when an active goal edits a paused linked schedule', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Drift paused',
      type: 'recurring',
      checkInCronExpression: '0 9 * * 1',
    });
    const scheduleId = goal.taskScheduleId as string;
    scheduleService.pauseSchedule(scheduleId);
    expect(goal.status).toBe('active');

    const updated = service.updateGoal(goal.id, { checkInCronExpression: '0 * * * *' });

    expect(scheduleRepo.getById(scheduleId)?.cronExpression).toBe('0 * * * *');
    expect(scheduleRepo.getById(scheduleId)?.status).toBe('paused');
    expect(updated.nextCheckInAt).toBeNull();
    expect(pendingFireJobCount(scheduleId)).toBe(0);
  });

  it('nulls nextCheckInAt and re-pauses a drifted active schedule for a non-active goal', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Drifted active',
      type: 'recurring',
      checkInCronExpression: '0 9 * * 1',
    });
    const scheduleId = goal.taskScheduleId as string;
    service.pauseGoal(goal.id);
    scheduleService.resumeSchedule(scheduleId);
    expect(scheduleRepo.getById(scheduleId)?.status).toBe('active');

    const updated = service.updateGoal(goal.id, { checkInCronExpression: '0 * * * *' });

    expect(updated.status).toBe('paused');
    expect(updated.nextCheckInAt).toBeNull();
    expect(scheduleRepo.getById(scheduleId)?.cronExpression).toBe('0 * * * *');
    expect(scheduleRepo.getById(scheduleId)?.status).toBe('paused');
    expect(pendingFireJobCount(scheduleId)).toBe(0);
  });

  it('adds a schedule to an existing goal that has none', () => {
    const goal = service.createGoal({ spaceId, title: 'No schedule', type: 'recurring' });
    expect(goal.taskScheduleId).toBeNull();
    expect(goal.nextCheckInAt).toBeNull();

    const updated = service.updateGoal(goal.id, {
      checkInCronExpression: '0 9 * * 1',
      checkInTimezone: 'UTC',
    });

    expect(updated.taskScheduleId).not.toBeNull();
    expect(updated.nextCheckInAt).not.toBeNull();
    const schedule = scheduleRepo.getById(updated.taskScheduleId as string);
    expect(schedule?.cronExpression).toBe('0 9 * * 1');
    expect(schedule?.goalId).toBe(goal.id);
    expect(pendingFireJobCount(updated.taskScheduleId as string)).toBe(1);
  });

  it('removes a linked schedule when checkInCronExpression is cleared', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Remove me',
      type: 'recurring',
      checkInCronExpression: '0 9 * * 1',
    });
    const scheduleId = goal.taskScheduleId as string;
    expect(pendingFireJobCount(scheduleId)).toBe(1);

    const updated = service.updateGoal(goal.id, { checkInCronExpression: null });

    expect(updated.taskScheduleId).toBeNull();
    expect(updated.nextCheckInAt).toBeNull();
    expect(scheduleRepo.getById(scheduleId)).toBeNull();
    expect(pendingFireJobCount(scheduleId)).toBe(0);
  });

  it('preserves active task pointer and pendingNextRun when editing the schedule mid-run', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Active task',
      type: 'recurring',
      checkInCronExpression: '0 9 * * 1',
      autoTriggerNext: true,
    });
    const { task } = service.createImmediateTask(goal.id);
    expect(task).not.toBeNull();
    const queued = service.createImmediateTask(goal.id);
    expect(queued.queued).toBe(true);

    const before = service.getGoal(goal.id);
    expect(before?.activeTaskId).toBe(task!.id);
    expect(before?.pendingNextRun).toBe(true);

    const updated = service.updateGoal(goal.id, { checkInCronExpression: '0 * * * *' });

    expect(updated.activeTaskId).toBe(task!.id);
    expect(updated.pendingNextRun).toBe(true);
    expect(updated.taskScheduleId).toBe(goal.taskScheduleId);
  });

  it('records a goal event capturing the schedule cadence change', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Audited cadence',
      type: 'recurring',
      checkInCronExpression: '0 9 * * 1',
    });

    service.updateGoal(goal.id, { checkInCronExpression: '0 * * * *' });

    const events = service.listGoalEvents(goal.id);
    const last = events[0];
    expect(last?.eventType).toBe('updated');
    expect(last?.diff?.nextCheckInAt).toBeDefined();
  });

  it('rejects an invalid cron expression when editing the schedule', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Validate',
      type: 'recurring',
      checkInCronExpression: '0 9 * * 1',
    });

    expect(() => service.updateGoal(goal.id, { checkInCronExpression: 'not a cron' })).toThrow(
      /cron/i
    );
    expect(scheduleRepo.getById(goal.taskScheduleId as string)?.cronExpression).toBe('0 9 * * 1');
  });

  it('rejects a non-string checkInCronExpression instead of treating it as removal', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Type check',
      type: 'recurring',
      checkInCronExpression: '0 9 * * 1',
    });

    expect(() =>
      service.updateGoal(goal.id, {
        checkInCronExpression: false as unknown as string,
      })
    ).toThrow(/checkInCronExpression must be a string or null/i);
    expect(scheduleRepo.getById(goal.taskScheduleId as string)?.cronExpression).toBe('0 9 * * 1');
  });

  it('rejects a null checkInTimezone instead of silently resetting to UTC', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Tz null',
      type: 'recurring',
      checkInCronExpression: '0 9 * * 1',
      checkInTimezone: 'Asia/Tokyo',
    });

    expect(() =>
      service.updateGoal(goal.id, {
        checkInTimezone: null as unknown as string,
      })
    ).toThrow(/checkInTimezone must be a string/i);
    expect(scheduleRepo.getById(goal.taskScheduleId as string)?.timezone).toBe('Asia/Tokyo');
  });

  it('leaves the schedule untouched when checkInCronExpression is omitted', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Omit cron',
      type: 'recurring',
      checkInCronExpression: '0 9 * * 1',
    });
    const scheduleId = goal.taskScheduleId as string;
    const before = scheduleRepo.getById(scheduleId);

    service.updateGoal(goal.id, { summary: 'Just a summary edit' });

    const after = scheduleRepo.getById(scheduleId);
    expect(after?.cronExpression).toBe('0 9 * * 1');
    expect(after?.pendingJobId).toBe(before?.pendingJobId);
  });

  it('rolls back status + invalid-cadence updates atomically (no partial disable)', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Atomic',
      type: 'recurring',
      checkInCronExpression: '0 9 * * 1',
    });
    const scheduleId = goal.taskScheduleId as string;
    expect(scheduleRepo.getById(scheduleId)?.status).toBe('active');
    expect(pendingFireJobCount(scheduleId)).toBe(1);

    expect(() =>
      service.updateGoal(goal.id, { status: 'paused', checkInCronExpression: 'bad cron' })
    ).toThrow(/cron/i);

    const after = service.getGoal(goal.id);
    expect(after?.status).toBe('active');
    expect(after?.nextCheckInAt).not.toBeNull();
    expect(scheduleRepo.getById(scheduleId)?.status).toBe('active');
    expect(pendingFireJobCount(scheduleId)).toBe(1);
  });

  it('does not clear the link when schedule removal loses its CAS', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'CAS',
      type: 'recurring',
      checkInCronExpression: '0 9 * * 1',
    });
    const spy = spyOn(scheduleService, 'deleteSchedule').mockReturnValue(false);
    try {
      expect(() => service.updateGoal(goal.id, { checkInCronExpression: null })).toThrow(
        /remove check-in schedule/i
      );
      const after = service.getGoal(goal.id);
      expect(after?.taskScheduleId).toBe(goal.taskScheduleId);
      expect(scheduleRepo.getById(goal.taskScheduleId as string)).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('clears a stale link when schedule removal finds the schedule already gone', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Already gone',
      type: 'recurring',
      checkInCronExpression: '0 9 * * 1',
    });
    scheduleRepo.delete(goal.taskScheduleId as string);

    const updated = service.updateGoal(goal.id, { checkInCronExpression: null });

    expect(updated.taskScheduleId).toBeNull();
    expect(updated.nextCheckInAt).toBeNull();
  });

  it('recreates a missing linked schedule when a cron is supplied (stale ref)', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Stale',
      type: 'recurring',
      checkInCronExpression: '0 9 * * 1',
    });
    const staleId = goal.taskScheduleId as string;
    scheduleRepo.delete(staleId);

    const updated = service.updateGoal(goal.id, { checkInCronExpression: '0 * * * *' });

    expect(updated.taskScheduleId).not.toBeNull();
    expect(updated.taskScheduleId).not.toBe(staleId);
    expect(updated.nextCheckInAt).not.toBeNull();
    const schedule = scheduleRepo.getById(updated.taskScheduleId as string);
    expect(schedule?.cronExpression).toBe('0 * * * *');
    expect(schedule?.goalId).toBe(goal.id);
  });

  it('records cadence changes in the audit diff even for paused goals', () => {
    const goal = service.createGoal({
      spaceId,
      title: 'Audit paused',
      type: 'recurring',
      checkInCronExpression: '0 9 * * 1',
    });
    service.pauseGoal(goal.id);

    service.updateGoal(goal.id, { checkInCronExpression: '0 * * * *' });

    const events = service.listGoalEvents(goal.id);
    const last = events[0];
    expect(last?.eventType).toBe('updated');
    expect(last?.diff?.checkInCronExpression).toBeDefined();
    expect((last?.diff?.checkInCronExpression as { previous: string }).previous).toBe('0 9 * * 1');
    expect((last?.diff?.checkInCronExpression as { current: string }).current).toBe('0 * * * *');
  });

  it('increments the goal revision monotonically on each mutation', () => {
    const goal = service.createGoal({ spaceId, title: 'Revision counter' });
    expect(goal.revision).toBe(1);

    const updated = service.updateGoal(goal.id, { summary: 'v2' });
    expect(updated.revision).toBe(2);

    const again = service.updateGoal(goal.id, { progress: 50 });
    expect(again.revision).toBe(3);

    expect(goalRepo.getById(goal.id)?.revision).toBe(3);
  });

  it('exposes the durable terminal generation from handleTaskTerminal', () => {
    const goal = service.createGoal({ spaceId, title: 'Generation goal' });
    const task = service.createImmediateTask(goal.id);
    expect(task.task).not.toBeNull();

    taskRepo.updateTask(task.task!.id, { status: 'in_progress' });
    taskRepo.updateTask(task.task!.id, { status: 'open' });
    taskRepo.updateTask(task.task!.id, { status: 'done' });

    const done = taskRepo.getTask(task.task!.id);
    expect(done?.terminalGeneration).toBe(1);

    const terminal = service.handleTaskTerminal(task.task!.id);
    expect(terminal?.terminalGeneration).toBe(1);

    taskRepo.updateTask(task.task!.id, { status: 'open' });
    taskRepo.updateTask(task.task!.id, { status: 'cancelled' });
    const reopened = taskRepo.getTask(task.task!.id);
    expect(reopened?.terminalGeneration).toBe(2);

    taskRepo.updateTask(task.task!.id, { status: 'cancelled' });
    expect(taskRepo.getTask(task.task!.id)?.terminalGeneration).toBe(2);
  });

  it('advances the terminal generation through the CAS writer', () => {
    const goal = service.createGoal({ spaceId, title: 'CAS generation goal' });
    const task = service.createImmediateTask(goal.id);
    expect(task.task).not.toBeNull();

    taskRepo.updateTask(task.task!.id, { status: 'in_progress' });
    const won = taskRepo.casStatus(task.task!.id, 'in_progress', 'blocked');
    expect(won).toBe('won');
    expect(taskRepo.getTask(task.task!.id)?.terminalGeneration).toBe(1);

    const superseded = taskRepo.casStatus(task.task!.id, 'in_progress', 'done');
    expect(superseded).toBe('superseded');
    expect(taskRepo.getTask(task.task!.id)?.terminalGeneration).toBe(1);
  });

  it('advances the terminal generation through the archive writer without re-advancing archived rows', () => {
    const goal = service.createGoal({ spaceId, title: 'Archive generation goal' });
    const task = service.createImmediateTask(goal.id);
    expect(task.task).not.toBeNull();

    taskRepo.updateTask(task.task!.id, { status: 'in_progress' });
    taskRepo.archiveTask(task.task!.id);
    expect(taskRepo.getTask(task.task!.id)?.terminalGeneration).toBe(1);

    taskRepo.archiveTask(task.task!.id);
    expect(taskRepo.getTask(task.task!.id)?.terminalGeneration).toBe(1);
  });

  it('persists a pending outcome notification for a reportable terminal transition', () => {
    const goal = service.createGoal({ spaceId, title: 'Notify goal' });
    const task = service.createImmediateTask(goal.id);
    expect(task.task).not.toBeNull();
    taskRepo.updateTask(task.task!.id, { status: 'in_progress' });
    taskRepo.updateTask(task.task!.id, { status: 'open' });
    taskRepo.updateTask(task.task!.id, { status: 'done' });

    service.handleTaskTerminal(task.task!.id);

    const pending = notificationRepo.listPendingByGoal(goal.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].taskId).toBe(task.task!.id);
    expect(pending[0].goalRevision).toBe(goalRepo.getById(goal.id)?.revision);
    expect(pending[0].terminalGeneration).toBe(1);
    expect(pending[0].payload.taskTitle).toBe(task.task!.title);
    expect(pending[0].payload.goalTitle).toBe(goal.title);
  });

  it('does not persist a notification for an administrative (unstarted) terminal transition', () => {
    const goal = service.createGoal({ spaceId, title: 'No notify goal' });
    const task = service.createImmediateTask(goal.id);
    expect(task.task).not.toBeNull();
    taskRepo.archiveTask(task.task!.id);

    service.handleTaskTerminal(task.task!.id);

    expect(notificationRepo.listPendingByGoal(goal.id)).toHaveLength(0);
  });

  it('supersedes pending notifications when a terminal task is reopened', () => {
    const goal = service.createGoal({ spaceId, title: 'Supersede goal' });
    const task = service.createImmediateTask(goal.id);
    expect(task.task).not.toBeNull();
    taskRepo.updateTask(task.task!.id, { status: 'in_progress' });
    taskRepo.updateTask(task.task!.id, { status: 'done' });
    service.handleTaskTerminal(task.task!.id);
    expect(notificationRepo.listPendingByGoal(goal.id)).toHaveLength(1);

    service.supersedeOutcomeNotificationsForTask(task.task!.id);

    expect(notificationRepo.listPendingByGoal(goal.id)).toHaveLength(0);
    expect(notificationRepo.countByGoal(goal.id, 'superseded')).toBe(1);
  });

  it('keeps the current generation pending when a terminal transition is retried', () => {
    const goal = service.createGoal({ spaceId, title: 'Retry outcome' });
    const task = service.createImmediateTask(goal.id);
    expect(task.task).not.toBeNull();
    taskRepo.updateTask(task.task!.id, { status: 'in_progress' });
    service.handleTaskTerminal(task.task!.id, {
      fromStatus: 'in_progress',
      updates: { status: 'done' },
    });
    expect(notificationRepo.listPendingByGoal(goal.id)).toHaveLength(1);

    service.handleTaskTerminal(task.task!.id, {
      fromStatus: 'in_progress',
      updates: { status: 'done' },
    });
    const pending = notificationRepo.listPendingByGoal(goal.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe('pending');
  });

  it('does not re-run terminal bookkeeping for an already-notified generation', () => {
    const goal = service.createGoal({ spaceId, title: 'Idempotent goal' });
    const task = service.createImmediateTask(goal.id);
    expect(task.task).not.toBeNull();
    taskRepo.updateTask(task.task!.id, { status: 'in_progress' });
    taskRepo.updateTask(task.task!.id, { status: 'done' });
    service.handleTaskTerminal(task.task!.id);
    service.handleTaskTerminal(task.task!.id);

    expect(notificationRepo.listPendingByGoal(goal.id)).toHaveLength(1);
    const events = goalEventRepo.listByGoal(goal.id);
    expect(events.filter((event) => event.eventType === 'task_terminal')).toHaveLength(1);
  });

  it('rolls back the terminal write and notification together when notification creation fails', () => {
    const goal = service.createGoal({ spaceId, title: 'Atomic goal' });
    const task = service.createImmediateTask(goal.id);
    expect(task.task).not.toBeNull();
    taskRepo.updateTask(task.task!.id, { status: 'in_progress' });

    const spy = spyOn(notificationRepo, 'create').mockImplementation(() => {
      throw new Error('injected notification failure');
    });

    expect(() =>
      service.handleTaskTerminal(task.task!.id, {
        fromStatus: 'in_progress',
        updates: { status: 'done', result: 'shipped' },
      })
    ).toThrow('injected notification failure');
    spy.mockRestore();

    expect(taskRepo.getTask(task.task!.id)?.status).toBe('in_progress');
    expect(notificationRepo.listPendingByGoal(goal.id)).toHaveLength(0);
    expect(taskRepo.getTask(task.task!.id)?.result).toBeNull();
  });
});
