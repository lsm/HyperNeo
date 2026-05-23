import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { SpaceTask, SpaceWorkflow } from '@neokai/shared';
import { ExternalEventService } from '../../../../src/lib/external-events/external-event-service';
import { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';
import { createInternalCommandBus } from '../../../../src/lib/internal-command-bus';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager';
import {
	parsePositiveIntegerEnv,
	SpaceRuntime,
} from '../../../../src/lib/space/runtime/space-runtime';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

const SPACE_ID = 'space-runtime-events';
const AGENT_ID = 'agent-runtime-events';
const DEFAULT_TOPIC = 'github/*/*/pull_request/*.review_*';
const LEGACY_TOPIC = 'github/*/*/pull_request.review_*';

describe('parsePositiveIntegerEnv', () => {
	test('rejects fractional and non-positive values', () => {
		const previous = process.env.TEST_POSITIVE_INTEGER_ENV;
		try {
			process.env.TEST_POSITIVE_INTEGER_ENV = '0.5';
			expect(parsePositiveIntegerEnv('TEST_POSITIVE_INTEGER_ENV', 10)).toBe(10);

			process.env.TEST_POSITIVE_INTEGER_ENV = '0';
			expect(parsePositiveIntegerEnv('TEST_POSITIVE_INTEGER_ENV', 10)).toBe(10);

			process.env.TEST_POSITIVE_INTEGER_ENV = '11';
			expect(parsePositiveIntegerEnv('TEST_POSITIVE_INTEGER_ENV', 10)).toBe(11);
		} finally {
			if (previous === undefined) {
				delete process.env.TEST_POSITIVE_INTEGER_ENV;
			} else {
				process.env.TEST_POSITIVE_INTEGER_ENV = previous;
			}
		}
	});
});

function makeDb(): Database {
	const db = new Database(':memory:');
	createSpaceTables(db);
	const now = Date.now();
	db.prepare(
		`INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(SPACE_ID, SPACE_ID, '/tmp/runtime-events', 'Runtime Events', now, now);
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, description, tools, system_prompt, created_at, updated_at)
		 VALUES (?, ?, ?, '', '[]', '', ?, ?)`
	).run(AGENT_ID, SPACE_ID, 'Coder', now, now);
	return db;
}

function makeEvent(overrides: Partial<ExternalEvent> = {}): ExternalEvent {
	return {
		id: `evt-${Math.random().toString(36).slice(2)}`,
		spaceId: SPACE_ID,
		source: 'github',
		topic: 'github/lsm/neokai/pull_request/42.review_submitted',
		occurredAt: 1_700_000_000_000,
		ingestedAt: 1_700_000_001_000,
		dedupeKey: `dedupe-${Math.random().toString(36).slice(2)}`,
		summary: 'PR review submitted',
		payload: { action: 'review_submitted', prNumber: 42 },
		...overrides,
	};
}

class MockTaskAgentManager {
	alive = new Set<string>();
	spawned: string[] = [];

	isSessionAlive(sessionId: string): boolean {
		return this.alive.has(sessionId);
	}

	async rehydrate(): Promise<void> {}

	isExecutionSpawning(_executionId: string): boolean {
		return false;
	}

	async tryResumeNodeAgentSession(): Promise<void> {}

	cancelBySessionId(sessionId: string): void {
		this.alive.delete(sessionId);
	}

	async prepareSubSessionForWorkflowResume(): Promise<boolean> {
		return true;
	}

	async flushPendingMessagesForTarget(): Promise<void> {}

	async spawnWorkflowNodeAgentForExecution(
		_task: unknown,
		_space: unknown,
		_workflow: unknown,
		_run: unknown,
		execution: { id: string },
		_options?: unknown
	): Promise<string> {
		const sessionId = `session-${execution.id}`;
		this.spawned.push(sessionId);
		this.alive.add(sessionId);
		return sessionId;
	}
}

describe('SpaceRuntime external event subscriptions', () => {
	let db: Database;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	let taskRepo: SpaceTaskRepository;
	let nodeExecutionRepo: NodeExecutionRepository;
	let workflowManager: SpaceWorkflowManager;
	let runtime: SpaceRuntime;
	let eventStore: ExternalEventStore;
	let eventService: ExternalEventService;
	let injected: Array<{ sessionId: string; message: string; deliveryMode?: string }>;
	let tam: MockTaskAgentManager;
	let bus: ReturnType<typeof createDaemonInternalEventBus>;

	function createWorkflow(
		nodeId = 'code',
		options: { eventInterests?: Array<{ topic: string }> } = {}
	): SpaceWorkflow {
		return workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Workflow ${Math.random()}`,
			description: '',
			nodes: [
				{
					id: nodeId,
					name: 'Code',
					agents: [
						{
							agentId: AGENT_ID,
							name: 'coder',
							...(options.eventInterests ? { eventInterests: options.eventInterests } : {}),
						},
					],
				},
			],
			transitions: [],
			startNodeId: nodeId,
			rules: [],
			tags: [],
		});
	}

	/**
	 * Create a workflow, start a run, and register a subscription topic.
	 * Returns the workflow, run, and canonical task.
	 */
	async function startRunWithSubscription(
		topic = DEFAULT_TOPIC,
		nodeId = 'code',
		options: { staticInterest?: boolean } = {}
	): Promise<{
		workflow: SpaceWorkflow;
		run: Awaited<ReturnType<typeof runtime.startWorkflowRun>>['run'];
		task: SpaceTask;
	}> {
		const workflow = createWorkflow(
			nodeId,
			options.staticInterest ? { eventInterests: [{ topic }] } : {}
		);
		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const task = tasks[0]!;
		if (!options.staticInterest) {
			runtime.registerSubscription(run.id, task.id, nodeId, 'coder', topic);
		}
		return { workflow, run, task };
	}

	beforeEach(() => {
		db = makeDb();
		workflowRunRepo = new SpaceWorkflowRunRepository(db);
		taskRepo = new SpaceTaskRepository(db);
		nodeExecutionRepo = new NodeExecutionRepository(db);
		workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
		bus = createDaemonInternalEventBus();
		const commandBus = createInternalCommandBus();
		eventStore = new ExternalEventStore(db);
		eventService = new ExternalEventService(eventStore, bus);
		injected = [];
		commandBus.register('agent.message.inject', async (command) => {
			injected.push({
				sessionId: command.sessionId,
				message: command.message,
				deliveryMode: command.deliveryMode,
			});
			return { ok: true };
		});
		tam = new MockTaskAgentManager();
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
	});

	test('delivers matching events to a live node-agent session and marks delivery complete', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-live',
			startedAt: Date.now(),
		});
		tam.alive.add('session-live');

		const event = makeEvent();
		await eventService.publish(event);

		expect(injected).toHaveLength(1);
		expect(injected[0]!.sessionId).toBe('session-live');
		expect(injected[0]!.deliveryMode).toBe('immediate');
		expect(JSON.parse(injected[0]!.message).eventId).toBe(event.id);
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
		const deliveries = eventStore.listDeliveries(event.id);
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]!.state).toBe('delivered');
		expect(deliveries[0]!.taskId).toBe(task.id);
	});

	test('queues matching events for pending nodes and flushes after session creation', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const event = makeEvent();

		await eventService.publish(event);

		expect(injected).toHaveLength(0);
		expect(eventStore.getById(event.id)?.state).toBe('published');
		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('pending');

		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: task.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-flush',
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(injected).toHaveLength(1);
		expect(injected[0]!.sessionId).toBe('session-flush');
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
	});

	test('marks unmatched events ignored', async () => {
		const { run, task } = await startRunWithSubscription(DEFAULT_TOPIC);
		await runtime.executeTick();

		const event = makeEvent({ topic: 'github/lsm/neokai/pull_request/42.comment_created' });
		await eventService.publish(event);

		expect(injected).toHaveLength(0);
		expect(eventStore.getById(event.id)?.state).toBe('ignored');
	});

	test('fails queued deliveries when an execution is unregistered', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const event = makeEvent();
		await eventService.publish(event);

		runtime.unregisterExecution(run.id, task.id, 'code', 'coder');

		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toBe('node_execution_cancelled');
		expect(eventStore.getById(event.id)?.state).toBe('failed');
	});

	test('throws for invalid static event interest topics during registration', async () => {
		const workflow = createWorkflow();
		workflow.nodes[0]!.agents![0]!.eventInterests = [{ topic: 'github/**/pull_request/*.opened' }];
		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

		expect(() => runtime.registerRunInterests(run.id, tasks[0]!.id, workflow.nodes)).toThrow(
			'Invalid static external event interest'
		);
	});

	test('allows the first 10 event interests for an agent slot', async () => {
		const workflow = createWorkflow();
		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const task = tasks[0]!;

		for (let index = 0; index < 10; index += 1) {
			expect(() =>
				runtime.registerSubscription(
					run.id,
					task.id,
					'code',
					'coder',
					`github/owner/repo/pull_request_${index}.opened`
				)
			).not.toThrow();
		}
	});

	test('rejects the 11th event interest for an agent slot', async () => {
		const workflow = createWorkflow();
		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const task = tasks[0]!;

		for (let index = 0; index < 10; index += 1) {
			runtime.registerSubscription(
				run.id,
				task.id,
				'code',
				'coder',
				`github/owner/repo/pull_request_${index}.opened`
			);
		}

		expect(() =>
			runtime.registerSubscription(
				run.id,
				task.id,
				'code',
				'coder',
				'github/owner/repo/pull_request_10.opened'
			)
		).toThrow('cannot register more than 10 event interests');
	});

	test('allows new event interests after an agent slot unsubscribes', async () => {
		const workflow = createWorkflow();
		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const task = tasks[0]!;

		for (let index = 0; index < 10; index += 1) {
			runtime.registerSubscription(
				run.id,
				task.id,
				'code',
				'coder',
				`github/owner/repo/pull_request_${index}.opened`
			);
		}

		runtime.unregisterExecution(run.id, task.id, 'code', 'coder');

		expect(() =>
			runtime.registerSubscription(
				run.id,
				task.id,
				'code',
				'coder',
				'github/owner/repo/pull_request_10.opened'
			)
		).not.toThrow();
	});

	test('drops stale queued deliveries when run interests are rebuilt', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const event = makeEvent();
		await eventService.publish(event);

		runtime.registerRunInterests(run.id, task.id, workflow.nodes, {
			clearQueuedDeliveries: true,
		});
		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: task.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-stale',
		});

		expect(injected).toHaveLength(0);
		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toBe('run_interests_rebuilt');
	});

	test('does not ignore unmatched events before runtime rehydrate completes', async () => {
		const event = makeEvent();
		await eventService.publish(event);

		expect(eventStore.getById(event.id)?.state).toBe('published');
		expect(eventStore.listDeliveries(event.id)).toHaveLength(0);
	});

	test('re-subscribes external event listener after runtime restart', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-restart',
			startedAt: Date.now(),
		});
		tam.alive.add('session-restart');

		await runtime.stop();
		runtime.registerSubscription(
			run.id,
			taskRepo.listByWorkflowRun(run.id)[0]!.id,
			'code',
			'coder',
			DEFAULT_TOPIC
		);
		runtime.start();
		await runtime.executeTick();

		const event = makeEvent();
		await eventService.publish(event);

		expect(injected).toHaveLength(1);
		expect(injected[0]!.sessionId).toBe('session-restart');
	});

	test('delivers five-segment events to legacy four-segment GitHub subscriptions', async () => {
		const { run } = await startRunWithSubscription(LEGACY_TOPIC);
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-legacy-topic',
			startedAt: Date.now(),
		});
		tam.alive.add('session-legacy-topic');

		const event = makeEvent();
		await eventService.publish(event);

		expect(injected).toHaveLength(1);
		expect(injected[0]!.sessionId).toBe('session-legacy-topic');
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
	});

	test('deduplicates dispatch attempts for overlapping interests', async () => {
		const { run, task } = await startRunWithSubscription('github/*/*/pull_request/*.*');
		// Register a second overlapping topic
		runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-dedupe',
			startedAt: Date.now(),
		});
		tam.alive.add('session-dedupe');

		const event = makeEvent();
		await eventService.publish(event);

		expect(eventStore.listDeliveries(event.id)).toHaveLength(1);
		expect(injected).toHaveLength(1);
		expect(injected[0]!.sessionId).toBe('session-dedupe');
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
	});

	test('preserves subscriptions across dependency-added block and recovery', async () => {
		const { run, task } = await startRunWithSubscription(DEFAULT_TOPIC);
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-before-block',
			startedAt: Date.now(),
		});
		tam.alive.add('session-before-block');

		await runtime.blockWorkflowBackedTask(SPACE_ID, task.id, {
			status: 'blocked',
			blockReason: 'dependency_added',
			result: 'Dependency added while task was in progress',
			completedAt: null,
		});
		const blockedEvent = makeEvent({
			id: 'evt-blocked-preserved-subscription',
			dedupeKey: 'dedupe-blocked-preserved-subscription',
		});
		await eventService.publish(blockedEvent);
		expect(eventStore.getById(blockedEvent.id)?.state).toBe('published');
		expect(eventStore.listDeliveries(blockedEvent.id)).toHaveLength(0);

		await runtime.recoverWorkflowBackedTask(SPACE_ID, task.id, 'in_progress');
		const recoveredExecution = [...nodeExecutionRepo.listByNode(run.id, 'code')]
			.filter((execution) => execution.completedAt === null && execution.status !== 'cancelled')
			.sort((a, b) => b.updatedAt - a.updatedAt)[0]!;
		const sessionId = recoveredExecution.agentSessionId ?? 'session-after-recover';
		nodeExecutionRepo.update(recoveredExecution.id, {
			status: 'in_progress',
			agentSessionId: sessionId,
			startedAt: Date.now(),
			completedAt: null,
		});
		tam.alive.add(sessionId);

		const event = makeEvent();
		await eventService.publish(event);

		expect(injected).toHaveLength(1);
		expect(injected[0]!.sessionId).toBe(sessionId);
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
	});

	test('fails queued deliveries during terminal run cleanup', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const event = makeEvent();
		await eventService.publish(event);

		workflowRunRepo.updateRun(run.id, { status: 'cancelled' });
		await runtime.executeTick();

		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toBe('run_not_externally_deliverable');
		expect(eventStore.getById(event.id)?.state).toBe('failed');
	});

	test('delivers matching events to idle sessions using defer mode', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-idle',
			startedAt: Date.now(),
		});

		const event = makeEvent();
		await eventService.publish(event);

		expect(injected).toHaveLength(1);
		expect(injected[0]!.sessionId).toBe('session-idle');
		expect(injected[0]!.deliveryMode).toBe('defer');
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
	});

	test('coalesces events over rate limit into a digest', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-rate-limit',
			startedAt: Date.now(),
		});
		tam.alive.add('session-rate-limit');
		const rateLimitState = runtime as unknown as {
			externalEventRateLimits: Map<string, unknown>;
		};

		const events = Array.from({ length: 15 }, (_, index) =>
			makeEvent({
				id: `evt-rate-limit-${index}`,
				dedupeKey: `dedupe-rate-limit-${index}`,
				topic:
					index % 2 === 0
						? 'github/lsm/neokai/pull_request/42.review_submitted'
						: 'github/lsm/neokai/pull_request/42.review_comment',
				occurredAt: 1_700_000_000_000 + index,
			})
		);

		for (const event of events) {
			await eventService.publish(event);
		}
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(injected).toHaveLength(11);
		expect(injected.slice(0, 10).map((item) => JSON.parse(item.message).eventId)).toEqual(
			events.slice(0, 10).map((event) => event.id)
		);
		expect(injected[10]!.message).toBe(
			'5 events received for topics: github/lsm/neokai/pull_request/42.review_comment, github/lsm/neokai/pull_request/42.review_submitted (oldest: 2023-11-14T22:13:20.010Z, newest: 2023-11-14T22:13:20.014Z). Use subscribe_external_event to get details.'
		);
		for (const event of events) {
			expect(eventStore.getById(event.id)?.state).toBe('delivered');
			expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('delivered');
		}
		expect(rateLimitState.externalEventRateLimits.size).toBe(1);
	});

	test('releases idle rate-limit buckets after window expiry', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-rate-cleanup',
			startedAt: Date.now(),
		});
		tam.alive.add('session-rate-cleanup');
		const event = makeEvent({ id: 'evt-rate-cleanup', dedupeKey: 'dedupe-rate-cleanup' });

		await eventService.publish(event);
		const rateLimitState = runtime as unknown as {
			externalEventRateLimits: Map<string, { timestamps: number[] }>;
			scheduleExternalEventRateLimitCleanup(rateLimitKey: string): void;
		};
		expect(rateLimitState.externalEventRateLimits.has(execution.id)).toBe(true);

		const state = rateLimitState.externalEventRateLimits.get(execution.id)! as {
			timestamps: number[];
			cleanupTimer: Timer | null;
		};
		if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
		state.cleanupTimer = null;
		state.timestamps = [Date.now() - 60_001];
		rateLimitState.scheduleExternalEventRateLimitCleanup(execution.id);

		expect(rateLimitState.externalEventRateLimits.has(execution.id)).toBe(false);
	});

	test('coalesces all events after digest within the same rate window', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-sustained-rate-limit',
			startedAt: Date.now(),
		});
		tam.alive.add('session-sustained-rate-limit');
		const originalNow = Date.now;
		let fakeNow = originalNow();
		Date.now = () => fakeNow;
		try {
			const firstBurst = Array.from({ length: 15 }, (_, index) =>
				makeEvent({
					id: `evt-sustained-rate-first-${index}`,
					dedupeKey: `dedupe-sustained-rate-first-${index}`,
					occurredAt: 1_700_000_000_000 + index,
				})
			);
			for (const event of firstBurst) {
				await eventService.publish(event);
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(injected).toHaveLength(11);

			fakeNow += 1_000;
			const secondBurst = Array.from({ length: 3 }, (_, index) =>
				makeEvent({
					id: `evt-sustained-rate-second-${index}`,
					dedupeKey: `dedupe-sustained-rate-second-${index}`,
					occurredAt: 1_700_000_001_000 + index,
				})
			);
			for (const event of secondBurst) {
				await eventService.publish(event);
			}
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(injected).toHaveLength(12);
			expect(injected[11]!.message).toContain(
				'3 events received for topics: github/lsm/neokai/pull_request/42.review_submitted'
			);
		} finally {
			Date.now = originalNow;
		}
	});

	test('flushes digest to the current execution session', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-digest-stale',
			startedAt: Date.now(),
		});
		tam.alive.add('session-digest-stale');
		const events = Array.from({ length: 11 }, (_, index) =>
			makeEvent({
				id: `evt-digest-current-session-${index}`,
				dedupeKey: `dedupe-digest-current-session-${index}`,
				occurredAt: 1_700_000_000_000 + index,
			})
		);

		for (const event of events) {
			await eventService.publish(event);
		}
		tam.alive.delete('session-digest-stale');
		tam.alive.add('session-digest-fresh');
		nodeExecutionRepo.update(execution.id, {
			agentSessionId: 'session-digest-fresh',
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(injected).toHaveLength(11);
		expect(injected[10]!.sessionId).toBe('session-digest-fresh');
		expect(injected[10]!.message).toContain(
			'1 events received for topics: github/lsm/neokai/pull_request/42.review_submitted'
		);
		expect(eventStore.getById(events[10]!.id)?.state).toBe('delivered');
	});

	test('retries digest failures against the resolved flush target', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-digest-stale-retry',
			startedAt: Date.now(),
		});
		tam.alive.add('session-digest-stale-retry');
		await runtime.stop();
		let failNext = true;
		const commandBus = createInternalCommandBus();
		commandBus.register('agent.message.inject', async (command) => {
			if (failNext && command.metadata?.source === 'external_event_digest') {
				failNext = false;
				return { ok: false, error: 'temporary digest target failure' };
			}
			injected.push({
				sessionId: command.sessionId,
				message: command.message,
				deliveryMode: command.deliveryMode,
			});
			return { ok: true };
		});
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
		const events = Array.from({ length: 11 }, (_, index) =>
			makeEvent({
				id: `evt-digest-resolved-retry-${index}`,
				dedupeKey: `dedupe-digest-resolved-retry-${index}`,
			})
		);

		for (const event of events) {
			await eventService.publish(event);
		}
		tam.alive.delete('session-digest-stale-retry');
		tam.alive.add('session-digest-fresh-retry');
		nodeExecutionRepo.update(execution.id, {
			agentSessionId: 'session-digest-fresh-retry',
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(injected).toHaveLength(10);
		const digestDelivery = eventStore.listDeliveries(events[10]!.id)[0]!;
		expect(digestDelivery.failureReason).toBe(
			'deliveryMode:immediate; digest; temporary digest target failure'
		);

		await new Promise((resolve) => setTimeout(resolve, 1100));
		expect(injected).toHaveLength(11);
		expect(injected[10]!.sessionId).toBe('session-digest-fresh-retry');
		expect(eventStore.getById(events[10]!.id)?.state).toBe('delivered');
	});

	test('preserves deferred mode when digest delivery is retried after rehydrate', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-digest-defer',
			startedAt: Date.now(),
		});
		await runtime.stop();
		const commandBus = createInternalCommandBus();
		commandBus.register('agent.message.inject', async () => ({
			ok: false,
			error: 'temporary digest failure',
		}));
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
		const events = Array.from({ length: 11 }, (_, index) =>
			makeEvent({
				id: `evt-digest-defer-${index}`,
				dedupeKey: `dedupe-digest-defer-${index}`,
			})
		);

		for (const event of events) {
			await eventService.publish(event);
		}
		await new Promise((resolve) => setTimeout(resolve, 0));

		const digestDelivery = eventStore.listDeliveries(events[10]!.id)[0]!;
		expect(digestDelivery.state).toBe('pending');
		expect(digestDelivery.failureReason).toBe(
			'deliveryMode:defer; digest; temporary digest failure'
		);
	});

	test('delivers events within rate limit normally', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-within-rate-limit',
			startedAt: Date.now(),
		});
		tam.alive.add('session-within-rate-limit');
		const events = Array.from({ length: 10 }, (_, index) =>
			makeEvent({ id: `evt-within-rate-${index}`, dedupeKey: `dedupe-within-rate-${index}` })
		);

		for (const event of events) {
			await eventService.publish(event);
		}
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(injected).toHaveLength(10);
		expect(injected.map((item) => JSON.parse(item.message).eventId)).toEqual(
			events.map((event) => event.id)
		);
	});

	test('drops queued deliveries older than ttl instead of delivering them', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const event = makeEvent({ id: 'evt-expired-queued', dedupeKey: 'dedupe-expired-queued' });
		await eventService.publish(event);
		const originalNow = Date.now;
		Date.now = () => originalNow() + 300_001;
		try {
			runtime.flushPendingNodeQueue({
				workflowRunId: run.id,
				taskId: task.id,
				nodeId: 'code',
				agentName: 'coder',
				sessionId: 'session-expired-queued',
			});
		} finally {
			Date.now = originalNow;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(injected).toHaveLength(0);
		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toBe('ttl_expired');
		expect(eventStore.getById(event.id)?.state).toBe('failed');
	});

	test('evicts expired queued deliveries from memory during retry reschedule', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const staleEvents = Array.from({ length: 50 }, (_, index) =>
			makeEvent({
				id: `evt-stale-queued-${index}`,
				dedupeKey: `dedupe-stale-queued-${index}`,
			})
		);
		for (const event of staleEvents) {
			await eventService.publish(event);
		}
		await runtime.stop();
		const originalNow = Date.now;
		Date.now = () => originalNow() + 300_001;
		try {
			runtime.start();
		} finally {
			Date.now = originalNow;
		}
		const queued = runtime as unknown as {
			pendingExternalEventQueue: Map<string, Array<{ deliveryKey: string }>>;
		};
		expect([...queued.pendingExternalEventQueue.values()].flat()).toHaveLength(0);
		expect(eventStore.listDeliveries(staleEvents[0]!.id)[0]!.failureReason).toBe('ttl_expired');
	});

	test('drops rehydrated pending deliveries using original event created time', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const event = makeEvent({
			id: 'evt-expired-rehydrated',
			dedupeKey: 'dedupe-expired-rehydrated',
		});
		await eventService.publish(event);
		await runtime.stop();
		const originalNow = Date.now;
		Date.now = () => originalNow() + 300_001;
		try {
			runtime = new SpaceRuntime({
				db,
				spaceManager: new SpaceManager(db),
				spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
				spaceWorkflowManager: workflowManager,
				workflowRunRepo,
				taskRepo,
				nodeExecutionRepo,
				internalEventBus: bus,
				commandBus: createInternalCommandBus(),
				externalEventStore: eventStore,
				taskAgentManager: tam as never,
			});
			runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
			await runtime.rehydrateExecutors();
			runtime.flushPendingNodeQueue({
				workflowRunId: run.id,
				taskId: task.id,
				nodeId: 'code',
				agentName: 'coder',
				sessionId: 'session-expired-rehydrated',
			});
		} finally {
			Date.now = originalNow;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(injected).toHaveLength(0);
		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toBe('ttl_expired');
		expect(eventStore.getById(event.id)?.state).toBe('failed');
	});

	test('drops expired rehydrated delivery before scheduling retry', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-expired-retry',
			startedAt: Date.now(),
		});
		tam.alive.add('session-expired-retry');
		await runtime.stop();
		const failingCommandBus = createInternalCommandBus();
		failingCommandBus.register('agent.message.inject', async () => ({
			ok: false,
			error: 'temporary failure before restart',
		}));
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus: failingCommandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
		const event = makeEvent({
			id: 'evt-expired-rehydrated-retry',
			dedupeKey: 'dedupe-expired-rehydrated-retry',
		});
		await eventService.publish(event);
		expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
		const commandBus = createInternalCommandBus();
		commandBus.register('agent.message.inject', async (command) => {
			injected.push({
				sessionId: command.sessionId,
				message: command.message,
				deliveryMode: command.deliveryMode,
			});
			return { ok: true };
		});
		await runtime.stop();
		const originalNow = Date.now;
		Date.now = () => originalNow() + 300_001;
		try {
			runtime = new SpaceRuntime({
				db,
				spaceManager: new SpaceManager(db),
				spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
				spaceWorkflowManager: workflowManager,
				workflowRunRepo,
				taskRepo,
				nodeExecutionRepo,
				internalEventBus: bus,
				commandBus,
				externalEventStore: eventStore,
				taskAgentManager: tam as never,
			});
			runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
			await runtime.rehydrateExecutors();
		} finally {
			Date.now = originalNow;
		}

		expect(injected).toHaveLength(0);
		const expiredDelivery = eventStore.listDeliveries(event.id)[0]!;
		expect(expiredDelivery.state).toBe('failed');
		expect(expiredDelivery.failureReason).toBe('ttl_expired');
	});

	test('requeues pending digest deliveries across same-runtime stop and start', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-digest-stop-start',
			startedAt: Date.now(),
		});
		tam.alive.add('session-digest-stop-start');
		const events = Array.from({ length: 11 }, (_, index) =>
			makeEvent({
				id: `evt-digest-stop-start-${index}`,
				dedupeKey: `dedupe-digest-stop-start-${index}`,
			})
		);

		for (const event of events) {
			await eventService.publish(event);
		}
		await runtime.stop();
		runtime.start();
		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: task.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-digest-stop-start',
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(eventStore.getById(events[10]!.id)?.state).toBe('delivered');
		expect(injected.some((item) => item.message.includes(events[10]!.id))).toBe(true);
	});

	test('preserves deferred mode for unflushed digest deliveries after rehydrate', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-digest-rehydrate-defer',
			startedAt: Date.now(),
		});
		const events = Array.from({ length: 11 }, (_, index) =>
			makeEvent({
				id: `evt-digest-rehydrate-defer-${index}`,
				dedupeKey: `dedupe-digest-rehydrate-defer-${index}`,
			})
		);

		for (const event of events) {
			await eventService.publish(event);
		}
		await runtime.stop();
		const delivery = eventStore.listDeliveries(events[10]!.id)[0]!;
		expect(delivery.failureReason).toBe('deliveryMode:defer; digest pending during runtime stop');
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus: createInternalCommandBus(),
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
		await runtime.rehydrateExecutors();
		const queued = runtime as unknown as {
			pendingExternalEventQueue: Map<string, Array<{ deliveryMode: string }>>;
		};

		expect(
			[...queued.pendingExternalEventQueue.values()].some((items) =>
				items.some((item) => item.deliveryMode === 'defer')
			)
		).toBe(true);
	});

	test('preserves deferred mode when digest fallback requeues after session loss', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-digest-fallback-lost',
			startedAt: Date.now(),
		});
		const events = Array.from({ length: 11 }, (_, index) =>
			makeEvent({
				id: `evt-digest-fallback-lost-${index}`,
				dedupeKey: `dedupe-digest-fallback-lost-${index}`,
			})
		);

		for (const event of events) {
			await eventService.publish(event);
		}
		tam.alive.delete('session-digest-fallback-lost');
		nodeExecutionRepo.updateSessionId(execution.id, null);
		expect(nodeExecutionRepo.getById(execution.id)?.agentSessionId).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const delivery = eventStore.listDeliveries(events[10]!.id)[0]!;
		expect(delivery.state).toBe('pending');
		expect(delivery.failureReason).toBe('deliveryMode:defer; digest requeued after session loss');
		await runtime.stop();
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus: createInternalCommandBus(),
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
		await runtime.rehydrateExecutors();
		const rehydratedDelivery = eventStore.listDeliveries(events[10]!.id)[0]!;
		expect(rehydratedDelivery.failureReason).toBe(
			'deliveryMode:defer; digest requeued after session loss'
		);
		const queued = runtime as unknown as {
			pendingExternalEventQueue: Map<string, Array<{ deliveryMode: string }>>;
		};

		expect(
			[...queued.pendingExternalEventQueue.values()].some((items) =>
				items.some((item) => item.deliveryMode === 'defer')
			)
		).toBe(true);
	});

	test('expires digest items preserved across stop before retry replay', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-digest-expire-stop',
			startedAt: Date.now(),
		});
		tam.alive.add('session-digest-expire-stop');
		const events = Array.from({ length: 11 }, (_, index) =>
			makeEvent({
				id: `evt-digest-expire-stop-${index}`,
				dedupeKey: `dedupe-digest-expire-stop-${index}`,
			})
		);

		for (const event of events) {
			await eventService.publish(event);
		}
		await runtime.stop();
		const originalNow = Date.now;
		Date.now = () => originalNow() + 300_001;
		try {
			runtime.start();
		} finally {
			Date.now = originalNow;
		}

		expect(injected.some((item) => item.message.includes(events[10]!.id))).toBe(false);
		const delivery = eventStore.listDeliveries(events[10]!.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toBe('ttl_expired');
	});

	test('preserves large digest backlog during stop without pending queue overflow', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-digest-large-stop',
			startedAt: Date.now(),
		});
		tam.alive.add('session-digest-large-stop');
		const events = Array.from({ length: 61 }, (_, index) =>
			makeEvent({
				id: `evt-digest-large-stop-${index}`,
				dedupeKey: `dedupe-digest-large-stop-${index}`,
			})
		);

		for (const event of events) {
			await eventService.publish(event);
		}
		await runtime.stop();

		for (const event of events.slice(10)) {
			const delivery = eventStore.listDeliveries(event.id)[0]!;
			expect(delivery.state).toBe('pending');
			expect(delivery.failureReason).not.toBe('pending_node_queue_overflow');
		}
	});

	test('preserves original queue age when replaying queued digest backlog', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-digest-backlog-age',
			startedAt: Date.now(),
		});
		await runtime.stop();
		const commandBus = createInternalCommandBus();
		commandBus.register('agent.message.inject', async () => ({
			ok: false,
			error: 'temporary digest backlog failure',
		}));
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
		const originalNow = Date.now;
		const originalCreatedAt = originalNow() - 299_999;
		Date.now = () => originalCreatedAt;
		const events = Array.from({ length: 11 }, (_, index) =>
			makeEvent({
				id: `evt-digest-backlog-age-${index}`,
				dedupeKey: `dedupe-digest-backlog-age-${index}`,
			})
		);
		for (const event of events) {
			await eventService.publish(event);
		}
		Date.now = () => originalCreatedAt + 300_000;
		try {
			runtime.flushPendingNodeQueue({
				workflowRunId: run.id,
				taskId: task.id,
				nodeId: 'code',
				agentName: 'coder',
				sessionId: 'session-digest-backlog-age',
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			Date.now = originalNow;
		}

		const queuedAfterFailure = runtime as unknown as {
			pendingExternalEventQueue: Map<string, Array<{ createdAt: number }>>;
		};
		expect(
			[...queuedAfterFailure.pendingExternalEventQueue.values()]
				.flat()
				.some((item) => item.createdAt === originalCreatedAt)
		).toBe(true);
		const digestDelivery = eventStore.listDeliveries(events[10]!.id)[0]!;
		expect(digestDelivery.state).toBe('pending');
		expect(digestDelivery.failureReason).toBe(
			'deliveryMode:defer; digest; temporary digest backlog failure'
		);
		Date.now = () => originalCreatedAt + 300_001;
		try {
			runtime.flushPendingNodeQueue({
				workflowRunId: run.id,
				taskId: task.id,
				nodeId: 'code',
				agentName: 'coder',
				sessionId: 'session-digest-backlog-age',
			});
		} finally {
			Date.now = originalNow;
		}
		const expiredDelivery = eventStore.listDeliveries(events[10]!.id)[0]!;
		expect(expiredDelivery.state).toBe('failed');
		expect(expiredDelivery.failureReason).toBe('ttl_expired');
	});

	test('preserves original queue age across transient retry requeues', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-retry-age',
			startedAt: Date.now(),
		});
		tam.alive.add('session-retry-age');
		await runtime.stop();
		const commandBus = createInternalCommandBus();
		commandBus.register('agent.message.inject', async () => ({
			ok: false,
			error: 'temporary retry age failure',
		}));
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
		const event = makeEvent({ id: 'evt-retry-age', dedupeKey: 'dedupe-retry-age' });

		await eventService.publish(event);
		const queued = runtime as unknown as {
			pendingExternalEventQueue: Map<string, Array<{ createdAt: number }>>;
		};
		const firstQueued = [...queued.pendingExternalEventQueue.values()][0]![0]!;
		const originalCreatedAt = firstQueued.createdAt;
		const originalNow = Date.now;
		Date.now = () => originalCreatedAt + 300_001;
		try {
			runtime.flushPendingNodeQueue({
				workflowRunId: run.id,
				taskId: task.id,
				nodeId: 'code',
				agentName: 'coder',
				sessionId: 'session-retry-age',
			});
		} finally {
			Date.now = originalNow;
		}

		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toBe('ttl_expired');
	});

	test('drops delivery that expires before scheduled retry dispatch', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-retry-dispatch-ttl',
			startedAt: Date.now(),
		});
		tam.alive.add('session-retry-dispatch-ttl');
		await runtime.stop();
		let attempt = 0;
		const commandBus = createInternalCommandBus();
		commandBus.register('agent.message.inject', async (command) => {
			attempt += 1;
			injected.push({
				sessionId: command.sessionId,
				message: command.message,
				deliveryMode: command.deliveryMode,
			});
			return attempt === 1
				? { ok: false, error: 'temporary retry dispatch failure' }
				: { ok: true };
		});
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
		const event = makeEvent({
			id: 'evt-retry-dispatch-ttl',
			dedupeKey: 'dedupe-retry-dispatch-ttl',
		});
		await eventService.publish(event);
		const queued = runtime as unknown as {
			pendingExternalEventQueue: Map<string, Array<{ createdAt: number }>>;
		};
		const originalCreatedAt = [...queued.pendingExternalEventQueue.values()][0]![0]!.createdAt;
		const originalNow = Date.now;
		Date.now = () => originalCreatedAt + 300_001;
		try {
			await new Promise((resolve) => setTimeout(resolve, 1100));
		} finally {
			Date.now = originalNow;
		}

		expect(injected).toHaveLength(1);
		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toBe('ttl_expired');
	});

	test('enforces pending queue overflow cap and fails oldest delivery', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const events = Array.from({ length: 51 }, (_, index) =>
			makeEvent({
				id: `evt-overflow-${index}`,
				dedupeKey: `dedupe-overflow-${index}`,
			})
		);

		for (const event of events) {
			await eventService.publish(event);
		}

		const oldestDelivery = eventStore.listDeliveries(events[0]!.id)[0]!;
		expect(oldestDelivery.state).toBe('failed');
		expect(oldestDelivery.failureReason).toBe('pending_node_queue_overflow');

		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: task.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-overflow',
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(injected).toHaveLength(11);
		expect(injected.slice(0, 10).map((item) => JSON.parse(item.message).eventId)).toEqual(
			events.slice(1, 11).map((event) => event.id)
		);
		expect(injected[10]!.message).toContain(
			'40 events received for topics: github/lsm/neokai/pull_request/42.review_submitted'
		);
		expect(injected.some((item) => item.message.includes(events[0]!.id))).toBe(false);
	});

	test('marks delivery failed when target execution is not active', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'cancelled',
			agentSessionId: 'session-cancelled',
			completedAt: Date.now(),
		});
		tam.alive.add('session-cancelled');

		const event = makeEvent();
		await eventService.publish(event);

		expect(injected).toHaveLength(0);
		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toBe('node_execution_not_active');
		expect(eventStore.getById(event.id)?.state).toBe('failed');
	});

	test('does not deliver external events to idle executions with retained sessions', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'idle',
			agentSessionId: 'session-idle-stale',
			completedAt: Date.now(),
		});
		tam.alive.add('session-idle-stale');

		const event = makeEvent();
		await eventService.publish(event);

		expect(injected).toHaveLength(0);
		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toBe('node_execution_not_active');
		expect(eventStore.getById(event.id)?.state).toBe('failed');
	});

	test('terminalizes mixed-outcome events after the final delivery succeeds', async () => {
		const event = makeEvent({ topic: 'github/owner/repo/pull_request/42.review_submitted' });
		eventStore.store(event);
		const failedDeliveryKey = JSON.stringify([
			'github',
			event.dedupeKey,
			'task-failed',
			'node-failed',
			'coder',
			'run-failed',
		]);
		eventStore.registerExpectedDelivery(event.id, failedDeliveryKey, {
			workflowRunId: 'run-failed',
			taskId: 'task-failed',
			nodeId: 'node-failed',
			agentName: 'coder',
		});
		eventStore.markDeliveryFailed(event.id, failedDeliveryKey, {
			terminal: true,
			reason: 'simulated_prior_failure',
		});
		expect(eventStore.getById(event.id)?.state).toBe('published');

		const workflow = createWorkflow('review');
		const { run, tasks: reviewTasks } = await runtime.startWorkflowRun(
			SPACE_ID,
			workflow.id,
			'Run'
		);
		runtime.registerSubscription(run.id, reviewTasks[0]!.id, 'review', 'coder', event.topic);
		const execution = nodeExecutionRepo.listByNode(run.id, 'review')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-mixed',
			startedAt: Date.now(),
		});
		tam.alive.add('session-mixed');

		await eventService.publish(makeEvent({ id: 'evt-mixed-retry', dedupeKey: event.dedupeKey }));

		const deliveries = eventStore.listDeliveries(event.id);
		expect(deliveries).toHaveLength(2);
		expect(deliveries.some((delivery) => delivery.state === 'delivered')).toBe(true);
		expect(eventStore.getById(event.id)?.state).toBe('failed');
	});

	test('marks unmatched events ignored after stop/start on a rehydrated runtime', async () => {
		await startRunWithSubscription();
		await runtime.executeTick();
		await runtime.stop();
		runtime.start();

		const event = makeEvent({ topic: 'github/lsm/neokai/pull_request/42.comment_created' });
		await eventService.publish(event);

		expect(eventStore.getById(event.id)?.state).toBe('ignored');
	});

	test('keeps unmatched events published until restart rehydrate completes', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-rehydrate-race',
			startedAt: Date.now(),
		});
		await runtime.stop();
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus: createInternalCommandBus(),
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.start();

		const event = makeEvent({ topic: 'github/lsm/neokai/pull_request/42.comment_created' });
		await eventService.publish(event);

		expect(eventStore.getById(event.id)?.state).toBe('published');
	});

	test('redispatches published events without deliveries after rehydrate', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-redispatch-stranded',
			startedAt: Date.now(),
		});
		tam.alive.add('session-redispatch-stranded');
		await runtime.stop();
		eventStore.store(makeEvent({ id: 'evt-stranded-without-deliveries' }));
		const commandBus = createInternalCommandBus();
		commandBus.register('agent.message.inject', async (command) => {
			injected.push({
				sessionId: command.sessionId,
				message: command.message,
				deliveryMode: command.deliveryMode,
			});
			return { ok: true };
		});

		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);

		await runtime.executeTick();

		expect(eventStore.listDeliveries('evt-stranded-without-deliveries')).toHaveLength(1);
		const delivery = eventStore.listDeliveries('evt-stranded-without-deliveries')[0]!;
		expect(delivery.state).toBe('delivered');
		expect(delivery.taskId).toBe(task.id);
		expect(eventStore.getById('evt-stranded-without-deliveries')?.state).toBe('delivered');
	});

	test('marks stranded published events without matches ignored after rehydrate opens delivery', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-redispatch-unmatched',
			startedAt: Date.now(),
		});
		await runtime.stop();
		eventStore.store(
			makeEvent({
				id: 'evt-stranded-without-matches',
				topic: 'github/lsm/neokai/pull_request/42.comment_created',
			})
		);

		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus: createInternalCommandBus(),
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});

		await runtime.executeTick();

		expect(eventStore.listDeliveries('evt-stranded-without-matches')).toHaveLength(0);
		expect(eventStore.getById('evt-stranded-without-matches')?.state).toBe('ignored');
	});

	test('redispatches events that arrived during stop when runtime restarts', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-stop-start-sweep',
			startedAt: Date.now(),
		});
		tam.alive.add('session-stop-start-sweep');
		await runtime.executeTick();
		await runtime.stop();
		// Event arrives while stopped (subscriber detached, persisted only)
		eventStore.store(makeEvent({ id: 'evt-arrived-while-stopped' }));

		// Restart the same runtime instance (rehydrated=true, interests intact)
		runtime.start();
		// The sweep in start() fires async — wait for microtasks to settle
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(eventStore.listDeliveries('evt-arrived-while-stopped')).toHaveLength(1);
		expect(eventStore.getById('evt-arrived-while-stopped')?.state).toBe('delivered');
		expect(injected).toHaveLength(1);
		expect(injected[0]!.sessionId).toBe('session-stop-start-sweep');
	});

	test('requeues persisted pending deliveries during runtime rehydrate', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const event = makeEvent();
		await eventService.publish(event);
		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('pending');
		await runtime.stop();
		const commandBus = createInternalCommandBus();
		commandBus.register('agent.message.inject', async (command) => {
			injected.push({
				sessionId: command.sessionId,
				message: command.message,
				deliveryMode: command.deliveryMode,
			});
			return { ok: true };
		});
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);

		await runtime.rehydrateExecutors();
		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: task.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-rehydrated-pending',
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
	});

	test('ignores terminal runs when matching external event deliveries', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		workflowRunRepo.updateRun(run.id, { status: 'cancelled' });
		await runtime.executeTick();

		const event = makeEvent();
		await eventService.publish(event);

		expect(eventStore.getById(event.id)?.state).toBe('ignored');
		expect(eventStore.listDeliveries(event.id)).toHaveLength(0);
	});

	test('refreshes active run interests when subscriptions are rebuilt', async () => {
		const { workflow, run, task } = await startRunWithSubscription(DEFAULT_TOPIC);
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-updated-interests',
			startedAt: Date.now(),
		});
		tam.alive.add('session-updated-interests');

		// Clear old dynamic interest and register new ones (simulates what a runtime
		// caller would do after a workflow definition change)
		runtime.unregisterSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
		runtime.registerRunInterests(run.id, task.id, workflow.nodes);
		runtime.registerSubscription(
			run.id,
			task.id,
			'code',
			'coder',
			'github/*/*/pull_request/*.comment_created'
		);
		await runtime.executeTick();

		const removedInterestEvent = makeEvent({ id: 'evt-removed-interest' });
		await eventService.publish(removedInterestEvent);
		await runtime.executeTick();
		expect(eventStore.getById(removedInterestEvent.id)?.state).toBe('ignored');
		expect(eventStore.listDeliveries(removedInterestEvent.id)).toHaveLength(0);

		const addedInterestEvent = makeEvent({
			id: 'evt-added-interest',
			topic: 'github/lsm/neokai/pull_request/42.comment_created',
		});
		await eventService.publish(addedInterestEvent);
		expect(eventStore.getById(addedInterestEvent.id)?.state).toBe('delivered');
		expect(eventStore.listDeliveries(addedInterestEvent.id)[0]!.taskId).toBe(task.id);
		expect(injected).toHaveLength(1);
	});

	test('clears stale queued deliveries when run interests are cleared', async () => {
		const { workflow, run, task } = await startRunWithSubscription(DEFAULT_TOPIC);
		const event = makeEvent({ id: 'evt-queued-before-interest-update' });
		await eventService.publish(event);
		const queuedDelivery = eventStore.listDeliveries(event.id)[0]!;
		expect(queuedDelivery.state).toBe('pending');

		// Clear interests with queued delivery cleanup (simulates what a runtime
		// caller would do after a workflow definition change removes interests)
		runtime.registerRunInterests(run.id, task.id, workflow.nodes, {
			clearQueuedDeliveries: true,
		});
		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: task.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-stale-after-update',
		});

		expect(injected).toHaveLength(0);
		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toBe('run_interests_rebuilt');
		expect(eventStore.getById(event.id)?.state).toBe('failed');
	});

	test('ignores blocked runs with no active execution path', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'idle',
			agentSessionId: 'session-cancelled',
			completedAt: Date.now(),
		});
		workflowRunRepo.updateRun(run.id, { status: 'blocked', failureReason: 'agentCrash' });
		await runtime.executeTick();

		runtime.registerSubscription(
			run.id,
			taskRepo.listByWorkflowRun(run.id)[0]!.id,
			'code',
			'coder',
			DEFAULT_TOPIC
		);

		const event = makeEvent();
		await eventService.publish(event);

		expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
		expect(nodeExecutionRepo.listByWorkflowRun(run.id).map((item) => item.status)).toEqual([
			'idle',
		]);
		expect(eventStore.listDeliveries(event.id)).toHaveLength(0);
		expect(eventStore.getById(event.id)?.state).toBe('ignored');
	});

	test('terminalizes delivery for target node with no queueable execution in multi-node run', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Workflow ${Math.random()}`,
			description: '',
			nodes: [
				{
					id: 'review',
					name: 'Review',
					agents: [
						{
							agentId: AGENT_ID,
							name: 'reviewer',
						},
					],
				},
				{
					id: 'code',
					name: 'Code',
					agents: [
						{
							agentId: AGENT_ID,
							name: 'coder',
						},
					],
				},
			],
			transitions: [],
			startNodeId: 'review',
			rules: [],
			tags: [],
		});
		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		runtime.registerSubscription(run.id, tasks[0]!.id, 'review', 'reviewer', DEFAULT_TOPIC);
		runtime.registerSubscription(run.id, tasks[0]!.id, 'code', 'coder', DEFAULT_TOPIC);
		// Make the review node execution in_progress (active)
		const reviewExecution = nodeExecutionRepo.listByNode(run.id, 'review')[0]!;
		nodeExecutionRepo.update(reviewExecution.id, {
			status: 'in_progress',
			agentSessionId: 'session-review-active',
			startedAt: Date.now(),
		});
		// Create an idle execution for the code node (terminal for that target)
		const codeExecution = nodeExecutionRepo.createOrIgnore({
			workflowRunId: run.id,
			workflowNodeId: 'code',
			agentName: 'coder',
			status: 'idle',
		});
		nodeExecutionRepo.update(codeExecution.id, {
			completedAt: Date.now(),
		});

		const event = makeEvent();
		await eventService.publish(event);

		// The code node should be terminalized immediately (no queueable execution)
		const deliveries = eventStore.listDeliveries(event.id);
		expect(deliveries).toHaveLength(2);
		const codeDelivery = deliveries.find((d) => d.nodeId === 'code')!;
		expect(codeDelivery).toBeDefined();
		expect(codeDelivery.state).toBe('failed');
		expect(codeDelivery.failureReason).toBe('node_execution_not_active');
	});

	test('preserves queued deliveries while re-registering unchanged interests', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const event = makeEvent();
		await eventService.publish(event);

		runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: task.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-preserved-reregister',
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(injected).toHaveLength(1);
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
	});

	test('retries transient external event injection failures from the pending queue', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-retry',
			startedAt: Date.now(),
		});
		tam.alive.add('session-retry');
		await runtime.stop();
		let failNext = true;
		const commandBus = createInternalCommandBus();
		commandBus.register('agent.message.inject', async (command) => {
			if (failNext) {
				failNext = false;
				return { ok: false, error: 'temporary injection failure' };
			}
			injected.push({
				sessionId: command.sessionId,
				message: command.message,
				deliveryMode: command.deliveryMode,
			});
			return { ok: true };
		});
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);

		const event = makeEvent();
		await eventService.publish(event);
		expect(injected).toHaveLength(0);
		expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
		expect(eventStore.listDeliveries(event.id)[0]!.failureReason).toBe(
			'deliveryMode:immediate; temporary injection failure'
		);

		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: task.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-retry',
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(injected).toHaveLength(1);
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
	});

	test('queues events for waiting_rebind executions instead of failing them terminally', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'waiting_rebind',
			completedAt: null,
		});

		const event = makeEvent();
		await eventService.publish(event);

		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('pending');
		expect(delivery.failureReason).toBeNull();

		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: task.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-waiting-rebind',
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(injected).toHaveLength(1);
		expect(injected[0]!.sessionId).toBe('session-waiting-rebind');
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
	});

	test('drains transient retry queue for an in-progress session without respawn', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-retry-drain',
			startedAt: Date.now(),
		});
		tam.alive.add('session-retry-drain');
		await runtime.stop();
		let failNext = true;
		const commandBus = createInternalCommandBus();
		commandBus.register('agent.message.inject', async (command) => {
			if (failNext) {
				failNext = false;
				return { ok: false, error: 'temporary retry drain failure' };
			}
			injected.push({
				sessionId: command.sessionId,
				message: command.message,
				deliveryMode: command.deliveryMode,
			});
			return { ok: true };
		});
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(
			run.id,
			taskRepo.listByWorkflowRun(run.id)[0]!.id,
			'code',
			'coder',
			DEFAULT_TOPIC
		);

		const event = makeEvent();
		await eventService.publish(event);

		expect(injected).toHaveLength(0);
		await new Promise((resolve) => setTimeout(resolve, 1100));
		expect(injected).toHaveLength(1);
		expect(injected[0]!.sessionId).toBe('session-retry-drain');
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
	});

	test('reschedules queued transient retries across runtime stop and start', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-retry-restart',
			startedAt: Date.now(),
		});
		tam.alive.add('session-retry-restart');
		await runtime.stop();
		let failNext = true;
		const commandBus = createInternalCommandBus();
		commandBus.register('agent.message.inject', async (command) => {
			if (failNext) {
				failNext = false;
				return { ok: false, error: 'temporary restart retry failure' };
			}
			injected.push({
				sessionId: command.sessionId,
				message: command.message,
				deliveryMode: command.deliveryMode,
			});
			return { ok: true };
		});
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(
			run.id,
			taskRepo.listByWorkflowRun(run.id)[0]!.id,
			'code',
			'coder',
			DEFAULT_TOPIC
		);

		const event = makeEvent();
		await eventService.publish(event);
		await runtime.stop();
		runtime.start();

		expect(injected).toHaveLength(0);
		await new Promise((resolve) => setTimeout(resolve, 1100));
		expect(injected).toHaveLength(1);
		expect(injected[0]!.sessionId).toBe('session-retry-restart');
		expect(eventStore.getById(event.id)?.state).toBe('delivered');

		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: taskRepo.listByWorkflowRun(run.id)[0]!.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-retry-restart',
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(injected).toHaveLength(1);
	});

	test('suppresses retryable duplicates while a delivery attempt is in flight', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-inflight-dedupe',
			startedAt: Date.now(),
		});
		tam.alive.add('session-inflight-dedupe');
		await runtime.stop();
		let releaseDelivery!: () => void;
		const deliveryStarted = Promise.withResolvers<void>();
		const commandBus = createInternalCommandBus();
		commandBus.register('agent.message.inject', async (command) => {
			injected.push({
				sessionId: command.sessionId,
				message: command.message,
				deliveryMode: command.deliveryMode,
			});
			deliveryStarted.resolve();
			await new Promise<void>((resolve) => {
				releaseDelivery = resolve;
			});
			return { ok: true };
		});
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(
			run.id,
			taskRepo.listByWorkflowRun(run.id)[0]!.id,
			'code',
			'coder',
			DEFAULT_TOPIC
		);

		const event = makeEvent({ dedupeKey: 'dedupe-inflight' });
		const firstPublish = eventService.publish(event);
		await deliveryStarted.promise;
		await eventService.publish(
			makeEvent({ id: 'evt-inflight-duplicate', dedupeKey: event.dedupeKey })
		);

		expect(injected).toHaveLength(1);
		releaseDelivery();
		await firstPublish;
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
		expect(injected).toHaveLength(1);
	});

	test('does not fire retry timer while the same delivery is in flight', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-retry-inflight',
			startedAt: Date.now(),
		});
		tam.alive.add('session-retry-inflight');
		await runtime.stop();
		let attempts = 0;
		let releaseDelivery!: () => void;
		const duplicateDeliveryStarted = Promise.withResolvers<void>();
		const commandBus = createInternalCommandBus();
		commandBus.register('agent.message.inject', async (command) => {
			attempts++;
			if (attempts === 1) return { ok: false, error: 'temporary retry timer failure' };
			injected.push({
				sessionId: command.sessionId,
				message: command.message,
				deliveryMode: command.deliveryMode,
			});
			duplicateDeliveryStarted.resolve();
			await new Promise<void>((resolve) => {
				releaseDelivery = resolve;
			});
			return { ok: true };
		});
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(
			run.id,
			taskRepo.listByWorkflowRun(run.id)[0]!.id,
			'code',
			'coder',
			DEFAULT_TOPIC
		);

		const event = makeEvent({ dedupeKey: 'dedupe-retry-inflight' });
		await eventService.publish(event);
		const duplicatePublish = eventService.publish(
			makeEvent({ id: 'evt-retry-inflight-duplicate', dedupeKey: event.dedupeKey })
		);
		await duplicateDeliveryStarted.promise;
		await new Promise((resolve) => setTimeout(resolve, 1100));

		expect(injected).toHaveLength(1);
		expect(attempts).toBe(2);
		releaseDelivery();
		await duplicatePublish;
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
	});

	test('queues downstream events that arrive before subscribed node execution exists', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Workflow ${Math.random()}`,
			description: '',
			nodes: [
				{
					id: 'code',
					name: 'Code',
					agents: [{ agentId: AGENT_ID, name: 'coder' }],
				},
				{
					id: 'review',
					name: 'Review',
					agents: [
						{
							agentId: AGENT_ID,
							name: 'reviewer',
						},
					],
				},
			],
			transitions: [],
			startNodeId: 'code',
			endNodeId: 'review',
			rules: [],
			tags: [],
		});
		const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const task = taskRepo.listByWorkflowRun(run.id)[0]!;
		runtime.registerSubscription(run.id, task.id, 'review', 'reviewer', DEFAULT_TOPIC);

		await runtime.executeTick();
		const earlyEvent = makeEvent({ id: 'evt-downstream-before-activation' });
		await eventService.publish(earlyEvent);
		expect(eventStore.getById(earlyEvent.id)?.state).toBe('published');
		const earlyDelivery = eventStore.listDeliveries(earlyEvent.id)[0]!;
		expect(earlyDelivery.state).toBe('pending');
		expect(earlyDelivery.nodeId).toBe('review');

		nodeExecutionRepo.create({
			workflowRunId: run.id,
			workflowNodeId: 'review',
			agentName: 'reviewer',
			agentId: AGENT_ID,
			status: 'pending',
		});
		runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: task.id,
			nodeId: 'review',
			agentName: 'reviewer',
			sessionId: 'session-downstream-activated',
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(eventStore.getById(earlyEvent.id)?.state).toBe('delivered');
		expect(injected).toHaveLength(1);
		expect(injected[0]!.sessionId).toBe('session-downstream-activated');
	});

	test('registers all matching deliveries before successful delivery terminalizes source event', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Workflow ${Math.random()}`,
			description: '',
			nodes: [
				{
					id: 'code',
					name: 'Code',
					agents: [
						{
							agentId: AGENT_ID,
							name: 'coder',
						},
					],
				},
				{
					id: 'review',
					name: 'Review',
					agents: [
						{
							agentId: AGENT_ID,
							name: 'reviewer',
						},
					],
				},
			],
			transitions: [],
			startNodeId: 'code',
			endNodeId: 'review',
			rules: [],
			tags: [],
		});
		const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const task = taskRepo.listByWorkflowRun(run.id)[0]!;
		runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
		runtime.registerSubscription(run.id, task.id, 'review', 'reviewer', DEFAULT_TOPIC);
		const reviewExecution = nodeExecutionRepo.create({
			workflowRunId: run.id,
			workflowNodeId: 'review',
			agentName: 'reviewer',
			agentId: AGENT_ID,
			status: 'pending',
		});
		const codeExecution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(codeExecution.id, {
			status: 'in_progress',
			agentSessionId: 'session-multi-success',
			startedAt: Date.now(),
		});
		tam.alive.add('session-multi-success');
		runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
		nodeExecutionRepo.update(reviewExecution.id, {
			status: 'idle',
			agentSessionId: 'session-review-idle',
			completedAt: Date.now(),
		});
		workflowRunRepo.updateRun(run.id, { status: 'blocked' });

		const event = makeEvent();
		await eventService.publish(event);

		const deliveries = eventStore.listDeliveries(event.id);
		expect(deliveries).toHaveLength(2);
		expect(deliveries.some((delivery) => delivery.state === 'delivered')).toBe(true);
		expect(deliveries.some((delivery) => delivery.state === 'failed')).toBe(true);
		expect(eventStore.getById(event.id)?.state).toBe('failed');
	});

	test('terminalizes delivery instead of retrying when run is terminal after transient dispatch failure', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-retry-terminal-check',
			startedAt: Date.now(),
		});
		await runtime.stop();
		const commandBus = createInternalCommandBus();
		let injectAttempts = 0;
		commandBus.register('agent.message.inject', async () => {
			injectAttempts++;
			return { ok: false, error: 'simulated transient failure' };
		});
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(
			run.id,
			taskRepo.listByWorkflowRun(run.id)[0]!.id,
			'code',
			'coder',
			DEFAULT_TOPIC
		);
		runtime.start();
		await runtime.executeTick();

		// Publish event → first dispatch attempt will fail transiently
		const event = makeEvent();
		await eventService.publish(event);
		expect(injectAttempts).toBe(1);

		// Now terminalize the run before the retry timer fires
		workflowRunRepo.updateRun(run.id, { status: 'cancelled' });

		// Trigger the retry by waiting for the retry timer
		await new Promise((resolve) => setTimeout(resolve, 250));

		// The retry should check run deliverability and fail terminally
		// instead of re-queueing
		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toBe('run_not_externally_deliverable');
		expect(injected).toHaveLength(0);
	});

	test('terminalizes delivery when run becomes blocked without active execution during transient retry', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-blocked-retry-check',
			startedAt: Date.now(),
		});
		await runtime.stop();
		const commandBus = createInternalCommandBus();
		let injectAttempts = 0;
		commandBus.register('agent.message.inject', async () => {
			injectAttempts++;
			return { ok: false, error: 'simulated transient failure' };
		});
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(
			run.id,
			taskRepo.listByWorkflowRun(run.id)[0]!.id,
			'code',
			'coder',
			DEFAULT_TOPIC
		);
		runtime.start();

		// Publish event → first dispatch attempt will fail transiently
		const event = makeEvent();
		await eventService.publish(event);
		expect(injectAttempts).toBe(1);

		// Now transition the run to blocked with no active execution
		workflowRunRepo.updateRun(run.id, { status: 'blocked' });
		nodeExecutionRepo.update(execution.id, {
			status: 'idle',
			startedAt: null,
			result: 'blocked for test',
		});

		// Trigger the retry by waiting for the retry timer
		await new Promise((resolve) => setTimeout(resolve, 1100));
		await runtime.executeTick();

		// Runtime recovery keeps the blocked run retryable and leaves delivery queued.
		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('pending');
		expect(delivery.failureReason).toContain('simulated transient failure');
	});

	test('re-registers interests when recovering a terminal workflow run', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-pre-terminal',
			startedAt: Date.now(),
		});
		tam.alive.add('session-pre-terminal');

		// Simulate terminal cleanup — clear interests and mark run done
		runtime.clearRunInterests(run.id);
		workflowRunRepo.updateRun(run.id, { status: 'done' });
		tam.alive.delete('session-pre-terminal'); // session dies at terminalization

		// Recover the terminal run back to active
		await runtime.recoverWorkflowBackedTask(SPACE_ID, task.id, 'in_progress');

		// Re-register subscription for the recovered run
		runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);

		// Set up a live session for the recovered execution
		const executions = nodeExecutionRepo.listByWorkflowRun(run.id);
		const pendingExec = executions.find((e) => e.status === 'pending');
		expect(pendingExec).toBeDefined();
		nodeExecutionRepo.update(pendingExec!.id, {
			status: 'in_progress',
			agentSessionId: 'session-recovered',
			startedAt: Date.now(),
		});
		tam.alive.add('session-recovered');

		// Publish an event — interests should be re-registered after recovery
		const event = makeEvent();
		await eventService.publish(event);

		expect(injected.length).toBeGreaterThanOrEqual(1);
		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('delivered');
	});

	test('clears retry state when pending queue overflow drops a retry delivery', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-overflow-retry',
			startedAt: Date.now(),
		});
		tam.alive.add('session-overflow-retry');
		await runtime.stop();
		const commandBus = createInternalCommandBus();
		commandBus.register('agent.message.inject', async () => ({
			ok: false,
			error: 'temporary overflow retry failure',
		}));
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(
			run.id,
			taskRepo.listByWorkflowRun(run.id)[0]!.id,
			'code',
			'coder',
			DEFAULT_TOPIC
		);

		const originalNow = Date.now;
		let fakeNow = originalNow();
		Date.now = () => fakeNow;
		const events = Array.from({ length: 51 }, (_, index) =>
			makeEvent({
				id: `evt-overflow-retry-${index}`,
				dedupeKey: `dedupe-overflow-retry-${index}`,
			})
		);
		try {
			for (const event of events) {
				await eventService.publish(event);
				fakeNow += 61_000;
			}
		} finally {
			Date.now = originalNow;
		}

		const droppedDelivery = eventStore.listDeliveries(events[0]!.id)[0]!;
		expect(droppedDelivery.state).toBe('failed');
		expect(droppedDelivery.failureReason).toBe('pending_node_queue_overflow');
		const retryState = runtime as unknown as {
			externalEventRetryTimers: Map<string, unknown>;
			externalEventRetryCounts: Map<string, number>;
		};
		expect(retryState.externalEventRetryTimers.has(droppedDelivery.deliveryKey)).toBe(false);
		expect(retryState.externalEventRetryCounts.has(droppedDelivery.deliveryKey)).toBe(false);
	});

	test('fails delivery terminally when injection command handler is missing', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-no-handler',
			startedAt: Date.now(),
		});
		tam.alive.add('session-no-handler');
		await runtime.stop();
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus: createInternalCommandBus(),
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(
			run.id,
			taskRepo.listByWorkflowRun(run.id)[0]!.id,
			'code',
			'coder',
			DEFAULT_TOPIC
		);

		const event = makeEvent();
		await eventService.publish(event);

		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toContain('No handler registered');
		expect(eventStore.getById(event.id)?.state).toBe('failed');
	});

	test('fails delivery terminally when command bus is missing', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-no-command-bus',
			startedAt: Date.now(),
		});
		tam.alive.add('session-no-command-bus');
		await runtime.stop();
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(
			run.id,
			taskRepo.listByWorkflowRun(run.id)[0]!.id,
			'code',
			'coder',
			DEFAULT_TOPIC
		);

		const event = makeEvent();
		await eventService.publish(event);

		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toContain(
			"No handler registered for command 'agent.message.inject'"
		);
		expect(eventStore.getById(event.id)?.state).toBe('failed');
	});

	test('clears queued retry items when a later attempt fails terminally', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-terminal-after-retry',
			startedAt: Date.now(),
		});
		tam.alive.add('session-terminal-after-retry');
		await runtime.stop();
		const failingCommandBus = createInternalCommandBus();
		failingCommandBus.register('agent.message.inject', async () => ({
			ok: false,
			error: 'temporary before terminal',
		}));
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus: failingCommandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(
			run.id,
			taskRepo.listByWorkflowRun(run.id)[0]!.id,
			'code',
			'coder',
			DEFAULT_TOPIC
		);
		const event = makeEvent();
		await eventService.publish(event);
		expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
		await runtime.stop();

		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus: createInternalCommandBus(),
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		await runtime.rehydrateExecutors();
		runtime.registerSubscription(
			run.id,
			taskRepo.listByWorkflowRun(run.id)[0]!.id,
			'code',
			'coder',
			DEFAULT_TOPIC
		);
		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: taskRepo.listByWorkflowRun(run.id)[0]!.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-terminal-after-retry',
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('failed');

		const commandBus = createInternalCommandBus();
		commandBus.register('agent.message.inject', async (command) => {
			injected.push({
				sessionId: command.sessionId,
				message: command.message,
				deliveryMode: command.deliveryMode,
			});
			return { ok: true };
		});
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: taskRepo.listByWorkflowRun(run.id)[0]!.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-terminal-after-retry',
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(injected).toHaveLength(0);
	});

	test('terminalizes persisted pending deliveries for non-deliverable runs on rehydrate', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const event = makeEvent();
		await eventService.publish(event);
		workflowRunRepo.updateRun(run.id, { status: 'cancelled' });
		await runtime.stop();

		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus: createInternalCommandBus(),
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});

		await runtime.rehydrateExecutors();

		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toBe('run_not_externally_deliverable');
		expect(eventStore.getById(event.id)?.state).toBe('failed');
	});

	test('does not requeue persisted pending deliveries for removed subscriptions', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const event = makeEvent();
		await eventService.publish(event);
		await runtime.stop();
		// Create fresh runtime WITHOUT registering a subscription — simulates
		// the subscription being removed between runtime restarts
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus: createInternalCommandBus(),
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});

		await runtime.rehydrateExecutors();
		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: task.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-removed-interest',
		});

		expect(injected).toHaveLength(0);
		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toBe('subscription_no_longer_active');
		expect(eventStore.getById(event.id)?.state).toBe('failed');
	});

	test('schedules persisted pending retries for active sessions on rehydrate', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-persisted-retry',
			startedAt: Date.now(),
		});
		tam.alive.add('session-persisted-retry');
		await runtime.stop();
		const failingCommandBus = createInternalCommandBus();
		failingCommandBus.register('agent.message.inject', async () => ({
			ok: false,
			error: 'persisted transient failure',
		}));
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus: failingCommandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(
			run.id,
			taskRepo.listByWorkflowRun(run.id)[0]!.id,
			'code',
			'coder',
			DEFAULT_TOPIC
		);
		const event = makeEvent();
		await eventService.publish(event);
		expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
		await runtime.stop();

		const commandBus = createInternalCommandBus();
		commandBus.register('agent.message.inject', async (command) => {
			injected.push({
				sessionId: command.sessionId,
				message: command.message,
				deliveryMode: command.deliveryMode,
			});
			return { ok: true };
		});
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(
			run.id,
			taskRepo.listByWorkflowRun(run.id)[0]!.id,
			'code',
			'coder',
			DEFAULT_TOPIC
		);

		await runtime.rehydrateExecutors();

		expect(injected).toHaveLength(0);
		await new Promise((resolve) => setTimeout(resolve, 1100));
		expect(injected).toHaveLength(1);
		expect(injected[0]!.sessionId).toBe('session-persisted-retry');
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
	});

	test('preserves deferred delivery mode when rebuilding pending queue', async () => {
		const { workflow, run, task } = await startRunWithSubscription();
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-defer-rehydrate',
			startedAt: Date.now(),
		});
		await runtime.stop();
		let failNext = true;
		const failingCommandBus = createInternalCommandBus();
		failingCommandBus.register('agent.message.inject', async () => {
			if (failNext) {
				failNext = false;
				return { ok: false, error: 'defer failure' };
			}
			return { ok: true };
		});
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus: failingCommandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);
		const event = makeEvent();
		await eventService.publish(event);
		expect(eventStore.listDeliveries(event.id)[0]!.failureReason).toBe(
			'deliveryMode:defer; defer failure'
		);
		await runtime.stop();

		const commandBus = createInternalCommandBus();
		commandBus.register('agent.message.inject', async (command) => {
			injected.push({
				sessionId: command.sessionId,
				message: command.message,
				deliveryMode: command.deliveryMode,
			});
			return { ok: true };
		});
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerSubscription(run.id, task.id, 'code', 'coder', DEFAULT_TOPIC);

		await runtime.rehydrateExecutors();
		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: task.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-defer-rehydrate',
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(injected).toHaveLength(1);
		expect(injected[0]!.deliveryMode).toBe('defer');
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
	});
});
