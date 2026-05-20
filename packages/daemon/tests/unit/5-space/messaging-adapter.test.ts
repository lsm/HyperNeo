import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	SpaceDeliveryFacade,
	SpaceMessageResolver,
	pendingMessageToDeliveryRecords,
	pendingMessageToMessageRecord,
	translateLegacyNodeTargets,
	translateTaskMessageTarget,
} from '../../../src/lib/space/messaging-adapter';
import { SpaceActorRegistryAdapter } from '../../../src/lib/space/actor-registry';
import { NodeExecutionRepository } from '../../../src/storage/repositories/node-execution-repository';
import { PendingAgentMessageRepository } from '../../../src/storage/repositories/pending-agent-message-repository';
import { SessionRepository } from '../../../src/storage/repositories/session-repository';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository';
import type { MessageRecord } from '../../../../messaging/src/types';
import { createSpaceTables } from '../helpers/space-test-db';

function alignTestSchema(db: Database): void {
	db.exec('ALTER TABLE space_agents ADD COLUMN custom_prompt TEXT DEFAULT NULL');
	db.exec('DROP TABLE sessions');
	db.exec(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			workspace_path TEXT,
			created_at TEXT NOT NULL,
			last_active_at TEXT NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived', 'pending_worktree_choice')),
			config TEXT NOT NULL,
			metadata TEXT NOT NULL,
			is_worktree INTEGER DEFAULT 0,
			worktree_path TEXT,
			main_repo_path TEXT,
			worktree_branch TEXT,
			git_branch TEXT,
			sdk_session_id TEXT,
			sdk_origin_path TEXT,
			available_commands TEXT,
			processing_state TEXT,
			archived_at TEXT,
			type TEXT DEFAULT 'worker',
			session_context TEXT
		)
	`);
}

describe('Space messaging adapter', () => {
	let db: Database;
	let spaceRepo: SpaceRepository;
	let sessionRepo: SessionRepository;
	let spaceAgentRepo: SpaceAgentRepository;
	let workflowRepo: SpaceWorkflowRepository;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	let nodeExecutionRepo: NodeExecutionRepository;
	let pendingMessageRepo: PendingAgentMessageRepository;
	let registry: SpaceActorRegistryAdapter;
	let spaceId: string;
	let runId: string;
	let message: MessageRecord;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);
		alignTestSchema(db);
		spaceRepo = new SpaceRepository(db);
		sessionRepo = new SessionRepository(db);
		spaceAgentRepo = new SpaceAgentRepository(db);
		workflowRepo = new SpaceWorkflowRepository(db);
		workflowRunRepo = new SpaceWorkflowRunRepository(db);
		nodeExecutionRepo = new NodeExecutionRepository(db);
		pendingMessageRepo = new PendingAgentMessageRepository(db);
		registry = new SpaceActorRegistryAdapter({
			spaceRepo,
			sessionRepo,
			spaceAgentRepo,
			workflowRepo,
			workflowRunRepo,
			nodeExecutionRepo,
			pendingMessageRepo,
		});

		const space = spaceRepo.createSpace({
			workspacePath: '/workspace/project',
			slug: 'project',
			name: 'Project',
		});
		spaceId = space.id;
		const agent = spaceAgentRepo.create({ spaceId, name: 'Worker Agent' });
		const workflow = workflowRepo.createWorkflow({
			spaceId,
			name: 'Coding Workflow',
			nodes: [
				{ id: 'node-coding', name: 'Coding', agents: [{ agentId: agent.id, name: 'coder' }] },
				{
					id: 'node-review',
					name: 'Review',
					agents: [
						{ agentId: agent.id, name: 'reviewer' },
						{ agentId: agent.id, name: 'observer' },
					],
				},
				{ id: 'node-deploy', name: 'Deploy', agents: [{ agentId: agent.id, name: 'deployer' }] },
				{ id: 'node-qa', name: 'QA', agents: [{ agentId: agent.id, name: 'reviewer' }] },
			],
			channels: [{ from: 'Coding', to: ['Review', 'Deploy'] }],
			transitions: [],
			startNodeId: 'Coding',
			rules: [],
			completionAutonomyLevel: 3,
		});
		const run = workflowRunRepo.createRun({ spaceId, workflowId: workflow.id, title: 'Run' });
		runId = run.id;
		const otherRun = workflowRunRepo.createRun({
			spaceId,
			workflowId: workflow.id,
			title: 'Run 2',
		});
		nodeExecutionRepo.create({
			workflowRunId: otherRun.id,
			workflowNodeId: 'node-review',
			agentName: 'reviewer',
			agentId: agent.id,
			agentSessionId: 'other-review-session',
			status: 'in_progress',
		});
		nodeExecutionRepo.create({
			workflowRunId: runId,
			workflowNodeId: 'node-coding',
			agentName: 'coder',
			agentId: agent.id,
			agentSessionId: 'coding-session',
			status: 'in_progress',
		});
		nodeExecutionRepo.create({
			workflowRunId: runId,
			workflowNodeId: 'node-review',
			agentName: 'reviewer',
			agentId: agent.id,
			agentSessionId: 'review-session',
			status: 'in_progress',
		});
		nodeExecutionRepo.create({
			workflowRunId: runId,
			workflowNodeId: 'node-review',
			agentName: 'observer',
			agentId: agent.id,
			agentSessionId: 'observer-session',
			status: 'in_progress',
		});
		nodeExecutionRepo.create({
			workflowRunId: runId,
			workflowNodeId: 'node-qa',
			agentName: 'reviewer',
			agentId: agent.id,
			agentSessionId: null,
			status: 'pending',
		});
		message = {
			messageId: 'msg-1',
			spaceId,
			senderActorId: `worker:${encodeURIComponent(runId)}:node-coding:coder`,
			targets: [],
			body: 'hello',
			kind: 'message',
			workflowRunId: runId,
			createdAt: 1,
		};
	});

	afterEach(() => {
		db.close();
	});

	it('resolves handles, role fan-out, sessions, and workers deterministically', async () => {
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'node-coding', agentName: 'coder' }
		);
		const result = await resolver.resolveTargets({
			...message,
			targets: ['@coordinator', '@role:reviewer', '@worker:node-review/reviewer'],
		});

		expect(result.unresolved).toEqual([]);
		expect(result.resolved.map((target) => target.actor.actorId)).toEqual([
			`agent:coordinator:${spaceId}`,
			`worker:${encodeURIComponent(runId)}:node-review:reviewer`,
			`worker:${encodeURIComponent(runId)}:node-review:reviewer`,
		]);
	});

	it('filters role-resolved worker actors through channel topology', async () => {
		nodeExecutionRepo.create({
			workflowRunId: runId,
			workflowNodeId: 'node-qa',
			agentName: 'reviewer',
			agentId: spaceAgentRepo.getBySpaceId(spaceId)[0].id,
			agentSessionId: 'qa-session',
			status: 'in_progress',
		});
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'node-coding', agentName: 'coder' }
		);
		const result = await resolver.resolveTargets({
			...message,
			targets: ['@role:reviewer'],
		});

		expect(result.unresolved).toEqual([]);
		expect(result.resolved.map((target) => target.actor.actorId)).toEqual([
			`worker:${encodeURIComponent(runId)}:node-review:reviewer`,
		]);
	});

	it('falls back to permitted inactive role holders when active holders are rejected', async () => {
		nodeExecutionRepo.create({
			workflowRunId: runId,
			workflowNodeId: 'node-qa',
			agentName: 'reviewer',
			agentId: spaceAgentRepo.getBySpaceId(spaceId)[0].id,
			agentSessionId: 'qa-session',
			status: 'in_progress',
		});
		nodeExecutionRepo.updateStatus(
			nodeExecutionRepo
				.listByWorkflowRun(runId)
				.find(
					(execution) =>
						execution.workflowNodeId === 'node-review' && execution.agentName === 'reviewer'
				)!.id,
			'pending'
		);
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'node-coding', agentName: 'coder' }
		);
		const result = await resolver.resolveTargets({
			...message,
			targets: ['@role:reviewer'],
		});

		expect(result.unresolved).toEqual([]);
		expect(result.resolved.map((target) => target.actor.actorId)).toEqual([
			`worker:${encodeURIComponent(runId)}:node-review:reviewer`,
		]);
		expect(result.resolved[0].actor.status).toBe('inactive');
	});

	it('errors instead of falling back for stale handles and forbidden worker topology', async () => {
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'node-review', agentName: 'reviewer' }
		);
		const result = await resolver.resolveTargets({
			...message,
			targets: ['@coordiantor', '@worker:node-qa/reviewer'],
		});

		expect(result.resolved).toEqual([]);
		expect(result.unresolved.map((target) => target.reason)).toEqual([
			'No routable actor found for handle @coordiantor',
			'Channel topology does not permit worker target @worker:node-qa/reviewer',
		]);
	});

	it('rejects message space and implicit workflow run mismatches', async () => {
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'node-coding', agentName: 'coder' }
		);
		const spaceMismatch = await resolver.resolveTargets({
			...message,
			spaceId: 'other-space',
			targets: ['@coordinator'],
		});
		expect(spaceMismatch.resolved).toEqual([]);
		expect(spaceMismatch.unresolved.map((target) => target.reason)).toEqual([
			`Message space other-space does not match resolver space ${spaceId}`,
		]);

		const runMismatch = await resolver.resolveTargets({
			...message,
			workflowRunId: 'other-run',
			targets: ['@worker:Review/reviewer'],
		});
		expect(runMismatch.resolved).toEqual([]);
		expect(runMismatch.unresolved.map((target) => target.reason)).toEqual([
			`Message workflowRunId other-run does not match resolver workflowRunId ${runId}`,
		]);
	});

	it('resolves inactive long-term agents by handle and role', async () => {
		const agent = spaceAgentRepo.create({ spaceId, name: 'Task Manager' });
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId }
		);
		const result = await resolver.resolveTargets({
			...message,
			workflowRunId: undefined,
			targets: ['@task-manager', '@role:task-manager'],
		});

		expect(result.unresolved).toEqual([]);
		expect(result.resolved.map((target) => target.actor)).toEqual([
			expect.objectContaining({
				actorId: `agent:${encodeURIComponent(agent.id)}`,
				status: 'inactive',
			}),
			expect.objectContaining({
				actorId: `agent:${encodeURIComponent(agent.id)}`,
				status: 'inactive',
			}),
		]);
	});

	it('queues inactive long-term agent deliveries via activation callback', async () => {
		const agent = spaceAgentRepo.create({ spaceId, name: 'Task Manager' });
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId }
		);
		const queued: string[] = [];
		const facade = new SpaceDeliveryFacade({
			resolver,
			queueForActivation: async (actor) => {
				queued.push(actor.actorId);
				return 'inbox-1';
			},
		});

		const result = await facade.routeMessage({
			...message,
			workflowRunId: undefined,
			targets: ['@task-manager'],
		});

		expect(queued).toEqual([`agent:${encodeURIComponent(agent.id)}`]);
		expect(result.deliveries).toHaveLength(1);
		expect(result.deliveries[0]).toMatchObject({
			targetActorId: `agent:${encodeURIComponent(agent.id)}`,
			targetRef: '@task-manager',
			state: 'queued',
			deliveryId: 'delivery_inbox-1',
		});
	});

	it('writes queued deliveries for inactive actors and failed rows for unresolved targets', async () => {
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'node-coding', agentName: 'coder' }
		);
		const facade = new SpaceDeliveryFacade({ resolver });
		const result = await facade.routeMessage({
			...message,
			targets: ['@worker:node-review/reviewer', '@missing'],
		});

		expect(result.deliveries).toHaveLength(2);
		expect(result.deliveries[0]).toMatchObject({
			targetActorId: `worker:${encodeURIComponent(runId)}:node-review:reviewer`,
			targetRef: '@worker:node-review/reviewer',
			state: 'queued',
		});
		expect(result.deliveries[1]).toMatchObject({
			targetRef: '@missing',
			state: 'failed',
			lastError: 'No routable actor found for handle @missing',
		});
		expect(new Set(result.deliveries.map((delivery) => delivery.deliveryId)).size).toBe(
			result.deliveries.length
		);
	});

	it('keeps active actors queued when delivery callback returns no session id', async () => {
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'node-coding', agentName: 'coder' }
		);
		const facade = new SpaceDeliveryFacade({
			resolver,
			deliverToSession: async () => null,
		});
		const result = await facade.routeMessage({
			...message,
			targets: ['@worker:node-review/reviewer'],
		});

		expect(result.deliveries).toHaveLength(1);
		expect(result.deliveries[0]).toMatchObject({
			targetActorId: `worker:${encodeURIComponent(runId)}:node-review:reviewer`,
			state: 'queued',
		});
		expect(result.deliveries[0].deliveredAt).toBeUndefined();
		expect(result.deliveries[0].deliveredSessionId).toBeUndefined();
	});

	it('translates legacy node-agent targets to generic worker targets', () => {
		const targets = translateLegacyNodeTargets(['Review', 'reviewer', 'space-agent', '*'], {
			spaceId,
			workflowRunId: runId,
			workflowNodeId: 'node-coding',
			agentName: 'coder',
			workflow: workflowRepo.getWorkflow(workflowRunRepo.getRun(runId)!.workflowId),
		});

		expect(targets).toEqual([
			`@worker:${encodeURIComponent(runId)}/Review/reviewer`,
			`@worker:${encodeURIComponent(runId)}/Review/observer`,
			`@worker:${encodeURIComponent(runId)}/QA/reviewer`,
			'@coordinator',
			`@worker:${encodeURIComponent(runId)}/Deploy/deployer`,
		]);
		expect(() =>
			translateLegacyNodeTargets('task-agent', {
				spaceId,
				workflowRunId: runId,
				workflowNodeId: 'node-coding',
				agentName: 'coder',
				workflow: workflowRepo.getWorkflow(workflowRunRepo.getRun(runId)!.workflowId),
			})
		).toThrow('task-agent');
		expect(() =>
			translateLegacyNodeTargets(['reviewer', 'ghost'], {
				spaceId,
				workflowRunId: runId,
				workflowNodeId: 'node-coding',
				agentName: 'coder',
				workflow: workflowRepo.getWorkflow(workflowRunRepo.getRun(runId)!.workflowId),
			})
		).toThrow('Unknown target "ghost"');
	});

	it('translates task message node_id selectors to generic worker targets', () => {
		const workflow = workflowRepo.getWorkflow(workflowRunRepo.getRun(runId)!.workflowId);
		const executions = nodeExecutionRepo.listByWorkflowRun(runId);
		const reviewExecution = executions.find(
			(execution) =>
				execution.workflowNodeId === 'node-review' && execution.agentName === 'reviewer'
		)!;

		expect(
			translateTaskMessageTarget(
				{ nodeId: reviewExecution.id },
				{ workflowRunId: runId, nodeExecutions: executions, workflow }
			)
		).toBe(`@worker:${encodeURIComponent(runId)}/Review/reviewer`);
		expect(
			translateTaskMessageTarget(
				{ nodeId: 'observer' },
				{ workflowRunId: runId, nodeExecutions: executions, workflow }
			)
		).toBe(`@worker:${encodeURIComponent(runId)}/Review/observer`);
		expect(
			translateTaskMessageTarget(
				{ target: '@session:abc', nodeId: reviewExecution.id },
				{ workflowRunId: runId, nodeExecutions: executions, workflow }
			)
		).toBe('@session:abc');
		expect(() =>
			translateTaskMessageTarget(
				{ target: 'task-agent' },
				{ workflowRunId: runId, nodeExecutions: executions, workflow }
			)
		).toThrow('task-agent');
	});

	it('resolves worker node names, context agent shorthand, and explicit run targets', async () => {
		const shorthandResolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'node-coding', agentName: 'reviewer' }
		);
		const shorthand = await shorthandResolver.resolveTargets({
			...message,
			targets: ['@worker:Review'],
		});
		expect(shorthand.unresolved).toEqual([]);
		expect(shorthand.resolved.map((target) => target.actor.actorId)).toEqual([
			`worker:${encodeURIComponent(runId)}:node-review:reviewer`,
		]);

		const explicitResolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId }
		);
		const explicit = await explicitResolver.resolveTargets({
			...message,
			workflowRunId: undefined,
			targets: [`@worker:${runId}/Review/reviewer`],
		});
		expect(explicit.unresolved).toEqual([]);
		expect(explicit.resolved.map((target) => target.actor.actorId)).toEqual([
			`worker:${encodeURIComponent(runId)}:node-review:reviewer`,
		]);
	});

	it('permits worker routes declared with agent-name channel endpoints', async () => {
		workflowRepo.updateWorkflow(workflowRunRepo.getRun(runId)!.workflowId, {
			channels: [{ from: 'coder', to: 'reviewer' }],
		});
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'node-coding', agentName: 'coder' }
		);
		const result = await resolver.resolveTargets({
			...message,
			targets: ['@worker:Review/reviewer'],
		});

		expect(result.unresolved).toEqual([]);
		expect(result.resolved.map((target) => target.actor.actorId)).toEqual([
			`worker:${encodeURIComponent(runId)}:node-review:reviewer`,
		]);
	});

	it('queues declared workflow workers that have not spawned yet', async () => {
		nodeExecutionRepo.delete(
			nodeExecutionRepo
				.listByWorkflowRun(runId)
				.find(
					(execution) =>
						execution.workflowNodeId === 'node-review' && execution.agentName === 'reviewer'
				)!.id
		);
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'node-coding', agentName: 'coder' }
		);
		const result = await resolver.resolveTargets({
			...message,
			targets: ['@worker:Review/reviewer'],
		});

		expect(result.unresolved).toEqual([]);
		expect(result.resolved.map((target) => target.actor)).toEqual([
			expect.objectContaining({
				actorId: `worker:${encodeURIComponent(runId)}:node-review:reviewer`,
				status: 'inactive',
			}),
		]);
	});

	it('queues declared single-slot worker shorthand without a spawned execution', async () => {
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'node-coding', agentName: 'coder' }
		);
		const result = await resolver.resolveTargets({
			...message,
			targets: ['@worker:Deploy'],
		});

		expect(result.unresolved).toEqual([]);
		expect(result.resolved.map((target) => target.actor)).toEqual([
			expect.objectContaining({
				actorId: `worker:${encodeURIComponent(runId)}:node-deploy:deployer`,
				status: 'inactive',
			}),
		]);
	});

	it('includes declared worker slots in role resolution', async () => {
		nodeExecutionRepo.delete(
			nodeExecutionRepo
				.listByWorkflowRun(runId)
				.find(
					(execution) =>
						execution.workflowNodeId === 'node-review' && execution.agentName === 'reviewer'
				)!.id
		);
		nodeExecutionRepo.updateStatus(
			nodeExecutionRepo
				.listByWorkflowRun(runId)
				.find(
					(execution) =>
						execution.workflowNodeId === 'node-qa' && execution.agentName === 'reviewer'
				)!.id,
			'cancelled'
		);
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'node-coding', agentName: 'coder' }
		);
		const result = await resolver.resolveTargets({
			...message,
			targets: ['@role:reviewer'],
		});

		expect(result.unresolved).toEqual([]);
		expect(result.resolved.map((target) => target.actor)).toEqual([
			expect.objectContaining({
				actorId: `worker:${encodeURIComponent(runId)}:node-review:reviewer`,
				status: 'inactive',
			}),
		]);
	});

	it('includes declared worker slots for node-role targets', async () => {
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'node-coding', agentName: 'coder' }
		);
		const result = await resolver.resolveTargets({
			...message,
			targets: ['@role:node-deploy'],
		});

		expect(result.unresolved).toEqual([]);
		expect(result.resolved.map((target) => target.actor)).toEqual([
			expect.objectContaining({
				actorId: `worker:${encodeURIComponent(runId)}:node-deploy:deployer`,
				status: 'inactive',
			}),
		]);
	});

	it('resolves spawned workers for node-name role targets', async () => {
		nodeExecutionRepo.create({
			workflowRunId: runId,
			workflowNodeId: 'node-deploy',
			agentName: 'deployer',
			agentId: spaceAgentRepo.getBySpaceId(spaceId)[0].id,
			agentSessionId: 'deploy-session',
			status: 'in_progress',
		});
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'node-coding', agentName: 'coder' }
		);
		const result = await resolver.resolveTargets({
			...message,
			targets: ['@role:Deploy'],
		});

		expect(result.unresolved).toEqual([]);
		expect(result.resolved.map((target) => target.actor)).toEqual([
			expect.objectContaining({
				actorId: `worker:${encodeURIComponent(runId)}:node-deploy:deployer`,
				status: 'active',
			}),
		]);
	});

	it('includes declared worker slots for encoded agent-role targets', async () => {
		nodeExecutionRepo.delete(
			nodeExecutionRepo
				.listByWorkflowRun(runId)
				.find(
					(execution) =>
						execution.workflowNodeId === 'node-review' && execution.agentName === 'reviewer'
				)!.id
		);
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'node-coding', agentName: 'coder' }
		);
		const result = await resolver.resolveTargets({
			...message,
			targets: ['@role:actor-role:reviewer'],
		});

		expect(result.unresolved).toEqual([]);
		expect(result.resolved.map((target) => target.actor)).toEqual([
			expect.objectContaining({
				actorId: `worker:${encodeURIComponent(runId)}:node-review:reviewer`,
				status: 'inactive',
			}),
		]);
	});

	it('scopes role worker candidates to the message workflow run', async () => {
		nodeExecutionRepo.delete(
			nodeExecutionRepo
				.listByWorkflowRun(runId)
				.find(
					(execution) =>
						execution.workflowNodeId === 'node-review' && execution.agentName === 'reviewer'
				)!.id
		);
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId }
		);
		const result = await resolver.resolveTargets({
			...message,
			targets: ['@role:reviewer'],
		});

		expect(result.unresolved).toEqual([]);
		expect(result.resolved.map((target) => target.actor.actorId)).toEqual([
			`worker:${encodeURIComponent(runId)}:node-qa:reviewer`,
			`worker:${encodeURIComponent(runId)}:node-review:reviewer`,
		]);
		expect(result.resolved.every((target) => target.actor.status === 'inactive')).toBe(true);
	});

	it('queues missing context-selected worker slots instead of unrelated spawned slots', async () => {
		nodeExecutionRepo.delete(
			nodeExecutionRepo
				.listByWorkflowRun(runId)
				.find(
					(execution) =>
						execution.workflowNodeId === 'node-review' && execution.agentName === 'reviewer'
				)!.id
		);
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'node-coding', agentName: 'reviewer' }
		);
		const result = await resolver.resolveTargets({
			...message,
			targets: ['@worker:Review'],
		});

		expect(result.unresolved).toEqual([]);
		expect(result.resolved.map((target) => target.actor)).toEqual([
			expect.objectContaining({
				actorId: `worker:${encodeURIComponent(runId)}:node-review:reviewer`,
				status: 'inactive',
			}),
		]);
	});

	it('rejects ambiguous worker node shorthand based on declared slots', async () => {
		nodeExecutionRepo.delete(
			nodeExecutionRepo
				.listByWorkflowRun(runId)
				.find(
					(execution) =>
						execution.workflowNodeId === 'node-review' && execution.agentName === 'reviewer'
				)!.id
		);
		for (const agentName of [undefined, 'coder']) {
			const resolver = new SpaceMessageResolver(
				{ actorRegistry: registry, workflowRepo, workflowRunRepo },
				{ spaceId, workflowRunId: runId, nodeId: 'node-coding', agentName }
			);
			const result = await resolver.resolveTargets({
				...message,
				workflowRunId: undefined,
				targets: ['@worker:Review'],
			});

			expect(result.resolved).toEqual([]);
			expect(result.unresolved.map((target) => target.reason)).toEqual([
				'Worker target @worker:Review is ambiguous; specify @worker:<node>/<agent>',
			]);
		}
	});

	it('does not synthesize declared role workers over archived executions', async () => {
		nodeExecutionRepo.updateStatus(
			nodeExecutionRepo
				.listByWorkflowRun(runId)
				.find(
					(execution) =>
						execution.workflowNodeId === 'node-review' && execution.agentName === 'reviewer'
				)!.id,
			'cancelled'
		);
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'node-coding', agentName: 'coder' }
		);
		const result = await resolver.resolveTargets({
			...message,
			targets: ['@role:reviewer'],
		});

		expect(result.resolved).toEqual([]);
		expect(result.unresolved.map((target) => target.reason)).toEqual([
			'No routable actor found for role reviewer',
		]);
	});

	it('returns unresolved deliveries for malformed worker escapes', async () => {
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'node-coding', agentName: 'coder' }
		);
		const facade = new SpaceDeliveryFacade({ resolver });
		const result = await facade.routeMessage({
			...message,
			targets: ['@worker:%/reviewer', '@worker:Review/reviewer', '@worker:%/reviewer'],
		});

		expect(result.deliveries).toHaveLength(3);
		expect(result.deliveries[0]).toMatchObject({
			targetRef: '@worker:Review/reviewer',
			state: 'queued',
		});
		expect(result.deliveries[1]).toMatchObject({
			targetRef: '@worker:%/reviewer',
			state: 'failed',
			lastError: 'Invalid worker target escape in @worker:%/reviewer',
		});
		expect(result.deliveries[2]).toMatchObject({
			targetRef: '@worker:%/reviewer',
			state: 'failed',
			lastError: 'Invalid worker target escape in @worker:%/reviewer',
		});
		expect(new Set(result.deliveries.map((delivery) => delivery.deliveryId)).size).toBe(
			result.deliveries.length
		);
	});

	it('maps pending_agent_messages rows into message and delivery facade records', () => {
		const pending = pendingMessageRepo.enqueue({
			workflowRunId: runId,
			spaceId,
			taskId: 'task-1',
			sourceAgentName: 'coder',
			targetKind: 'node_agent',
			targetAgentName: 'reviewer',
			message: 'queued review',
			idempotencyKey: 'idem-1',
		}).record;

		const actors = registry.listActors(spaceId);
		const mappedMessage = pendingMessageToMessageRecord(pending, actors);
		const deliveries = pendingMessageToDeliveryRecords(pending, actors);

		expect(mappedMessage).toMatchObject({
			messageId: `msg_legacy_${pending.id}`,
			spaceId,
			targets: ['reviewer'],
			body: 'queued review',
			workflowRunId: runId,
			taskId: 'task-1',
			idempotencyKey: 'idem-1',
		});
		expect(deliveries.map((delivery) => delivery.targetActorId)).toEqual([
			`worker:${encodeURIComponent(runId)}:node-qa:reviewer`,
			`worker:${encodeURIComponent(runId)}:node-review:reviewer`,
		]);
		expect(deliveries.every((delivery) => delivery.state === 'queued')).toBe(true);
	});

	it('includes unspawned declared slots in pending legacy fan-out', () => {
		nodeExecutionRepo.delete(
			nodeExecutionRepo
				.listByWorkflowRun(runId)
				.find(
					(execution) =>
						execution.workflowNodeId === 'node-review' && execution.agentName === 'reviewer'
				)!.id
		);
		const pending = pendingMessageRepo.enqueue({
			workflowRunId: runId,
			spaceId,
			taskId: 'task-1',
			sourceAgentName: 'coder',
			targetKind: 'node_agent',
			targetAgentName: 'reviewer',
			message: 'queued review',
		}).record;

		const actors = registry.listActors(spaceId);
		const workflow = workflowRepo.getWorkflow(workflowRunRepo.getRun(runId)!.workflowId)!;
		const deliveries = pendingMessageToDeliveryRecords(pending, actors, workflow);

		expect(deliveries.map((delivery) => delivery.targetActorId)).toEqual([
			`worker:${encodeURIComponent(runId)}:node-qa:reviewer`,
			`worker:${encodeURIComponent(runId)}:node-review:reviewer`,
		]);
		expect(deliveries.every((delivery) => delivery.state === 'queued')).toBe(true);
	});

	it('maps legacy senders and terminal deliveries without inventing actors', () => {
		const observerExecution = nodeExecutionRepo
			.listByWorkflowRun(runId)
			.find(
				(execution) =>
					execution.workflowNodeId === 'node-review' && execution.agentName === 'observer'
			)!;
		nodeExecutionRepo.updateStatus(observerExecution.id, 'cancelled');
		const actors = registry.listActors(spaceId);
		const queued = pendingMessageRepo.enqueue({
			workflowRunId: runId,
			spaceId,
			taskId: 'task-1',
			sourceAgentName: 'coder',
			targetKind: 'node_agent',
			targetAgentName: 'reviewer',
			message: 'queued review',
		}).record;
		const archivedSender = pendingMessageToMessageRecord(
			{
				...queued,
				sourceAgentName: 'observer',
				targetAgentName: 'reviewer',
			},
			actors
		);
		expect(archivedSender.senderActorId).toBe(
			`worker:${encodeURIComponent(runId)}:node-review:observer`
		);

		const mappedWorkerSender = pendingMessageToMessageRecord(queued, actors);
		expect(mappedWorkerSender.senderActorId).toBe(
			`worker:${encodeURIComponent(runId)}:node-coding:coder`
		);

		const coordinator = pendingMessageToMessageRecord(
			{ ...queued, sourceAgentName: 'coordinator' },
			actors
		);
		expect(coordinator.senderActorId).toBe(`agent:coordinator:${spaceId}`);

		nodeExecutionRepo.updateStatus(
			nodeExecutionRepo
				.listByWorkflowRun(runId)
				.find(
					(execution) =>
						execution.workflowNodeId === 'node-review' && execution.agentName === 'reviewer'
				)!.id,
			'cancelled'
		);
		const actorsWithArchivedReviewer = registry.listActors(spaceId);
		const delivered = {
			...queued,
			targetAgentName: 'observer',
			status: 'delivered' as const,
			deliveredSessionId: 'observer',
			deliveredAt: Date.now(),
		};
		expect(pendingMessageToDeliveryRecords(delivered, actorsWithArchivedReviewer)).toEqual([
			expect.objectContaining({
				targetActorId: `worker:${encodeURIComponent(runId)}:node-review:observer`,
				state: 'delivered',
			}),
		]);

		const failed = { ...queued, status: 'failed' as const };
		expect(pendingMessageToDeliveryRecords(failed, actors)).toEqual([
			expect.objectContaining({ targetActorId: undefined, state: 'failed' }),
		]);
	});

	it('preserves terminal coordinator delivery targets', () => {
		sessionRepo.createSession({
			id: `space:chat:${spaceId}`,
			title: 'Space chat',
			workspacePath: '/workspace/project',
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'archived',
			config: {},
			metadata: {
				messageCount: 0,
				totalTokens: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalCost: 0,
				toolCallCount: 0,
			},
			type: 'space_chat',
			context: { spaceId },
		});
		const actors = registry.listActors(spaceId);
		const queued = pendingMessageRepo.enqueue({
			workflowRunId: runId,
			spaceId,
			sourceAgentName: 'coder',
			targetKind: 'space_agent',
			targetAgentName: 'coordinator',
			message: 'terminal escalation',
		}).record;
		const delivered = {
			...queued,
			status: 'delivered' as const,
			deliveredSessionId: `space:chat:${spaceId}`,
			deliveredAt: Date.now(),
		};

		expect(pendingMessageToDeliveryRecords(delivered, actors)).toEqual([
			expect.objectContaining({
				targetActorId: `agent:coordinator:${spaceId}`,
				state: 'delivered',
			}),
		]);
	});
});
