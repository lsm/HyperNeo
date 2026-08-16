import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { EvidenceQualityPreflight } from '@hyperneo/shared';
import { Database } from '../../../src/storage/sqlite-compat';
import type { Job } from '../../../src/storage/repositories/job-queue-repository';
import { GOAL_AUTOMATION_EXECUTE } from '../../../src/lib/job-queue-constants';
import { handleGoalAutomationExecute } from '../../../src/lib/job-handlers/goal-automation-execute.handler';
import {
  GoalAutomationService,
  externalEventTriggerKey,
} from '../../../src/lib/space/goals/goal-automation-service';
import { EvolutionScopeService } from '../../../src/lib/space/evolution-scope-service';
import { EvolutionRepository } from '../../../src/storage/repositories/evolution-repository';
import { GoalAutomationCursorRepository } from '../../../src/storage/repositories/goal-automation-cursor-repository';
import { JobQueueRepository } from '../../../src/storage/repositories/job-queue-repository';
import { SpaceGoalEventRepository } from '../../../src/storage/repositories/space-goal-event-repository';
import { SpaceGoalRepository } from '../../../src/storage/repositories/space-goal-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository';
import { TaskScheduleRepository } from '../../../src/storage/repositories/task-schedule-repository';
import {
  validateGoalAutomationSelfNagPolicy,
  syncGoalAutomationSelfNagScheduleForScope,
} from '../../../src/lib/rpc-handlers';
import { mergeEvolutionPolicy } from '../../../src/lib/space/evolution-scope-service';
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

/** Build an EvidenceQualityPreflight for handler tests (episodeService is mocked). */
function makePreflight(
  overrides: Partial<EvidenceQualityPreflight> = {}
): EvidenceQualityPreflight {
  return {
    level: 'high',
    score: 80,
    maxScore: 100,
    canGenerate: true,
    requiresConfirmation: false,
    reasons: [],
    warnings: [],
    counts: {
      total: 1,
      manualNotes: 0,
      taskResults: 1,
      workflowArtifacts: 0,
      metricSnapshots: 0,
      outcomes: 1,
    },
    artifactDiagnostics: {
      status: 'selected',
      availableKinds: [],
      omittedCount: 0,
      recommendations: [],
    },
    ...overrides,
  };
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
      workflowRunRepo: new SpaceWorkflowRunRepository(db as never),
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

  it('deduplicates pending completed-task jobs without external event id', () => {
    const goal = goalRepo.create({ spaceId, title: 'Dedupe enqueue', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Dedupe enqueue',
      objective: 'Avoid duplicate pending jobs',
      policy: { automation: { completedTaskThreshold: 1 } },
    });
    const first = taskRepo.createTask({ spaceId, title: 'First task', goalId: goal.id });
    taskRepo.updateTask(first.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: first.id,
      summary: 'First result',
      createdAt: 10,
    });
    jobQueue.enqueueUniquePending({
      queue: GOAL_AUTOMATION_EXECUTE,
      payload: {
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:1',
        reason: 'task_completed',
        taskId: first.id,
      },
      matchPayload: {
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:1',
      },
      activeStatuses: ['pending'],
    });

    const second = taskRepo.createTask({ spaceId, title: 'Second task', goalId: goal.id });
    taskRepo.updateTask(second.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: second.id,
      summary: 'Second result',
      createdAt: 20,
    });
    const result = service.onTaskCompleted(second.id);

    expect(result.enqueued).toBe(true);
    expect(jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'pending' })).toHaveLength(
      1
    );
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

  it('skips default completed-task threshold for non-recurring goals', () => {
    const goal = goalRepo.create({ spaceId, title: 'One-shot default', type: 'one_shot' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'One-shot default',
      objective: 'Do not default count automation',
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

    expect(result).toEqual({ enqueued: false, reason: 'disabled' });
    expect(jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'pending' })).toHaveLength(
      0
    );
  });

  it('allows explicit completed-task threshold for non-recurring goals', () => {
    const goal = goalRepo.create({ spaceId, title: 'One-shot explicit', type: 'one_shot' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'One-shot explicit',
      objective: 'Opt in count automation',
      policy: { automation: { completedTaskThreshold: 1 } },
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

    expect(result).toEqual({ enqueued: true, reason: 'queued', count: 1 });
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

  it('uses newest completed-task cursor id after threshold changes with tied timestamps', () => {
    const goal = goalRepo.create({ spaceId, title: 'Threshold tied cursor', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Threshold tied cursor',
      objective: 'Do not replay tied cursor evidence',
      policy: { automation: { completedTaskThreshold: 2 } },
    });
    const first = taskRepo.createTask({ spaceId, title: 'First tied task', goalId: goal.id });
    const second = taskRepo.createTask({ spaceId, title: 'Second tied task', goalId: goal.id });
    const third = taskRepo.createTask({ spaceId, title: 'Fresh task', goalId: goal.id });
    taskRepo.updateTask(first.id, { status: 'done' });
    taskRepo.updateTask(second.id, { status: 'done' });
    taskRepo.updateTask(third.id, { status: 'done' });
    const firstEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: first.id,
      summary: 'First tied result',
      createdAt: 20,
    });
    const secondEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: second.id,
      summary: 'Second tied result',
      createdAt: 20,
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: third.id,
      summary: 'Fresh result',
      createdAt: 30,
    });
    const orderedIds = [firstEvidence.id, secondEvidence.id].sort();
    cursorRepo.upsert({
      spaceId,
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'completed_task_threshold',
      triggerKey: 'threshold:2',
      lastEvidenceCreatedAt: 20,
      lastEvidenceId: orderedIds[0],
      lastFiredAt: 30,
      metadata: {},
    });
    cursorRepo.upsert({
      spaceId,
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'completed_task_threshold',
      triggerKey: 'threshold:5',
      lastEvidenceCreatedAt: 20,
      lastEvidenceId: orderedIds[1],
      lastFiredAt: 10,
      metadata: {},
    });

    const result = service.onTaskCompleted(third.id);

    expect(result).toEqual({ enqueued: false, reason: 'below_threshold', count: 1 });
    expect(jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'pending' })).toHaveLength(
      0
    );
  });

  it('uses newest completed-task cursor after threshold changes', () => {
    const goal = goalRepo.create({ spaceId, title: 'Threshold changed', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Threshold changed',
      objective: 'Do not replay completed work',
      policy: { automation: { completedTaskThreshold: 10 } },
    });
    let threshold10EvidenceId = '';
    for (let i = 1; i <= 10; i++) {
      const task = taskRepo.createTask({ spaceId, title: `Old task ${i}`, goalId: goal.id });
      taskRepo.updateTask(task.id, { status: 'done' });
      threshold10EvidenceId = evolutionRepo.createEvidence({
        scopeId: scope.id,
        kind: 'task_result',
        sourceId: task.id,
        summary: `Old result ${i}`,
        createdAt: i,
      }).id;
    }
    cursorRepo.upsert({
      spaceId,
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'completed_task_threshold',
      triggerKey: 'threshold:10',
      lastEvidenceCreatedAt: 10,
      lastEvidenceId: threshold10EvidenceId,
      lastTaskCompletedAt: null,
      lastExternalEventId: null,
      lastEpisodeId: null,
      lastFiredAt: 10,
      metadata: {},
    });
    let threshold5EvidenceId = '';
    for (let i = 11; i <= 15; i++) {
      const task = taskRepo.createTask({
        spaceId,
        title: `Intermediate task ${i}`,
        goalId: goal.id,
      });
      taskRepo.updateTask(task.id, { status: 'done' });
      threshold5EvidenceId = evolutionRepo.createEvidence({
        scopeId: scope.id,
        kind: 'task_result',
        sourceId: task.id,
        summary: `Intermediate result ${i}`,
        createdAt: i,
      }).id;
    }
    cursorRepo.upsert({
      spaceId,
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'completed_task_threshold',
      triggerKey: 'threshold:5',
      lastEvidenceCreatedAt: 15,
      lastEvidenceId: threshold5EvidenceId,
      lastTaskCompletedAt: null,
      lastExternalEventId: null,
      lastEpisodeId: null,
      lastFiredAt: 15,
      metadata: {},
    });
    const freshTask = taskRepo.createTask({ spaceId, title: 'Fresh task', goalId: goal.id });
    taskRepo.updateTask(freshTask.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: freshTask.id,
      summary: 'Fresh result',
      createdAt: 16,
    });

    const result = service.onTaskCompleted(freshTask.id);

    expect(result).toEqual({ enqueued: false, reason: 'below_threshold', count: 1 });
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

  it('deduplicates external events against processing jobs', () => {
    const goal = goalRepo.create({ spaceId, title: 'Deduplicate processing', type: 'recurring' });
    const subscription = {
      source: 'github',
      topic: 'pull_request/*',
      filter: { action: 'closed' },
    };
    evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Deduplicate processing',
      objective: 'Avoid duplicate episodes',
      policy: { automation: { eventSubscriptions: [subscription] } },
    });

    service.onExternalEventPublished({
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

    // Simulate the job being claimed (moved to processing)
    const jobs = jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'pending' });
    expect(jobs).toHaveLength(1);
    db.prepare("UPDATE job_queue SET status = 'processing', started_at = ? WHERE id = ?").run(
      Date.now(),
      jobs[0].id
    );

    // Same event should not enqueue a second job while the first is processing
    service.onExternalEventPublished({
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

    expect(jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'pending' })).toHaveLength(
      0
    );
    expect(
      jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'processing' })
    ).toHaveLength(1);
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
    expect(() => validateGoalAutomationSelfNagPolicy({})).not.toThrow();
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
    expect(() =>
      validateGoalAutomationSelfNagPolicy({
        policy: { automation: { completedTaskThreshold: '5' as never } },
      })
    ).toThrow('Completed-task automation threshold must be a positive integer');
  });

  it('rejects non-boolean completed-task automation enabled flags', () => {
    expect(() =>
      validateGoalAutomationSelfNagPolicy({
        policy: { automation: { completedTaskAutomationEnabled: 'false' as never } },
      })
    ).toThrow('completedTaskAutomationEnabled must be a boolean');
    expect(() =>
      validateGoalAutomationSelfNagPolicy({
        policy: { automation: { completedTaskAutomationEnabled: 1 as never } },
      })
    ).toThrow('completedTaskAutomationEnabled must be a boolean');
    expect(() =>
      validateGoalAutomationSelfNagPolicy({
        policy: { automation: { completedTaskAutomationEnabled: false } },
      })
    ).not.toThrow();
  });

  it('rejects non-object automation policies', () => {
    expect(() =>
      validateGoalAutomationSelfNagPolicy({
        policy: { automation: null as never },
      })
    ).toThrow('Automation policy must be an object');
    expect(() =>
      validateGoalAutomationSelfNagPolicy({
        policy: { automation: ['array'] as never },
      })
    ).toThrow('Automation policy must be an object');
    expect(() =>
      validateGoalAutomationSelfNagPolicy({
        policy: { automation: { completedTaskThreshold: 5 } },
      })
    ).not.toThrow();
  });

  it('rejects invalid automation policy patches before scope save', () => {
    const existingPolicy = {
      automation: { completedTaskThreshold: 7, selfNagCronExpression: '0 * * * *' },
    };

    expect(() =>
      validateGoalAutomationSelfNagPolicy({
        policy: mergeEvolutionPolicy(existingPolicy, {
          automation: { completedTaskThreshold: '5' as never },
        }),
      })
    ).toThrow('Completed-task automation threshold must be a positive integer');
    expect(() =>
      validateGoalAutomationSelfNagPolicy({
        policy: mergeEvolutionPolicy(existingPolicy, {
          automation: { selfNagCronExpression: 'not-a-cron' },
        }),
      })
    ).toThrow(/Invalid cron expression/);
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

  it('enqueues follow-up job while a processing automation job exists', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Follow-up enqueue', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Follow-up enqueue',
      objective: 'Queue while processing',
      policy: { automation: { completedTaskThreshold: 1 } },
    });

    const firstTask = taskRepo.createTask({ spaceId, title: 'First', goalId: goal.id });
    taskRepo.updateTask(firstTask.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: firstTask.id,
      summary: 'First',
      createdAt: 10,
    });

    jobQueue.enqueue({
      queue: GOAL_AUTOMATION_EXECUTE,
      status: 'processing',
      payload: {
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:1',
        reason: 'task_completed',
        taskId: firstTask.id,
      },
    });

    const secondTask = taskRepo.createTask({ spaceId, title: 'Second', goalId: goal.id });
    taskRepo.updateTask(secondTask.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: secondTask.id,
      summary: 'Second',
      createdAt: 20,
    });

    const result = service.onTaskCompleted(secondTask.id);
    expect(result.enqueued).toBe(true);
    expect(result.reason).toBe('queued');
  });
});

