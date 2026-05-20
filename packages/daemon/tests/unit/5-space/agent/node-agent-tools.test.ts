/**
 * Unit tests for createNodeAgentToolHandlers()
 *
 * Covers all node agent peer communication tools:
 *   list_peers              — list peers excluding self and task-agent
 *   send_message            — channel-validated direct messaging + gate-write side-effect
 *   save                    — persist summary and/or structured data to NodeExecution
 *   list_channels           — enumerate declared channels
 *   read_gate / list_gates  — gate inspection
 *   list_reachable_agents   — cross-node reachability
 *
 * Tests use a real SQLite database (via runMigrations) and mock message
 * injectors so no real agent sessions are created.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { GateDataRepository } from '../../../../src/storage/repositories/gate-data-repository.ts';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository.ts';
import {
	createNodeAgentToolHandlers,
	createNodeAgentMcpServer,
	type NodeAgentToolsConfig,
} from '../../../../src/lib/space/tools/node-agent-tools.ts';
import { AgentMessageRouter } from '../../../../src/lib/space/runtime/agent-message-router.ts';
import { ChannelResolver } from '../../../../src/lib/space/runtime/channel-resolver.ts';
import { PendingAgentMessageRepository } from '../../../../src/storage/repositories/pending-agent-message-repository.ts';
import { McpAuditLogRepository } from '../../../../src/storage/repositories/mcp-audit-log-repository.ts';
import { jsonResult } from '../../../../src/lib/space/tools/tool-result.ts';
import type { SpaceWorkflow, Gate, WorkflowChannel } from '@neokai/shared';
import type {
	DaemonInternalEventMap,
	InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';

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

function seedSpaceRow(db: BunDatabase, spaceId: string): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(spaceId, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedSpaceWorkflowRunRow(
	db: BunDatabase,
	runId: string,
	spaceId: string,
	workflowId: string
): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO space_workflow_runs
     (id, space_id, workflow_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, '', 'pending', ?, ?)`
	).run(runId, spaceId, workflowId, now, now);
}

/**
 * Creates a fresh workflow run and returns its ID.
 * Used by tests that need isolation from the default makeCtx() run.
 */
function makeFreshRunId(db: BunDatabase, spaceId: string): string {
	const runId = `run-${Math.random().toString(36).slice(2)}`;
	seedSpaceWorkflowRunRow(db, runId, spaceId, 'wf-seed');
	return runId;
}

function toNodeExecutionStatus(
	status: string
): 'pending' | 'in_progress' | 'idle' | 'blocked' | 'cancelled' {
	switch (status) {
		case 'pending':
		case 'open':
			return 'pending';
		case 'in_progress':
			return 'in_progress';
		case 'idle':
		case 'done':
		case 'completed':
			return 'idle';
		case 'blocked':
		case 'failed':
			return 'blocked';
		case 'cancelled':
			return 'cancelled';
		default:
			return 'in_progress';
	}
}

function seedSpaceTask(
	db: BunDatabase,
	spaceId: string,
	workflowRunId: string,
	workflowNodeId: string,
	agentName: string,
	status: string = 'in_progress',
	result: string | null = null,
	sessionId: string | null = null
): string {
	const id = `task-${Math.random().toString(36).slice(2)}`;
	const now = Date.now();
	db.exec('PRAGMA foreign_keys = OFF');
	db.prepare(
		`INSERT INTO space_tasks
         (id, space_id, task_number, title, description, status, priority, result,
          workflow_run_id, depends_on, created_at, updated_at)
         VALUES (?, ?, (SELECT COALESCE(MAX(task_number), 0) + 1 FROM space_tasks WHERE space_id = ?), ?, '', ?, 'normal', ?, ?, '[]', ?, ?)`
	).run(id, spaceId, spaceId, agentName, status, result, workflowRunId, now, now);
	if (sessionId) {
		db.prepare('UPDATE space_tasks SET task_agent_session_id = ? WHERE id = ?').run(sessionId, id);
	}
	db.exec('PRAGMA foreign_keys = ON');

	const nodeExecutionRepo = new NodeExecutionRepository(db);
	const execution = nodeExecutionRepo.createOrIgnore({
		workflowRunId,
		workflowNodeId,
		agentName,
		agentSessionId: sessionId,
		status: toNodeExecutionStatus(status),
	});
	nodeExecutionRepo.update(execution.id, {
		agentSessionId: sessionId,
		status: toNodeExecutionStatus(status),
		result,
	});

	return id;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeResolvedChannel(
	from: string,
	to: string,
	_isHubSpoke = false,
	_overrides: Record<string, unknown> = {}
): WorkflowChannel {
	return {
		id: `ch-${from}-${to}`,
		from,
		to,
	};
}

// ---------------------------------------------------------------------------
// Test context
// ---------------------------------------------------------------------------

interface TestCtx {
	db: BunDatabase;
	spaceId: string;
	taskRepo: SpaceTaskRepository;
	taskManager: SpaceTaskManager;
	spaceTaskRepo: SpaceTaskRepository;
	nodeExecutionRepo: NodeExecutionRepository;
	artifactRepo: WorkflowRunArtifactRepository;
	/** Workflow run ID for peer task seeding. */
	workflowRunId: string;
	/** Workflow node ID for peer task seeding. */
	nodeId: string;
	coderSessionId: string;
	reviewerSessionId: string;
	taskAgentSessionId: string;
	/** ID of the parent (main) task seeded in the DB. */
	parentTaskId: string;
	/** ID of the step task seeded in the DB. */
	stepTaskId: string;
}

function makeCtx(): TestCtx {
	const db = makeDb();
	const spaceId = 'space-node-tools-test';

	seedSpaceRow(db, spaceId);

	const taskRepo = new SpaceTaskRepository(db);
	const spaceTaskRepo = taskRepo;
	const taskManager = new SpaceTaskManager(db, spaceId);
	const nodeExecutionRepo = new NodeExecutionRepository(db);
	const artifactRepo = new WorkflowRunArtifactRepository(db);

	// Session IDs for peers
	const taskAgentSessionId = 'session-task-agent';
	const coderSessionId = 'session-coder';
	const reviewerSessionId = 'session-reviewer';

	// Workflow run/node IDs for peer task seeding
	const workflowRunId = 'run-node-tools-default';
	const nodeId = 'node-node-tools-default';

	// Seed workflow run so gate_data FK constraint is satisfied for write_gate tests
	seedSpaceWorkflowRunRow(db, workflowRunId, spaceId, 'wf-seed');

	// Seed peer tasks: coder and reviewer on the default node
	seedSpaceTask(db, spaceId, workflowRunId, nodeId, 'coder', 'in_progress', null, coderSessionId);
	seedSpaceTask(
		db,
		spaceId,
		workflowRunId,
		nodeId,
		'reviewer',
		'in_progress',
		null,
		reviewerSessionId
	);

	// Seed a parent task and a step task in the DB
	const parentTask = taskRepo.createTask({
		spaceId,
		title: 'Parent Task',
		description: '',
		status: 'in_progress',
	});
	const stepTask = taskRepo.createTask({
		spaceId,
		title: 'Step Task',
		description: '',
		status: 'in_progress',
	});

	return {
		db,
		spaceId,
		taskRepo,
		taskManager,
		spaceTaskRepo,
		nodeExecutionRepo,
		artifactRepo,
		workflowRunId,
		nodeId,
		coderSessionId,
		reviewerSessionId,
		taskAgentSessionId,
		parentTaskId: parentTask.id,
		stepTaskId: stepTask.id,
	};
}

type NodeConfigOverrides = Partial<NodeAgentToolsConfig> & {
	messageInjector?: (sessionId: string, message: string) => Promise<void>;
};

function makeConfig(ctx: TestCtx, overrides: NodeConfigOverrides = {}): NodeAgentToolsConfig {
	const { messageInjector, ...configOverrides } = overrides;
	const workflowRunId = configOverrides.workflowRunId ?? ctx.workflowRunId;
	const nodeExecutionRepo = configOverrides.nodeExecutionRepo ?? ctx.nodeExecutionRepo;
	const channelResolver = configOverrides.channelResolver ?? new ChannelResolver([]);
	const injector = messageInjector ?? (async () => {});
	const agentMessageRouter =
		configOverrides.agentMessageRouter ??
		new AgentMessageRouter({
			nodeExecutionRepo,
			workflowRunId,
			workflowChannels: channelResolver.getChannels(),
			messageInjector: injector,
		});

	return {
		mySessionId: ctx.coderSessionId,
		myAgentName: 'coder',
		taskId: ctx.parentTaskId,
		spaceId: ctx.spaceId,
		channelResolver,
		workflowRunId,
		workflowNodeId: ctx.nodeId,
		nodeExecutionRepo,
		agentMessageRouter,
		workflow: null,
		gateDataRepo: new GateDataRepository(ctx.db),
		artifactRepo: ctx.artifactRepo,
		...configOverrides,
	};
}

/**
 * Build a ChannelResolver directly from resolved channel entries.
 * Replaces the old seedWorkflowRunWithChannels + DB approach.
 */
function makeResolver(channels: WorkflowChannel[]): ChannelResolver {
	return new ChannelResolver(channels);
}

// ---------------------------------------------------------------------------
// Tests: list_peers
// ---------------------------------------------------------------------------

describe('node-agent-tools: list_peers', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
	});

	test('returns peers excluding self and task-agent', async () => {
		const config = makeConfig(ctx);
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.peers).toHaveLength(1); // only reviewer (coder=self, task-agent=excluded)
		expect(data.peers[0].agentName).toBe('reviewer');
		expect(data.peers[0].sessionId).toBe(ctx.reviewerSessionId);
		expect(data.myAgentName).toBe('coder');
	});

	test('reports no channel topology when none declared', async () => {
		const config = makeConfig(ctx);
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.channelTopologyDeclared).toBe(false);
		expect(data.permittedTargets).toEqual(['space-agent']);
		expect(data.message).toContain('Use "space-agent"');
	});

	test('reports permitted targets when channels declared', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.channelTopologyDeclared).toBe(true);
		expect(data.permittedTargets).toEqual(['reviewer', 'space-agent']);
	});

	test('returns empty peer list when no peers in the run', async () => {
		// Use a fresh run that has only the coder task (self) — no reviewer
		const isolatedRunId = makeFreshRunId(ctx.db, ctx.spaceId);
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			isolatedRunId,
			ctx.nodeId,
			'coder',
			'in_progress',
			null,
			ctx.coderSessionId
		);

		const config = makeConfig(ctx, { workflowRunId: isolatedRunId });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.peers).toHaveLength(0);
	});

	test('excludes open task with no session from peers list', async () => {
		// Seed an open task with no session — should not appear in peers
		const isolatedRunId = makeFreshRunId(ctx.db, ctx.spaceId);
		seedSpaceTask(ctx.db, ctx.spaceId, isolatedRunId, ctx.nodeId, 'tester', 'open', null);
		// Do NOT set task_agent_session_id — simulates not-yet-spawned task

		const config = makeConfig(ctx, { workflowRunId: isolatedRunId });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.peers).toHaveLength(0);
	});

	test('excludes failed task with no session from peers list', async () => {
		// A blocked task that never got a session should also be excluded
		const isolatedRunId = makeFreshRunId(ctx.db, ctx.spaceId);
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			isolatedRunId,
			ctx.nodeId,
			'tester',
			'blocked',
			'Failed before session'
		);

		const config = makeConfig(ctx, { workflowRunId: isolatedRunId });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.peers).toHaveLength(0);
	});

	test('includes idle task with no session in peers list', async () => {
		// An idle task whose session was cleared should still appear for visibility
		// space_tasks uses 'done'; toNodeExecutionStatus maps it to 'idle' for node_executions
		const isolatedRunId = makeFreshRunId(ctx.db, ctx.spaceId);
		seedSpaceTask(ctx.db, ctx.spaceId, isolatedRunId, ctx.nodeId, 'tester', 'done', 'Done');
		// Do NOT set task_agent_session_id — simulates post-session cleanup

		const config = makeConfig(ctx, { workflowRunId: isolatedRunId });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.peers).toHaveLength(1);
		expect(data.peers[0].agentName).toBe('tester');
		expect(data.peers[0].sessionId).toBeNull();
		expect(data.peers[0].status).toBe('completed');
		expect(data.peers[0].completionState.completionSummary).toBe('Done');
	});
});

// ---------------------------------------------------------------------------
// Tests: send_message
// ---------------------------------------------------------------------------

