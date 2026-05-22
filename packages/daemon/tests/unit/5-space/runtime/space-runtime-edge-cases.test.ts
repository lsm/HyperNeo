/**
 * SpaceRuntime — Edge Case and Resilience Tests
 *
 * Tests adversarial and failure-mode scenarios to ensure the runtime
 * is robust under adverse conditions:
 *
 *   1. Rapid status changes between ticks — only final state generates notification
 *   2. Runtime rehydration with workflow tasks in blocked → dedup still works
 *   3. Deduplication for standalone tasks across many ticks
 *   4. Workflow run cancelled externally → no stale event
 *   5. InternalEventBus errors do not crash the tick loop
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';

// ---------------------------------------------------------------------------
// BusEventCollector — captures InternalEventBus events for test assertions
// ---------------------------------------------------------------------------

type BusEventKind =
	| 'task_blocked'
	| 'workflow_run_blocked'
	| 'task_timeout'
	| 'workflow_run_completed'
	| 'workflow_run_reopened'
	| 'agent_crash'
	| 'agent_idle_non_terminal'
	| 'task_retry'
	| 'workflow_run_needs_attention'
	| 'task_awaiting_approval';

interface CapturedEvent {
	kind: BusEventKind;
	payload: Record<string, unknown>;
}

const EVENT_MAP: Record<string, BusEventKind> = {
	'space.task.blocked': 'task_blocked',
	'space.workflowRun.blocked': 'workflow_run_blocked',
	'space.task.timeout': 'task_timeout',
	'space.workflowRun.completed': 'workflow_run_completed',
	'space.workflowRun.reopened': 'workflow_run_reopened',
	'space.agent.crashed': 'agent_crash',
	'space.agent.idleNonTerminal': 'agent_idle_non_terminal',
	'space.workflowRun.retry': 'task_retry',
	'space.workflowRun.needsAttention': 'workflow_run_needs_attention',
	'space.task.awaitingApproval': 'task_awaiting_approval',
};

class BusEventCollector {
	readonly events: CapturedEvent[] = [];
	private unsubscribers: Array<() => void> = [];

	constructor(bus: InternalEventBus<DaemonInternalEventMap>) {
		for (const [eventName, kind] of Object.entries(EVENT_MAP)) {
			const unsub = bus.subscribe(
				eventName as keyof DaemonInternalEventMap,
				(payload) => {
					this.events.push({ kind, payload: payload as Record<string, unknown> });
				},
				{ subscriberName: `test-collector:${eventName}` }
			);
			this.unsubscribers.push(unsub);
		}
	}

	clear(): void {
		this.events.length = 0;
	}

	destroy(): void {
		for (const unsub of this.unsubscribers) unsub();
		this.unsubscribers.length = 0;
	}
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
	// Use in-memory SQLite — faster than file-based DB and avoids filesystem
	// I/O contention that caused beforeEach hook timeouts in CI.
	const db = new BunDatabase(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string, workspacePath = '/tmp/ws'): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function setSpaceTaskTimeoutMs(db: BunDatabase, spaceId: string, timeoutMs: number): void {
	db.prepare(`UPDATE spaces SET config = ? WHERE id = ?`).run(
		JSON.stringify({ taskTimeoutMs: timeoutMs }),
		spaceId
	);
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
	).run(agentId, spaceId, `Agent ${agentId}`, Date.now(), Date.now());
}

class MockTaskAgentManager {
	readonly cancelledSessions: string[] = [];

	cancelBySessionId(sessionId: string): void {
		this.cancelledSessions.push(sessionId);
	}
}

function buildLinearWorkflow(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	nodes: Array<{ id: string; name: string; agentId: string }>,
	conditions: Array<{ type: 'always' | 'human' }> = []
) {
	const transitions = nodes.slice(0, -1).map((step, i) => ({
		from: step.id,
		to: nodes[i + 1].id,
		condition: conditions[i] ?? { type: 'always' as const },
		order: 0,
	}));

	return workflowManager.createWorkflow({
		spaceId,
		name: `Workflow ${Date.now()}-${Math.random()}`,
		description: '',
		nodes,
		transitions,
		startNodeId: nodes[0].id,
		rules: [],
		tags: [],
		completionAutonomyLevel: 3,
	});
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe('SpaceRuntime — edge cases and resilience', () => {
	let db: BunDatabase;

	let workflowRunRepo: SpaceWorkflowRunRepository;
	let taskRepo: SpaceTaskRepository;
	let nodeExecutionRepo: NodeExecutionRepository;
	let agentManager: SpaceAgentManager;
	let workflowManager: SpaceWorkflowManager;
	let spaceManager: SpaceManager;
	let bus: InternalEventBus<DaemonInternalEventMap>;
	let collector: BusEventCollector;
	let runtime: SpaceRuntime;

	const SPACE_ID = 'space-edge-1';
	const WORKSPACE = '/tmp/edge-ws';
	const AGENT = 'agent-edge-coder';

	function makeRuntime(extraConfig?: Partial<SpaceRuntimeConfig>): SpaceRuntime {
		return new SpaceRuntime({
			db,
			spaceManager,
			spaceAgentManager: agentManager,
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			...extraConfig,
		});
	}

	function updateFirstNodeExecution(
		runId: string,
		params: Parameters<NodeExecutionRepository['update']>[1]
	): void {
		const execution = nodeExecutionRepo.listByWorkflowRun(runId)[0];
		if (!execution) {
			throw new Error(`No node execution found for run ${runId}`);
		}
		nodeExecutionRepo.update(execution.id, params);
	}

	beforeEach(() => {
		db = makeDb();

		seedSpaceRow(db, SPACE_ID, WORKSPACE);
		seedAgentRow(db, AGENT, SPACE_ID);

		workflowRunRepo = new SpaceWorkflowRunRepository(db);
		taskRepo = new SpaceTaskRepository(db);
		nodeExecutionRepo = new NodeExecutionRepository(db);

		const agentRepo = new SpaceAgentRepository(db);
		agentManager = new SpaceAgentManager(agentRepo);

		const workflowRepo = new SpaceWorkflowRepository(db);
		workflowManager = new SpaceWorkflowManager(workflowRepo);

		spaceManager = new SpaceManager(db);
		bus = new InternalEventBus<DaemonInternalEventMap>();
		collector = new BusEventCollector(bus);
		runtime = makeRuntime();
	});

	afterEach(() => {
		collector.destroy();
		try {
			db.close();
		} catch {
			/* ignore */
		}
		try {
		} catch {
			/* ignore */
		}
	});

	// -------------------------------------------------------------------------
	// 1. InternalEventBus errors — tick resilience
	// -------------------------------------------------------------------------

	describe('InternalEventBus — tick loop resilience', () => {
		test('tick does not crash when InternalEventBus publishAsync throws', async () => {
			// Create a bus that throws on publishAsync
			const throwingBus = new InternalEventBus<DaemonInternalEventMap>();
			// Subscribe a handler that throws — the bus itself handles this,
			// but safeNotify also catches errors from publishAsync
			throwingBus.subscribe(
				'space.task.blocked',
				() => {
					throw new Error('Subscriber error');
				},
				{ subscriberName: 'throwing-subscriber' }
			);

			const rt = makeRuntime({ internalEventBus: throwingBus });

			const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-throw-1', name: 'Only Step', agentId: AGENT },
			]);
			const { run } = await rt.startWorkflowRun(SPACE_ID, wf.id, 'Run');
			updateFirstNodeExecution(run.id, { status: 'blocked', result: 'Build failed' });

			// Tick must complete without throwing even though a subscriber throws
			await expect(rt.executeTick()).resolves.toBeUndefined();
		});

		test('tick does not crash for standalone task when subscriber throws', async () => {
			const throwingBus = new InternalEventBus<DaemonInternalEventMap>();
			throwingBus.subscribe(
				'space.task.blocked',
				() => {
					throw new Error('Subscriber error');
				},
				{ subscriberName: 'throwing-subscriber' }
			);

			const rt = makeRuntime({ internalEventBus: throwingBus });

			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Standalone',
				description: '',
				status: 'blocked',
			});

			await expect(rt.executeTick()).resolves.toBeUndefined();
		});

		test('tick does not crash for task_timeout when subscriber throws', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);
			const throwingBus = new InternalEventBus<DaemonInternalEventMap>();
			throwingBus.subscribe(
				'space.task.timeout',
				() => {
					throw new Error('Subscriber error');
				},
				{ subscriberName: 'throwing-subscriber' }
			);

			const rt = makeRuntime({ internalEventBus: throwingBus });

			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Slow Standalone',
				description: '',
				status: 'in_progress',
			});
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 5000,
				task.id
			);

			await expect(rt.executeTick()).resolves.toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// 2. Rapid status changes between ticks
	// -------------------------------------------------------------------------

	describe('rapid status changes between ticks', () => {
		test('task goes blocked→pending→in_progress→blocked between ticks — one notification on final state', async () => {
			const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-rapid', name: 'Only Step', agentId: AGENT },
			]);
			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');

			// Tick 1: initial pending execution — no notification
			await runtime.executeTick();
			expect(collector.events).toHaveLength(0);

			// Simulate rapid execution-state transitions between ticks.
			updateFirstNodeExecution(run.id, { status: 'blocked', result: 'First failure' });
			updateFirstNodeExecution(run.id, {
				status: 'pending',
				result: null,
				startedAt: null,
				completedAt: null,
			});
			updateFirstNodeExecution(run.id, { status: 'in_progress' });
			updateFirstNodeExecution(run.id, { status: 'blocked', result: 'Final failure' });

			// Tick 2: final state is blocked — exactly one notification
			await runtime.executeTick();

			const blockedEvents = collector.events.filter((e) => e.kind === 'task_blocked');
			expect(blockedEvents).toHaveLength(1);
			expect(blockedEvents[0].payload['reason']).toBe('Final failure');
			expect(blockedEvents[0].payload['taskId']).toBe(tasks[0].id);
		});

		test('standalone task rapid changes — only final blocked state generates notification', async () => {
			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Rapid Standalone',
				description: '',
				status: 'open',
			});

			// Tick 1: pending — no notification
			await runtime.executeTick();
			expect(collector.events).toHaveLength(0);

			// Simulate rapid status cycling (between ticks)
			taskRepo.updateTask(task.id, { status: 'blocked', error: 'Transient error' });
			taskRepo.updateTask(task.id, { status: 'open', error: null });
			taskRepo.updateTask(task.id, { status: 'in_progress' });
			taskRepo.updateTask(task.id, { status: 'blocked', error: 'Persistent error' });

			// Tick 2: final state is blocked — exactly 1 notification
			await runtime.executeTick();

			const naEvents = collector.events.filter((e) => e.kind === 'task_blocked');
			expect(naEvents).toHaveLength(1);
			expect(naEvents[0].payload['reason']).toBe('Task requires attention');
		});
	});

	// -------------------------------------------------------------------------
	// 3. SpaceRuntime rehydration with workflow tasks in blocked
	// -------------------------------------------------------------------------

	describe('rehydration — workflow tasks in blocked on restart', () => {
		test('workflow task in blocked is not re-notified on first tick after restart', async () => {
			// Tick 1 on original runtime: task enters blocked
			const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-rehydrate', name: 'Only Step', agentId: AGENT },
			]);
			const { run } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');
			updateFirstNodeExecution(run.id, { status: 'blocked', result: 'Pre-restart error' });

			await runtime.executeTick();

			const originalEvents = collector.events.filter((e) => e.kind === 'task_blocked');
			expect(originalEvents).toHaveLength(1);

			// Simulate daemon restart: create a fresh SpaceRuntime with empty dedup set
			const freshBus = new InternalEventBus<DaemonInternalEventMap>();
			const freshCollector = new BusEventCollector(freshBus);
			const freshRuntime = makeRuntime({ internalEventBus: freshBus });

			// First tick on fresh runtime: run is already blocked, so processRunTick skips it.
			await freshRuntime.executeTick();

			const reNotified = freshCollector.events.filter((e) => e.kind === 'task_blocked');
			expect(reNotified).toHaveLength(0);

			// Subsequent ticks remain quiet for already-blocked runs.
			await freshRuntime.executeTick();
			expect(freshCollector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(0);
			freshCollector.destroy();
		});

		test('multiple workflow runs with blocked tasks — none re-notified after restart', async () => {
			// Set up two workflow runs, each with a task in blocked
			const wfA = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-rehy-a', name: 'Step A', agentId: AGENT },
			]);
			const wfB = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-rehy-b', name: 'Step B', agentId: AGENT },
			]);

			const { run: runA } = await runtime.startWorkflowRun(SPACE_ID, wfA.id, 'Run A');
			const { run: runB } = await runtime.startWorkflowRun(SPACE_ID, wfB.id, 'Run B');

			updateFirstNodeExecution(runA.id, { status: 'blocked', result: 'Error A' });
			updateFirstNodeExecution(runB.id, { status: 'blocked', result: 'Error B' });

			await runtime.executeTick();
			expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(2);

			// Simulate restart
			const freshBus = new InternalEventBus<DaemonInternalEventMap>();
			const freshCollector = new BusEventCollector(freshBus);
			const freshRuntime = makeRuntime({ internalEventBus: freshBus });

			await freshRuntime.executeTick();

			const reNotified = freshCollector.events.filter((e) => e.kind === 'task_blocked');
			expect(reNotified).toHaveLength(0);
			freshCollector.destroy();
		});
	});

	// -------------------------------------------------------------------------
	// 4. Deduplication — standalone tasks across many ticks
	// -------------------------------------------------------------------------

	describe('deduplication — standalone tasks across many ticks', () => {
		test('same standalone task in blocked for 5+ ticks emits only 1 notification', async () => {
			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Persistent Issue',
				description: '',
				status: 'blocked',
			});

			// Run many ticks — should emit only 1 notification total
			for (let i = 0; i < 5; i++) {
				await runtime.executeTick();
			}

			const naEvents = collector.events.filter((e) => e.kind === 'task_blocked');
			expect(naEvents).toHaveLength(1);
			expect(naEvents[0].payload['taskId']).toBe(task.id);
		});

		test('standalone task in timeout for 5+ ticks emits only 1 notification', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Stuck Standalone',
				description: '',
				status: 'in_progress',
			});
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 30000, // 30s ago, well past 1s timeout
				task.id
			);

			for (let i = 0; i < 5; i++) {
				await runtime.executeTick();
			}

			const timeoutEvents = collector.events.filter((e) => e.kind === 'task_timeout');
			expect(timeoutEvents).toHaveLength(1);
		});

		test('dedup key refreshed after task resolves and re-enters blocked', async () => {
			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Flapping Task',
				description: '',
				status: 'blocked',
			});

			// Tick 1 → 1 notification
			await runtime.executeTick();
			expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

			// Tick 2 → deduped, still 1
			await runtime.executeTick();
			expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

			// Task resolves (leaves blocked)
			taskRepo.updateTask(task.id, { status: 'in_progress', error: null });

			// Tick 3 → in_progress, no new notification
			await runtime.executeTick();
			expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

			// Task hits blocked again
			taskRepo.updateTask(task.id, { status: 'blocked', error: 'Second error' });

			// Tick 4 → dedup key cleared when task left blocked, so re-notifies
			await runtime.executeTick();
			expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(2);
		});
	});

	// -------------------------------------------------------------------------
	// 5. Workflow-backed dependency block cleanup
	// -------------------------------------------------------------------------

	describe('workflow-backed dependency block cleanup', () => {
		test('blocking an in-progress workflow task stops run and active node agents', async () => {
			const tam = new MockTaskAgentManager();
			const rt = makeRuntime({ taskAgentManager: tam as never });
			const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-dep-block', name: 'Only Step', agentId: AGENT },
			]);
			const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, wf.id, 'Run');
			const task = tasks[0];
			const [execution] = nodeExecutionRepo.listByWorkflowRun(run.id);
			nodeExecutionRepo.update(execution.id, {
				status: 'in_progress',
				agentSessionId: 'node-session-1',
			});
			taskRepo.updateTask(task.id, { taskAgentSessionId: 'task-session-1' });

			const blocked = await rt.blockWorkflowBackedTask(SPACE_ID, task.id, {
				dependsOn: ['missing-dep'],
				status: 'blocked',
				blockReason: 'dependency_added',
				result: 'Dependency added while task was in progress',
				completedAt: null,
			});

			expect(blocked?.status).toBe('blocked');
			expect(blocked?.blockReason).toBe('dependency_added');
			expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
			expect(tam.cancelledSessions).toEqual(['node-session-1', 'task-session-1']);
			const cancelledExecution = nodeExecutionRepo.getById(execution.id)!;
			expect(cancelledExecution.status).toBe('cancelled');
			expect(cancelledExecution.agentSessionId).toBeNull();
			const clearedTask = taskRepo.getTask(task.id)!;
			expect(clearedTask.workflowRunId).toBeUndefined();
			expect(clearedTask.taskAgentSessionId).toBeUndefined();
			expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);
			expect(collector.events.filter((e) => e.kind === 'workflow_run_blocked')).toHaveLength(1);
		});
	});

	// -------------------------------------------------------------------------
	// 6. External run cancellation — no stale notifications
	// -------------------------------------------------------------------------

	describe('external run cancellation — no stale notifications', () => {
		test('run cancelled externally between ticks — no notification on subsequent tick', async () => {
			const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-cancel-ext', name: 'Only Step', agentId: AGENT },
			]);
			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');

			// Tick 1: task in_progress, no notification
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
			await runtime.executeTick();
			expect(collector.events).toHaveLength(0);

			// External cancellation: update run status directly in DB (simulating external API call)
			workflowRunRepo.transitionStatus(run.id, 'cancelled');

			// Tick 2: run is now cancelled, SpaceRuntime skips it in processRunTick
			await runtime.executeTick();

			// No notifications for a cancelled run
			expect(collector.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(0);
			expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(0);
		});

		test('run cancelled externally while task is in blocked — no stale task notification on next tick', async () => {
			const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-cancel-na', name: 'Only Step', agentId: AGENT },
			]);
			const { run } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');
			updateFirstNodeExecution(run.id, { status: 'blocked', result: 'Error' });

			// Tick 1: task_blocked emitted
			await runtime.executeTick();
			expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

			// External cancellation between ticks
			workflowRunRepo.transitionStatus(run.id, 'cancelled');

			// Tick 2: run is cancelled, executor removed by cleanupTerminalExecutors.
			await runtime.executeTick();

			// Still only 1 task_blocked (from tick 1)
			expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);
			// No workflow_run_completed for cancelled runs
			expect(collector.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(0);
		});

		test('run cancelled between rehydration and first tick — no notification emitted', async () => {
			// Start a run on the original runtime
			const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-cancel-rehy', name: 'Only Step', agentId: AGENT },
			]);
			const { run } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');

			// Simulate: between daemon restart and first tick, run gets cancelled externally
			workflowRunRepo.transitionStatus(run.id, 'cancelled');

			// Fresh runtime (simulating restart): first executeTick() rehydrates,
			// then processes — cancelled run should emit nothing
			const freshBus = new InternalEventBus<DaemonInternalEventMap>();
			const freshCollector = new BusEventCollector(freshBus);
			const freshRuntime = makeRuntime({ internalEventBus: freshBus });

			await freshRuntime.executeTick();

			// No notifications for a run that was already cancelled before first tick
			expect(freshCollector.events).toHaveLength(0);
			freshCollector.destroy();
		});
	});
});