describe('handleGoalAutomationExecute', () => {
  let db: Database;
  let evolutionRepo: EvolutionRepository;
  let cursorRepo: GoalAutomationCursorRepository;
  let goalRepo: SpaceGoalRepository;
  let spaceRepo: SpaceRepository;
  let taskRepo: SpaceTaskRepository;
  let jobQueue: JobQueueRepository;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    createJobQueueTable(db);
    evolutionRepo = new EvolutionRepository(db as never);
    cursorRepo = new GoalAutomationCursorRepository(db as never);
    goalRepo = new SpaceGoalRepository(db as never);
    spaceRepo = new SpaceRepository(db as never);
    taskRepo = new SpaceTaskRepository(db as never);
    jobQueue = new JobQueueRepository(db as never);
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
      title: 'Review Evolution retrospective: Review generated lessons',
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

  it('skips completed-task execution for non-recurring goals without explicit threshold', async () => {
    const goal = goalRepo.create({ spaceId, title: 'One-shot goal', type: 'one_shot' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'One-shot goal',
      objective: 'Do not run default threshold',
      policy: {},
    });
    const task = taskRepo.createTask({ spaceId, title: 'Completed task', goalId: goal.id });
    taskRepo.updateTask(task.id, { status: 'done', result: 'Finished' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Completed task result',
      createdAt: 40,
    });

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:10',
        reason: 'task_completed',
        taskId: task.id,
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async () => {
            throw new Error('should not create episode for non-recurring default');
          },
        },
      }
    );

    expect(result).toMatchObject({
      skipped: true,
      skipReason: 'disabled',
      evidenceCount: 0,
    });
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(0);
  });

  it('serializes concurrent completed-task automation jobs for the same scope', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Serialize jobs', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Serialize jobs',
      objective: 'Avoid overlapping episodes',
      policy: { automation: { completedTaskThreshold: 1 } },
    });
    const first = taskRepo.createTask({ spaceId, title: 'First task', goalId: goal.id });
    taskRepo.updateTask(first.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: first.id,
      summary: 'First result',
      createdAt: 10,
    });
    const second = taskRepo.createTask({ spaceId, title: 'Second task', goalId: goal.id });
    taskRepo.updateTask(second.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: second.id,
      summary: 'Second result',
      createdAt: 20,
    });
    const deps = {
      goalRepo,
      taskRepo,
      evolutionRepo,
      cursorRepo,
      jobQueue,
      episodeService: {
        createFromEvidence: async ({ evidenceIds }: { evidenceIds: string[] }) => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return {
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Serialized retrospective',
              evidenceIds,
              outcomeSummary: 'Serialized outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          };
        },
      },
    };

    const [result1, result2] = await Promise.all([
      handleGoalAutomationExecute(
        createAutomationJob(
          {
            goalId: goal.id,
            scopeId: scope.id,
            triggerKind: 'completed_task_threshold',
            triggerKey: 'threshold:1',
            reason: 'task_completed',
            taskId: first.id,
          },
          'job-serialize-1'
        ),
        deps
      ),
      handleGoalAutomationExecute(
        createAutomationJob(
          {
            goalId: goal.id,
            scopeId: scope.id,
            triggerKind: 'completed_task_threshold',
            triggerKey: 'threshold:2',
            reason: 'task_completed',
            taskId: second.id,
          },
          'job-serialize-2'
        ),
        deps
      ),
    ]);

    const successes = [result1, result2].filter((r) => !r.skipped);
    expect(successes).toHaveLength(1);
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(1);
    const requeued = [result1, result2].find((r) => r.requeued);
    expect(requeued).toBeDefined();
  });

  it('deduplicates pending active-review requeues when payload omits external event id', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Dedupe requeue', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Dedupe requeue',
      objective: 'Avoid duplicate deferred jobs',
      policy: { automation: { completedTaskThreshold: 1 } },
    });
    const activeReview = taskRepo.createTask({
      spaceId,
      title: 'Review Evolution retrospective: Dedupe requeue',
      goalId: goal.id,
      evolutionScopeId: scope.id,
      description: 'Episode: episode-active',
      labels: [
        'forge',
        'review',
        'automation',
        'automation:completed_task_threshold:threshold:1:first-task',
      ],
    });
    taskRepo.updateTask(activeReview.id, { status: 'in_progress' });
    const task = taskRepo.createTask({ spaceId, title: 'Done task', goalId: goal.id });
    taskRepo.updateTask(task.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Done task',
      createdAt: 10,
    });
    jobQueue.enqueueUniquePending({
      queue: GOAL_AUTOMATION_EXECUTE,
      payload: {
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:1',
        reason: 'task_completed',
        taskId: task.id,
        activeReviewRequeueCount: 1,
      },
      matchPayload: {
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:1',
      },
      activeStatuses: ['pending'],
    });

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:1',
        reason: 'task_completed',
        taskId: task.id,
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        jobQueue,
        episodeService: {
          createFromEvidence: async () => {
            throw new Error('should not create episode while active review exists');
          },
        },
      }
    );

    expect(result).toMatchObject({ skipped: true, skipReason: 'active_review', requeued: true });
    expect(jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'pending' })).toHaveLength(
      1
    );
  });

  it('defers completed-task execution when another Forge review is active', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Defer overlap', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Defer overlap',
      objective: 'Avoid overlapping review tasks',
      policy: { automation: { completedTaskThreshold: 1 } },
    });
    const firstTask = taskRepo.createTask({ spaceId, title: 'First done', goalId: goal.id });
    taskRepo.updateTask(firstTask.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: firstTask.id,
      summary: 'First done',
      createdAt: 10,
    });
    const activeReview = taskRepo.createTask({
      spaceId,
      title: 'Review Evolution retrospective: Defer overlap',
      goalId: goal.id,
      evolutionScopeId: scope.id,
      description: 'Episode: episode-active',
      labels: [
        'forge',
        'review',
        'automation',
        'automation:completed_task_threshold:threshold:1:first-task',
      ],
    });
    taskRepo.updateTask(activeReview.id, { status: 'in_progress' });
    const secondTask = taskRepo.createTask({ spaceId, title: 'Second done', goalId: goal.id });
    taskRepo.updateTask(secondTask.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: secondTask.id,
      summary: 'Second done',
      createdAt: 20,
    });
    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:1',
        reason: 'task_completed',
        taskId: secondTask.id,
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        jobQueue,
        episodeService: {
          createFromEvidence: async () => {
            throw new Error('should not create episode while active review exists');
          },
        },
      }
    );

    expect(result).toMatchObject({
      skipped: true,
      skipReason: 'active_review',
      evidenceCount: 2,
      requeued: true,
    });
    expect(taskRepo.listBySpace(spaceId, true)).toHaveLength(3);
    expect(cursorRepo.get(goal.id, scope.id, 'completed_task_threshold', 'threshold:1')).toBeNull();
    const [pendingJob] = jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'pending' });
    expect(pendingJob?.payload).toMatchObject({
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'completed_task_threshold',
      triggerKey: 'threshold:1',
      activeReviewRequeueCount: 1,
    });
  });

  it('defers when active review shares the same automation token', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Same token defer', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Same token defer',
      objective: 'Avoid reusing same-token review for new evidence',
      policy: { automation: { completedTaskThreshold: 1 } },
    });
    const firstTask = taskRepo.createTask({ spaceId, title: 'First done', goalId: goal.id });
    taskRepo.updateTask(firstTask.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: firstTask.id,
      summary: 'First done',
      createdAt: 10,
    });
    const activeReview = taskRepo.createTask({
      spaceId,
      title: 'Review Evolution retrospective: Same token defer',
      goalId: goal.id,
      evolutionScopeId: scope.id,
      description: 'Episode: episode-active',
      labels: [
        'forge',
        'review',
        'automation',
        'automation:completed_task_threshold:threshold:1:run',
      ],
    });
    taskRepo.updateTask(activeReview.id, { status: 'in_progress' });
    const secondTask = taskRepo.createTask({ spaceId, title: 'Second done', goalId: goal.id });
    taskRepo.updateTask(secondTask.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: secondTask.id,
      summary: 'Second done',
      createdAt: 20,
    });
    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:1',
        reason: 'task_completed',
        taskId: secondTask.id,
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        jobQueue,
        episodeService: {
          createFromEvidence: async () => {
            throw new Error('should not create episode while same-token active review exists');
          },
        },
      }
    );

    expect(result).toMatchObject({
      skipped: true,
      skipReason: 'active_review',
      evidenceCount: 2,
      requeued: true,
    });
  });

  it('does not reuse terminal completed-task review tasks for the same trigger', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Terminal reuse', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Terminal reuse',
      objective: 'Avoid reusing terminal review',
      policy: { automation: { completedTaskThreshold: 1 } },
    });
    const firstTask = taskRepo.createTask({ spaceId, title: 'First done', goalId: goal.id });
    taskRepo.updateTask(firstTask.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: firstTask.id,
      summary: 'First done',
      createdAt: 10,
    });

    // First run: creates episode and review task
    const firstResult = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:1',
        reason: 'task_completed',
        taskId: firstTask.id,
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'First retrospective',
              evidenceIds,
              outcomeSummary: 'First outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
        },
      }
    );
    expect(firstResult.skipped).toBe(false);
    expect(firstResult.episodeId).not.toBeNull();

    // Mark review task as terminal
    const reviewTask = taskRepo.getTask(firstResult.reviewTaskId as string);
    expect(reviewTask).not.toBeNull();
    taskRepo.updateTask(reviewTask!.id, { status: 'done' });

    // Add newer evidence
    const secondTask = taskRepo.createTask({ spaceId, title: 'Second done', goalId: goal.id });
    taskRepo.updateTask(secondTask.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: secondTask.id,
      summary: 'Second done',
      createdAt: 20,
    });

    // Re-trigger for the same first task (simulating re-terminal handling)
    const secondResult = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:1',
        reason: 'task_completed',
        taskId: firstTask.id,
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Second retrospective',
              evidenceIds,
              outcomeSummary: 'Second outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
        },
      }
    );

    expect(secondResult.skipped).toBe(false);
    expect(secondResult.episodeId).not.toBe(firstResult.episodeId);
  });

  it('does not reuse old review when a newer threshold cursor has advanced', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Newer cursor guard', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Newer cursor guard',
      objective: 'Use newest cursor for dedup',
      policy: { automation: { completedTaskThreshold: 1 } },
    });
    const firstTask = taskRepo.createTask({ spaceId, title: 'First done', goalId: goal.id });
    taskRepo.updateTask(firstTask.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: firstTask.id,
      summary: 'First done',
      createdAt: 10,
    });

    // First run at threshold:1 creates review and advances cursor
    const firstResult = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:1',
        reason: 'task_completed',
        taskId: firstTask.id,
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'First retrospective',
              evidenceIds,
              outcomeSummary: 'First outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
        },
      }
    );
    expect(firstResult.skipped).toBe(false);

    // Mark review as terminal
    const reviewTask = taskRepo.getTask(firstResult.reviewTaskId as string);
    taskRepo.updateTask(reviewTask!.id, { status: 'done' });

    // Change threshold and complete a second task — advances a newer cursor
    const secondTask = taskRepo.createTask({ spaceId, title: 'Second done', goalId: goal.id });
    taskRepo.updateTask(secondTask.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: secondTask.id,
      summary: 'Second done',
      createdAt: 20,
    });
    const secondResult = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:2',
        reason: 'task_completed',
        taskId: secondTask.id,
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Second retrospective',
              evidenceIds,
              outcomeSummary: 'Second outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
        },
      }
    );
    expect(secondResult.skipped).toBe(false);
    taskRepo.updateTask(secondResult.reviewTaskId as string, { status: 'done' });

    // Add third task and re-trigger the original first task
    const thirdTask = taskRepo.createTask({ spaceId, title: 'Third done', goalId: goal.id });
    taskRepo.updateTask(thirdTask.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: thirdTask.id,
      summary: 'Third done',
      createdAt: 30,
    });
    const thirdResult = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:1',
        reason: 'task_completed',
        taskId: firstTask.id,
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Third retrospective',
              evidenceIds,
              outcomeSummary: 'Third outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
        },
      }
    );

    // Must create a new episode because the newer threshold:2 cursor has advanced
    expect(thirdResult.skipped).toBe(false);
    expect(thirdResult.episodeId).not.toBe(firstResult.episodeId);
  });

  it('uses extended delay after max active-review requeues', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Extended requeue', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Extended requeue',
      objective: 'Keep durable retry until active review clears',
      policy: { automation: { completedTaskThreshold: 1 } },
    });
    const activeReview = taskRepo.createTask({
      spaceId,
      title: 'Review Evolution retrospective: Extended requeue',
      goalId: goal.id,
      evolutionScopeId: scope.id,
      description: 'Episode: episode-active',
      labels: [
        'forge',
        'review',
        'automation',
        'automation:completed_task_threshold:threshold:1:first-task',
      ],
    });
    taskRepo.updateTask(activeReview.id, { status: 'in_progress' });
    const task = taskRepo.createTask({ spaceId, title: 'Done task', goalId: goal.id });
    taskRepo.updateTask(task.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Done task',
      createdAt: 10,
    });

    const before = Date.now();
    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:1',
        reason: 'task_completed',
        taskId: task.id,
        activeReviewRequeueCount: 60,
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        jobQueue,
        episodeService: {
          createFromEvidence: async () => {
            throw new Error('should not create episode while active review exists');
          },
        },
      }
    );

    expect(result).toMatchObject({
      skipped: true,
      skipReason: 'active_review',
      evidenceCount: 1,
      requeued: true,
    });
    const pending = jobQueue.listJobs({
      queue: GOAL_AUTOMATION_EXECUTE,
      status: 'pending',
    });
    expect(pending).toHaveLength(1);
    expect(pending[0].runAt).toBeGreaterThanOrEqual(before + 300_000);
  });

  it('defers completed-task execution across threshold changes and blocked reviews', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Changed threshold', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Changed threshold',
      objective: 'Avoid overlapping review tasks after config changes',
      policy: { automation: { completedTaskThreshold: 5 } },
    });
    const activeReview = taskRepo.createTask({
      spaceId,
      title: 'Review Evolution retrospective: Changed threshold',
      goalId: goal.id,
      evolutionScopeId: scope.id,
      description: 'Episode: episode-active',
      labels: [
        'forge',
        'review',
        'automation',
        'automation:completed_task_threshold:threshold:10:previous-task',
      ],
    });
    taskRepo.updateTask(activeReview.id, { status: 'blocked' });
    let lastTaskId = '';
    for (let i = 1; i <= 5; i++) {
      const task = taskRepo.createTask({ spaceId, title: `Task ${i}`, goalId: goal.id });
      taskRepo.updateTask(task.id, { status: 'done' });
      evolutionRepo.createEvidence({
        scopeId: scope.id,
        kind: 'task_result',
        sourceId: task.id,
        summary: `Task ${i} done`,
        createdAt: i,
      });
      lastTaskId = task.id;
    }

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:5',
        reason: 'task_completed',
        taskId: lastTaskId,
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        jobQueue,
        episodeService: {
          createFromEvidence: async () => {
            throw new Error('should not create episode while blocked review exists');
          },
        },
      }
    );

    expect(result).toMatchObject({
      skipped: true,
      skipReason: 'active_review',
      evidenceCount: 5,
      requeued: true,
    });
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(0);
    expect(jobQueue.listJobs({ queue: GOAL_AUTOMATION_EXECUTE, status: 'pending' })).toHaveLength(
      1
    );
  });

  it('uses newest completed-task cursor id after threshold changes in executor', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Executor tied cursor', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Executor tied cursor',
      objective: 'Do not replay tied cursor evidence in executor',
      policy: { automation: { completedTaskThreshold: 2 } },
    });
    const first = taskRepo.createTask({ spaceId, title: 'First tied task', goalId: goal.id });
    const second = taskRepo.createTask({ spaceId, title: 'Second tied task', goalId: goal.id });
    const fresh = taskRepo.createTask({ spaceId, title: 'Fresh task', goalId: goal.id });
    taskRepo.updateTask(first.id, { status: 'done' });
    taskRepo.updateTask(second.id, { status: 'done' });
    taskRepo.updateTask(fresh.id, { status: 'done' });
    const firstEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: first.id,
      summary: 'First tied result',
      createdAt: 20,
    });
    const secondEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: second.id,
      summary: 'Second tied result',
      createdAt: 20,
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: fresh.id,
      summary: 'Fresh result',
      createdAt: 30,
    });
    const orderedIds = [firstEvidence.id, secondEvidence.id].sort();
    cursorRepo.upsert({
      spaceId,
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'completed_task_threshold',
      triggerKey: 'threshold:2',
      lastEvidenceCreatedAt: 20,
      lastEvidenceId: orderedIds[0],
      lastFiredAt: 30,
      metadata: {},
    });
    cursorRepo.upsert({
      spaceId,
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'completed_task_threshold',
      triggerKey: 'threshold:5',
      lastEvidenceCreatedAt: 20,
      lastEvidenceId: orderedIds[1],
      lastFiredAt: 10,
      metadata: {},
    });

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:2',
        reason: 'task_completed',
        taskId: fresh.id,
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async () => {
            throw new Error('should not replay tied evidence after threshold changes');
          },
        },
      }
    );

    expect(result).toMatchObject({
      skipped: true,
      skipReason: 'below_threshold',
      evidenceCount: 1,
    });
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(0);
  });

  it('uses newest completed-task cursor after threshold changes in executor', async () => {
    const goal = goalRepo.create({
      spaceId,
      title: 'Executor threshold changed',
      type: 'recurring',
    });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Executor threshold changed',
      objective: 'Do not replay old evidence in executor',
      policy: { automation: { completedTaskThreshold: 10 } },
    });
    let threshold10EvidenceId = '';
    for (let i = 1; i <= 10; i++) {
      const task = taskRepo.createTask({ spaceId, title: `Old task ${i}`, goalId: goal.id });
      taskRepo.updateTask(task.id, { status: 'done' });
      threshold10EvidenceId = evolutionRepo.createEvidence({
        scopeId: scope.id,
        kind: 'task_result',
        sourceId: task.id,
        summary: `Old result ${i}`,
        createdAt: i,
      }).id;
    }
    cursorRepo.upsert({
      spaceId,
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'completed_task_threshold',
      triggerKey: 'threshold:10',
      lastEvidenceCreatedAt: 10,
      lastEvidenceId: threshold10EvidenceId,
      lastTaskCompletedAt: null,
      lastExternalEventId: null,
      lastEpisodeId: null,
      lastFiredAt: 10,
      metadata: {},
    });
    let threshold5EvidenceId = '';
    for (let i = 11; i <= 15; i++) {
      const task = taskRepo.createTask({
        spaceId,
        title: `Intermediate task ${i}`,
        goalId: goal.id,
      });
      taskRepo.updateTask(task.id, { status: 'done' });
      threshold5EvidenceId = evolutionRepo.createEvidence({
        scopeId: scope.id,
        kind: 'task_result',
        sourceId: task.id,
        summary: `Intermediate result ${i}`,
        createdAt: i,
      }).id;
    }
    cursorRepo.upsert({
      spaceId,
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'completed_task_threshold',
      triggerKey: 'threshold:5',
      lastEvidenceCreatedAt: 15,
      lastEvidenceId: threshold5EvidenceId,
      lastTaskCompletedAt: null,
      lastExternalEventId: null,
      lastEpisodeId: null,
      lastFiredAt: 15,
      metadata: {},
    });
    const freshTask = taskRepo.createTask({ spaceId, title: 'Fresh task', goalId: goal.id });
    taskRepo.updateTask(freshTask.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: freshTask.id,
      summary: 'Fresh result',
      createdAt: 16,
    });

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:10',
        reason: 'task_completed',
        taskId: freshTask.id,
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async () => {
            throw new Error('should not replay old evidence after threshold changes');
          },
        },
      }
    );

    expect(result).toMatchObject({
      skipped: true,
      skipReason: 'below_threshold',
      evidenceCount: 1,
    });
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(0);
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
      summary: 'PR #1 merged',
      createdAt: 10,
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: 'second',
      summary: 'PR #2 merged',
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
        preflightEvidence: () => makePreflight(),
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

  it('skips episode and review task for low-evidence self_nag ticks and records a no-op note', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Thin self nag', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Thin self nag',
      objective: 'Process-level evidence only',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      summary: 'Status note: no new signal this tick',
      createdAt: 30,
    });
    const goalEventRepo = new SpaceGoalEventRepository(db as never);
    let episodeCreated = false;

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-thin',
        reason: 'self_nag',
        scheduleId: 'schedule-thin',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        goalEventRepo,
        episodeService: {
          createFromEvidence: async () => {
            episodeCreated = true;
            throw new Error('should not create episode for low-evidence self_nag');
          },
          // Low confidence, no concrete outcomes, all-manual selection -> skip.
          // (counts.metricSnapshots stays 0; the gate no longer consults it.)
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 0,
              },
            }),
        },
      }
    );

    expect(result).toMatchObject({
      skipped: true,
      skipReason: 'low_evidence_noop',
      episodeId: null,
      reviewTaskId: null,
      evidenceCount: 1,
    });
    expect(episodeCreated).toBe(false);
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(0);
    expect(taskRepo.listBySpace(spaceId, true)).toHaveLength(0);
    // Cursor advances so the next tick is not stuck on the same thin evidence.
    const cursor = cursorRepo.get(goal.id, scope.id, 'self_nag', 'schedule-thin');
    expect(cursor).toMatchObject({ lastEpisodeId: null });
    expect(cursor?.metadata).toMatchObject({ skipReason: 'low_evidence_noop' });
    // A lightweight no-op note is recorded on the goal.
    const events = goalEventRepo.listByGoal(goal.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'automation_noop', source: 'scheduler' });
    expect(events[0]?.note).toContain('Self-nag retrospective skipped');
  });

  it('still produces an episode for non-manual friction traces even at a low preflight', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Low but substantive', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Low but substantive',
      objective: 'Low preflight, real friction trace',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'slow_tool_call',
      sourceId: null,
      summary: 'Slow tool call trace',
      createdAt: 30,
    });

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-substantive',
        reason: 'self_nag',
        scheduleId: 'schedule-substantive',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Substantive retrospective',
              evidenceIds,
              outcomeSummary: 'Substantive outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
          // Low confidence with a friction trace (slow_tool_call) that resolves
          // to task context but is NOT a task_result kind — counts.taskResults,
          // workflowArtifacts, and metricSnapshots are all 0, yet the selection
          // is non-manual, so the gate must preserve the retrospective.
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 40,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 0,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 0,
              },
            }),
        },
      }
    );

    expect(result.skipped).toBe(false);
    expect(result.episodeId).toBeString();
    expect(result.reviewTaskId).toBeString();
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(1);
    expect(taskRepo.listBySpace(spaceId, true)).toHaveLength(1);
  });

  it('still produces an episode for a substantive manual note with concrete outcomes', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Substantive note', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Substantive note',
      objective: 'Manual note with real outcomes',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      // Cross-clause: the earlier "No errors" must not suppress "passed".
      summary: 'No errors; tests passed',
      createdAt: 30,
    });

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-note-outcomes',
        reason: 'self_nag',
        scheduleId: 'schedule-note-outcomes',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Substantive note retrospective',
              evidenceIds,
              outcomeSummary: 'Substantive note outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
          // Manual-only selection, but the note carries concrete PR/CI/merge
          // outcome signal -> not thin, so the retrospective is preserved.
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 24,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 3,
              },
            }),
        },
      }
    );

    expect(result.skipped).toBe(false);
    expect(result.episodeId).toBeString();
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(1);
  });

  it('skips a manual note whose outcome keywords are negated or still pending', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Pending keywords', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Pending keywords',
      objective: 'Status notes that only mention outcome words',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      summary: 'CI has not run yet; tests have not passed; build still pending',
      createdAt: 30,
    });
    let episodeCreated = false;
    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-pending-keywords',
        reason: 'self_nag',
        scheduleId: 'schedule-pending-keywords',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        goalEventRepo: new SpaceGoalEventRepository(db as never),
        episodeService: {
          createFromEvidence: async () => {
            episodeCreated = true;
            throw new Error('should not create episode for negated/pending outcome mentions');
          },
          // Low confidence; the scorer's loose outcome count would be > 0 here
          // (bare "ci"/"build"/"tests" keywords), but none is affirmative.
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 8,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 3,
              },
            }),
        },
      }
    );

    expect(result).toMatchObject({ skipped: true, skipReason: 'low_evidence_noop' });
    expect(episodeCreated).toBe(false);
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(0);
  });

  it('skips a manual note whose outcome reference is trailed by a pending qualifier', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Trailing pending', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Trailing pending',
      objective: 'Outcome references that are still pending afterward',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      // The PR reference matches before the pending qualifier — the suffix
      // check must classify it as still pending, not affirmative.
      summary: 'PR #123 is still pending',
      createdAt: 30,
    });
    let episodeCreated = false;

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-trailing-pending',
        reason: 'self_nag',
        scheduleId: 'schedule-trailing-pending',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        goalEventRepo: new SpaceGoalEventRepository(db as never),
        episodeService: {
          createFromEvidence: async () => {
            episodeCreated = true;
            throw new Error('should not create episode for a trailing-pending outcome reference');
          },
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 1,
              },
            }),
        },
      }
    );

    expect(result).toMatchObject({ skipped: true, skipReason: 'low_evidence_noop' });
    expect(episodeCreated).toBe(false);
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(0);
  });

  it('skips a manual note whose outcome claims are prospective', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Prospective', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Prospective',
      objective: 'Future-tense outcome claims are not results',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      summary: 'Tests will pass after the patch; PR #123 will merge after approval',
      createdAt: 30,
    });
    let episodeCreated = false;

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-prospective',
        reason: 'self_nag',
        scheduleId: 'schedule-prospective',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        goalEventRepo: new SpaceGoalEventRepository(db as never),
        episodeService: {
          createFromEvidence: async () => {
            episodeCreated = true;
            throw new Error('should not create episode for prospective outcome claims');
          },
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 8,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 2,
              },
            }),
        },
      }
    );

    expect(result).toMatchObject({ skipped: true, skipReason: 'low_evidence_noop' });
    expect(episodeCreated).toBe(false);
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(0);
  });

  it('skips a thin batch even when the preflight inflates to medium', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Inflated preflight', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Inflated preflight',
      objective: 'Scope metric and keyword outcomes inflate the score',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      summary: 'PR pending; CI waiting; merge not done; no errors',
      createdAt: 30,
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'session',
      sourceId: null,
      summary: 'Conversation trace: no friction detected',
      metadata: { traceDiagnostic: true, status: 'no_friction' },
      createdAt: 31,
    });
    let episodeCreated = false;
    let goalEventRepoRef: SpaceGoalEventRepository | null = null;

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-inflated',
        reason: 'self_nag',
        scheduleId: 'schedule-inflated',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        goalEventRepo: ((): Pick<SpaceGoalEventRepository, 'create' | 'listByGoal'> => {
          const repo = new SpaceGoalEventRepository(db as never);
          goalEventRepoRef = repo;
          return repo;
        })(),
        episodeService: {
          createFromEvidence: async () => {
            episodeCreated = true;
            throw new Error('should not create episode from inflated thin evidence');
          },
          // Medium from non-manual + keyword-outcome + scope-metric points, but
          // every selected row is thin and no claimed outcome is affirmative —
          // the content test decides, not the score.
          preflightEvidence: () =>
            makePreflight({
              level: 'medium',
              score: 50,
              requiresConfirmation: false,
              counts: {
                total: 2,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 1,
                outcomes: 4,
              },
            }),
        },
      }
    );

    expect(result).toMatchObject({ skipped: true, skipReason: 'low_evidence_noop' });
    expect(episodeCreated).toBe(false);
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(0);
    // The persisted no-op note must report the actual preflight level, not
    // claim "low" for a medium-preflight thin batch.
    const note = goalEventRepoRef?.listByGoal(goal.id)[0]?.note ?? '';
    expect(note).toContain('preflight is medium');
    expect(note).not.toContain('preflight is low');
  });

  it('still produces an episode when a second quantitative change is genuine', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Second change', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Second change',
      objective: 'A negated first measurement must not hide a real second',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      summary: 'No change from 800 ms to 800 ms; latency fell from 800 ms to 200 ms',
      createdAt: 30,
    });

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-second-change',
        reason: 'self_nag',
        scheduleId: 'schedule-second-change',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Second change retrospective',
              evidenceIds,
              outcomeSummary: 'Second change outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 0,
              },
            }),
        },
      }
    );

    expect(result.skipped).toBe(false);
    expect(result.episodeId).toBeString();
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(1);
  });

  it('skips a manual note whose quantitative change is a planned target', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Quantified target', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Quantified target',
      objective: 'A measured target is not an achieved result',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      summary: 'Benchmark target: 800 ms to 200 ms is planned',
      createdAt: 30,
    });
    let episodeCreated = false;

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-quantified-target',
        reason: 'self_nag',
        scheduleId: 'schedule-quantified-target',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        goalEventRepo: new SpaceGoalEventRepository(db as never),
        episodeService: {
          createFromEvidence: async () => {
            episodeCreated = true;
            throw new Error('should not create episode for a planned quantitative target');
          },
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 0,
              },
            }),
        },
      }
    );

    expect(result).toMatchObject({ skipped: true, skipReason: 'low_evidence_noop' });
    expect(episodeCreated).toBe(false);
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(0);
  });

  it('still produces an episode when a pending status belongs to another clause', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Other clause', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Other clause',
      objective: 'A pending status in an independent clause is not this outcome status',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      // The pending status belongs to "deployment", not "Tests passed" — the
      // suffix check must stop at the independent-clause boundary.
      summary: 'Tests passed; deployment pending',
      createdAt: 30,
    });

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-other-clause',
        reason: 'self_nag',
        scheduleId: 'schedule-other-clause',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Other clause retrospective',
              evidenceIds,
              outcomeSummary: 'Other clause outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 2,
              },
            }),
        },
      }
    );

    expect(result.skipped).toBe(false);
    expect(result.episodeId).toBeString();
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(1);
  });

  it('still produces an episode when a pending status follows a conjunction with a new subject', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Conjunction subject', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Conjunction subject',
      objective: 'An unpunctuated new clause has its own subject',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      // "still pending" describes deployment (new subject after "and"), not
      // the completed test result.
      summary: 'Tests passed and deployment is still pending',
      createdAt: 30,
    });

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-conjunction-subject',
        reason: 'self_nag',
        scheduleId: 'schedule-conjunction-subject',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Conjunction subject retrospective',
              evidenceIds,
              outcomeSummary: 'Conjunction subject outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 2,
              },
            }),
        },
      }
    );

    expect(result.skipped).toBe(false);
    expect(result.episodeId).toBeString();
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(1);
  });

  it('still produces an episode when a negation belongs to an earlier conjoined clause', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Conjoined negation', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Conjoined negation',
      objective: 'A negation before a conjunction scopes only its own clause',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      // "No" scopes the errors clause; the conjoined "tests passed" outcome
      // must stay affirmative.
      summary: 'No errors and tests passed',
      createdAt: 30,
    });

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-conjoined-negation',
        reason: 'self_nag',
        scheduleId: 'schedule-conjoined-negation',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Conjoined negation retrospective',
              evidenceIds,
              outcomeSummary: 'Conjoined negation outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 2,
              },
            }),
        },
      }
    );

    expect(result.skipped).toBe(false);
    expect(result.episodeId).toBeString();
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(1);
  });

  it('skips a manual note whose coordinated verbs share one future modal', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Coordinated future', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Coordinated future',
      objective: 'Coordinated predicates share the modal of their clause',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      // "will" scopes the whole coordinated predicate "run and pass".
      summary: 'Tests will run and pass',
      createdAt: 30,
    });
    let episodeCreated = false;

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-coordinated-future',
        reason: 'self_nag',
        scheduleId: 'schedule-coordinated-future',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        goalEventRepo: new SpaceGoalEventRepository(db as never),
        episodeService: {
          createFromEvidence: async () => {
            episodeCreated = true;
            throw new Error('should not create episode for coordinated future predicates');
          },
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 1,
              },
            }),
        },
      }
    );

    expect(result).toMatchObject({ skipped: true, skipReason: 'low_evidence_noop' });
    expect(episodeCreated).toBe(false);
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(0);
  });

  it('still produces an episode when a multiword subject follows a conjunction', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Multiword subject', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Multiword subject',
      objective: 'A multiword subject after a conjunction starts a new clause',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      // "build pipeline" (multiword subject) + "is" starts a new clause, so
      // its "pending" must not suppress the completed "Tests passed".
      summary: 'Tests passed and build pipeline is pending',
      createdAt: 30,
    });

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-multiword-subject',
        reason: 'self_nag',
        scheduleId: 'schedule-multiword-subject',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Multiword subject retrospective',
              evidenceIds,
              outcomeSummary: 'Multiword subject outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 2,
              },
            }),
        },
      }
    );

    expect(result.skipped).toBe(false);
    expect(result.episodeId).toBeString();
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(1);
  });

  it('still produces an episode for a free-form deploy note with artifact references', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Deploy artifact', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Deploy artifact',
      objective: 'Deploy/release verbs with concrete artifact references',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      summary: 'Deployed release v2.4.1 from commit a1b2c3d',
      createdAt: 30,
    });

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-deploy-artifact',
        reason: 'self_nag',
        scheduleId: 'schedule-deploy-artifact',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Deploy artifact retrospective',
              evidenceIds,
              outcomeSummary: 'Deploy artifact outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 0,
              },
            }),
        },
      }
    );

    expect(result.skipped).toBe(false);
    expect(result.episodeId).toBeString();
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(1);
  });

  it('skips a manual note whose artifact reference is prospective', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Prospective artifact', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Prospective artifact',
      objective: 'A planned release is not a completed deploy',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      summary: 'Release v2.4.1 is planned',
      createdAt: 30,
    });
    let episodeCreated = false;

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-prospective-artifact',
        reason: 'self_nag',
        scheduleId: 'schedule-prospective-artifact',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        goalEventRepo: new SpaceGoalEventRepository(db as never),
        episodeService: {
          createFromEvidence: async () => {
            episodeCreated = true;
            throw new Error('should not create episode for a prospective artifact reference');
          },
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 0,
              },
            }),
        },
      }
    );

    expect(result).toMatchObject({ skipped: true, skipReason: 'low_evidence_noop' });
    expect(episodeCreated).toBe(false);
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(0);
  });

  it('still produces an episode for a qualitative note with no outcome keywords', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Qualitative note', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Qualitative note',
      objective: 'A diagnosis or lesson is substantive without outcome wording',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      // No outcome keyword, no status language — a concrete diagnosis and
      // lesson. A manual note is thin only when it is empty or carries
      // status/pending language.
      summary: 'Root cause was lock contention in checkout; use atomic cache replacement',
      createdAt: 30,
    });

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-qualitative',
        reason: 'self_nag',
        scheduleId: 'schedule-qualitative',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Qualitative retrospective',
              evidenceIds,
              outcomeSummary: 'Qualitative outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 0,
              },
            }),
        },
      }
    );

    expect(result.skipped).toBe(false);
    expect(result.episodeId).toBeString();
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(1);
  });

  it('skips a manual note describing required rather than completed artifact work', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Required work', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Required work',
      objective: 'Requirement modals are prospective, not completed',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      summary: 'Need to deploy v2.4.1',
      createdAt: 30,
    });
    let episodeCreated = false;

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-required-work',
        reason: 'self_nag',
        scheduleId: 'schedule-required-work',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        goalEventRepo: new SpaceGoalEventRepository(db as never),
        episodeService: {
          createFromEvidence: async () => {
            episodeCreated = true;
            throw new Error('should not create episode for required (not completed) work');
          },
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 0,
              },
            }),
        },
      }
    );

    expect(result).toMatchObject({ skipped: true, skipReason: 'low_evidence_noop' });
    expect(episodeCreated).toBe(false);
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(0);
  });

  it('still produces an episode for a note mixing a diagnosis with a status clause', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Mixed note', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Mixed note',
      objective: 'One status clause must not discard a substantive clause in the same note',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      // The second clause is status ("blocked", "pending"), but the first is
      // a root-cause diagnosis — the note as a whole is substantive.
      summary: 'Root cause was lock contention; rollout is blocked pending a cache fix',
      createdAt: 30,
    });

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-mixed-note',
        reason: 'self_nag',
        scheduleId: 'schedule-mixed-note',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Mixed note retrospective',
              evidenceIds,
              outcomeSummary: 'Mixed note outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 0,
              },
            }),
        },
      }
    );

    expect(result.skipped).toBe(false);
    expect(result.episodeId).toBeString();
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(1);
  });

  it('skips a note whose every clause is process status', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Pure status', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Pure status',
      objective: 'A note with only status clauses across sentences is thin',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      summary: 'No update this tick. Still waiting on review.',
      createdAt: 30,
    });
    let episodeCreated = false;

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-pure-status',
        reason: 'self_nag',
        scheduleId: 'schedule-pure-status',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        goalEventRepo: new SpaceGoalEventRepository(db as never),
        episodeService: {
          createFromEvidence: async () => {
            episodeCreated = true;
            throw new Error('should not create episode for an all-status note');
          },
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 0,
              },
            }),
        },
      }
    );

    expect(result).toMatchObject({ skipped: true, skipReason: 'low_evidence_noop' });
    expect(episodeCreated).toBe(false);
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(0);
  });

  it('skips a note with an adverb between the conjunction and a prospective verb', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Adverb coordination', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Adverb coordination',
      objective: 'A shared modal scopes a coordinated verb behind an intervening adverb',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      summary: 'Tests will run and eventually pass',
      createdAt: 30,
    });
    let episodeCreated = false;

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-adverb-coordination',
        reason: 'self_nag',
        scheduleId: 'schedule-adverb-coordination',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        goalEventRepo: new SpaceGoalEventRepository(db as never),
        episodeService: {
          createFromEvidence: async () => {
            episodeCreated = true;
            throw new Error('should not create episode for a prospective verb behind an adverb');
          },
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 0,
              },
            }),
        },
      }
    );

    expect(result).toMatchObject({ skipped: true, skipReason: 'low_evidence_noop' });
    expect(episodeCreated).toBe(false);
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(0);
  });

  it('still produces an episode when a status shorthand clause omits its linking verb', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Omitted verb', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Omitted verb',
      objective: 'A new subject with a status adjective is a clause boundary without is/was',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      // "but deployment [is] pending" — the pending status belongs to the
      // deployment clause, so "passed" stays affirmative.
      summary: 'Tests passed but deployment pending',
      createdAt: 30,
    });

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-omitted-verb',
        reason: 'self_nag',
        scheduleId: 'schedule-omitted-verb',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Omitted verb retrospective',
              evidenceIds,
              outcomeSummary: 'Omitted verb outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 0,
              },
            }),
        },
      }
    );

    expect(result.skipped).toBe(false);
    expect(result.episodeId).toBeString();
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(1);
  });

  it('does not compute the preflight for substantive self_nag selections', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Lazy preflight', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Lazy preflight',
      objective: 'Substantive ticks must not pay a duplicate buildEpisodeInput',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      summary: 'PR #9 merged',
      createdAt: 30,
    });
    let preflightCalls = 0;

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-lazy-preflight',
        reason: 'self_nag',
        scheduleId: 'schedule-lazy-preflight',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Lazy preflight retrospective',
              evidenceIds,
              outcomeSummary: 'Lazy preflight outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
          preflightEvidence: () => {
            preflightCalls += 1;
            return makePreflight();
          },
        },
      }
    );

    // The skip decision no longer needs the preflight score, so a substantive
    // selection must not compute it at all — it is evaluated only on the skip
    // path for the audit note.
    expect(result.skipped).toBe(false);
    expect(preflightCalls).toBe(0);
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(1);
  });

  it('skips a manual note whose metadata only has non-affirmative key names', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Metadata keys', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Metadata keys',
      objective: 'Metadata whose keys are outcome words but values are absent',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      summary: 'Waiting on the pipeline',
      // Key names are outcome words, but the values are explicitly absent —
      // serializing the whole object must not make them affirmative.
      metadata: { passed: false, error: null, status: 'pending' },
      createdAt: 30,
    });
    let episodeCreated = false;

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-metadata-keys',
        reason: 'self_nag',
        scheduleId: 'schedule-metadata-keys',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        goalEventRepo: new SpaceGoalEventRepository(db as never),
        episodeService: {
          createFromEvidence: async () => {
            episodeCreated = true;
            throw new Error('should not create episode from metadata key names alone');
          },
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 0,
              },
            }),
        },
      }
    );

    expect(result).toMatchObject({ skipped: true, skipReason: 'low_evidence_noop' });
    expect(episodeCreated).toBe(false);
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(0);
  });

  it('still produces an episode for a manual note with a quantitative outcome', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Quantified result', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Quantified result',
      objective: 'Manual note with a measured change',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: null,
      summary: 'Benchmark latency dropped from 800 ms to 200 ms',
      createdAt: 30,
    });

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-quantified',
        reason: 'self_nag',
        scheduleId: 'schedule-quantified',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Quantified retrospective',
              evidenceIds,
              outcomeSummary: 'Quantified outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
          // A measured value changing to another measured value is a concrete
          // outcome even though no outcome keyword appears in the note.
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 1,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 0,
              },
            }),
        },
      }
    );

    expect(result.skipped).toBe(false);
    expect(result.episodeId).toBeString();
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(1);
  });

  it('skips an empty auto-generated session trace diagnostic with no outcomes', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Empty trace', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Empty trace',
      objective: 'No-friction session diagnostic',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'session',
      sourceId: null,
      summary: 'Conversation trace: no friction detected',
      metadata: { traceDiagnostic: true, status: 'no_friction' },
      createdAt: 30,
    });
    const goalEventRepo = new SpaceGoalEventRepository(db as never);
    let episodeCreated = false;

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-empty-trace',
        reason: 'self_nag',
        scheduleId: 'schedule-empty-trace',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        goalEventRepo,
        episodeService: {
          createFromEvidence: async () => {
            episodeCreated = true;
            throw new Error('should not create episode for an empty trace diagnostic');
          },
          // A session diagnostic with no outcomes and no task context is thin
          // even though it is not a manual note -> skip.
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 0,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 0,
              },
            }),
        },
      }
    );

    expect(result).toMatchObject({
      skipped: true,
      skipReason: 'low_evidence_noop',
      episodeId: null,
      reviewTaskId: null,
    });
    expect(episodeCreated).toBe(false);
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(0);
    const cursor = cursorRepo.get(goal.id, scope.id, 'self_nag', 'schedule-empty-trace');
    expect(cursor?.metadata).toMatchObject({ skipReason: 'low_evidence_noop' });
    expect(goalEventRepo.listByGoal(goal.id)[0]).toMatchObject({
      eventType: 'automation_noop',
    });
  });

  it('still produces an episode for a genuine session summary without the traceDiagnostic marker', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Session summary', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Session summary',
      objective: 'Genuine session conversation summary',
      policy: { automation: { selfNagCronExpression: '0 * * * *' } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'session',
      sourceId: null,
      // A real conversation summary (no traceDiagnostic marker, no outcome
      // words) must NOT be treated as thin just because it is kind 'session'.
      summary: 'Discussed the API design tradeoffs with the team.',
      createdAt: 30,
    });

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'self_nag',
        triggerKey: 'schedule-session-summary',
        reason: 'self_nag',
        scheduleId: 'schedule-session-summary',
      }),
      {
        goalRepo,
        taskRepo,
        evolutionRepo,
        cursorRepo,
        episodeService: {
          createFromEvidence: async ({ evidenceIds }) => ({
            episode: evolutionRepo.createEpisode({
              scopeId: scope.id,
              title: 'Session summary retrospective',
              evidenceIds,
              outcomeSummary: 'Session outcome',
              findings: [],
            }),
            proposals: [],
            lessons: [],
          }),
          preflightEvidence: () =>
            makePreflight({
              level: 'low',
              score: 0,
              requiresConfirmation: true,
              counts: {
                total: 1,
                manualNotes: 0,
                taskResults: 0,
                workflowArtifacts: 0,
                metricSnapshots: 0,
                outcomes: 0,
              },
            }),
        },
      }
    );

    expect(result.skipped).toBe(false);
    expect(result.episodeId).toBeString();
    expect(evolutionRepo.listEpisodes(scope.id)).toHaveLength(1);
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
    // The capped slice (12) plus the triggering external-event evidence.
    expect(episodeEvidenceIds).toHaveLength(13);
    const freshEvidence = evolutionRepo
      .listEvidence(scope.id)
      .find((item) => item.sourceId === 'fresh-event');
    expect(freshEvidence).toBeDefined();
    expect(episodeEvidenceIds).toContain(freshEvidence?.id as string);
    const cursor = cursorRepo.get(goal.id, scope.id, 'external_event', 'event:*:pull_request/*');
    expect(cursor?.lastExternalEventId).toBe('fresh-event');
  });

  it('includes triggering task result even when maxEvidence caps older evidence', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Capped task results', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Capped task results',
      objective: 'Include triggering task',
      policy: { automation: { completedTaskThreshold: 1, maxEvidencePerEpisode: 2 } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: 'old-1',
      summary: 'Old note 1',
      createdAt: 1,
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: 'old-2',
      summary: 'Old note 2',
      createdAt: 2,
    });
    const task = taskRepo.createTask({ spaceId, title: 'Triggering task', goalId: goal.id });
    taskRepo.updateTask(task.id, { status: 'done' });
    const taskEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Triggering result',
      createdAt: 3,
    });
    let episodeEvidenceIds: string[] = [];

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:1',
        reason: 'task_completed',
        taskId: task.id,
      }),
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
                title: 'Capped task retrospective',
                evidenceIds,
                outcomeSummary: 'Included triggering task',
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
    expect(episodeEvidenceIds).toHaveLength(3);
    expect(episodeEvidenceIds).toContain(taskEvidence.id);
    const cursor = cursorRepo.get(goal.id, scope.id, 'completed_task_threshold', 'threshold:1');
    expect(cursor?.lastEvidenceCreatedAt).toBe(taskEvidence.createdAt);
    expect(cursor?.lastEvidenceId).toBe(taskEvidence.id);
  });

  it('preserves intervening evidence between cap and trigger in episode', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Intervening evidence', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Intervening evidence',
      objective: 'Keep cursor contiguous',
      policy: { automation: { completedTaskThreshold: 1, maxEvidencePerEpisode: 2 } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: 'old-1',
      summary: 'Old note 1',
      createdAt: 1,
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: 'old-2',
      summary: 'Old note 2',
      createdAt: 2,
    });
    const intervening = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: 'intervening',
      summary: 'Intervening note',
      createdAt: 3,
    });
    const task = taskRepo.createTask({ spaceId, title: 'Triggering task', goalId: goal.id });
    taskRepo.updateTask(task.id, { status: 'done' });
    const taskEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Triggering result',
      createdAt: 4,
    });
    let episodeEvidenceIds: string[] = [];

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:1',
        reason: 'task_completed',
        taskId: task.id,
      }),
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
                title: 'Intervening retrospective',
                evidenceIds,
                outcomeSummary: 'Preserved intervening evidence',
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
    expect(episodeEvidenceIds).toHaveLength(4);
    expect(episodeEvidenceIds).toContain(intervening.id);
    expect(episodeEvidenceIds).toContain(taskEvidence.id);
    const cursor = cursorRepo.get(goal.id, scope.id, 'completed_task_threshold', 'threshold:1');
    expect(cursor?.lastEvidenceCreatedAt).toBe(taskEvidence.createdAt);
    expect(cursor?.lastEvidenceId).toBe(taskEvidence.id);
  });

  it('requires task_result kind when matching triggering task evidence', async () => {
    const goal = goalRepo.create({ spaceId, title: 'Trigger kind filter', type: 'recurring' });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Trigger kind filter',
      objective: 'Match only task_result',
      policy: { automation: { completedTaskThreshold: 1, maxEvidencePerEpisode: 2 } },
    });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: 'old-1',
      summary: 'Old note 1',
      createdAt: 1,
    });
    const task = taskRepo.createTask({ spaceId, title: 'Triggering task', goalId: goal.id });
    taskRepo.updateTask(task.id, { status: 'done' });
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      sourceId: task.id,
      summary: 'Older non-task evidence with same sourceId',
      createdAt: 2,
    });
    const taskEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Actual task result',
      createdAt: 3,
    });
    let episodeEvidenceIds: string[] = [];

    const result = await handleGoalAutomationExecute(
      createAutomationJob({
        goalId: goal.id,
        scopeId: scope.id,
        triggerKind: 'completed_task_threshold',
        triggerKey: 'threshold:1',
        reason: 'task_completed',
        taskId: task.id,
      }),
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
                title: 'Kind filter retrospective',
                evidenceIds,
                outcomeSummary: 'Matched task_result only',
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
    expect(episodeEvidenceIds).toHaveLength(3);
    expect(episodeEvidenceIds).toContain(taskEvidence.id);
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
    const t0 = Date.now();
    evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      summary: 'Early evidence: PR merged',
      createdAt: t0,
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
        preflightEvidence: () => makePreflight(),
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
      summary: 'Later evidence: tests passed',
      createdAt: t0 + 1,
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