describe('node-agent-tools: send_message', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
	});

	test('point-to-point succeeds when channel declared', async () => {
		const injected: Array<{ sessionId: string; message: string }> = [];
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
			messageInjector: async (sid, msg) => {
				injected.push({ sessionId: sid, message: msg });
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'LGTM!' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.delivered).toHaveLength(1);
		expect(data.delivered[0].sessionId).toBe(ctx.reviewerSessionId);
		expect(data.delivered[0].agentName).toBe('reviewer');
		expect(injected).toHaveLength(1);
		expect(injected[0].message).toBe('─── Message from coder ───\n\nLGTM!');
	});

	test('point-to-point fails when channel not declared', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('reviewer', 'coder')]), // reverse direction only
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'hello' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain("does not permit 'coder' to send to: reviewer");
		expect(data.unauthorizedAgentNames).toContain('reviewer');
	});

	test('returns error when no channels declared at all (empty topology blocks send_message)', async () => {
		const config = makeConfig(ctx); // no workflowRunId, no channels
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'test' });
		const data = JSON.parse(result.content[0].text);

		// With no declared channels, send_message is unavailable.
		expect(data.success).toBe(false);
		expect(data.error).toContain('No channel topology declared');
	});

	test('delivers space-agent target through send_message tool handler', async () => {
		const spaceMessages: Array<{ spaceId: string; message: string }> = [];
		const agentMessageRouter = new AgentMessageRouter({
			nodeExecutionRepo: ctx.nodeExecutionRepo,
			workflowRunId: ctx.workflowRunId,
			workflowChannels: [],
			messageInjector: async () => {},
			spaceId: ctx.spaceId,
			taskId: ctx.parentTaskId,
			taskNumber: 42,
			spaceAgentInjector: async (spaceId, message) => {
				spaceMessages.push({ spaceId, message });
			},
		});
		const config = makeConfig(ctx, { agentMessageRouter });
		const handlers = createNodeAgentToolHandlers(config);

		const result = await handlers.send_message({
			target: 'space-agent',
			message: 'Need space-level judgment',
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.delivered).toEqual([
			{ agentName: 'space-agent', sessionId: `space:chat:${ctx.spaceId}` },
		]);
		expect(spaceMessages).toEqual([
			{
				spaceId: ctx.spaceId,
				message:
					'─── Message from coder (task #42) ───\n\n' +
					'Need space-level judgment\n\n' +
					'─── Reply ───\n' +
					`To reply, use: send_message_to_task with task_id="${ctx.parentTaskId}" and target node "coder"`,
			},
		]);
	});

	test('broadcast (*) succeeds and delivers to all permitted targets', async () => {
		const injected: string[] = [];
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
			messageInjector: async (sid) => {
				injected.push(sid);
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: '*', message: 'broadcast!' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.delivered).toHaveLength(1);
		expect(injected).toContain(ctx.reviewerSessionId);
	});

	test('broadcast (*) fails when no channels declared', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('reviewer', 'coder')]), // coder has no outgoing channels
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: '*', message: 'broadcast' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain("No permitted targets for agent 'coder'");
	});

	test('broadcast (*) with empty topology returns error', async () => {
		// No channels declared at all
		const config = makeConfig(ctx);
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: '*', message: 'broadcast' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('No channel topology declared');
	});

	test('multicast delivers to all specified target roles', async () => {
		// Add a security peer task
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			ctx.workflowRunId,
			ctx.nodeId,
			'security',
			'in_progress',
			null,
			'session-security'
		);

		const injected: string[] = [];
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('coder', 'reviewer'),
				makeResolvedChannel('coder', 'security'),
			]),
			messageInjector: async (sid) => {
				injected.push(sid);
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({
			target: ['reviewer', 'security'],
			message: 'multicast!',
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.delivered).toHaveLength(2);
		expect(injected).toContain(ctx.reviewerSessionId);
		expect(injected).toContain('session-security');
	});

	test('multicast partial authorization fails with full error', async () => {
		// Add security peer task
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			ctx.workflowRunId,
			ctx.nodeId,
			'security',
			'in_progress',
			null,
			'session-security'
		);
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('coder', 'reviewer'),
				// no coder → security channel
			]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({
			target: ['reviewer', 'security'],
			message: 'msg',
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.unauthorizedAgentNames).toContain('security');
	});

	test('hub-spoke: spoke cannot send to other spokes', async () => {
		// Hub-spoke topology: hub ↔ coder, hub ↔ reviewer (coder cannot send to reviewer directly)
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('hub', 'coder', true),
				makeResolvedChannel('coder', 'hub', true),
				makeResolvedChannel('hub', 'reviewer', true),
				makeResolvedChannel('reviewer', 'hub', true),
			]),
		}); // myAgentName='coder'
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'hello' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain("does not permit 'coder' to send to: reviewer");
	});

	test('hub-spoke: spoke can reply to hub', async () => {
		// Add hub peer task
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			ctx.workflowRunId,
			ctx.nodeId,
			'hub',
			'in_progress',
			null,
			'session-hub'
		);
		const injected: string[] = [];
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('hub', 'coder', true),
				makeResolvedChannel('coder', 'hub', true),
			]),
			messageInjector: async (sid) => {
				injected.push(sid);
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'hub', message: 'done!' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(injected).toContain('session-hub');
	});

	test('bidirectional: both directions work', async () => {
		// coder ↔ reviewer
		const biResolver = makeResolver([
			makeResolvedChannel('coder', 'reviewer'),
			makeResolvedChannel('reviewer', 'coder'),
		]);
		const injectedToReviewer: string[] = [];
		const config = makeConfig(ctx, {
			channelResolver: biResolver,
			messageInjector: async (sid) => {
				injectedToReviewer.push(sid);
			},
		});
		const handlers = createNodeAgentToolHandlers(config);

		// coder → reviewer
		const r1 = await handlers.send_message({ target: 'reviewer', message: 'code ready' });
		expect(JSON.parse(r1.content[0].text).success).toBe(true);

		// reviewer → coder (as reviewer)
		const configAsReviewer = makeConfig(ctx, {
			channelResolver: biResolver,
			mySessionId: ctx.reviewerSessionId,
			myAgentName: 'reviewer',
			messageInjector: async (sid) => {
				injectedToReviewer.push(sid);
			},
		});
		const handlersAsReviewer = createNodeAgentToolHandlers(configAsReviewer);
		const r2 = await handlersAsReviewer.send_message({ target: 'coder', message: 'approved' });
		expect(JSON.parse(r2.content[0].text).success).toBe(true);
	});

	test('returns no-active-sessions when topology declares target but no session exists yet', async () => {
		// "tester" is declared in channel topology (coder → tester) but has no active session.
		// Target resolution succeeds (topology-declared), but delivery fails with
		// a "could not deliver" error explaining the target is declared but has no session.
		// Reworded in Task #133 to disambiguate from the genuinely-unknown-agent path.
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'tester')]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'tester', message: 'test pls' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('Could not deliver message to target agent(s): tester');
		expect(data.error).toContain('no live session received the message');
	});

	test('returns unknown-target when role is not in topology or any execution', async () => {
		// "totally-unknown" is not declared in channel topology and has no execution record.
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({
			target: 'totally-unknown',
			message: 'test pls',
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain("Unknown target 'totally-unknown'");
	});

	test('handles partial injection failures gracefully (partial success)', async () => {
		// In the new task-centric model, agent_name is unique per (run, node).
		// Partial success is tested via multicast to two different roles: reviewer + security.
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			ctx.workflowRunId,
			ctx.nodeId,
			'security',
			'in_progress',
			null,
			'session-security'
		);
		let callCount = 0;
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('coder', 'reviewer'),
				makeResolvedChannel('coder', 'security'),
			]),
			messageInjector: async (_sid) => {
				callCount++;
				if (callCount === 1) throw new Error('injection failed');
				// second call succeeds
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({
			target: ['reviewer', 'security'],
			message: 'hello',
		});
		const data = JSON.parse(result.content[0].text);

		// Partial success — one delivered, one failed
		expect(data.success).toBe('partial');
		expect(data.delivered).toHaveLength(1);
		expect(data.failed).toHaveLength(1);
		// Both targets were attempted (best-effort, not stop-on-first-error)
		expect(callCount).toBe(2);
	});

	test('fails entirely when all injections fail', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
			messageInjector: async () => {
				throw new Error('always fails');
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'test' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.failed).toHaveLength(1);
		expect(data.delivered).toBeUndefined();
	});

	test('best-effort multicast: first delivery succeeds, second fails — partial success', async () => {
		// Add security peer task so we can send to two different non-task-agent roles
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			ctx.workflowRunId,
			ctx.nodeId,
			'security',
			'in_progress',
			null,
			'session-security'
		);

		let callCount = 0;
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('coder', 'reviewer'),
				makeResolvedChannel('coder', 'security'),
			]),
			messageInjector: async (_sid, _msg) => {
				callCount++;
				if (callCount === 2) throw new Error('session not available');
			},
		});
		const handlers = createNodeAgentToolHandlers(config);

		const result = await handlers.send_message({
			target: ['reviewer', 'security'],
			message: 'Hello',
		});
		const data = JSON.parse(result.content[0].text);

		// Should NOT return success: false for total failure — it's partial
		expect(data.success).toBe('partial');
		expect(data.delivered).toHaveLength(1);
		expect(data.failed).toHaveLength(1);
		expect(data.failed[0].error).toContain('session not available');
		// Both targets were attempted (best-effort, not stop-on-first-error)
		expect(callCount).toBe(2);
	});

	test('best-effort multicast: all deliveries fail — success: false', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
			messageInjector: async () => {
				throw new Error('all sessions unavailable');
			},
		});
		const handlers = createNodeAgentToolHandlers(config);

		const result = await handlers.send_message({ target: 'reviewer', message: 'Hello' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.delivered).toBeUndefined();
		expect(data.failed).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Tests: save_artifact
// ---------------------------------------------------------------------------

describe('node-agent-tools: save_artifact', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
	});

	test('save_artifact({ type, summary }) writes to artifact store and does NOT mutate task status', async () => {
		const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
		const result = await handlers.save_artifact({ type: 'progress', summary: 'PR #42 merged.' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.artifact.type).toBe('progress');
		expect(data.artifact.nodeId).toBe(ctx.nodeId);
		expect(data.artifact.runId).toBe(ctx.workflowRunId);

		// Verify persisted in DB
		const artifacts = ctx.artifactRepo.listByRun(ctx.workflowRunId, { artifactType: 'progress' });
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0].data.summary).toBe('PR #42 merged.');
		expect(artifacts[0].nodeId).toBe(ctx.nodeId);
	});

	test('save_artifact({ type, data }) persists structured data', async () => {
		const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
		const result = await handlers.save_artifact({
			type: 'pr',
			data: { prNumber: 42, merged: true },
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		const artifacts = ctx.artifactRepo.listByRun(ctx.workflowRunId, { artifactType: 'pr' });
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0].data.prNumber).toBe(42);
		expect(artifacts[0].data.merged).toBe(true);
	});

	test('save_artifact({ type, summary, data }) persists both fields', async () => {
		const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
		const result = await handlers.save_artifact({
			type: 'result',
			summary: 'work done',
			data: { pr: 99 },
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);

		const artifacts = ctx.artifactRepo.listByRun(ctx.workflowRunId, { artifactType: 'result' });
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0].data.summary).toBe('work done');
		expect(artifacts[0].data.pr).toBe(99);
	});

	test('overwrite mode (default): same (type, key) upserts the record', async () => {
		const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
		const r1 = JSON.parse(
			(await handlers.save_artifact({ type: 'progress', key: 'current', summary: 'first' }))
				.content[0].text
		);
		expect(r1.success).toBe(true);

		const r2 = JSON.parse(
			(await handlers.save_artifact({ type: 'progress', key: 'current', summary: 'second' }))
				.content[0].text
		);
		expect(r2.success).toBe(true);
		// Same artifact ID (upserted, not inserted)
		expect(r2.artifact.id).toBe(r1.artifact.id);

		const artifacts = ctx.artifactRepo.listByRun(ctx.workflowRunId, { artifactType: 'progress' });
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0].data.summary).toBe('second');
	});

	test('append mode: multiple calls create multiple records', async () => {
		const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
		const r1 = JSON.parse(
			(await handlers.save_artifact({ type: 'audit', append: true, summary: 'first' })).content[0]
				.text
		);
		const r2 = JSON.parse(
			(await handlers.save_artifact({ type: 'audit', append: true, summary: 'second' })).content[0]
				.text
		);
		expect(r1.success).toBe(true);
		expect(r2.success).toBe(true);
		// Distinct records
		expect(r2.artifact.id).not.toBe(r1.artifact.id);

		const artifacts = ctx.artifactRepo.listByRun(ctx.workflowRunId, { artifactType: 'audit' });
		expect(artifacts).toHaveLength(2);
	});

	test('returns error when artifactRepo is absent', async () => {
		const handlers = createNodeAgentToolHandlers(makeConfig(ctx, { artifactRepo: undefined }));
		const result = await handlers.save_artifact({ type: 'result', summary: 'done' });
		const data = JSON.parse(result.content[0].text);
		expect(data.success).toBe(false);
	});

	test('returns error when neither summary nor data provided', async () => {
		const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
		const result = await handlers.save_artifact({ type: 'result' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('summary');
	});
});

// ---------------------------------------------------------------------------
// Tests: list_channels
// ---------------------------------------------------------------------------

