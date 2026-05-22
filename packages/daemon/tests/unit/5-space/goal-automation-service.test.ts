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
		spaceRepo = new SpaceRepository(db as never);
		taskRepo = new SpaceTaskRepository(db as never);
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
			labels: ['forge', 'review', 'automation'],
		});
		expect(reviewTask?.description).toContain(evidence.id);
		expect(published).toHaveLength(1);
		expect(published[0].event).toBe('space.task.created');
		const cursor = cursorRepo.get(goal.id, 'completed_task_threshold', 'threshold:1');
		expect(cursor).toMatchObject({
			goalId: goal.id,
			scopeId: scope.id,
			lastEvidenceCreatedAt: 40,
			lastEpisodeId: result.episodeId,
		});
		expect(cursor?.metadata.evidenceIds).toEqual([evidence.id]);
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
			createdAt: 50,
		});
		expect(eventEvidence.metadata).toMatchObject({
			autoCaptured: true,
			triggerKind: 'external_event',
			source: 'github',
			topic: 'pull_request/closed',
		});
		const cursor = cursorRepo.get(goal.id, 'external_event', 'event:*:pull_request/*');
		expect(cursor?.lastExternalEventId).toBe('event-2');
	});
});
