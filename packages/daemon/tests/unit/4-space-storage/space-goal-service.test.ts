import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceGoalService } from '../../../src/lib/space/goals/goal-service';
import { ScheduleService } from '../../../src/lib/space/schedule/schedule-service';
import { JobQueueRepository } from '../../../src/storage/repositories/job-queue-repository';
import { SpaceGoalEventRepository } from '../../../src/storage/repositories/space-goal-event-repository';
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
  let spaceRepo: SpaceRepository;
  let scheduleRepo: TaskScheduleRepository;
  let service: SpaceGoalService;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    createJobQueueTable(db);

    goalRepo = new SpaceGoalRepository(db as never);
    goalEventRepo = new SpaceGoalEventRepository(db as never);
    taskRepo = new SpaceTaskRepository(db as never);
    spaceRepo = new SpaceRepository(db as never);
    scheduleRepo = new TaskScheduleRepository(db as never);
    const scheduleService = new ScheduleService({
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

    expect(() => service.handleTaskTerminal(first.task!.id)).toThrow(
      'Cannot create goal task in a non-active space'
    );
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
});