describe('node-agent-tools: list_channels', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
	});

	test('returns empty channels when workflow is null', async () => {
		const config = makeConfig(ctx, { workflow: null });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_channels({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.channels).toHaveLength(0);
		expect(data.total).toBe(0);
	});

	test('returns empty channels when workflow has no channels', async () => {
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [],
		};
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_channels({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.channels).toHaveLength(0);
	});

	test('returns channel with hasGate false when no inline gate', async () => {
		const channel: WorkflowChannel = {
			id: 'ch-1',
			from: 'coder',
			to: 'reviewer',
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [channel],
		};
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_channels({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.channels).toHaveLength(1);
		expect(data.channels[0].channelId).toBe('ch-1');
		expect(data.channels[0].from).toBe('coder');
		expect(data.channels[0].to).toBe('reviewer');
		expect(data.channels[0].hasGate).toBe(false);
	});

	test('returns channel with hasGate true when inline gate present', async () => {
		const channel: WorkflowChannel = {
			id: 'ch-2',
			from: 'coder',
			to: 'reviewer',
			gateId: 'approval-gate',
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [channel],
		};
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_channels({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.channels).toHaveLength(1);
		expect(data.channels[0].hasGate).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests: list_gates
// ---------------------------------------------------------------------------

describe('node-agent-tools: list_gates', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
	});

	test('returns empty gates when workflow is null', async () => {
		const config = makeConfig(ctx, { workflow: null });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_gates({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.gates).toHaveLength(0);
		expect(data.nodeId).toBe(ctx.nodeId);
	});

	test('returns empty gates when workflow has no gates', async () => {
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [],
			gates: [],
		};
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_gates({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.gates).toHaveLength(0);
	});

	test('returns gate with default data when no runtime data exists', async () => {
		const gate: Gate = {
			id: 'gate-approval',
			fields: [
				{
					name: 'approved',
					type: 'boolean',
					writers: [],
					check: { op: '==', value: true },
				},
			],
			resetOnCycle: false,
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [],
			gates: [gate],
		};
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_gates({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.gates).toHaveLength(1);
		expect(data.gates[0].gateId).toBe('gate-approval');
		expect(data.gates[0].currentData).toEqual({});
		expect(data.gates[0].fields).toHaveLength(1);
		expect(data.gates[0].fields[0].name).toBe('approved');
		expect(data.nodeId).toBe(ctx.nodeId);
	});

	test('returns gate with runtime data overriding defaults', async () => {
		const gate: Gate = {
			id: 'gate-vote',
			fields: [
				{
					name: 'votes',
					type: 'map',
					writers: ['*'],
					check: { op: 'count', match: 'approved', min: 2 },
				},
			],
			resetOnCycle: false,
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [],
			gates: [gate],
		};
		// Pre-write some runtime data
		const gateDataRepo = new GateDataRepository(ctx.db);
		gateDataRepo.merge(ctx.workflowRunId, 'gate-vote', {
			votes: { 'node-a': 'approved', 'node-b': 'approved' },
		});

		const config = makeConfig(ctx, { workflow, gateDataRepo });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_gates({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.gates).toHaveLength(1);
		expect(data.gates[0].currentData).toEqual({
			votes: { 'node-a': 'approved', 'node-b': 'approved' },
		});
	});
});

// ---------------------------------------------------------------------------
// Tests: read_gate
// ---------------------------------------------------------------------------

describe('node-agent-tools: read_gate', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
	});

	test('returns error for non-existent gateId', async () => {
		const gate: Gate = {
			id: 'gate-real',
			fields: [{ name: 'x', type: 'number', writers: [], check: { op: '==', value: 1 } }],
			resetOnCycle: false,
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [],
			gates: [gate],
		};
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.read_gate({ gateId: 'gate-does-not-exist' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('not found');
		expect(data.availableGateIds).toEqual(['gate-real']);
	});

	test('returns gate data and open status for existing gate (closed)', async () => {
		const gate: Gate = {
			id: 'gate-check',
			fields: [
				{ name: 'ready', type: 'boolean', writers: ['coder'], check: { op: '==', value: true } },
			],
			resetOnCycle: false,
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [],
			gates: [gate],
		};
		const gateDataRepo = new GateDataRepository(ctx.db);
		gateDataRepo.set(ctx.workflowRunId, 'gate-check', { ready: false });
		const config = makeConfig(ctx, { workflow, gateDataRepo });
		const handlers = createNodeAgentToolHandlers(config);

		const result = await handlers.read_gate({ gateId: 'gate-check' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.gateId).toBe('gate-check');
		expect(data.data).toEqual({ ready: false });
		expect(data.gateOpen).toBe(false);
	});

	test('returns gate data and open status for existing gate (open)', async () => {
		const gate: Gate = {
			id: 'gate-open',
			fields: [{ name: 'status', type: 'string', writers: [], check: { op: '==', value: 'go' } }],
			resetOnCycle: false,
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [],
			gates: [gate],
		};
		const gateDataRepo = new GateDataRepository(ctx.db);
		gateDataRepo.set(ctx.workflowRunId, 'gate-open', { status: 'go' });
		const config = makeConfig(ctx, { workflow, gateDataRepo });
		const handlers = createNodeAgentToolHandlers(config);

		const result = await handlers.read_gate({ gateId: 'gate-open' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.gateOpen).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests: send_message (gate-write)
// ---------------------------------------------------------------------------

describe('node-agent-tools: send_message (gate-write)', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
	});

	/** Build a workflow with a gated channel from coder → reviewer. */
	function makeWorkflowWithGatedChannel(gate: Gate): SpaceWorkflow {
		return {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [
				{
					id: ctx.nodeId,
					name: 'Coding',
					agents: [{ agentId: 'agent-coder', name: 'coder' }],
				},
				{
					id: 'node-review',
					name: 'Review',
					agents: [{ agentId: 'agent-reviewer', name: 'reviewer' }],
				},
			],
			startNodeId: ctx.nodeId,
			rules: [],
			tags: [],
			channels: [{ id: 'ch-coder-reviewer', from: 'coder', to: 'reviewer', gateId: gate.id }],
			gates: [gate],
		};
	}

	test('gate-write occurs and gateWrite returned in response when data provided on gated channel', async () => {
		const gate: Gate = {
			id: 'gate-writable',
			fields: [{ name: 'x', type: 'string', writers: ['coder'], check: { op: 'exists' } }],
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGatedChannel(gate);
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);

		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { x: 'val' },
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.gateWrite).toBeDefined();
		expect(data.gateWrite.gateId).toBe('gate-writable');
		expect(data.gateWrite.gateOpen).toBe(true);
	});

	test('gate-write authorizes fields whose writers reference the current node name', async () => {
		const gate: Gate = {
			id: 'gate-node-writer',
			fields: [{ name: 'pr_url', type: 'string', writers: ['Coding'], check: { op: 'exists' } }],
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGatedChannel(gate);
		const gateDataRepo = new GateDataRepository(ctx.db);
		const config = makeConfig(ctx, { workflow, gateDataRepo });
		const handlers = createNodeAgentToolHandlers(config);

		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'ready',
			data: { pr_url: 'https://github.com/test/repo/pull/42' },
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.gateWrite).toEqual({ gateId: 'gate-node-writer', gateOpen: true });
		expect(gateDataRepo.get(ctx.workflowRunId, 'gate-node-writer')?.data.pr_url).toBe(
			'https://github.com/test/repo/pull/42'
		);
	});

	test('no gateWrite in response when data not provided', async () => {
		const gate: Gate = {
			id: 'gate-no-data',
			fields: [{ name: 'x', type: 'string', writers: ['coder'], check: { op: 'exists' } }],
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGatedChannel(gate);
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);

		const result = await handlers.send_message({ target: 'reviewer', message: 'hi' });
		const data = JSON.parse(result.content[0].text);

		expect(data.gateWrite).toBeUndefined();
	});

	test('no gateWrite when channel has no gateId', async () => {
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [{ id: 'ch-open', from: 'coder', to: 'reviewer' }],
			gates: [],
		};
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);

		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { x: 1 },
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.gateWrite).toBeUndefined();
	});

	test('only authorized fields are merged into gate', async () => {
		const gate: Gate = {
			id: 'gate-auth',
			fields: [
				{ name: 'approved', type: 'string', writers: ['coder'], check: { op: 'exists' } },
				{ name: 'score', type: 'string', writers: ['reviewer'], check: { op: 'exists' } },
			],
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGatedChannel(gate);
		const gateDataRepo = new GateDataRepository(ctx.db);
		const config = makeConfig(ctx, { workflow, gateDataRepo });
		const handlers = createNodeAgentToolHandlers(config);

		// coder can write 'approved' but not 'score'
		await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { approved: 'yes', score: '10' },
		});

		const record = gateDataRepo.get(ctx.workflowRunId, 'gate-auth');
		expect(record?.data.approved).toBe('yes');
		expect(record?.data.score).toBeUndefined();
	});

	test('gate is closed when only partial conditions met', async () => {
		const gate: Gate = {
			id: 'gate-partial',
			fields: [
				{ name: 'a', type: 'string', writers: ['coder'], check: { op: 'exists' } },
				{ name: 'b', type: 'string', writers: ['coder'], check: { op: 'exists' } },
			],
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGatedChannel(gate);
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);

		// Only provide 'a', missing 'b'
		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { a: '1' },
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.gateWrite.gateOpen).toBe(false);
	});

	test('gate opens once all conditions satisfied across multiple sends', async () => {
		const gate: Gate = {
			id: 'gate-accumulate',
			fields: [
				{ name: 'x', type: 'string', writers: ['coder'], check: { op: 'exists' } },
				{ name: 'y', type: 'string', writers: ['coder'], check: { op: 'exists' } },
			],
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGatedChannel(gate);
		const gateDataRepo = new GateDataRepository(ctx.db);
		const config = makeConfig(ctx, { workflow, gateDataRepo });
		const handlers = createNodeAgentToolHandlers(config);

		// First send: x only — gate still closed
		const r1 = await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { x: 'val1' },
		});
		expect(JSON.parse(r1.content[0].text).gateWrite.gateOpen).toBe(false);

		// Second send: y — gate now opens (both x and y satisfied)
		const r2 = await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { y: 'val2' },
		});
		expect(JSON.parse(r2.content[0].text).gateWrite.gateOpen).toBe(true);

		const record = gateDataRepo.get(ctx.workflowRunId, 'gate-accumulate');
		expect(record?.data.x).toBe('val1');
		expect(record?.data.y).toBe('val2');
	});

	test('map-type field deep-merges entries from multiple writers (vote-counting)', async () => {
		// Simulates plan-approval-gate: multiple reviewers each write a partial
		// `approvals` map keyed by their lens. A shallow merge would replace the
		// whole map with the latest writer's entry, losing prior votes. Deep
		// merge of map-type fields must preserve all entries.
		const gate: Gate = {
			id: 'gate-votes',
			fields: [
				{
					name: 'approvals',
					type: 'map',
					writers: ['*'],
					check: { op: 'count', match: 'approved', min: 2 },
				},
			],
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGatedChannel(gate);
		const gateDataRepo = new GateDataRepository(ctx.db);
		const config = makeConfig(ctx, { workflow, gateDataRepo });
		const handlers = createNodeAgentToolHandlers(config);

		// First write (lens "architecture")
		const r1 = await handlers.send_message({
			target: 'reviewer',
			message: 'lens=architecture',
			data: { approvals: { architecture: 'approved' } },
		});
		expect(JSON.parse(r1.content[0].text).gateWrite.gateOpen).toBe(false);

		// Second write (lens "security") — must NOT overwrite the first vote.
		// The auto-gate-write deep-merges map-type fields keyed by writer lens.
		const r2 = await handlers.send_message({
			target: 'reviewer',
			message: 'lens=security',
			data: { approvals: { security: 'approved' } },
		});
		expect(JSON.parse(r2.content[0].text).gateWrite.gateOpen).toBe(true);

		const record = gateDataRepo.get(ctx.workflowRunId, 'gate-votes');
		expect(record?.data.approvals).toEqual({
			architecture: 'approved',
			security: 'approved',
		});
	});

	test('onGateDataChanged fires after successful gated delivery via send_message', async () => {
		const gate: Gate = {
			id: 'gate-callback',
			fields: [{ name: 'ready', type: 'string', writers: ['*'], check: { op: 'exists' } }],
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGatedChannel(gate);
		const calls: Array<{ runId: string; gateId: string }> = [];
		const config = makeConfig(ctx, {
			workflow,
			channelResolver: makeResolver(workflow.channels ?? []),
			onGateDataChanged: async (runId, gateId) => {
				calls.push({ runId, gateId });
			},
		});
		const handlers = createNodeAgentToolHandlers(config);

		await handlers.send_message({ target: 'reviewer', message: 'hi', data: { ready: true } });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(calls).toHaveLength(1);
		expect(calls[0].runId).toBe(ctx.workflowRunId);
		expect(calls[0].gateId).toBe('gate-callback');
	});

	test('onGateDataChanged fires after queued-only gated delivery via send_message', async () => {
		const gate: Gate = {
			id: 'gate-queued-callback',
			fields: [{ name: 'ready', type: 'string', writers: ['*'], check: { op: 'exists' } }],
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGatedChannel(gate);
		const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
		const agentMessageRouter = new AgentMessageRouter({
			nodeExecutionRepo: ctx.nodeExecutionRepo,
			workflowRunId: ctx.workflowRunId,
			workflowChannels: workflow.channels ?? [],
			messageInjector: async () => {
				throw new Error('Should not be called — reviewer has no live session');
			},
			pendingMessageRepo,
			spaceId: ctx.spaceId,
			taskId: null,
		});
		const calls: Array<{ runId: string; gateId: string }> = [];
		const config = makeConfig(ctx, {
			workflow,
			channelResolver: makeResolver(workflow.channels ?? []),
			agentMessageRouter,
			onGateDataChanged: async (runId, gateId) => {
				calls.push({ runId, gateId });
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const reviewerExecution = ctx.nodeExecutionRepo
			.listByWorkflowRun(ctx.workflowRunId)
			.find((execution) => execution.agentName === 'reviewer')!;
		ctx.nodeExecutionRepo.update(reviewerExecution.id, { agentSessionId: null });

		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'queued but gate data changed',
			data: { ready: true },
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.queued).toHaveLength(1);
		expect(calls).toEqual([{ runId: ctx.workflowRunId, gateId: 'gate-queued-callback' }]);
		expect(pendingMessageRepo.listPendingForTarget(ctx.workflowRunId, 'reviewer')).toHaveLength(1);
	});

	test('onGateDataChanged fires after failed gated delivery via send_message', async () => {
		const gate: Gate = {
			id: 'gate-failed-callback',
			fields: [{ name: 'ready', type: 'string', writers: ['*'], check: { op: 'exists' } }],
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGatedChannel(gate);
		const agentMessageRouter = new AgentMessageRouter({
			nodeExecutionRepo: ctx.nodeExecutionRepo,
			workflowRunId: ctx.workflowRunId,
			workflowChannels: workflow.channels ?? [],
			messageInjector: async () => {
				throw new Error('transport unavailable');
			},
		});
		const calls: Array<{ runId: string; gateId: string }> = [];
		const config = makeConfig(ctx, {
			workflow,
			channelResolver: makeResolver(workflow.channels ?? []),
			agentMessageRouter,
			onGateDataChanged: async (runId, gateId) => {
				calls.push({ runId, gateId });
			},
		});
		const handlers = createNodeAgentToolHandlers(config);

		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'fails but gate data changed',
			data: { ready: true },
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.failed).toHaveLength(1);
		expect(parsed.queued).toBeUndefined();
		expect(calls).toEqual([{ runId: ctx.workflowRunId, gateId: 'gate-failed-callback' }]);
	});

	test('does not notify gate data changed before the current gated delivery finishes', async () => {
		const gate: Gate = {
			id: 'review-posted-gate',
			fields: [
				{ name: 'pr_url', type: 'string', writers: ['Review'], check: { op: 'exists' } },
				{ name: 'review_url', type: 'string', writers: ['Review'], check: { op: 'exists' } },
			],
			resetOnCycle: true,
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-review-posted-race',
			spaceId: ctx.spaceId,
			name: 'Review Posted Race Workflow',
			description: '',
			nodes: [
				{
					id: ctx.nodeId,
					name: 'Review',
					agents: [{ agentId: 'agent-reviewer', name: 'reviewer' }],
				},
				{
					id: 'node-coding',
					name: 'Coding',
					agents: [{ agentId: 'agent-coder', name: 'coder' }],
				},
			],
			startNodeId: ctx.nodeId,
			rules: [],
			tags: [],
			channels: [{ id: 'ch-review-coding', from: 'Review', to: 'Coding', gateId: gate.id }],
			gates: [gate],
		};
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			ctx.workflowRunId,
			'node-coding',
			'coder',
			'in_progress',
			null,
			ctx.coderSessionId
		);
		const gateDataRepo = new GateDataRepository(ctx.db);
		const gateSnapshotsDuringDelivery: Array<Record<string, unknown> | undefined> = [];
		const agentMessageRouter = new AgentMessageRouter({
			nodeExecutionRepo: ctx.nodeExecutionRepo,
			workflowRunId: ctx.workflowRunId,
			workflowChannels: workflow.channels ?? [],
			nodeGroups: { Review: ['reviewer'], Coding: ['coder'] },
			messageInjector: async () => {
				gateSnapshotsDuringDelivery.push(gateDataRepo.get(ctx.workflowRunId, gate.id)?.data);
			},
		});
		const notifications: string[] = [];
		const config = makeConfig(ctx, {
			workflow,
			channelResolver: makeResolver(workflow.channels ?? []),
			workflowNodeId: ctx.nodeId,
			myAgentName: 'reviewer',
			mySessionId: ctx.reviewerSessionId,
			gateDataRepo,
			agentMessageRouter,
			onGateDataChanged: async (_runId, gateId) => {
				notifications.push(gateId);
				gateDataRepo.reset(ctx.workflowRunId, gateId, {});
			},
		});
		const handlers = createNodeAgentToolHandlers(config);

		const result = await handlers.send_message({
			target: 'Coding',
			message: 'Changes requested',
			data: {
				pr_url: 'https://github.com/test/repo/pull/42',
				review_url: 'https://github.com/test/repo/pull/42#pullrequestreview-1',
			},
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed).toMatchObject({ success: true });
		expect(gateSnapshotsDuringDelivery).toEqual([
			{
				pr_url: 'https://github.com/test/repo/pull/42',
				review_url: 'https://github.com/test/repo/pull/42#pullrequestreview-1',
				approvalSource: 'agent',
			},
			{
				pr_url: 'https://github.com/test/repo/pull/42',
				review_url: 'https://github.com/test/repo/pull/42#pullrequestreview-1',
				approvalSource: 'agent',
			},
		]);
		expect(notifications).toEqual(['review-posted-gate']);
		expect(gateDataRepo.get(ctx.workflowRunId, gate.id)?.data).toEqual({});
	});

	test('internalEventBus publishes space.gateData.updated after gate-write via send_message', async () => {
		const gate: Gate = {
			id: 'gate-event',
			fields: [{ name: 'ready', type: 'string', writers: ['*'], check: { op: 'exists' } }],
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGatedChannel(gate);
		const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
		const fakeInternalEventBus = {
			publish: async (name: string, payload: unknown) => {
				emitted.push({ name, payload: payload as Record<string, unknown> });
				return { delivered: 0, failures: [] };
			},
			publishAsync: (name: string, payload: unknown) => {
				emitted.push({ name, payload: payload as Record<string, unknown> });
			},
		};
		const config = makeConfig(ctx, {
			workflow,
			internalEventBus: fakeInternalEventBus as unknown as InternalEventBus<DaemonInternalEventMap>,
		});
		const handlers = createNodeAgentToolHandlers(config);

		await handlers.send_message({ target: 'reviewer', message: 'hi', data: { ready: true } });
		await new Promise((resolve) => setTimeout(resolve, 0));

		const gateEvent = emitted.find((e) => e.name === 'space.gateData.updated');
		expect(gateEvent).toBeDefined();
		expect(gateEvent!.payload.gateId).toBe('gate-event');
	});

	test('gate-write resolves agent-name target to node-name channel (Coding -> Review)', async () => {
		// Regression test for GitHub issue #1842 / Task #321:
		// When channels use node names (e.g. 'Coding' -> 'Review') but the agent
		// sends to an agent name (e.g. 'reviewer'), the gate data write must still
		// find the correct channel and write pr_url to gate data. Previously the
		// channel match failed because it compared 'reviewer' against the channel
		// 'to' value 'Review', causing pr_url to never reach gate data and the
		// PR_READY_BASH_SCRIPT to fall back to current-branch lookup (creating
		// duplicate PRs in stacked-branch workflows).
		const gate: Gate = {
			id: 'review-posted-gate',
			fields: [{ name: 'pr_url', type: 'string', writers: ['coder'], check: { op: 'exists' } }],
			resetOnCycle: false,
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [
				{
					id: ctx.nodeId,
					name: 'Coding',
					agents: [{ agentId: 'agent-coder', name: 'coder' }],
				},
				{
					id: 'node-review',
					name: 'Review',
					agents: [{ agentId: 'agent-reviewer', name: 'reviewer' }],
				},
			],
			startNodeId: ctx.nodeId,
			rules: [],
			tags: [],
			// Channel uses node names, not agent names
			channels: [{ id: 'ch-coding-review', from: 'Coding', to: 'Review', gateId: gate.id }],
			gates: [gate],
		};
		const gateDataRepo = new GateDataRepository(ctx.db);
		const config = makeConfig(ctx, { workflow, gateDataRepo });
		const handlers = createNodeAgentToolHandlers(config);

		// Agent targets 'reviewer' (agent name) not 'Review' (node name)
		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'PR ready',
			data: { pr_url: 'https://github.com/test/repo/pull/42' },
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.gateWrite).toEqual({ gateId: 'review-posted-gate', gateOpen: true });
		expect(gateDataRepo.get(ctx.workflowRunId, 'review-posted-gate')?.data.pr_url).toBe(
			'https://github.com/test/repo/pull/42'
		);
	});
});

describe('node-agent-tools: list_reachable_agents', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
	});

	test('returns within-node peers excluding self and task-agent', async () => {
		const config = makeConfig(ctx);
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.myAgentName).toBe('coder');
		expect(data.withinNodePeers).toHaveLength(1);
		expect(data.withinNodePeers[0].agentName).toBe('reviewer');
		expect(data.withinNodePeers[0].status).toBe('active');
	});

	test('returns empty cross-node targets when no channels declared', async () => {
		const config = makeConfig(ctx);
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.reachabilityDeclared).toBe(false);
		expect(data.crossNodeTargets).toHaveLength(0);
		expect(data.spaceAgent).toEqual({
			target: 'space-agent',
			description: 'Space-level escalation target. Use to request human/space-level judgment.',
		});
		expect(data.message).toContain('space-agent escalation target');
	});

	test('returns cross-node targets for channels to roles not in current group', async () => {
		// 'tester' is not a member of the session group — cross-node target
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'tester')]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.reachabilityDeclared).toBe(true);
		expect(data.crossNodeTargets).toHaveLength(1);
		expect(data.crossNodeTargets[0].nodeName).toBe('tester');
		// isFanOut removed from cross-node targets (fan-out is determined by array 'to')
	});

	test('within-node peer with a channel does not appear in cross-node targets', async () => {
		// 'reviewer' is in the session group — stays in withinNodePeers, not crossNodeTargets
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.withinNodePeers).toHaveLength(1);
		expect(data.withinNodePeers[0].agentName).toBe('reviewer');
		expect(data.crossNodeTargets).toHaveLength(0);
	});

	test('gate type none when no gate on cross-node channel', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'tester')]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets[0].gate.type).toBe('none');
		expect(data.crossNodeTargets[0].gate.isGated).toBe(false);
	});

	test('gate type check: isGated true', async () => {
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			gates: [
				{
					id: 'approval-gate',
					fields: [
						{ name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
					],
					resetOnCycle: false,
				},
			],
		};
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				{ id: 'ch-1', from: 'coder', to: 'tester', gateId: 'approval-gate' },
			]),
			workflow,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets[0].gate.type).toBe('check');
		expect(data.crossNodeTargets[0].gate.isGated).toBe(true);
	});

	test('gate type count: isGated true', async () => {
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			gates: [
				{
					id: 'vote-gate',
					fields: [
						{
							name: 'votes',
							type: 'map',
							writers: ['*'],
							check: { op: 'count', match: 'approved', min: 2 },
						},
					],
					resetOnCycle: false,
				},
			],
		};
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				{ id: 'ch-1', from: 'coder', to: 'tester', gateId: 'vote-gate' },
			]),
			workflow,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets[0].gate.type).toBe('count');
		expect(data.crossNodeTargets[0].gate.isGated).toBe(true);
	});

	test('no gateId on channel: isGated false', async () => {
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
		};
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'tester')]),
			workflow,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets[0].gate.type).toBe('none');
		expect(data.crossNodeTargets[0].gate.isGated).toBe(false);
	});

	test('gate description propagated when present', async () => {
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			gates: [
				{
					id: 'lead-gate',
					description: 'Needs tech lead approval',
					fields: [
						{ name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
					],
					resetOnCycle: false,
				},
			],
		};
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				{ id: 'ch-1', from: 'coder', to: 'tester', gateId: 'lead-gate' },
			]),
			workflow,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets[0].gate.description).toBe('Needs tech lead approval');
	});

	test('fan-out target marked as isFanOut true', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('coder', 'qa-node', false, { isFanOut: true }),
			]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets).toHaveLength(1);
		expect(data.crossNodeTargets[0].nodeName).toBe('qa-node');
		// isFanOut removed - channel to[] array already indicates fan-out
	});

	test('deduplicates cross-node targets from multiple channels to same role', async () => {
		// Two channels to 'tester' (e.g. from bidirectional expansion) — should appear once
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('coder', 'tester'),
				makeResolvedChannel('coder', 'tester'), // duplicate
			]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets).toHaveLength(1);
	});

	test('only includes outgoing channels (fromRole matches myAgentName)', async () => {
		// Channel from 'tester' → 'coder' should NOT appear as a cross-node target for coder
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('tester', 'coder')]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Tests: external event subscriptions
// ---------------------------------------------------------------------------

describe('node-agent-tools: external event subscriptions', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
	});

	test('delegates subscribe_external_event and audits successful calls', async () => {
		const calls: Array<{ topicPattern: string; label?: string }> = [];
		const handlers = createNodeAgentToolHandlers(
			makeConfig(ctx, {
				onSubscribeExternalEvent: async (args) => {
					calls.push(args);
					return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
				},
				auditLogRepo: new McpAuditLogRepository(ctx.db),
			})
		);

		const result = await handlers.subscribe_external_event({
			topicPattern: 'github/*/*/pull_request.*',
			label: 'PR updates',
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(calls).toEqual([{ topicPattern: 'github/*/*/pull_request.*', label: 'PR updates' }]);

		const auditRepo = new McpAuditLogRepository(ctx.db);
		const entries = auditRepo
			.listBySession(ctx.coderSessionId)
			.filter((entry) => entry.toolName === 'subscribe_external_event');
		expect(entries).toHaveLength(1);
		expect(entries[0].paramsSummary).toBe(
			JSON.stringify({ topicPattern: 'github/*/*/pull_request.*', label: 'PR updates' })
		);
	});

	test('delegates unsubscribe_external_event', async () => {
		const calls: string[] = [];
		const handlers = createNodeAgentToolHandlers(
			makeConfig(ctx, {
				onUnsubscribeExternalEvent: async (args) => {
					calls.push(args.topicPattern);
					return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
				},
			})
		);

		const result = await handlers.unsubscribe_external_event({
			topicPattern: 'github/*/*/pull_request.*',
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(calls).toEqual(['github/*/*/pull_request.*']);
	});

	test('returns unavailable when subscription callbacks are not wired', async () => {
		const handlers = createNodeAgentToolHandlers(makeConfig(ctx));

		const result = await handlers.subscribe_external_event({
			topicPattern: 'github/*/*/pull_request.*',
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('not available');
	});

	test('createNodeAgentMcpServer registers external event tools only when callbacks are wired', () => {
		const withoutCallback = createNodeAgentMcpServer(makeConfig(ctx));
		const withoutRegistered = Object.keys(
			(withoutCallback as unknown as { instance: { _registeredTools: Record<string, unknown> } })
				.instance._registeredTools
		);
		expect(withoutRegistered).not.toContain('subscribe_external_event');
		expect(withoutRegistered).not.toContain('unsubscribe_external_event');

		const withCallback = createNodeAgentMcpServer(
			makeConfig(ctx, {
				onSubscribeExternalEvent: async () => ({
					content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
				}),
				onUnsubscribeExternalEvent: async () => ({
					content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
				}),
			})
		);
		const withRegistered = Object.keys(
			(withCallback as unknown as { instance: { _registeredTools: Record<string, unknown> } })
				.instance._registeredTools
		);
		expect(withRegistered).toContain('subscribe_external_event');
		expect(withRegistered).toContain('unsubscribe_external_event');
	});
});

// ---------------------------------------------------------------------------
// Tests: createNodeAgentMcpServer (factory)
// ---------------------------------------------------------------------------

describe('node-agent-tools: createNodeAgentMcpServer', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
	});

	test('creates an MCP server with expected tools', () => {
		const config = makeConfig(ctx);
		const server = createNodeAgentMcpServer(config);

		// Server should be an object with a server property (MCP SDK server)
		expect(server).toBeDefined();
		expect(typeof server).toBe('object');
	});
});

describe('node-agent-tools: system prompt uses only visible prompt text', () => {
	test('buildCustomAgentSystemPrompt returns configured text only', async () => {
		const { buildCustomAgentSystemPrompt } = await import(
			'../../../../src/lib/space/agents/custom-agent.ts'
		);

		const prompt = buildCustomAgentSystemPrompt({
			id: 'agent-1',
			spaceId: 'space-1',
			name: 'Coder',
			customPrompt: 'Visible workflow prompt',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		expect(prompt).toBe('Visible workflow prompt');
	});
});

// ---------------------------------------------------------------------------
// Tests: list_peers — completion state
// ---------------------------------------------------------------------------

describe('list_peers — completion state', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
	});

	test('list_peers includes completionState for each peer based on space_tasks', async () => {
		const workflowNodeId = 'node-abc';
		const workflowRunId = 'run-test-abc';

		seedSpaceWorkflowRunRow(ctx.db, workflowRunId, ctx.spaceId, 'wf-seed');

		// Seed a completed task for the reviewer peer
		// space_tasks uses 'done'; toNodeExecutionStatus maps it to 'idle' for node_executions
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			workflowRunId,
			workflowNodeId,
			'reviewer',
			'done',
			'All looks good!'
		);

		const config = makeConfig(ctx, {
			workflowRunId,
			workflowNodeId,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		const reviewerPeer = data.peers.find((p: { agentName: string }) => p.agentName === 'reviewer');
		expect(reviewerPeer).toBeDefined();
		expect(reviewerPeer.completionState).not.toBeNull();
		expect(reviewerPeer.completionState.taskStatus).toBe('idle');
		expect(reviewerPeer.completionState.completionSummary).toBe('All looks good!');
		expect(reviewerPeer.completionState.agentName).toBe('reviewer');
	});

	test('list_peers shows nodeCompletionState for all tasks on the node', async () => {
		const workflowNodeId = 'node-xyz';
		const workflowRunId = 'run-test-xyz';

		seedSpaceWorkflowRunRow(ctx.db, workflowRunId, ctx.spaceId, 'wf-seed');

		// Seed tasks for both coder and reviewer on the same node
		seedSpaceTask(ctx.db, ctx.spaceId, workflowRunId, workflowNodeId, 'coder', 'in_progress', null);
		// space_tasks uses 'done'; toNodeExecutionStatus maps it to 'idle' for node_executions
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			workflowRunId,
			workflowNodeId,
			'reviewer',
			'done',
			'Review done'
		);

		const config = makeConfig(ctx, {
			workflowRunId,
			workflowNodeId,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(Array.isArray(data.nodeCompletionState)).toBe(true);
		expect(data.nodeCompletionState).toHaveLength(2);

		const coderState = data.nodeCompletionState.find(
			(s: { agentName: string }) => s.agentName === 'coder'
		);
		expect(coderState).toBeDefined();
		expect(coderState.taskStatus).toBe('in_progress');

		const reviewerState = data.nodeCompletionState.find(
			(s: { agentName: string }) => s.agentName === 'reviewer'
		);
		expect(reviewerState).toBeDefined();
		expect(reviewerState.taskStatus).toBe('idle');
		expect(reviewerState.completionSummary).toBe('Review done');
	});

	test('list_peers works without space_tasks (no tasks on node)', async () => {
		const workflowNodeId = 'node-empty';
		const workflowRunId = 'run-test-empty';

		// No tasks seeded for this node
		const config = makeConfig(ctx, {
			workflowRunId,
			workflowNodeId,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.nodeCompletionState).toHaveLength(0);
		// All peers should have null completionState
		for (const peer of data.peers) {
			expect(peer.completionState).toBeNull();
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: async gate evaluation (scriptExecutor + scriptContext)
// ---------------------------------------------------------------------------

describe('node-agent-tools: async gate evaluation', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
	});

	/**
	 * Build a workflow with a gated channel from coder → reviewer.
	 * Used by tests that drive gate-write via send_message.
	 */
	function makeWorkflowWithGate(gate: Gate, spaceId: string): SpaceWorkflow {
		return {
			id: 'wf-1',
			spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [{ id: 'ch-coder-reviewer', from: 'coder', to: 'reviewer', gateId: gate.id }],
			gates: [gate],
		};
	}

	test('send_message gate-write uses scriptExecutor when provided (script passes)', async () => {
		const gate: Gate = {
			id: 'gate-script-pass',
			fields: [
				{ name: 'ready', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
			],
			script: {
				interpreter: 'bash',
				source: 'echo "ok"',
			},
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGate(gate, ctx.spaceId);

		// Script executor that returns success with merged data
		const mockExecutor = async () => ({
			success: true,
			data: { ready: true },
			error: undefined,
		});

		const config = makeConfig(ctx, {
			workflow,
			scriptExecutor: mockExecutor,
			scriptContext: {
				workspacePath: '/tmp',
				runId: ctx.workflowRunId,
				gateId: 'gate-script-pass',
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { ready: true },
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.gateWrite).toBeDefined();
		expect(data.gateWrite.gateOpen).toBe(true);
	});

	test('send_message gate-write uses scriptExecutor when provided (script fails)', async () => {
		const gate: Gate = {
			id: 'gate-script-fail',
			fields: [{ name: 'x', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
			script: {
				interpreter: 'bash',
				source: 'exit 1',
			},
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGate(gate, ctx.spaceId);

		const mockExecutor = async () => ({
			success: false,
			data: {},
			error: 'Script check failed: exit code 1',
		});

		const config = makeConfig(ctx, {
			workflow,
			scriptExecutor: mockExecutor,
			scriptContext: {
				workspacePath: '/tmp',
				runId: ctx.workflowRunId,
				gateId: 'gate-script-fail',
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { x: true },
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.gateWrite).toBeDefined();
		expect(data.gateWrite.gateOpen).toBe(false);
	});

	test('send_message gate-write emits space.gateData.updated when script fails', async () => {
		const gate: Gate = {
			id: 'gate-event',
			fields: [{ name: 'x', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
			script: {
				interpreter: 'bash',
				source: 'exit 1',
			},
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGate(gate, ctx.spaceId);

		const mockExecutor = async () => ({
			success: false,
			data: {},
			error: 'Script failed',
		});

		const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
		const fakeInternalEventBus = {
			publish: async (name: string, payload: unknown) => {
				emitted.push({ name, payload: payload as Record<string, unknown> });
				return { delivered: 0, failures: [] };
			},
			publishAsync: (name: string, payload: unknown) => {
				emitted.push({ name, payload: payload as Record<string, unknown> });
			},
		};

		const config = makeConfig(ctx, {
			workflow,
			scriptExecutor: mockExecutor,
			scriptContext: { workspacePath: '/tmp', runId: ctx.workflowRunId, gateId: 'gate-event' },
			internalEventBus: fakeInternalEventBus as unknown as InternalEventBus<DaemonInternalEventMap>,
		});
		const handlers = createNodeAgentToolHandlers(config);
		await handlers.send_message({ target: 'reviewer', message: 'hi', data: { x: true } });

		// Allow microtasks to flush
		await new Promise((resolve) => setTimeout(resolve, 0));

		const gateEvent = emitted.find((e) => e.name === 'space.gateData.updated');
		expect(gateEvent).toBeDefined();
		expect(gateEvent!.payload.gateId).toBe('gate-event');
	});

	test('read_gate uses scriptExecutor when provided', async () => {
		const gate: Gate = {
			id: 'gate-read-script',
			fields: [],
			script: {
				interpreter: 'bash',
				source: 'exit 1',
			},
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGate(gate, ctx.spaceId);

		const mockExecutor = async () => ({
			success: false,
			data: {},
			error: 'Script failed',
		});

		const config = makeConfig(ctx, {
			workflow,
			scriptExecutor: mockExecutor,
			scriptContext: {
				workspacePath: '/tmp',
				runId: ctx.workflowRunId,
				gateId: 'gate-read-script',
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.read_gate({ gateId: 'gate-read-script' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.gateOpen).toBe(false);
		expect(data.reason).toContain('Script check failed');
	});

	test('read_gate without scriptExecutor reports script-only gate as open', async () => {
		const gate: Gate = {
			id: 'gate-read-no-exec',
			fields: [],
			script: {
				interpreter: 'bash',
				source: 'echo "should not run"',
			},
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGate(gate, ctx.spaceId);

		// No scriptExecutor provided — script-only gates report as open (documented limitation)
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.read_gate({ gateId: 'gate-read-no-exec' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.gateOpen).toBe(true);
	});

	test('send_message gate-write without scriptExecutor skips script check and opens gate on field pass', async () => {
		const gate: Gate = {
			id: 'gate-write-no-exec',
			fields: [{ name: 'x', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
			script: {
				interpreter: 'bash',
				source: 'echo "should not run"',
			},
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGate(gate, ctx.spaceId);

		// No scriptExecutor provided — script check is skipped, field check alone opens gate
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { x: true },
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.gateWrite).toBeDefined();
		expect(data.gateWrite.gateOpen).toBe(true);
	});

	test('scriptExecutor receives correct context with gateId via send_message', async () => {
		const gate: Gate = {
			id: 'gate-context-check',
			fields: [
				{ name: 'ready', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
			],
			script: {
				interpreter: 'bash',
				source: 'echo "ok"',
			},
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGate(gate, ctx.spaceId);

		let receivedContext: { workspacePath: string; runId: string; gateId: string } | null = null;
		const mockExecutor = async (
			_script: import('@neokai/shared').GateScript,
			context: { workspacePath: string; runId: string; gateId: string }
		) => {
			receivedContext = context;
			return { success: true, data: { ready: true }, error: undefined };
		};

		const config = makeConfig(ctx, {
			workflow,
			scriptExecutor: mockExecutor,
			scriptContext: { workspacePath: '/my-workspace', runId: 'run-123', gateId: '' },
		});
		const handlers = createNodeAgentToolHandlers(config);
		await handlers.send_message({ target: 'reviewer', message: 'hi', data: { ready: true } });

		expect(receivedContext).not.toBeNull();
		expect(receivedContext!.workspacePath).toBe('/my-workspace');
		expect(receivedContext!.runId).toBe('run-123');
		// gateId should be overridden per-gate inside the send_message handler
		expect(receivedContext!.gateId).toBe('gate-context-check');
	});

	test('send_message with script-only gated channel does not perform gate-write (no declared fields)', async () => {
		// Script-only gates have no declared fields, so all data keys are filtered out
		// at the field authorization layer — authorizedData stays empty, gate-write is skipped.
		const gate: Gate = {
			id: 'gate-script-only-no-write',
			script: {
				interpreter: 'bash',
				source: 'echo "ok"',
			},
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGate(gate, ctx.spaceId);

		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { anyKey: 'val' },
		});
		const data = JSON.parse(result.content[0].text);

		// Gate-write is silently skipped — no gateWrite field in response
		expect(data.gateWrite).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Tests: create_standalone_task
// ---------------------------------------------------------------------------

describe('node-agent-tools: create_standalone_task', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
	});

	test('delegates to onCreateStandaloneTask and returns the created task', async () => {
		const config = makeConfig(ctx, {
			onCreateStandaloneTask: async (args) => {
				const task = await ctx.taskManager.createTask({
					title: args.title,
					description: args.description,
					priority: args.priority,
					preferredWorkflowId: args.workflow_id ?? null,
					dependsOn: args.depends_on,
				});
				return {
					content: [{ type: 'text', text: JSON.stringify({ success: true, task }) }],
				};
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.create_standalone_task({
			title: 'Follow-up task',
			description: 'Do the follow-up work',
			priority: 'high',
			workflow_id: 'wf-follow-up',
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.task.title).toBe('Follow-up task');
		expect(data.task.priority).toBe('high');
		expect(data.task.preferredWorkflowId).toBe('wf-follow-up');
	});

	test('returns a clear error when callback is not wired', async () => {
		const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
		const result = await handlers.create_standalone_task({
			title: 'Follow-up task',
			description: 'Do the follow-up work',
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('not available');
	});

	test('createNodeAgentMcpServer registers create_standalone_task only when callback is wired', () => {
		const withoutCallback = createNodeAgentMcpServer(makeConfig(ctx));
		const withoutRegistered = Object.keys(
			(withoutCallback as unknown as { instance: { _registeredTools: Record<string, unknown> } })
				.instance._registeredTools
		);
		expect(withoutRegistered).not.toContain('create_standalone_task');

		const withCallback = createNodeAgentMcpServer(
			makeConfig(ctx, {
				onCreateStandaloneTask: async () => ({
					content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
				}),
			})
		);
		const withRegistered = Object.keys(
			(withCallback as unknown as { instance: { _registeredTools: Record<string, unknown> } })
				.instance._registeredTools
		);
		expect(withRegistered).toContain('create_standalone_task');
	});
});

// ---------------------------------------------------------------------------
// Tests: restore_node_agent (self-heal primitive)
// ---------------------------------------------------------------------------

describe('node-agent-tools: restore_node_agent', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
	});

	test('returns success with session/agent identity even without onRestoreNodeAgent callback', async () => {
		const config = makeConfig(ctx);
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.restore_node_agent({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.sessionId).toBe(ctx.coderSessionId);
		expect(data.agentName).toBe('coder');
		expect(typeof data.message).toBe('string');
		expect(data.message).toContain('node-agent MCP server is registered');
	});

	test('invokes onRestoreNodeAgent callback with the supplied reason', async () => {
		const captured: Array<{ reason?: string }> = [];
		const config = makeConfig(ctx, {
			onRestoreNodeAgent: (args) => {
				captured.push(args);
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		await handlers.restore_node_agent({ reason: 'previous send_message returned No such tool' });

		expect(captured).toHaveLength(1);
		expect(captured[0]!.reason).toBe('previous send_message returned No such tool');
	});

	test('still returns success when the onRestoreNodeAgent callback throws', async () => {
		const config = makeConfig(ctx, {
			onRestoreNodeAgent: () => {
				throw new Error('reattach failed');
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.restore_node_agent({ reason: 'diagnostic' });
		const data = JSON.parse(result.content[0].text);

		// The tool MUST report success — calling it at all proves node-agent is registered.
		// Server-side reattach failures are logged but must not block the agent's recovery flow.
		expect(data.success).toBe(true);
		expect(data.sessionId).toBe(ctx.coderSessionId);
	});

	test('awaits async onRestoreNodeAgent callback before returning', async () => {
		let resolved = false;
		const config = makeConfig(ctx, {
			onRestoreNodeAgent: async () => {
				await new Promise((r) => setTimeout(r, 10));
				resolved = true;
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		await handlers.restore_node_agent({});

		expect(resolved).toBe(true);
	});

	test('createNodeAgentMcpServer registers restore_node_agent tool', () => {
		const config = makeConfig(ctx);
		const server = createNodeAgentMcpServer(config);
		const registered = Object.keys(
			(server as unknown as { instance: { _registeredTools: Record<string, unknown> } }).instance
				._registeredTools
		);
		expect(registered).toContain('restore_node_agent');
	});
});

// ---------------------------------------------------------------------------
// Tests: send_message (review-posted-gate artifact append)
// ---------------------------------------------------------------------------

describe('node-agent-tools: review-posted-gate multi-round artifact history', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
	});

	/**
	 * Build a workflow with a single Review → Coding channel gated by the
	 * production review-posted-gate definition. The sender is the reviewer,
	 * matching the real coding workflow layout.
	 */
	function makeReviewPostedWorkflow(): SpaceWorkflow {
		const gate: Gate = {
			id: 'review-posted-gate',
			fields: [
				{ name: 'review_url', type: 'string', writers: ['reviewer'], check: { op: 'exists' } },
			],
			resetOnCycle: true,
		};
		return {
			id: 'wf-review-posted',
			spaceId: ctx.spaceId,
			name: 'Test Coding Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [
				{ id: 'ch-review-coder', from: 'reviewer', to: 'coder', gateId: 'review-posted-gate' },
			],
			gates: [gate],
		};
	}

	test('appends one review artifact per cycle with cycle 0, 1, 2 across 3 rounds', async () => {
		const { WorkflowRunArtifactRepository } = await import(
			'../../../../src/storage/repositories/workflow-run-artifact-repository.ts'
		);
		const artifactRepo = new WorkflowRunArtifactRepository(ctx.db);

		const workflow = makeReviewPostedWorkflow();
		const config = makeConfig(ctx, {
			workflow,
			myAgentName: 'reviewer',
			mySessionId: ctx.reviewerSessionId,
			artifactRepo,
		});
		const handlers = createNodeAgentToolHandlers(config);

		// Round 1
		const r1 = await handlers.send_message({
			target: 'coder',
			message: 'Round 1 — please fix retry logic',
			data: {
				review_url: 'https://github.com/acme/app/pull/42#pullrequestreview-1',
				comment_urls: ['https://github.com/acme/app/pull/42#discussion_r1001'],
			},
		});
		expect(JSON.parse(r1.content[0].text).gateWrite.gateOpen).toBe(true);

		// Round 2
		const r2 = await handlers.send_message({
			target: 'coder',
			message: 'Round 2 — edge case still broken',
			data: {
				review_url: 'https://github.com/acme/app/pull/42#pullrequestreview-2',
				comment_urls: [
					'https://github.com/acme/app/pull/42#discussion_r1002',
					'https://github.com/acme/app/pull/42#discussion_r1003',
				],
			},
		});
		expect(JSON.parse(r2.content[0].text).gateWrite.gateOpen).toBe(true);

		// Round 3
		const r3 = await handlers.send_message({
			target: 'coder',
			message: 'Round 3 — tests missing',
			data: {
				review_url: 'https://github.com/acme/app/pull/42#pullrequestreview-3',
				comment_urls: [],
			},
		});
		expect(JSON.parse(r3.content[0].text).gateWrite.gateOpen).toBe(true);

		const artifacts = artifactRepo.listByRun(ctx.workflowRunId, { artifactType: 'review' });
		expect(artifacts).toHaveLength(3);

		// Artifacts are ordered by createdAt ascending. Cycle numbers must be 0,1,2.
		const cycles = artifacts.map((a) => a.data.cycle);
		expect(cycles).toEqual([0, 1, 2]);

		// Each artifact carries review_url and comment_urls from its round.
		expect(artifacts[0].data.review_url).toBe(
			'https://github.com/acme/app/pull/42#pullrequestreview-1'
		);
		expect(artifacts[0].data.comment_urls).toEqual([
			'https://github.com/acme/app/pull/42#discussion_r1001',
		]);
		expect(artifacts[1].data.review_url).toBe(
			'https://github.com/acme/app/pull/42#pullrequestreview-2'
		);
		expect(artifacts[1].data.comment_urls as string[]).toHaveLength(2);
		expect(artifacts[2].data.review_url).toBe(
			'https://github.com/acme/app/pull/42#pullrequestreview-3'
		);
		expect(artifacts[2].data.comment_urls).toEqual([]);

		// submittedAt is an ISO8601 string set at write time.
		for (const a of artifacts) {
			expect(typeof a.data.submittedAt).toBe('string');
			expect(() => new Date(a.data.submittedAt as string).toISOString()).not.toThrow();
		}

		// Each artifact must have a unique artifactKey so upsert doesn't collapse rounds.
		const keys = artifacts.map((a) => a.artifactKey);
		expect(new Set(keys).size).toBe(3);
		expect(keys).toEqual(['cycle-0', 'cycle-1', 'cycle-2']);
	});

	test('skips artifact append when review_url is absent from gate data', async () => {
		const { WorkflowRunArtifactRepository } = await import(
			'../../../../src/storage/repositories/workflow-run-artifact-repository.ts'
		);
		const artifactRepo = new WorkflowRunArtifactRepository(ctx.db);

		// Use a gate where the reviewer can send data, but we omit review_url.
		const gate: Gate = {
			id: 'review-posted-gate',
			fields: [
				{ name: 'review_url', type: 'string', writers: ['reviewer'], check: { op: 'exists' } },
				{ name: 'other', type: 'string', writers: ['reviewer'], check: { op: 'exists' } },
			],
			resetOnCycle: true,
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-no-url',
			spaceId: ctx.spaceId,
			name: 'Test',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [
				{ id: 'ch-review-coder', from: 'reviewer', to: 'coder', gateId: 'review-posted-gate' },
			],
			gates: [gate],
		};

		const config = makeConfig(ctx, {
			workflow,
			myAgentName: 'reviewer',
			mySessionId: ctx.reviewerSessionId,
			artifactRepo,
		});
		const handlers = createNodeAgentToolHandlers(config);

		// Write to gate but with only `other`, no `review_url`.
		await handlers.send_message({
			target: 'coder',
			message: 'hi',
			data: { other: 'value' },
		});

		// No artifact should have been appended because the review_url field is absent.
		const artifacts = artifactRepo.listByRun(ctx.workflowRunId, { artifactType: 'review' });
		expect(artifacts).toHaveLength(0);
	});

	test('skips artifact append for non-review-posted-gate gates (no false positives)', async () => {
		const { WorkflowRunArtifactRepository } = await import(
			'../../../../src/storage/repositories/workflow-run-artifact-repository.ts'
		);
		const artifactRepo = new WorkflowRunArtifactRepository(ctx.db);

		// Different gate id — the append block is gated on id === 'review-posted-gate'.
		const gate: Gate = {
			id: 'some-other-gate',
			fields: [
				{ name: 'review_url', type: 'string', writers: ['reviewer'], check: { op: 'exists' } },
			],
			resetOnCycle: false,
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-other',
			spaceId: ctx.spaceId,
			name: 'Test',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [
				{ id: 'ch-review-coder', from: 'reviewer', to: 'coder', gateId: 'some-other-gate' },
			],
			gates: [gate],
		};

		const config = makeConfig(ctx, {
			workflow,
			myAgentName: 'reviewer',
			mySessionId: ctx.reviewerSessionId,
			artifactRepo,
		});
		const handlers = createNodeAgentToolHandlers(config);

		await handlers.send_message({
			target: 'coder',
			message: 'hi',
			data: { review_url: 'https://example.com/pr/1#review-1' },
		});

		const artifacts = artifactRepo.listByRun(ctx.workflowRunId, { artifactType: 'review' });
		expect(artifacts).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Tests: list_peers — cross-node peer discovery (Bug #1 fix)
// ---------------------------------------------------------------------------

describe('node-agent-tools: list_peers — cross-node peer discovery', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
	});

	test('shows cross-node peer as not_started when node has not been activated yet', async () => {
		// Workflow: Coding node (coder) → Review node (reviewer).
		// Coder is active; Review node hasn't been activated yet (no execution record).
		// After the fix: list_peers should include the reviewer with taskStatus: "not_started"
		// so the coder knows to send_message to activate it.
		const reviewNodeId = 'node-review';
		const codingNodeId = ctx.nodeId; // the node coder is running on

		// Workflow definition with two nodes and a channel
		const workflow: SpaceWorkflow = {
			id: 'wf-cross-node',
			spaceId: ctx.spaceId,
			name: 'Research Workflow',
			description: '',
			nodes: [
				{
					id: codingNodeId,
					name: 'Coding',
					agents: [{ agentId: 'agent-coder', name: 'coder' }],
				},
				{
					id: reviewNodeId,
					name: 'Review',
					agents: [{ agentId: 'agent-reviewer', name: 'agent-reviewer' }],
				},
			],
			startNodeId: codingNodeId,
			endNodeId: reviewNodeId,
			transitions: [],
			rules: [],
			channels: [{ id: 'ch-coding-review', from: 'Coding', to: 'Review' }],
		};

		const channelResolver = makeResolver([
			{ id: 'ch-coding-review', from: 'Coding', to: 'Review' },
		]);

		// Coder is on the Coding node; reviewer is on Review node but NOT YET ACTIVATED
		// (no execution record for Review node exists)
		const config = makeConfig(ctx, {
			myAgentName: 'coder',
			mySessionId: ctx.coderSessionId,
			workflowNodeId: codingNodeId,
			channelResolver,
			workflow,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		// Should include the reviewer as a cross-node peer even though not yet activated
		const crossNodePeer = data.peers.find(
			(p: { agentName: string }) => p.agentName === 'agent-reviewer'
		);
		expect(crossNodePeer).toBeDefined();
		expect(crossNodePeer.status).toBe('not_started');
		expect(crossNodePeer.completionState.taskStatus).toBe('not_started');
		expect(crossNodePeer.nodeName).toBe('Review');

		// permittedTargets must include BOTH the topology node name AND the resolved slot name
		// so callers can use either form with send_message.
		expect(data.permittedTargets).toContain('Review'); // topology node name
		expect(data.permittedTargets).toContain('agent-reviewer'); // resolved slot name
	});

	test('shows cross-node peer with active status when node has been activated', async () => {
		const reviewNodeId = 'node-review-activated';
		const codingNodeId = ctx.nodeId;

		const workflow: SpaceWorkflow = {
			id: 'wf-cross-node-active',
			spaceId: ctx.spaceId,
			name: 'Active Workflow',
			description: '',
			nodes: [
				{
					id: codingNodeId,
					name: 'Coding',
					agents: [{ agentId: 'agent-coder', name: 'coder' }],
				},
				{
					id: reviewNodeId,
					name: 'Review',
					agents: [{ agentId: 'agent-reviewer', name: 'agent-reviewer' }],
				},
			],
			startNodeId: codingNodeId,
			endNodeId: reviewNodeId,
			transitions: [],
			rules: [],
			channels: [{ id: 'ch-coding-review', from: 'Coding', to: 'Review' }],
		};

		const channelResolver = makeResolver([
			{ id: 'ch-coding-review', from: 'Coding', to: 'Review' },
		]);

		// Seed a reviewer execution on the Review node (already activated)
		const reviewerSessionId = 'session-reviewer-cross';
		const nodeExecutionRepo = ctx.nodeExecutionRepo;
		const exec = nodeExecutionRepo.createOrIgnore({
			workflowRunId: ctx.workflowRunId,
			workflowNodeId: reviewNodeId,
			agentName: 'agent-reviewer',
			agentSessionId: reviewerSessionId,
			status: 'in_progress',
		});
		nodeExecutionRepo.update(exec.id, { agentSessionId: reviewerSessionId });

		const config = makeConfig(ctx, {
			myAgentName: 'coder',
			mySessionId: ctx.coderSessionId,
			workflowNodeId: codingNodeId,
			channelResolver,
			workflow,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		const crossNodePeer = data.peers.find(
			(p: { agentName: string }) => p.agentName === 'agent-reviewer'
		);
		expect(crossNodePeer).toBeDefined();
		expect(crossNodePeer.status).toBe('active');
		expect(crossNodePeer.sessionId).toBe(reviewerSessionId);
		expect(crossNodePeer.nodeName).toBe('Review');
	});

	test('shows cross-node peer with completed status when execution is idle', async () => {
		const reviewNodeId = 'node-review-done';
		const codingNodeId = ctx.nodeId;

		const workflow: SpaceWorkflow = {
			id: 'wf-cross-node-done',
			spaceId: ctx.spaceId,
			name: 'Done Workflow',
			description: '',
			nodes: [
				{
					id: codingNodeId,
					name: 'Coding',
					agents: [{ agentId: 'agent-coder', name: 'coder' }],
				},
				{
					id: reviewNodeId,
					name: 'Review',
					agents: [{ agentId: 'agent-reviewer', name: 'agent-reviewer' }],
				},
			],
			startNodeId: codingNodeId,
			endNodeId: reviewNodeId,
			transitions: [],
			rules: [],
			channels: [{ id: 'ch-coding-review', from: 'Coding', to: 'Review' }],
		};

		const channelResolver = makeResolver([
			{ id: 'ch-coding-review', from: 'Coding', to: 'Review' },
		]);

		// Seed a completed (idle) reviewer execution
		const nodeExecutionRepo = ctx.nodeExecutionRepo;
		const exec = nodeExecutionRepo.createOrIgnore({
			workflowRunId: ctx.workflowRunId,
			workflowNodeId: reviewNodeId,
			agentName: 'agent-reviewer',
			agentSessionId: 'session-reviewer-done',
			status: 'idle',
		});
		nodeExecutionRepo.update(exec.id, { result: 'LGTM!', status: 'idle' });

		const config = makeConfig(ctx, {
			myAgentName: 'coder',
			mySessionId: ctx.coderSessionId,
			workflowNodeId: codingNodeId,
			channelResolver,
			workflow,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		const crossNodePeer = data.peers.find(
			(p: { agentName: string }) => p.agentName === 'agent-reviewer'
		);
		expect(crossNodePeer).toBeDefined();
		expect(crossNodePeer.status).toBe('completed');
		expect(crossNodePeer.completionState.completionSummary).toBe('LGTM!');
		expect(crossNodePeer.nodeName).toBe('Review');
	});

	test('does not include cross-node peers when no channel topology declared', async () => {
		// Without a channel resolver, no cross-node peers should appear
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([]), // empty topology
			workflow: null,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		// Only within-node peers (reviewer), no cross-node since topology empty
		expect(data.peers).toHaveLength(1);
		expect(data.peers[0].agentName).toBe('reviewer');
	});

	test('cross-node peer uses topology target name as agentName when workflow is null', async () => {
		// workflow: null means workflow?.nodes.find(...) → undefined, so targetNode is never found.
		// The fallback path (else branch after resolveNodeAgents) uses targetNodeName as agentName.
		// This verifies the code path is safe when a non-empty channelResolver is provided
		// but no workflow definition is available to look up node details.
		const config = makeConfig(ctx, {
			myAgentName: 'coder',
			mySessionId: ctx.coderSessionId,
			workflowNodeId: ctx.nodeId,
			channelResolver: makeResolver([{ id: 'ch-coder-review', from: 'coder', to: 'Review' }]),
			workflow: null,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		// No workflow → targetNode is undefined → agentName falls back to targetNodeName ('Review')
		const crossPeer = data.peers.find((p: { agentName: string }) => p.agentName === 'Review');
		expect(crossPeer).toBeDefined();
		expect(crossPeer.status).toBe('not_started');
		expect(crossPeer.nodeName).toBe('Review');
	});

	test('cross-node peer uses node name when resolveNodeAgents throws (no agents defined)', async () => {
		// When a node has no agents array and no agentId shorthand, resolveNodeAgents throws.
		// The catch block falls back to using the targetNodeName as the agent name.
		const reviewNodeId = 'node-review-no-agents';
		const codingNodeId = ctx.nodeId;

		const workflow: SpaceWorkflow = {
			id: 'wf-no-agents',
			spaceId: ctx.spaceId,
			name: 'No Agents Workflow',
			description: '',
			nodes: [
				{
					id: codingNodeId,
					name: 'Coding',
					agents: [{ agentId: 'agent-coder', name: 'coder' }],
				},
				// No agents defined and no legacy agentId — resolveNodeAgents will throw
				{ id: reviewNodeId, name: 'Review', agents: [] },
			],
			startNodeId: codingNodeId,
			endNodeId: reviewNodeId,
			transitions: [],
			rules: [],
			channels: [{ id: 'ch-coding-review', from: 'Coding', to: 'Review' }],
		};

		const config = makeConfig(ctx, {
			myAgentName: 'coder',
			mySessionId: ctx.coderSessionId,
			workflowNodeId: codingNodeId,
			channelResolver: makeResolver([{ id: 'ch-coding-review', from: 'Coding', to: 'Review' }]),
			workflow,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		// resolveNodeAgents throws (empty agents, no legacy agentId) → catch → agentName = 'Review'
		const crossPeer = data.peers.find((p: { agentName: string }) => p.agentName === 'Review');
		expect(crossPeer).toBeDefined();
		expect(crossPeer.status).toBe('not_started');
		expect(crossPeer.nodeName).toBe('Review');
	});

	test('cross-node peer with pending execution status appears as not_started', async () => {
		// Guards the fix for comment #1: 'pending' execution (node activated, session not yet
		// spawned) must appear as 'not_started' not 'active' in the cross-node peer list.
		const reviewNodeId = 'node-review-pending';
		const codingNodeId = ctx.nodeId;

		const workflow: SpaceWorkflow = {
			id: 'wf-pending-status',
			spaceId: ctx.spaceId,
			name: 'Pending Status Workflow',
			description: '',
			nodes: [
				{
					id: codingNodeId,
					name: 'Coding',
					agents: [{ agentId: 'agent-coder', name: 'coder' }],
				},
				{
					id: reviewNodeId,
					name: 'Review',
					agents: [{ agentId: 'agent-reviewer', name: 'agent-reviewer' }],
				},
			],
			startNodeId: codingNodeId,
			endNodeId: reviewNodeId,
			transitions: [],
			rules: [],
			channels: [{ id: 'ch-coding-review', from: 'Coding', to: 'Review' }],
		};

		// Seed a 'pending' execution for reviewer (activation created, session not yet spawned)
		ctx.nodeExecutionRepo.createOrIgnore({
			workflowRunId: ctx.workflowRunId,
			workflowNodeId: reviewNodeId,
			agentName: 'agent-reviewer',
			status: 'pending',
		});
		// No agentSessionId set — the session hasn't been assigned yet

		const config = makeConfig(ctx, {
			myAgentName: 'coder',
			mySessionId: ctx.coderSessionId,
			workflowNodeId: codingNodeId,
			channelResolver: makeResolver([{ id: 'ch-coding-review', from: 'Coding', to: 'Review' }]),
			workflow,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		const crossPeer = data.peers.find(
			(p: { agentName: string }) => p.agentName === 'agent-reviewer'
		);
		expect(crossPeer).toBeDefined();
		// 'pending' must NOT map to 'active' — it should be 'not_started'
		expect(crossPeer.status).toBe('not_started');
		expect(crossPeer.completionState.taskStatus).toBe('pending');
		expect(crossPeer.nodeName).toBe('Review');
	});
});

// ---------------------------------------------------------------------------
// Tests: send_message — queue-when-inactive (Bug #2 fix)
// ---------------------------------------------------------------------------

describe('node-agent-tools: send_message — queue-when-inactive', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
	});

	test('queues message for declared-but-inactive agent when pendingMessageRepo provided', async () => {
		// "reviewer" is declared in node_executions but has no active session.
		// With pendingMessageRepo configured, the message should be queued, not dropped.
		const isolatedRunId = makeFreshRunId(ctx.db, ctx.spaceId);

		// Seed reviewer execution WITHOUT a session (pending activation)
		const nodeExecutionRepo = ctx.nodeExecutionRepo;
		nodeExecutionRepo.createOrIgnore({
			workflowRunId: isolatedRunId,
			workflowNodeId: 'node-review',
			agentName: 'reviewer',
			status: 'pending',
		});

		const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
		const agentMessageRouter = new AgentMessageRouter({
			nodeExecutionRepo,
			workflowRunId: isolatedRunId,
			workflowChannels: [{ id: 'ch-coder-reviewer', from: 'coder', to: 'reviewer' }],
			messageInjector: async () => {
				throw new Error('Should not be called — reviewer has no session');
			},
			pendingMessageRepo,
			spaceId: ctx.spaceId,
			taskId: null,
		});

		const config = makeConfig(ctx, {
			workflowRunId: isolatedRunId,
			channelResolver: makeResolver([{ id: 'ch-coder-reviewer', from: 'coder', to: 'reviewer' }]),
			agentMessageRouter,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'code is ready for review',
		});
		const data = JSON.parse(result.content[0].text);

		// Message should be queued as a backstop, but not reported as delivered.
		expect(data.success).toBe(false);
		expect(data.queued).toBeDefined();
		expect(data.queued).toHaveLength(1);
		expect(data.queued[0].agentName).toBe('reviewer');
		expect(data.delivered ?? []).toHaveLength(0);

		// Verify the message is in the queue
		const pending = pendingMessageRepo.listPendingForTarget(isolatedRunId, 'reviewer');
		expect(pending).toHaveLength(1);
		expect(pending[0].sourceAgentName).toBe('coder');
		expect(pending[0].message).toBe('─── Message from coder ───\n\ncode is ready for review');
		expect(pending[0].targetKind).toBe('node_agent');
	});

	test('queues message with data appendix for declared-but-inactive agent', async () => {
		const isolatedRunId = makeFreshRunId(ctx.db, ctx.spaceId);

		const nodeExecutionRepo = ctx.nodeExecutionRepo;
		nodeExecutionRepo.createOrIgnore({
			workflowRunId: isolatedRunId,
			workflowNodeId: 'node-review',
			agentName: 'reviewer',
			status: 'pending',
		});

		const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
		const agentMessageRouter = new AgentMessageRouter({
			nodeExecutionRepo,
			workflowRunId: isolatedRunId,
			workflowChannels: [{ id: 'ch-coder-reviewer', from: 'coder', to: 'reviewer' }],
			messageInjector: async () => {},
			pendingMessageRepo,
			spaceId: ctx.spaceId,
			taskId: null,
		});

		const config = makeConfig(ctx, {
			workflowRunId: isolatedRunId,
			channelResolver: makeResolver([{ id: 'ch-coder-reviewer', from: 'coder', to: 'reviewer' }]),
			agentMessageRouter,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'please review my PR',
			data: { pr_url: 'https://github.com/example/repo/pull/1' },
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.queued).toHaveLength(1);

		// Queued message should include the structured data appendix
		const pending = pendingMessageRepo.listPendingForTarget(isolatedRunId, 'reviewer');
		expect(pending).toHaveLength(1);
		expect(pending[0].message).toContain('please review my PR');
		expect(pending[0].message).toContain('pr_url');
	});

	test('delivers immediately when target has an active session, queues when it does not', async () => {
		// Test mixed delivery: reviewer is active, security is not yet started.
		const isolatedRunId = makeFreshRunId(ctx.db, ctx.spaceId);

		const nodeExecutionRepo = ctx.nodeExecutionRepo;
		// reviewer has an active session
		const revExec = nodeExecutionRepo.createOrIgnore({
			workflowRunId: isolatedRunId,
			workflowNodeId: 'node-review',
			agentName: 'reviewer',
			agentSessionId: 'session-reviewer-live',
			status: 'in_progress',
		});
		nodeExecutionRepo.update(revExec.id, { agentSessionId: 'session-reviewer-live' });

		// security has no session yet (pending)
		nodeExecutionRepo.createOrIgnore({
			workflowRunId: isolatedRunId,
			workflowNodeId: 'node-security',
			agentName: 'security',
			status: 'pending',
		});

		const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
		const injectedSessions: string[] = [];
		const agentMessageRouter = new AgentMessageRouter({
			nodeExecutionRepo,
			workflowRunId: isolatedRunId,
			workflowChannels: [
				{ id: 'ch-coder-reviewer', from: 'coder', to: 'reviewer' },
				{ id: 'ch-coder-security', from: 'coder', to: 'security' },
			],
			messageInjector: async (sid) => {
				injectedSessions.push(sid);
			},
			pendingMessageRepo,
			spaceId: ctx.spaceId,
			taskId: null,
		});

		const config = makeConfig(ctx, {
			mySessionId: ctx.coderSessionId,
			workflowRunId: isolatedRunId,
			channelResolver: makeResolver([
				{ id: 'ch-coder-reviewer', from: 'coder', to: 'reviewer' },
				{ id: 'ch-coder-security', from: 'coder', to: 'security' },
			]),
			agentMessageRouter,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({
			target: ['reviewer', 'security'],
			message: 'hello from coder',
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		// reviewer delivered directly
		expect(data.delivered).toHaveLength(1);
		expect(data.delivered[0].agentName).toBe('reviewer');
		expect(injectedSessions).toContain('session-reviewer-live');

		// security queued
		expect(data.queued).toHaveLength(1);
		expect(data.queued[0].agentName).toBe('security');
		const securityPending = pendingMessageRepo.listPendingForTarget(isolatedRunId, 'security');
		expect(securityPending).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Tests: list_tasks / get_task
// ---------------------------------------------------------------------------

describe('node-agent-tools: list_tasks', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
	});

	test('lists tasks in the space', async () => {
		const config = makeConfig(ctx, { taskRepo: ctx.taskRepo });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_tasks({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.tasks.length).toBeGreaterThanOrEqual(2);
		expect(data.has_more).toBe(false);
	});

	test('filters tasks by status', async () => {
		const config = makeConfig(ctx, { taskRepo: ctx.taskRepo });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_tasks({ status: 'in_progress' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.tasks.every((t: { status: string }) => t.status === 'in_progress')).toBe(true);
	});

	test('returns compact tasks when compact:true', async () => {
		const config = makeConfig(ctx, { taskRepo: ctx.taskRepo });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_tasks({ compact: true });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.tasks[0]).toHaveProperty('id');
		expect(data.tasks[0]).toHaveProperty('title');
		expect(data.tasks[0]).toHaveProperty('status');
		expect(data.tasks[0]).toHaveProperty('priority');
		expect(data.tasks[0]).toHaveProperty('createdAt');
		expect(data.tasks[0]).not.toHaveProperty('description');
	});

	test('paginates with limit and offset', async () => {
		const config = makeConfig(ctx, { taskRepo: ctx.taskRepo });
		const handlers = createNodeAgentToolHandlers(config);

		// Get first page
		const page1 = await handlers.list_tasks({ limit: 1, offset: 0 });
		const data1 = JSON.parse(page1.content[0].text);
		expect(data1.tasks).toHaveLength(1);
		expect(data1.has_more).toBe(true);

		// Get second page
		const page2 = await handlers.list_tasks({ limit: 1, offset: 1 });
		const data2 = JSON.parse(page2.content[0].text);
		expect(data2.tasks).toHaveLength(1);
		expect(data2.tasks[0].id).not.toBe(data1.tasks[0].id);
	});

	test('returns error when taskRepo is not available', async () => {
		const config = makeConfig(ctx, { taskRepo: undefined });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_tasks({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('Task repository not available');
	});
});

describe('node-agent-tools: get_task', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
	});

	test('gets task by task_number', async () => {
		const config = makeConfig(ctx, { taskRepo: ctx.taskRepo });
		const handlers = createNodeAgentToolHandlers(config);

		// Create a task with a known number
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Task by number',
			description: '',
		});

		const result = await handlers.get_task({ task_number: task.taskNumber });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.task.id).toBe(task.id);
		expect(data.task.title).toBe('Task by number');
	});

	test('gets task by task_id', async () => {
		const config = makeConfig(ctx, { taskRepo: ctx.taskRepo });
		const handlers = createNodeAgentToolHandlers(config);

		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Task by ID',
			description: '',
		});

		const result = await handlers.get_task({ task_id: task.id });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.task.id).toBe(task.id);
	});

	test('scopes task_id lookup to current space', async () => {
		const config = makeConfig(ctx, { taskRepo: ctx.taskRepo });
		const handlers = createNodeAgentToolHandlers(config);

		// Create another space and task
		const otherSpaceId = 'other-space';
		ctx.db
			.prepare(
				`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
				 allowed_models, session_ids, slug, status, created_at, updated_at)
				 VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
			)
			.run(otherSpaceId, '/tmp/other', 'Other', 'other', Date.now(), Date.now());

		const otherTask = ctx.taskRepo.createTask({
			spaceId: otherSpaceId,
			title: 'Other space task',
			description: '',
		});

		// Should not find the task from the other space
		const result = await handlers.get_task({ task_id: otherTask.id });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('Task not found');
	});

	test('returns error when neither task_id nor task_number is provided', async () => {
		const config = makeConfig(ctx, { taskRepo: ctx.taskRepo });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.get_task({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('Either task_id or task_number is required');
	});

	test('returns error for non-existent task', async () => {
		const config = makeConfig(ctx, { taskRepo: ctx.taskRepo });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.get_task({ task_number: 99999 });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('Task not found');
	});

	test('returns error when taskRepo is not available', async () => {
		const config = makeConfig(ctx, { taskRepo: undefined });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.get_task({ task_id: 'some-id' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('Task repository not available');
	});
});

// ---------------------------------------------------------------------------
// Tests: list_audit_entries
// ---------------------------------------------------------------------------

describe('node-agent-tools: list_audit_entries', () => {
	let ctx: TestCtx;
	let auditLogRepo: McpAuditLogRepository;

	beforeEach(() => {
		ctx = makeCtx();
		auditLogRepo = new McpAuditLogRepository(ctx.db);
	});

	afterEach(() => {
		ctx.db.close();
	});

	test('lists audit entries by space with real total and has_more', async () => {
		auditLogRepo.createEntry({ toolName: 'send_message', spaceId: ctx.spaceId });
		auditLogRepo.createEntry({ toolName: 'save_artifact', spaceId: ctx.spaceId });

		const config = makeConfig(ctx, { auditLogRepo });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_audit_entries({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.entries).toHaveLength(2);
		expect(data.total).toBe(2);
		expect(data.has_more).toBe(false);
		const toolNames = data.entries.map((e: { toolName: string }) => e.toolName);
		expect(toolNames).toContain('send_message');
		expect(toolNames).toContain('save_artifact');
	});

	test('filters audit entries by task_id with real total', async () => {
		const taskA = 'task-a';
		const taskB = 'task-b';
		auditLogRepo.createEntry({ toolName: 't1', spaceId: ctx.spaceId, taskId: taskA });
		auditLogRepo.createEntry({ toolName: 't2', spaceId: ctx.spaceId, taskId: taskA });
		auditLogRepo.createEntry({ toolName: 't3', spaceId: ctx.spaceId, taskId: taskB });

		const config = makeConfig(ctx, { auditLogRepo });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_audit_entries({ task_id: taskA });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.entries).toHaveLength(2);
		expect(data.total).toBe(2);
		expect(data.has_more).toBe(false);
		expect(data.entries.every((e: { taskId: string }) => e.taskId === taskA)).toBe(true);
	});

	test('filters audit entries by session_id with real total', async () => {
		const sessA = 'sess-a';
		const sessB = 'sess-b';
		auditLogRepo.createEntry({ toolName: 't1', spaceId: ctx.spaceId, sessionId: sessA });
		auditLogRepo.createEntry({ toolName: 't2', spaceId: ctx.spaceId, sessionId: sessA });
		auditLogRepo.createEntry({ toolName: 't3', spaceId: ctx.spaceId, sessionId: sessB });

		const config = makeConfig(ctx, { auditLogRepo });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_audit_entries({ session_id: sessA });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.entries).toHaveLength(2);
		expect(data.total).toBe(2);
		expect(data.has_more).toBe(false);
		expect(data.entries.every((e: { sessionId: string }) => e.sessionId === sessA)).toBe(true);
	});

	test('task_id filter is scoped to current space', async () => {
		const sharedTaskId = 'shared-task';
		auditLogRepo.createEntry({ toolName: 't1', spaceId: ctx.spaceId, taskId: sharedTaskId });
		auditLogRepo.createEntry({ toolName: 't2', spaceId: 'other-space', taskId: sharedTaskId });

		const config = makeConfig(ctx, { auditLogRepo });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_audit_entries({ task_id: sharedTaskId });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.entries).toHaveLength(1);
		expect(data.entries[0].toolName).toBe('t1');
		expect(data.total).toBe(1);
	});

	test('session_id filter is scoped to current space', async () => {
		const sharedSessionId = 'shared-session';
		auditLogRepo.createEntry({ toolName: 't1', spaceId: ctx.spaceId, sessionId: sharedSessionId });
		auditLogRepo.createEntry({
			toolName: 't2',
			spaceId: 'other-space',
			sessionId: sharedSessionId,
		});

		const config = makeConfig(ctx, { auditLogRepo });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_audit_entries({ session_id: sharedSessionId });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.entries).toHaveLength(1);
		expect(data.entries[0].toolName).toBe('t1');
		expect(data.total).toBe(1);
	});

	test('task_id filter takes precedence over session_id', async () => {
		auditLogRepo.createEntry({
			toolName: 't1',
			spaceId: ctx.spaceId,
			taskId: 'task-x',
			sessionId: 'sess-a',
		});
		auditLogRepo.createEntry({
			toolName: 't2',
			spaceId: ctx.spaceId,
			taskId: 'task-y',
			sessionId: 'sess-a',
		});

		const config = makeConfig(ctx, { auditLogRepo });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_audit_entries({ task_id: 'task-x', session_id: 'sess-a' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.entries).toHaveLength(1);
		expect(data.entries[0].taskId).toBe('task-x');
	});

	test('paginates with limit and offset, reporting real total and has_more', async () => {
		auditLogRepo.createEntry({ toolName: 't1', spaceId: ctx.spaceId });
		auditLogRepo.createEntry({ toolName: 't2', spaceId: ctx.spaceId });
		auditLogRepo.createEntry({ toolName: 't3', spaceId: ctx.spaceId });

		const config = makeConfig(ctx, { auditLogRepo });
		const handlers = createNodeAgentToolHandlers(config);

		const page1 = await handlers.list_audit_entries({ limit: 2, offset: 0 });
		const data1 = JSON.parse(page1.content[0].text);
		expect(data1.entries).toHaveLength(2);
		expect(data1.total).toBe(3);
		expect(data1.has_more).toBe(true);

		const page2 = await handlers.list_audit_entries({ limit: 2, offset: 2 });
		const data2 = JSON.parse(page2.content[0].text);
		expect(data2.entries).toHaveLength(1);
		expect(data2.total).toBe(3);
		expect(data2.has_more).toBe(false);
		// Entries have same-timestamp + random UUIDs, so ordering of the "last" entry is non-deterministic.
		expect(data2.entries[0].toolName).toMatch(/^t[123]$/);
	});

	test('returns empty array with total=0 and has_more=false when no entries match', async () => {
		const config = makeConfig(ctx, { auditLogRepo });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_audit_entries({ task_id: 'nonexistent' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.entries).toEqual([]);
		expect(data.total).toBe(0);
		expect(data.has_more).toBe(false);
	});

	test('returns error when auditLogRepo is not available', async () => {
		const config = makeConfig(ctx, { auditLogRepo: undefined });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_audit_entries({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('Audit log repository not available');
	});
});

// ---------------------------------------------------------------------------
// publish_task
// ---------------------------------------------------------------------------

describe('node-agent-tools \u2014 publish_task', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
	});

	test('publishes a draft task via callback', async () => {
		const draftTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Draft task',
			description: 'Will publish',
			status: 'draft',
		});

		const onPublishTask = async (args: { task_id: string }) => {
			const updated = await ctx.taskManager.publishTask(args.task_id);
			return jsonResult({ success: true, task: updated });
		};

		const config = makeConfig(ctx, { onPublishTask });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.publish_task({ task_id: draftTask.id });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.task.status).toBe('open');
	});

	test('returns error when callback is not available', async () => {
		const config = makeConfig(ctx);
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.publish_task({ task_id: 'any-id' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('not available');
	});

	test('returns error when callback fails', async () => {
		const openTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Open task',
			description: 'Not draft',
			status: 'open',
		});

		const onPublishTask = async (args: { task_id: string }) => {
			try {
				const updated = await ctx.taskManager.publishTask(args.task_id);
				return jsonResult({ success: true, task: updated });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		};

		const config = makeConfig(ctx, { onPublishTask });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.publish_task({ task_id: openTask.id });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain("'open'");
	});
	test('callback emits space.task.updated event after publishing', async () => {
		const draftTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Draft task',
			description: 'Event emission test',
			status: 'draft',
		});

		const publishedEvents: Array<{
			event: string;
			data: { sessionId: string; spaceId: string; taskId: string };
		}> = [];
		const mockEventBus = {
			publish: async (
				event: string,
				data: { sessionId: string; spaceId: string; taskId: string }
			) => {
				publishedEvents.push({ event, data });
				return { delivered: 1, failures: [] };
			},
		} as unknown as InternalEventBus<DaemonInternalEventMap>;

		// This callback mirrors the wiring in task-agent-manager.ts
		const onPublishTask = async (args: { task_id: string }) => {
			try {
				const updated = await ctx.taskManager.publishTask(args.task_id);
				mockEventBus
					?.publish('space.task.updated', {
						sessionId: 'global',
						spaceId: ctx.spaceId,
						taskId: updated.id,
						task: updated,
					})
					.catch(() => {});
				return jsonResult({ success: true, task: updated });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		};

		const config = makeConfig(ctx, { onPublishTask });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.publish_task({ task_id: draftTask.id });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.task.status).toBe('open');
		expect(publishedEvents).toHaveLength(1);
		expect(publishedEvents[0].event).toBe('space.task.updated');
		expect(publishedEvents[0].data.taskId).toBe(draftTask.id);
		expect(publishedEvents[0].data.spaceId).toBe(ctx.spaceId);
		expect(publishedEvents[0].data.sessionId).toBe('global');
	});
});

// ---------------------------------------------------------------------------
// archive_task
// ---------------------------------------------------------------------------

describe('node-agent-tools \u2014 archive_task', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
	});

	test('archives a draft task via callback', async () => {
		const draftTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Draft task',
			description: 'Will archive',
			status: 'draft',
		});

		const onArchiveTask = async (args: { task_id: string }) => {
			const updated = await ctx.taskManager.archiveTask(args.task_id);
			return jsonResult({ success: true, task: updated });
		};

		const config = makeConfig(ctx, { onArchiveTask });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.archive_task({ task_id: draftTask.id });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.task.status).toBe('archived');
	});

	test('archives a cancelled task via callback', async () => {
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Task',
			description: 'Will cancel then archive',
			status: 'open',
		});
		await ctx.taskManager.cancelTask(task.id);

		const onArchiveTask = async (args: { task_id: string }) => {
			const updated = await ctx.taskManager.archiveTask(args.task_id);
			return jsonResult({ success: true, task: updated });
		};

		const config = makeConfig(ctx, { onArchiveTask });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.archive_task({ task_id: task.id });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.task.status).toBe('archived');
	});

	test('returns error when callback is not available', async () => {
		const config = makeConfig(ctx);
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.archive_task({ task_id: 'any-id' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('not available');
	});

	test('returns error when trying to archive an already-archived task', async () => {
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Task',
			description: 'Already archived',
			status: 'draft',
		});
		await ctx.taskManager.archiveTask(task.id);

		const onArchiveTask = async (args: { task_id: string }) => {
			try {
				const updated = await ctx.taskManager.archiveTask(args.task_id);
				return jsonResult({ success: true, task: updated });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		};

		const config = makeConfig(ctx, { onArchiveTask });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.archive_task({ task_id: task.id });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('archived');
	});
	test('callback emits space.task.updated event after archiving', async () => {
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Draft task',
			description: 'Event emission test',
			status: 'draft',
		});

		const publishedEvents: Array<{
			event: string;
			data: { sessionId: string; spaceId: string; taskId: string };
		}> = [];
		const mockEventBus = {
			publish: async (
				event: string,
				data: { sessionId: string; spaceId: string; taskId: string }
			) => {
				publishedEvents.push({ event, data });
				return { delivered: 1, failures: [] };
			},
		} as unknown as InternalEventBus<DaemonInternalEventMap>;

		// This callback mirrors the wiring in task-agent-manager.ts
		const onArchiveTask = async (args: { task_id: string }) => {
			try {
				const updated = await ctx.taskManager.archiveTask(args.task_id);
				mockEventBus
					?.publish('space.task.updated', {
						sessionId: 'global',
						spaceId: ctx.spaceId,
						taskId: updated.id,
						task: updated,
					})
					.catch(() => {});
				return jsonResult({ success: true, task: updated });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		};

		const config = makeConfig(ctx, { onArchiveTask });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.archive_task({ task_id: task.id });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.task.status).toBe('archived');
		expect(publishedEvents).toHaveLength(1);
		expect(publishedEvents[0].event).toBe('space.task.updated');
		expect(publishedEvents[0].data.taskId).toBe(task.id);
		expect(publishedEvents[0].data.spaceId).toBe(ctx.spaceId);
		expect(publishedEvents[0].data.sessionId).toBe('global');
	});

	test('clears pending-completion fields when archiving from review', async () => {
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Review task',
			description: 'Will archive from review',
			status: 'open',
		});
		await ctx.taskManager.startTask(task.id);
		await ctx.taskManager.submitTaskForReview(task.id, {
			submittedByNodeId: null,
			reason: 'Test submission',
		});
		const reviewTask = ctx.taskRepo.getTask(task.id);
		expect(reviewTask?.pendingCheckpointType).toBe('task_completion');

		const onArchiveTask = async (args: { task_id: string }) => {
			const updated = await ctx.taskManager.archiveTask(args.task_id);
			return jsonResult({ success: true, task: updated });
		};

		const config = makeConfig(ctx, { onArchiveTask });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.archive_task({ task_id: task.id });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.task.status).toBe('archived');
		expect(data.task.pendingCheckpointType).toBeNull();
		expect(data.task.pendingCompletionSubmittedByNodeId).toBeNull();
	});
});
