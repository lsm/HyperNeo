import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Job } from '../../../src/storage/repositories/job-queue-repository';
import { GOAL_AUTOMATION_EXECUTE } from '../../../src/lib/job-queue-constants';
import { handleGoalAutomationExecute } from '../../../src/lib/job-handlers/goal-automation-execute.handler';
import {
  GoalAutomationService,
  externalEventTriggerKey,
} from '../../../src/lib/space/goals/goal-automation-service';
import { EvolutionScopeService } from '../../../src/lib/space/evolution-scope-service';
import { EvolutionRepository } from '../../../src/storage/repositories/evolution-repository';
import { GateOpenStateRepository } from '../../../src/storage/repositories/gate-open-state-repository';
import { GoalAutomationCursorRepository } from '../../../src/storage/repositories/goal-automation-cursor-repository';
import { JobQueueRepository } from '../../../src/storage/repositories/job-queue-repository';
import { SpaceGoalRepository } from '../../../src/storage/repositories/space-goal-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository';
import { TaskScheduleRepository } from '../../../src/storage/repositories/task-schedule-repository';
import {
  validateGoalAutomationSelfNagPolicy,
  syncGoalAutomationSelfNagScheduleForScope,
} from '../../../src/lib/rpc-handlers';
import { ScheduleService } from '../../../src/lib/space/schedule/schedule-service';
import { createSpaceTables } from '../helpers/space-test-db';

