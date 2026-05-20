import type { ActorRef, ActorStatus } from '../../../../messaging/src/types';
import type { NodeExecution, Session, Space, SpaceAgent, SpaceWorkflow } from '@neokai/shared';
import type { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository';
import type { PendingAgentMessageRepository } from '../../storage/repositories/pending-agent-message-repository';
import type { SessionRepository } from '../../storage/repositories/session-repository';
import type { SpaceAgentRepository } from '../../storage/repositories/space-agent-repository';
import type { SpaceRepository } from '../../storage/repositories/space-repository';
import type { SpaceWorkflowRepository } from '../../storage/repositories/space-workflow-repository';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';
import { encodeActorIdComponent, longTermAgentSessionId } from './long-term-agent-session';

export const SPACE_SYSTEM_ACTORS = [
	{ actorId: 'system:runtime', handle: '@system-runtime', roles: ['runtime'] },
	{ actorId: 'system:workflow', handle: '@system-workflow', roles: ['workflow-runtime'] },
	{ actorId: 'system:messaging', handle: '@system-messaging', roles: ['messaging'] },
] as const;

export interface SpaceActorRegistryRepositories {
	spaceRepo: SpaceRepository;
	sessionRepo: SessionRepository;
	spaceAgentRepo: SpaceAgentRepository;
	workflowRepo: SpaceWorkflowRepository;
	workflowRunRepo: SpaceWorkflowRunRepository;
	nodeExecutionRepo: NodeExecutionRepository;
	pendingMessageRepo?: PendingAgentMessageRepository;
}

export class SpaceActorRegistryAdapter {
	constructor(private readonly repos: SpaceActorRegistryRepositories) {}

	listActors(spaceId: string): ActorRef[] {
		const space = this.repos.spaceRepo.getSpace(spaceId);
		if (!space) return [];

		const actors = new Map<string, ActorRef>();
		const sessions = this.repos.sessionRepo.getSessionsByIds(space.sessionIds);
		for (const session of sessions.values()) {
			if (!isAdHocMemberSession(session)) continue;
			this.add(actors, humanActorForSession(session, space));
			const sessionActor = sessionActorForSession(session, spaceId);
			if (sessionActor) this.add(actors, sessionActor);
		}

		this.add(actors, coordinatorActor(space, this.findCoordinatorSession(spaceId)));

		for (const actor of this.agentActors(spaceId)) {
			this.add(actors, actor);
		}

		const workflowById = new Map<string, SpaceWorkflow>();
		for (const run of this.repos.workflowRunRepo.listBySpace(spaceId)) {
			const workflow =
				workflowById.get(run.workflowId) ?? this.repos.workflowRepo.getWorkflow(run.workflowId);
			if (workflow) workflowById.set(workflow.id, workflow);

			for (const execution of this.repos.nodeExecutionRepo.listByWorkflowRun(run.id)) {
				this.add(actors, workerActorFromExecution(spaceId, execution));
			}
		}

		for (const row of this.repos.pendingMessageRepo?.listPendingForSpace(spaceId) ?? []) {
			if (row.targetKind !== 'node_agent') continue;
			const run = this.repos.workflowRunRepo.getRun(row.workflowRunId);
			const workflow = run
				? (workflowById.get(run.workflowId) ?? this.repos.workflowRepo.getWorkflow(run.workflowId))
				: null;
			if (workflow) workflowById.set(workflow.id, workflow);
			for (const worker of pendingWorkerActors(
				spaceId,
				row.workflowRunId,
				row.targetAgentName,
				workflow
			)) {
				this.add(actors, worker);
			}
		}

		for (const systemActor of SPACE_SYSTEM_ACTORS) {
			this.add(actors, {
				actorId: systemActor.actorId,
				kind: 'system',
				spaceId,
				handle: systemActor.handle,
				roles: [...systemActor.roles],
				status: 'active',
			});
		}

		return [...actors.values()].sort(compareActors);
	}

	getActor(spaceId: string, actorId: string): ActorRef | undefined {
		return this.listActors(spaceId).find((actor) => actor.actorId === actorId);
	}

	private agentActors(spaceId: string): ActorRef[] {
		const agents = this.repos.spaceAgentRepo.getBySpaceId(spaceId);
		const handleCounts = new Map<string, number>();
		for (const handle of reservedHandles()) {
			handleCounts.set(handle, 1);
		}
		for (const agent of agents) {
			const slug = baseHandleSlug(agent.name, agent.id);
			handleCounts.set(slug, (handleCounts.get(slug) ?? 0) + 1);
		}

		return agents.map((agent) =>
			agentActor(agent, handleCounts, this.findLongTermAgentSession(spaceId, agent.id))
		);
	}

	private findLongTermAgentSession(spaceId: string, agentId: string): Session | null {
		const canonicalId = longTermAgentSessionId(spaceId, agentId);
		const canonical = this.repos.sessionRepo.getSession(canonicalId);
		if (canonical && isSessionInSpace(canonical, spaceId)) return canonical;

		return (
			this.repos.sessionRepo
				.listSessionsBySpaceAgent(spaceId, agentId)
				.find((session) => isSessionInSpace(session, spaceId)) ?? null
		);
	}

	private findCoordinatorSession(spaceId: string): Session | null {
		const canonicalId = `space:chat:${spaceId}`;
		const canonical = this.repos.sessionRepo.getSession(canonicalId);
		if (canonical && isSessionInSpace(canonical, spaceId)) return canonical;

		return (
			this.repos.sessionRepo
				.listSessionsByType('space_chat')
				.find((session) => isSessionInSpace(session, spaceId)) ?? null
		);
	}

	private add(actors: Map<string, ActorRef>, actor: ActorRef): void {
		const existing = actors.get(actor.actorId);
		if (!existing) {
			actors.set(actor.actorId, actor);
			return;
		}

		actors.set(actor.actorId, mergeActorRefs(existing, actor));
	}
}

function humanActorForSession(session: Session, space: Space): ActorRef {
	return {
		actorId: `human:${session.id}`,
		kind: 'human',
		spaceId: space.id,
		handle: undefined,
		roles: ['member'],
		status: statusFromSession(session),
	};
}

function coordinatorActor(space: Space, session: Session | null): ActorRef {
	return {
		actorId: `agent:coordinator:${space.id}`,
		kind: 'agent',
		spaceId: space.id,
		handle: '@coordinator',
		roles: ['coordinator', 'space-agent'],
		status: session ? statusFromSession(session) : 'inactive',
	};
}

function sessionActorForSession(session: Session, spaceId: string): ActorRef | null {
	if (!isAdHocMemberSession(session)) return null;

	return {
		actorId: `session:${session.id}`,
		kind: 'session',
		spaceId,
		handle: `@session:${session.id}`,
		roles: ['member-session'],
		status: statusFromSession(session),
	};
}

function agentActor(
	agent: SpaceAgent,
	handleCounts: Map<string, number>,
	session: Session | null
): ActorRef {
	const slug = baseHandleSlug(agent.name, agent.id);
	const handleSlug = handleCounts.get(slug) === 1 ? slug : `${slug}-${shortId(agent.id)}`;
	return {
		actorId: `agent:${encodeActorIdComponent(agent.id)}`,
		kind: 'agent',
		spaceId: agent.spaceId,
		handle: `@${handleSlug}`,
		roles: unique(['space-agent', routingRole(handleSlug)]),
		status: session ? statusFromSession(session) : 'inactive',
	};
}

function workerActorFromExecution(spaceId: string, execution: NodeExecution): ActorRef {
	return {
		actorId: workerActorId(execution.workflowRunId, execution.workflowNodeId, execution.agentName),
		kind: 'worker',
		spaceId,
		handle: workerHandle(execution.workflowRunId, execution.workflowNodeId, execution.agentName),
		roles: unique([routingRole(execution.agentName), routingRole(execution.workflowNodeId)]),
		status: statusFromNodeExecution(execution),
	};
}

function pendingWorkerActors(
	spaceId: string,
	workflowRunId: string,
	targetAgentName: string,
	workflow: SpaceWorkflow | null
): ActorRef[] {
	const nodes =
		workflow?.nodes.filter((node) => node.agents.some((agent) => agent.name === targetAgentName)) ??
		[];
	if (nodes.length === 0) return [];

	const node = nodes[0];
	return [
		{
			actorId: workerActorId(workflowRunId, node.id, targetAgentName),
			kind: 'worker',
			spaceId,
			handle: workerHandle(workflowRunId, node.id, targetAgentName),
			roles: unique([routingRole(targetAgentName), routingRole(node.id)]),
			status: 'inactive',
		},
	];
}

function workerActorId(workflowRunId: string, nodeId: string, agentName: string): string {
	return `worker:${[workflowRunId, nodeId, agentName].map(encodeActorIdComponent).join(':')}`;
}

function workerHandle(workflowRunId: string, nodeId: string, agentName: string): string {
	return `@worker:${encodeWorkerHandleSegment(workflowRunId)}/${encodeWorkerHandleSegment(nodeId)}/${encodeWorkerHandleSegment(agentName)}`;
}

function reservedHandles(): string[] {
	return ['coordinator', ...SPACE_SYSTEM_ACTORS.map((actor) => actor.handle.slice(1))];
}

const ROUTING_ROLE_PREFIX = 'actor-role:';

function routingRole(role: string): string {
	return `${ROUTING_ROLE_PREFIX}${encodeURIComponent(role)}`;
}

function encodeWorkerHandleSegment(value: string): string {
	return encodeURIComponent(value);
}

function isSessionInSpace(session: Session, spaceId: string): boolean {
	if (session.context?.spaceId === spaceId) return true;
	return session.type === 'space_chat' && session.id === `space:chat:${spaceId}`;
}

function isAdHocMemberSession(session: Session): boolean {
	if (session.type === 'space_chat' || session.type === 'space_task_agent') return false;
	if (session.id.includes(':task:') && session.id.includes(':exec:')) return false;
	if (session.metadata.promptProvenance?.workflowRunId) return false;
	return true;
}

function statusFromSession(session: Session): ActorStatus {
	if (session.status === 'archived') return 'archived';
	if (session.status === 'active') return 'active';
	return 'inactive';
}

function statusFromNodeExecution(execution: NodeExecution): ActorStatus {
	if (execution.status === 'cancelled') return 'archived';
	if (execution.status === 'in_progress' || execution.status === 'waiting_rebind') return 'active';
	return 'inactive';
}

function mergeActorRefs(left: ActorRef, right: ActorRef): ActorRef {
	return {
		...left,
		handle: left.handle ?? right.handle,
		roles: unique([...(left.roles ?? []), ...(right.roles ?? [])]),
		status: strongerStatus(left.status, right.status),
	};
}

function strongerStatus(left: ActorStatus, right: ActorStatus): ActorStatus {
	const rank: Record<ActorStatus, number> = {
		active: 3,
		inactive: 2,
		archived: 2,
		deleted: 0,
	};
	return rank[right] > rank[left] ? right : left;
}

function compareActors(left: ActorRef, right: ActorRef): number {
	return left.kind.localeCompare(right.kind) || left.actorId.localeCompare(right.actorId);
}

function unique(values: string[]): string[] {
	return [...new Set(values)].sort();
}

function baseHandleSlug(name: string, id: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug || `agent-${shortId(id)}`;
}

function shortId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'unknown';
}