function createAutomationJob(payload: Job['payload'], id = 'job-automation'): Job {
  return {
    id,
    queue: GOAL_AUTOMATION_EXECUTE,
    status: 'processing',
    payload,
    result: null,
    error: null,
    priority: 0,
    maxRetries: 2,
    retryCount: 0,
    runAt: Date.now(),
    createdAt: Date.now(),
    startedAt: Date.now(),
    completedAt: null,
  } satisfies Job;
}

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
		)
	`);
}

describe('GoalAutomationService', () => {
  let db: Database;
  let evolutionRepo: EvolutionRepository;
  let cursorRepo: GoalAutomationCursorRepository;
  let goalRepo: SpaceGoalRepository;
  let jobQueue: JobQueueRepository;
  let service: GoalAutomationService;
  let scheduleRepo: TaskScheduleRepository;
  let scheduleService: ScheduleService;
  let scopeService: EvolutionScopeService;
  let spaceRepo: SpaceRepository;
  let taskRepo: SpaceTaskRepository;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    createJobQueueTable(db);
    evolutionRepo = new EvolutionRepository(db as never);
    cursorRepo = new GoalAutomationCursorRepository(db as never);
    goalRepo = new SpaceGoalRepository(db as never);
    jobQueue = new JobQueueRepository(db as never);
    scheduleRepo = new TaskScheduleRepository(db as never);
    spaceRepo = new SpaceRepository(db as never);
    taskRepo = new SpaceTaskRepository(db as never);
    scheduleService = new ScheduleService({
      db: db as never,
      scheduleRepo,
      jobQueue,
      spaceRepo,
    });
    scopeService = new EvolutionScopeService({
      evolutionRepo,
      spaceRepo,
      goalRepo,
      taskRepo,
      workflowRunRepo: new SpaceWorkflowRunRepository(
        db as never,
        new GateOpenStateRepository(db as never)
      ),
    });
    service = new GoalAutomationService({
      goalRepo,
      taskRepo,
      evolutionRepo,
      cursorRepo,
      jobQueue,
      evolutionScopeService: scopeService,
    });
    spaceId = spaceRepo.createSpace({
      workspacePath: '/workspace/goal-automation-test',
      slug: 'goal-automation-test',
      name: 'Goal Automation Test',
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  it('enqueues completed-task automation when evidence reaches threshold', () => {
    const goal = goalRepo.create({ spaceId, title: 'Improve retrospectives', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Improve retrospectives',
      objective: 'Learn from completed work',
      policy: { automation: { completedTaskThreshold: 2 } },
    });
    const first = taskRepo.createTask({ spaceId, title: 'First task', goalId: goal.id });
    const second = taskRepo.createTask({ spaceId, title: 'Second task', goalId: goal.id });
    taskRepo.updateTask(first.id, { status: 'done', result: 'First result' });
    taskRepo.updateTask(second.id, { status: 'done', result: 'Second result' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: first.id,
      summary: 'First result',
      createdAt: 10,
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: second.id,
      summary: 'Second result',
      createdAt: 20,
    });

    const result = service.onTaskCompleted(second.id);

    expect(result).toEqual({ enqueued: true, reason: 'queued', count: 2 });
    const jobs = jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'pending' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'completed_task_threshold',
      triggerKey: 'threshold:2',
      reason: 'task_completed',
      taskId: second.id,
    });
  });

  it('counts all due task evidence when threshold exceeds episode evidence cap', () => {
    const goal = goalRepo.create({ spaceId, title: 'Large batch', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Large batch',
      objective: 'Process larger task batches',
      policy: { automation: { completedTaskThreshold: 13 } },
    });
    let lastTaskId = '';
    for (let i = 1; i <= 13; i++) {
      const task = taskRepo.createTask({ spaceId, title: `Task ${i}`, goalId: goal.id });
      taskRepo.updateTask(task.id, { status: 'done' });
      evolutionRepo.createEvidence({
        scopeId: scope.id,
        kind: 'task_result',
        sourceId: task.id,
        summary: `Task ${i} result`,
        createdAt: i,
      });
      lastTaskId = task.id;
    }

    const result = service.onTaskCompleted(lastTaskId);

    expect(result).toEqual({ enqueued: true, reason: 'queued', count: 13 });
    expect(jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'pending' })).toHaveLength(
      1
    );
  });

  it('reads completed-task policy from the task scope', () => {
    const goal = goalRepo.create({ spaceId, title: 'Scoped policy', type: 'recurring' });
    evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Unrelated scope',
      objective: 'Should not control the task',
      policy: { automation: { completedTaskThreshold: 99 } },
    });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Task scope',
      objective: 'Should control the task',
      policy: { automation: { completedTaskThreshold: 1 } },
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Scoped task',
      goalId: goal.id,
      evolutionScopeId: scope.id,
    });
    taskRepo.updateTask(task.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Scoped result',
      createdAt: 10,
    });

    const result = service.onTaskCompleted(task.id);

    expect(result).toEqual({ enqueued: true, reason: 'queued', count: 1 });
  });

  it('uses default completed-task threshold when unset', () => {
    const goal = goalRepo.create({ spaceId, title: 'Default threshold', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Default threshold',
      objective: 'Use default batch size',
      policy: {},
    });
    let lastTaskId = '';
    for (let i = 1; i <= 10; i++) {
      const task = taskRepo.createTask({ spaceId, title: `Task ${i}`, goalId: goal.id });
      taskRepo.updateTask(task.id, { status: 'done' });
      evolutionRepo.createEvidence({
        scopeId: scope.id,
        kind: 'task_result',
        sourceId: task.id,
        summary: `Task ${i} result`,
        createdAt: i,
      });
      lastTaskId = task.id;
    }

    const result = service.onTaskCompleted(lastTaskId);

    expect(result).toEqual({ enqueued: true, reason: 'queued', count: 10 });
    const jobs = jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'pending' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({ triggerKey: 'threshold:10' });
  });

  it('skips completed-task automation when count-based policy is disabled', () => {
    const goal = goalRepo.create({ spaceId, title: 'Disabled count', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Disabled count',
      objective: 'Do not run count automation',
      policy: {
        automation: { completedTaskThreshold: 1, completedTaskAutomationEnabled: false },
      },
    });
    const task = taskRepo.createTask({ spaceId, title: 'Done task', goalId: goal.id });
    taskRepo.updateTask(task.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Done',
      createdAt: 10,
    });

    const result = service.onTaskCompleted(task.id);

    expect(result).toEqual({ enqueued: false, reason: 'disabled' });
    expect(jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'pending' })).toHaveLength(
      0
    );
  });

  it('queues pending count automation instead of overlapping active review tasks', () => {
    const goal = goalRepo.create({ spaceId, title: 'No overlap', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'No overlap',
      objective: 'Avoid duplicate reviews',
      policy: { automation: { completedTaskThreshold: 1 } },
    });
    const activeTask = taskRepo.createTask({
      spaceId,
      title: 'Review Forge retrospective: No overlap',
      goalId: goal.id,
      evolutionScopeId: scope.id,
      labels: [
        'forge',
        'review',
        'automation',
        'automation:completed_task_threshold:threshold:1:run',
      ],
    });
    taskRepo.updateTask(activeTask.id, { status: 'in_progress' });
    const task = taskRepo.createTask({ spaceId, title: 'Done task', goalId: goal.id });
    taskRepo.updateTask(task.id, { status: 'done' });
    const evidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Done',
      createdAt: 10,
    });

    const result = service.onTaskCompleted(task.id);

    expect(result).toEqual({ enqueued: true, reason: 'queued', count: 1 });
    expect(jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'pending' })).toHaveLength(
      0
    );
    const updatedGoal = goalRepo.getById(goal.id);
    expect(updatedGoal?.pendingNextRun).toBe(true);
    const cursor = cursorRepo.get(goal.id, scope.id, 'completed_task_threshold', 'threshold:1');
    expect(cursor).toMatchObject({
      lastEvidenceCreatedAt: 10,
      lastEvidenceId: evidence.id,
      metadata: {
        reason: 'task_completed_pending_active_review',
        pendingNextRun: true,
        taskId: task.id,
        evidenceCount: 1,
      },
    });
  });

  it('uses cursor state to avoid duplicate threshold retrospectives', () => {
    const goal = goalRepo.create({ spaceId, title: 'Avoid duplicates', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Avoid duplicates',
      objective: 'Learn once per batch',
      policy: { automation: { completedTaskThreshold: 2 } },
    });
    const first = taskRepo.createTask({ spaceId, title: 'First task', goalId: goal.id });
    const second = taskRepo.createTask({ spaceId, title: 'Second task', goalId: goal.id });
    taskRepo.updateTask(first.id, { status: 'done' });
    taskRepo.updateTask(second.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: first.id,
      summary: 'First result',
      createdAt: 10,
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: second.id,
      summary: 'Second result',
      createdAt: 20,
    });
    cursorRepo.upsert({
      spaceId,
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'completed_task_threshold',
      triggerKey: 'threshold:2',
      lastEvidenceCreatedAt: 20,
      lastEvidenceId:
        evolutionRepo.listEvidence(scope.id).find((e) => e.sourceId === second.id)?.id ?? null,
      lastTaskCompletedAt: null,
      lastExternalEventId: null,
      lastEpisodeId: null,
      lastFiredAt: Date.now(),
      metadata: {},
    });

    const result = service.onTaskCompleted(second.id);

    expect(result).toEqual({ enqueued: false, reason: 'below_threshold', count: 0 });
    expect(jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'pending' })).toHaveLength(
      0
    );
  });

  it('enqueues matching external event subscriptions once per event', () => {
    const goal = goalRepo.create({ spaceId, title: 'React to reviews', type: 'recurring' });
    const subscription = {
      source: 'github',
      topic: 'pull_request/*',
      filter: { action: 'closed' },
    };
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'React to reviews',
      objective: 'Learn from PR events',
      policy: { automation: { eventSubscriptions: [subscription] } },
    });

    const [result] = service.onExternalEventPublished({
      eventId: 'event-1',
      spaceId,
      source: 'github',
      topic: 'pull_request/closed',
      dedupeKey: 'pr-1',
      summary: 'PR closed',
      externalUrl: 'https://example.test/pr/1',
      payload: { action: 'closed' },
      occurredAt: 30,
      ingestedAt: 31,
    });

    expect(result).toEqual({ enqueued: true, reason: 'queued' });
    const jobs = jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'pending' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'external_event',
      triggerKey: externalEventTriggerKey(subscription),
      externalEventId: 'event-1',
    });

    cursorRepo.upsert({
      spaceId,
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'external_event',
      triggerKey: externalEventTriggerKey(subscription),
      lastEvidenceCreatedAt: null,
      lastTaskCompletedAt: null,
      lastExternalEventId: 'event-1',
      lastEpisodeId: null,
      lastFiredAt: Date.now(),
      metadata: {},
    });

    const [duplicate] = service.onExternalEventPublished({
      eventId: 'event-1',
      spaceId,
      source: 'github',
      topic: 'pull_request/closed',
      dedupeKey: 'pr-1',
      summary: 'PR closed',
      payload: { action: 'closed' },
      occurredAt: 30,
      ingestedAt: 31,
    });

    expect(duplicate).toEqual({ enqueued: false, reason: 'not_applicable' });
  });

  it('skips self-nag when no new evidence exists after the cursor', () => {
    const goal = goalRepo.create({ spaceId, title: 'Periodic check', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Periodic check',
      objective: 'Check only when new evidence exists',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      summary: 'Old evidence',
      createdAt: 20,
    });
    cursorRepo.upsert({
      spaceId,
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'self_nag',
      triggerKey: 'schedule-1',
      lastEvidenceCreatedAt: 20,
      lastEvidenceId: evolutionRepo.listEvidence(scope.id)[0]?.id ?? null,
      lastTaskCompletedAt: null,
      lastExternalEventId: null,
      lastEpisodeId: null,
      lastFiredAt: Date.now(),
      metadata: {},
    });

    const result = service.onSelfNag(goal.id, 'schedule-1');

    expect(result).toEqual({ enqueued: false, reason: 'not_applicable', count: 0 });
    expect(jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'pending' })).toHaveLength(
      0
    );
  });

  it('syncs one self-nag schedule per scope', () => {
    const goal = goalRepo.create({ spaceId, title: 'Scoped self nag', type: 'recurring' });
    const firstScope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'First cadence',
      objective: 'First',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    const secondScope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Second cadence',
      objective: 'Second',
      policy: { automation: { selfNagCronExpression: '30 * * * *' } },
    });

    syncGoalAutomationSelfNagScheduleForScope({ goalRepo, scheduleService, scope: firstScope });
    syncGoalAutomationSelfNagScheduleForScope({ goalRepo, scheduleService, scope: secondScope });

    const schedules = scheduleService.listSchedules(spaceId, 'active');
    expect(schedules).toHaveLength(2);
    expect(schedules.map((schedule) => schedule.labels).flat()).toContain(`scope:${firstScope.id}`);
    expect(schedules.map((schedule) => schedule.labels).flat()).toContain(
      `scope:${secondScope.id}`
    );
    expect(schedules.map((schedule) => schedule.cronExpression).sort()).toEqual([
      '0 * * * *',
      '30 * * * *',
    ]);
  });

  it('re-enables paused self-nag schedule when cron policy is restored', () => {
    const goal = goalRepo.create({ spaceId, title: 'Restore self nag', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Restore cadence',
      objective: 'Restore',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    syncGoalAutomationSelfNagScheduleForScope({ goalRepo, scheduleService, scope });
    const activeSchedule = scheduleService.listSchedules(spaceId, 'active')[0];
    scheduleService.pauseSchedule(activeSchedule.id);

    const restoredScope = evolutionRepo.updateScope(scope.id, {
      policy: { automation: { selfNagCronExpression: '30 * * * *' } },
    });
    expect(restoredScope).not.toBeNull();
    syncGoalAutomationSelfNagScheduleForScope({
      goalRepo,
      scheduleService,
      scope: restoredScope as typeof scope,
    });

    expect(scheduleService.listSchedules(spaceId, 'paused')).toHaveLength(0);
    const restoredSchedule = scheduleService.listSchedules(spaceId, 'active')[0];
    expect(restoredSchedule.id).toBe(activeSchedule.id);
    expect(restoredSchedule.cronExpression).toBe('30 * * * *');
    expect(restoredSchedule.pendingJobId).not.toBeNull();
  });

  it('creates a new self-nag schedule when previous automation schedule completed', () => {
    const goal = goalRepo.create({ spaceId, title: 'Recreate self nag', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Recreate cadence',
      objective: 'Recreate completed automation schedule',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    syncGoalAutomationSelfNagScheduleForScope({ goalRepo, scheduleService, scope });
    const completedSchedule = scheduleService.listSchedules(spaceId, 'active')[0];
    scheduleRepo.updateAfterFire(completedSchedule.id, {
      lastCreatedTaskId: null,
      lastRunAt: Date.now(),
      nextRunAt: null,
      status: 'completed',
      pendingJobId: null,
    });

    syncGoalAutomationSelfNagScheduleForScope({ goalRepo, scheduleService, scope });

    const completedSchedules = scheduleService.listSchedules(spaceId, 'completed');
    expect(completedSchedules).toHaveLength(1);
    expect(completedSchedules[0].id).toBe(completedSchedule.id);
    const activeSchedules = scheduleService.listSchedules(spaceId, 'active');
    expect(activeSchedules).toHaveLength(1);
    expect(activeSchedules[0].id).not.toBe(completedSchedule.id);
    expect(activeSchedules[0].metadata).toMatchObject({ goalAutomationScopeId: scope.id });
    expect(activeSchedules[0].pendingJobId).not.toBeNull();
  });

  it('pauses orphan self-nag schedule when scope is unlinked from goal', () => {
    const goal = goalRepo.create({ spaceId, title: 'Unlink self nag', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Unlink cadence',
      objective: 'Unlink scope from goal',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    syncGoalAutomationSelfNagScheduleForScope({ goalRepo, scheduleService, scope });
    expect(scheduleService.listSchedules(spaceId, 'active')).toHaveLength(1);

    // Unlink scope from goal.
    evolutionRepo.updateScope(scope.id, { spaceGoalId: null });
    const unlinkedScope = evolutionRepo.getScope(scope.id)!;
    expect(unlinkedScope.spaceGoalId).toBeNull();

    syncGoalAutomationSelfNagScheduleForScope({
      goalRepo,
      scheduleService,
      scope: unlinkedScope as typeof scope,
    });

    expect(scheduleService.listSchedules(spaceId, 'active')).toHaveLength(0);
    expect(scheduleService.listSchedules(spaceId, 'paused')).toHaveLength(1);
  });

  it('pauses old self-nag schedule when scope is reassigned to a new goal', () => {
    const goalA = goalRepo.create({ spaceId, title: 'Goal A', type: 'recurring' });
    const goalB = goalRepo.create({ spaceId, title: 'Goal B', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goalA.id,
      kind: 'mission',
      name: 'Reassign cadence',
      objective: 'Move scope between goals',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    syncGoalAutomationSelfNagScheduleForScope({ goalRepo, scheduleService, scope });
    expect(scheduleService.listSchedules(spaceId, 'active')).toHaveLength(1);
    const goalASchedule = scheduleService.listSchedules(spaceId, 'active')[0];

    // Reassign scope from goal A to goal B.
    evolutionRepo.updateScope(scope.id, { spaceGoalId: goalB.id });
    const reassignedScope = evolutionRepo.getScope(scope.id)!;

    syncGoalAutomationSelfNagScheduleForScope({
      goalRepo,
      scheduleService,
      scope: reassignedScope as typeof scope,
    });

    // Old schedule (goal A) should be paused.
    const pausedSchedules = scheduleService.listSchedules(spaceId, 'paused');
    expect(pausedSchedules.some((s) => s.id === goalASchedule.id)).toBe(true);

    // New schedule (goal B) should be active.
    const activeSchedules = scheduleService.listSchedules(spaceId, 'active');
    expect(activeSchedules).toHaveLength(1);
    expect(activeSchedules[0].goalId).toBe(goalB.id);
  });

  it('finds self-nag schedule by immutable metadata when labels are edited', () => {
    const goal = goalRepo.create({ spaceId, title: 'Metadata self nag', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Metadata cadence',
      objective: 'Route by metadata',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    syncGoalAutomationSelfNagScheduleForScope({ goalRepo, scheduleService, scope });
    const schedule = scheduleService.listSchedules(spaceId, 'active')[0];
    scheduleService.updateSchedule(schedule.id, { labels: ['user-edited'] });
    const updatedScope = evolutionRepo.updateScope(scope.id, {
      policy: { automation: { selfNagCronExpression: '30 * * * *' } },
    });

    syncGoalAutomationSelfNagScheduleForScope({
      goalRepo,
      scheduleService,
      scope: updatedScope as typeof scope,
    });

    const schedules = scheduleService.listSchedules(spaceId, 'active');
    expect(schedules).toHaveLength(1);
    expect(schedules[0].id).toBe(schedule.id);
    expect(schedules[0].cronExpression).toBe('30 * * * *');
    expect(schedules[0].metadata).toMatchObject({ goalAutomationScopeId: scope.id });
  });

  it('pauses active self-nag schedule when cron policy is removed', () => {
    const goal = goalRepo.create({ spaceId, title: 'Disable self nag', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Disable cadence',
      objective: 'Disable',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    syncGoalAutomationSelfNagScheduleForScope({ goalRepo, scheduleService, scope });
    const activeSchedule = scheduleService.listSchedules(spaceId, 'active')[0];
    expect(activeSchedule.labels).toContain(`scope:${scope.id}`);

    const updatedScope = evolutionRepo.updateScope(scope.id, { policy: { automation: {} } });
    expect(updatedScope).not.toBeNull();
    syncGoalAutomationSelfNagScheduleForScope({
      goalRepo,
      scheduleService,
      scope: updatedScope as typeof scope,
    });

    expect(scheduleService.listSchedules(spaceId, 'active')).toHaveLength(0);
    const pausedSchedule = scheduleService.listSchedules(spaceId, 'paused')[0];
    expect(pausedSchedule.id).toBe(activeSchedule.id);
    expect(pausedSchedule.pendingJobId).toBeNull();
  });

  it('rejects invalid completed-task threshold before scope save', () => {
    expect(() =>
      validateGoalAutomationSelfNagPolicy({
        policy: { automation: { completedTaskThreshold: 0 } },
      })
    ).toThrow('Completed-task automation threshold must be a positive integer');
    expect(() =>
      validateGoalAutomationSelfNagPolicy({
        policy: { automation: { completedTaskThreshold: 1.5 } },
      })
    ).toThrow('Completed-task automation threshold must be a positive integer');
  });

  it('rejects invalid self-nag timezone before scope save', () => {
    expect(() =>
      validateGoalAutomationSelfNagPolicy({
        policy: {
          automation: {
            selfNagCronExpression: '0 * * * *',
            selfNagTimezone: 'Bad/Timezone',
          },
        },
      })
    ).toThrow(/Invalid timezone/);
  });

  it('fails scope sync when self-nag cron is invalid', () => {
    const goal = goalRepo.create({ spaceId, title: 'Invalid self nag', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Invalid cadence',
      objective: 'Reject invalid cron',
      policy: { automation: { selfNagCronExpression: 'not-a-cron' } },
    });

    expect(() =>
      syncGoalAutomationSelfNagScheduleForScope({ goalRepo, scheduleService, scope })
    ).toThrow(/Invalid cron expression/);
    expect(scheduleService.listSchedules(spaceId)).toHaveLength(0);
  });

  it('uses evidence id cursor when gating completed-task threshold enqueue', () => {
    const goal = goalRepo.create({ spaceId, title: 'Threshold tie gate', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Threshold tie gate',
      objective: 'Gate same-timestamp task evidence',
      policy: { automation: { completedTaskThreshold: 1 } },
    });
    const first = taskRepo.createTask({ spaceId, title: 'First task', goalId: goal.id });
    const second = taskRepo.createTask({ spaceId, title: 'Second task', goalId: goal.id });
    taskRepo.updateTask(first.id, { status: 'done' });
    taskRepo.updateTask(second.id, { status: 'done' });
    const firstEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: first.id,
      summary: 'First result',
      createdAt: 20,
    });
    const secondEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: second.id,
      summary: 'Second result',
      createdAt: 20,
    });
    const orderedIds = [firstEvidence.id, secondEvidence.id].sort();
    cursorRepo.upsert({
      spaceId,
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'completed_task_threshold',
      triggerKey: 'threshold:1',
      lastEvidenceCreatedAt: 20,
      lastEvidenceId: orderedIds[0],
    });

    const result = service.onTaskCompleted(second.id);

    expect(result).toEqual({ enqueued: true, reason: 'queued', count: 1 });
    expect(jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'pending' })).toHaveLength(
      1
    );
  });

  it('uses evidence id cursor when gating self-nag enqueue', () => {
    const goal = goalRepo.create({ spaceId, title: 'Self nag tie gate', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Self nag tie gate',
      objective: 'Gate same-timestamp self-nag evidence',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    const firstEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      summary: 'First note',
      createdAt: 20,
    });
    const secondEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      summary: 'Second note',
      createdAt: 20,
    });
    const orderedIds = [firstEvidence.id, secondEvidence.id].sort();
    cursorRepo.upsert({
      spaceId,
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'self_nag',
      triggerKey: 'schedule-tie-gate',
      lastEvidenceCreatedAt: 20,
      lastEvidenceId: orderedIds[0],
    });

    const result = service.onSelfNag(goal.id, 'schedule-tie-gate', scope.id);

    expect(result).toEqual({ enqueued: true, reason: 'queued' });
    expect(jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'pending' })).toHaveLength(
      1
    );
  });

  it('skips ambiguous completed-task automation when task has no explicit scope', () => {
    const goal = goalRepo.create({ spaceId, title: 'Ambiguous task scope', type: 'recurring' });
    evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'First scope',
      objective: 'First',
      policy: { automation: { completedTaskThreshold: 1 } },
    });
    evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Second scope',
      objective: 'Second',
      policy: { automation: { completedTaskThreshold: 1 } },
    });
    const task = taskRepo.createTask({ spaceId, title: 'Unscoped task', goalId: goal.id });
    taskRepo.updateTask(task.id, { status: 'done' });

    const result = service.onTaskCompleted(task.id);

    expect(result).toEqual({ enqueued: false, reason: 'ambiguous_scope' });
    expect(jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'pending' })).toHaveLength(
      0
    );
  });

  it('tracks automation cursors per scope', () => {
    const goal = goalRepo.create({ spaceId, title: 'Scoped cursors', type: 'recurring' });
    const firstScope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'First scope',
      objective: 'First',
    });
    const secondScope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Second scope',
      objective: 'Second',
    });

    cursorRepo.upsert({
      spaceId,
      goalId: goal.id,
      scopeId: firstScope.id,
      triggerKind: 'external_event',
      triggerKey: 'event:*:topic',
      lastExternalEventId: 'event-1',
    });
    cursorRepo.upsert({
      spaceId,
      goalId: goal.id,
      scopeId: secondScope.id,
      triggerKind: 'external_event',
      triggerKey: 'event:*:topic',
      lastExternalEventId: 'event-2',
    });

    expect(
      cursorRepo.get(goal.id, firstScope.id, 'external_event', 'event:*:topic')?.lastExternalEventId
    ).toBe('event-1');
    expect(
      cursorRepo.get(goal.id, secondScope.id, 'external_event', 'event:*:topic')
        ?.lastExternalEventId
    ).toBe('event-2');
  });

  it('resumes paused schedule with updated cron config', () => {
    const goal = goalRepo.create({ spaceId, title: 'Resume cron', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Resume cron cadence',
      objective: 'Update before resume',
      policy: { automation: { selfNagCronExpression: '0 0 * * *' } },
    });
    syncGoalAutomationSelfNagScheduleForScope({ goalRepo, scheduleService, scope });
    const schedule = scheduleService.listSchedules(spaceId, 'active')[0];
    expect(schedule.cronExpression).toBe('0 0 * * *');

    // Pause the schedule (simulates goal temporarily inactive)
    scheduleService.pauseSchedule(schedule.id);
    expect(scheduleService.listSchedules(spaceId, 'paused')).toHaveLength(1);

    // Re-sync with a new cron expression while schedule is paused
    const updatedScope = evolutionRepo.updateScope(scope.id, {
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    syncGoalAutomationSelfNagScheduleForScope({
      goalRepo,
      scheduleService,
      scope: updatedScope as typeof scope,
    });

    // Schedule should be active again with the NEW cron expression
    const active = scheduleService.listSchedules(spaceId, 'active');
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(schedule.id);
    expect(active[0].cronExpression).toBe('0 * * * *');
    expect(active[0].nextRunAt).not.toBeNull();
  });
});

describe('handleGoalAutomationExecute', () => {
  let db: Database;
  let evolutionRepo: EvolutionRepository;
  let cursorRepo: GoalAutomationCursorRepository;
  let goalRepo: SpaceGoalRepository;
  let spaceRepo: SpaceRepository;
  let taskRepo: SpaceTaskRepository;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    evolutionRepo = new EvolutionRepository(db as never);
    cursorRepo = new GoalAutomationCursorRepository(db as never);
    goalRepo = new SpaceGoalRepository(db as never);
    spaceRepo = new SpaceRepository(db as never);
    taskRepo = new SpaceTaskRepository(db as never);
    spaceId = spaceRepo.createSpace({
      workspacePath: '/workspace/goal-automation-executor-test',
      slug: 'goal-automation-executor-test',
      name: 'Goal Automation Executor Test',
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  it('generates a draft episode, review task, and cursor from selected evidence', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Review generated lessons', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Review generated lessons',
      objective: 'Generate retrospectives',
      policy: { automation: { completedTaskThreshold: 1 } },
    });
    const task = taskRepo.createTask({ spaceId, title: 'Completed task', goalId: goal.id });
    taskRepo.updateTask(task.id, { status: 'done', result: 'Finished' });
    const evidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Completed task result',
      createdAt: 40,
    });
    const published: Array<{ event: string; data: Record<string, unknown> }> = [];

    const result = await handleGoalAutomationExecute(
      {
        id: 'job-1',
        queue: GOAL_AUTOMATION_EXECUTE,
        status: 'processing',
        payload: {
          goalId: goal.id,
          scopeId: scope.id,
          triggerKind: 'completed_task_threshold',
          triggerKey: 'threshold:1',
          reason: 'task_completed',
          taskId: task.id,
        },
        result: null,
        error: null,
        priority: 0,
        maxRetries: 2,
        retryCount: 0,
        runAt: Date.now(),
        createdAt: Date.now(),
        startedAt: Date.now(),
        completedAt: null,
      } satisfies Job,
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Draft retrospective',
              evidenceIds,
              outcomeSummary: 'Useful outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
        },
        taskCreatedEventHub: {
          publish: async (event, data) => {
            published.push({ event, data });
          },
        },
      }
    );

    expect(result.skipped).toBe(false);
    expect(result.evidenceCount).toBe(1);
    expect(result.episodeId).toBeString();
    expect(result.reviewTaskId).toBeString();
    const reviewTask = taskRepo.getTask(result.reviewTaskId as string);
    expect(reviewTask).toMatchObject({
      spaceId,
      goalId: goal.id,
      evolutionScopeId: scope.id,
      title: 'Review Forge retrospective: Review generated lessons',
    });
    expect(reviewTask?.labels).toContain('forge');
    expect(reviewTask?.labels).toContain('review');
    expect(reviewTask?.labels).toContain('automation');
    expect(reviewTask?.description).toContain(evidence.id);
    expect(published).toHaveLength(1);
    expect(published[0].event).toBe('space.task.created');
    const cursor = cursorRepo.get(goal.id, scope.id, 'completed_task_threshold', 'threshold:1');
    expect(cursor).toMatchObject({
      goalId: goal.id,
      scopeId: scope.id,
      lastEvidenceCreatedAt: 40,
      lastEpisodeId: result.episodeId,
    });
    expect(cursor?.metadata.evidenceIds).toEqual([evidence.id]);
  });

  it('keeps backlog cursor contiguous when capped external event is newer', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Contiguous backlog', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Contiguous backlog',
      objective: 'Keep cursor contiguous',
      policy: { automation: { eventSubscriptions: [{ topic: 'pull_request/*' }] } },
    });
    for (let i = 1; i <= 12; i++) {
      evolutionRepo.createEvidence({
        scopeId: scope.id,
        kind: 'manual_note',
        sourceId: `old-${i}`,
        summary: `Old evidence ${i}`,
        createdAt: i,
      });
    }
    await handleGoalAutomationExecute(
      createAutomationJob(
        {
          goalId: goal.id,
          scopeId: scope.id,
          triggerKind: 'external_event',
          triggerKey: 'event:*:pull_request/*',
          reason: 'external_event',
          externalEventId: 'fresh-event',
          externalEvent: {
            source: 'github',
            topic: 'pull_request/closed',
            summary: 'Fresh PR merged',
            payload: { action: 'closed' },
            occurredAt: 20,
            ingestedAt: 30,
          },
        },
        'job-contiguous-backlog'
      ),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Contiguous retrospective',
              evidenceIds,
              outcomeSummary: 'Contiguous cursor',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
        },
      }
    );

    const cursor = cursorRepo.get(goal.id, scope.id, 'external_event', 'event:*:pull_request/*');
    expect(cursor?.lastEvidenceCreatedAt).toBe(12);
    expect(cursor?.lastExternalEventId).toBe('fresh-event');
  });

  it('uses evidence id as cursor tie-breaker for same-timestamp evidence', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Tie cursor', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Tie cursor',
      objective: 'Keep same timestamp backlog',
      policy: { automation: { maxEvidencePerEpisode: 1 } },
    });
    const first = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: 'first',
      summary: 'First',
      createdAt: 10,
    });
    const second = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: 'second',
      summary: 'Second',
      createdAt: 10,
    });
    const selected: string[][] = [];
    const deps = {
      goalRepo,
      taskRepo,
      evolutionRepo,
      cursorRepo,
      episodeService: {
        createFromEvidence: async ({ evidenceIds }) => {
          selected.push(evidenceIds);
          return {
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Tie retrospective',
              evidenceIds,
              outcomeSummary: 'Tie cursor',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          };
        },
      },
    };

    await handleGoalAutomationExecute(
      createAutomationJob(
        {
          goalId: goal.id,
          scopeId: scope.id,
          triggerKind: 'external_event',
          triggerKey: 'event:*:tie',
          reason: 'external_event',
          externalEventId: 'event-tie-1',
        },
        'job-tie-1'
      ),
      deps
    );
    await handleGoalAutomationExecute(
      createAutomationJob(
        {
          goalId: goal.id,
          scopeId: scope.id,
          triggerKind: 'external_event',
          triggerKey: 'event:*:tie',
          reason: 'external_event',
          externalEventId: 'event-tie-2',
        },
        'job-tie-2'
      ),
      deps
    );

    const orderedIds = [first.id, second.id].sort();
    expect(selected).toEqual([[orderedIds[0]], [orderedIds[1]]]);
    const cursor = cursorRepo.get(goal.id, scope.id, 'external_event', 'event:*:tie');
    expect(cursor?.lastEvidenceCreatedAt).toBe(10);
    expect(cursor?.lastEvidenceId).toBe(orderedIds[1]);
  });

  it('reuses existing automation review task after cursor write retry', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Idempotent episode', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Idempotent episode',
      objective: 'Avoid duplicate episodes',
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: 'note-1',
      summary: 'Note 1',
      createdAt: 10,
    });
    const payload = {
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'external_event' as const,
      triggerKey: 'event:*:idempotent',
      reason: 'external_event' as const,
      externalEventId: 'event-idempotent',
    };
    let first = true;
    const deps = {
      goalRepo,
      taskRepo,
      evolutionRepo,
      cursorRepo,
      episodeService: {
        createFromEvidence: async ({ evidenceIds }) => ({
          episode: evolutionRepo.createEpisode({
            scopeId: scope.id,
            title: 'Idempotent retrospective',
            evidenceIds,
            outcomeSummary: 'Idempotent cursor',
            findings: [],
          }),
          proposals: [],
          lessons: [],
        }),
      },
    };
    const originalUpsert = cursorRepo.upsert.bind(cursorRepo);
    cursorRepo.upsert = ((params) => {
      if (first) {
        first = false;
        throw new Error('cursor write failed');
      }
      return originalUpsert(params);
    }) as typeof cursorRepo.upsert;

    await expect(
      handleGoalAutomationExecute(createAutomationJob(payload, 'job-idempotent-1'), deps)
    ).rejects.toThrow('cursor write failed');
    const retry = await handleGoalAutomationExecute(
      createAutomationJob(payload, 'job-idempotent-2'),
      deps
    );

    expect(retry.skipped).toBe(false);
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(1);
    expect(taskRepo.listBySpace(spaceId, true)).toHaveLength(1);
  });

  it('creates new self-nag episodes for later schedule ticks', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Periodic self nag', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Periodic self nag',
      objective: 'Keep periodic retrospectives running',
      policy: { automation: { maxEvidencePerEpisode: 1 } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: 'first',
      summary: 'First note',
      createdAt: 10,
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: 'second',
      summary: 'Second note',
      createdAt: 20,
    });
    const deps = {
      goalRepo,
      taskRepo,
      evolutionRepo,
      cursorRepo,
      episodeService: {
        createFromEvidence: async ({ evidenceIds }) => ({
          episode: evolutionRepo.createEpisode({
            scopeId: scope.id,
            title: 'Self nag retrospective',
            evidenceIds,
            outcomeSummary: 'Self nag cursor',
            findings: [],
          }),
          proposals: [],
          lessons: [],
        }),
      },
    };
    const payload = {
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'self_nag' as const,
      triggerKey: 'schedule-periodic',
      reason: 'self_nag' as const,
      scheduleId: 'schedule-periodic',
    };

    await handleGoalAutomationExecute(createAutomationJob(payload, 'job-self-nag-1'), deps);
    await handleGoalAutomationExecute(createAutomationJob(payload, 'job-self-nag-2'), deps);

    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(2);
    expect(taskRepo.listBySpace(spaceId, true)).toHaveLength(2);
  });

  it('captures external event evidence before generating the episode', async () => {
    const goal = goalRepo.create({ spaceId, title: 'React to external events', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'React to external events',
      objective: 'Learn from event evidence',
      policy: { automation: { eventSubscriptions: [{ topic: 'pull_request/*' }] } },
    });
    let episodeEvidenceIds: string[] = [];

    const result = await handleGoalAutomationExecute(
      {
        id: 'job-2',
        queue: GOAL_AUTOMATION_EXECUTE,
        status: 'processing',
        payload: {
          goalId: goal.id,
          scopeId: scope.id,
          triggerKind: 'external_event',
          triggerKey: 'event:*:pull_request/*',
          reason: 'external_event',
          externalEventId: 'event-2',
          externalEvent: {
            source: 'github',
            topic: 'pull_request/closed',
            summary: 'PR merged',
            externalUrl: 'https://example.test/pr/2',
            payload: { action: 'closed' },
            occurredAt: 50,
            ingestedAt: 60,
          },
        },
        result: null,
        error: null,
        priority: 0,
        maxRetries: 2,
        retryCount: 0,
        runAt: Date.now(),
        createdAt: Date.now(),
        startedAt: Date.now(),
        completedAt: null,
      } satisfies Job,
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => {
            episodeEvidenceIds = evidenceIds;
            return {
              episode: evolutionRepo.createEpisode({
                scopeId: scope.id,
                title: 'External event retrospective',
                evidenceIds,
                outcomeSummary: 'Event outcome',
                findings: [],
              }),
              proposals: [],
              lessons: [],
            };
          },
        },
      }
    );

    expect(result.skipped).toBe(false);
    expect(episodeEvidenceIds).toHaveLength(1);
    const [eventEvidence] = evolutionRepo.listEvidence(scope.id);
    expect(eventEvidence).toMatchObject({
      id: episodeEvidenceIds[0],
      kind: 'manual_note',
      sourceId: 'event-2',
      summary: 'External event: PR merged',
      createdAt: 60,
    });
    expect(eventEvidence.metadata).toMatchObject({
      autoCaptured: true,
      triggerKind: 'external_event',
      source: 'github',
      topic: 'pull_request/closed',
    });
    const cursor = cursorRepo.get(goal.id, scope.id, 'external_event', 'event:*:pull_request/*');
    expect(cursor?.lastExternalEventId).toBe('event-2');
  });

  it('always includes triggering external event when due evidence is capped', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Capped external events', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Capped external events',
      objective: 'Include triggering event',
      policy: { automation: { eventSubscriptions: [{ topic: 'pull_request/*' }] } },
    });
    for (let i = 1; i <= 12; i++) {
      evolutionRepo.createEvidence({
        scopeId: scope.id,
        kind: 'manual_note',
        sourceId: `old-${i}`,
        summary: `Old evidence ${i}`,
        createdAt: i,
      });
    }
    let episodeEvidenceIds: string[] = [];

    const result = await handleGoalAutomationExecute(
      {
        id: 'job-capped-event',
        queue: GOAL_AUTOMATION_EXECUTE,
        status: 'processing',
        payload: {
          goalId: goal.id,
          scopeId: scope.id,
          triggerKind: 'external_event',
          triggerKey: 'event:*:pull_request/*',
          reason: 'external_event',
          externalEventId: 'fresh-event',
          externalEvent: {
            source: 'github',
            topic: 'pull_request/closed',
            summary: 'Fresh PR merged',
            payload: { action: 'closed' },
            occurredAt: 20,
            ingestedAt: 30,
          },
        },
        result: null,
        error: null,
        priority: 0,
        maxRetries: 2,
        retryCount: 0,
        runAt: Date.now(),
        createdAt: Date.now(),
        startedAt: Date.now(),
        completedAt: null,
      } satisfies Job,
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => {
            episodeEvidenceIds = evidenceIds;
            return {
              episode: evolutionRepo.createEpisode({
                scopeId: scope.id,
                title: 'Capped event retrospective',
                evidenceIds,
                outcomeSummary: 'Included fresh event',
                findings: [],
              }),
              proposals: [],
              lessons: [],
            };
          },
        },
      }
    );

    expect(result.skipped).toBe(false);
    const freshEvidence = evolutionRepo
      .listEvidence(scope.id)
      .find((item) => item.sourceId === 'fresh-event');
    expect(freshEvidence).toBeDefined();
    expect(episodeEvidenceIds).toContain(freshEvidence?.id as string);
  });

  it('deduplicates external event evidence across retries', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Retry external events', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Retry external events',
      objective: 'Avoid duplicate event evidence',
      policy: { automation: { eventSubscriptions: [{ topic: 'pull_request/*' }] } },
    });
    const job = {
      id: 'job-retry',
      queue: GOAL_AUTOMATION_EXECUTE,
      status: 'processing',
      payload: {
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'external_event',
        triggerKey: 'event:*:pull_request/*',
        reason: 'external_event',
        externalEventId: 'event-retry',
        externalEvent: {
          source: 'github',
          topic: 'pull_request/closed',
          summary: 'PR merged after retry',
          payload: { action: 'closed' },
          occurredAt: 50,
          ingestedAt: 80,
        },
      },
      result: null,
      error: null,
      priority: 0,
      maxRetries: 2,
      retryCount: 0,
      runAt: Date.now(),
      createdAt: Date.now(),
      startedAt: Date.now(),
      completedAt: null,
    } satisfies Job;
    const deps = {
      goalRepo,
      taskRepo,
      evolutionRepo,
      cursorRepo,
      episodeService: {
        createFromEvidence: async ({ evidenceIds }) => ({
          episode: evolutionRepo.createEpisode({
            scopeId: scope.id,
            title: 'Retry retrospective',
            evidenceIds,
            outcomeSummary: 'Event outcome',
            findings: [],
          }),
          proposals: [],
          lessons: [],
        }),
      },
    };

    await handleGoalAutomationExecute(job, deps);
    await handleGoalAutomationExecute(job, deps);

    const eventEvidence = evolutionRepo
      .listEvidence(scope.id)
      .filter((item) => item.sourceId === 'event-retry');
    expect(eventEvidence).toHaveLength(1);
    expect(eventEvidence[0].createdAt).toBe(80);
  });

  it('cursor upsert keeps newer state when older job writes late', async () => {
    const space = spaceRepo.createSpace({
      slug: 'cursor-race',
      workspacePath: '/workspace/cursor-race',
      name: 'Cursor race',
      description: 'Cursor race test',
    });
    const goal = goalRepo.create({ spaceId: space.id, title: 'Race goal', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId: space.id,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Race scope',
      objective: 'Cursor race',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      summary: 'Early evidence',
    });

    const payload = {
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'self_nag' as const,
      triggerKey: 'sched-race',
      reason: 'self_nag' as const,
      scheduleId: 'sched-race',
    };
    const deps_base = {
      goalRepo,
      taskRepo,
      evolutionRepo,
      cursorRepo,
      episodeService: {
        createFromEvidence: async ({ evidenceIds }: { evidenceIds: string[] }) => ({
          episode: evolutionRepo.createEpisode({
            scopeId: scope.id,
            title: 'Race episode',
            evidenceIds,
            outcomeSummary: 'Race outcome',
            findings: [],
          }),
          proposals: [],
          lessons: [],
        }),
      },
      taskCreatedEventHub: { publish: async () => {} },
    };

    // First run: normal execution
    const job1 = createAutomationJob(payload, 'job-1');
    const result1 = await handleGoalAutomationExecute(job1, deps_base);
    expect(result1.skipped).toBe(false);

    const cursor1 = cursorRepo.get(goal.id, scope.id, 'self_nag', 'sched-race')!;
    expect(cursor1).not.toBeNull();

    // Add more evidence and run again: cursor advances
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      summary: 'Later evidence',
    });
    const job2 = createAutomationJob(payload, 'job-2');
    const result2 = await handleGoalAutomationExecute(job2, deps_base);
    expect(result2.skipped).toBe(false);

    const cursor2 = cursorRepo.get(goal.id, scope.id, 'self_nag', 'sched-race')!;
    expect(cursor2.lastFiredAt).toBeGreaterThanOrEqual(cursor1.lastFiredAt!);

    // Simulate old job (job-1) trying to write after job-2 already advanced cursor.
    // The cursor upsert must NOT regress lastFiredAt.
    cursorRepo.upsert({
      spaceId: space.id,
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'self_nag',
      triggerKey: 'sched-race',
      lastFiredAt: cursor1.lastFiredAt! - 1, // strictly older than cursor2
      lastEvidenceCreatedAt: 1, // stale value
      metadata: { stale: true },
    });
    const afterStale = cursorRepo.get(goal.id, scope.id, 'self_nag', 'sched-race')!;
    // Stale write must not regress: lastFiredAt stays at job-2's value
    expect(afterStale.lastFiredAt).toBe(cursor2.lastFiredAt);
    // Evidence cursor also stays at job-2's value (not regressed to 1)
    expect(afterStale.lastEvidenceCreatedAt).toBe(cursor2.lastEvidenceCreatedAt);
    // Metadata stays from job-2's write (stale marker not applied)
    expect(afterStale.metadata.stale).toBeUndefined();
  });
});
