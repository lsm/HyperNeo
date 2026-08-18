import type { ActorRef, ActorStatus } from '../../../../messaging/src/types';
import type {
  NodeExecution,
  Session,
  Space,
  SpaceWorkerAgent,
  SpaceLongHorizonAgent,
  SpaceWorkflow,
} from '@hyperneo/shared';
import type { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository';
import type { PendingAgentMessageRepository } from '../../storage/repositories/pending-agent-message-repository';
import type { SessionRepository } from '../../storage/repositories/session-repository';
import type { SpaceAgentRepository } from '../../storage/repositories/space-agent-repository';
import {
  coordinatorLongHorizonAgentId,
  type SpaceLongHorizonAgentRepository,
} from '../../storage/repositories/space-long-horizon-agent-repository';
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
  longHorizonAgentRepo?: SpaceLongHorizonAgentRepository;
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

    const workflowByKey = new Map<string, SpaceWorkflow>();
    const definitionKey = (wfId: string, version: string | null): string =>
      `${wfId}:${version ?? 'head'}`;
    for (const run of this.repos.workflowRunRepo.listBySpace(spaceId)) {
      for (const execution of this.repos.nodeExecutionRepo.listByWorkflowRun(run.id)) {
        this.add(actors, workerActorFromExecution(spaceId, execution));
      }
    }

    for (const row of this.repos.pendingMessageRepo?.listPendingForSpace(spaceId) ?? []) {
      if (row.targetKind !== 'node_agent') continue;
      const run = this.repos.workflowRunRepo.getRun(row.workflowRunId);
      let workflow: SpaceWorkflow | null = null;
      if (run) {
        const key = definitionKey(run.workflowId, run.definitionVersion);
        workflow = workflowByKey.get(key) ?? this.repos.workflowRepo.getWorkflowForRun(run);
        if (workflow) workflowByKey.set(key, workflow);
      }
      for (const worker of pendingWorkerActors(
        spaceId,
        row.workflowRunId,
        row.targetAgentName,
        workflow,
        row.workflowNodeId
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
    const workerActors = this.repos.spaceAgentRepo
      .getBySpaceId(spaceId)
      .map((agent) => agentActor(agent, this.findLongTermAgentSession(spaceId, agent.id)));
    const longHorizonActorById = new Map(
      (this.repos.longHorizonAgentRepo?.listBySpaceId(spaceId) ?? [])
        .filter((agent) => !isCoordinatorLongHorizonAgent(spaceId, agent))
        .map((agent) => [agent.id, longHorizonAgentActor(agent)])
    );
    const workerActorRefs = workerActors.filter((actor) => {
      const agentId = decodeAgentActorId(actor.actorId);
      const longHorizonActor = agentId ? longHorizonActorById.get(agentId) : undefined;
      return !longHorizonActor || longHorizonActor.status === 'active';
    });
    return [...longHorizonActorById.values(), ...workerActorRefs];
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

export function canonicalAgentHandle(
  _agents: SpaceWorkerAgent[],
  agent: SpaceWorkerAgent,
  _reserved: string[] = reservedHandles()
): string {
  return `@${agent.handle}`;
}

function agentActor(agent: SpaceWorkerAgent, session: Session | null): ActorRef {
  const handle = canonicalAgentHandle([], agent);
  return {
    actorId: `agent:${encodeActorIdComponent(agent.id)}`,
    kind: 'agent',
    spaceId: agent.spaceId,
    handle,
    roles: unique(['space-agent', routingRole(agent.handle)]),
    status: session ? statusFromSession(session) : 'inactive',
  };
}

function longHorizonAgentActor(agent: SpaceLongHorizonAgent): ActorRef {
  return {
    actorId: `agent:${encodeActorIdComponent(agent.id)}`,
    kind: 'agent',
    spaceId: agent.spaceId,
    handle: `@${agent.handle}`,
    roles: unique(['space-agent', routingRole(agent.handle)]),
    status: agent.status === 'active' ? 'active' : 'archived',
  };
}

function isCoordinatorLongHorizonAgent(spaceId: string, agent: SpaceLongHorizonAgent): boolean {
  return agent.id === coordinatorLongHorizonAgentId(spaceId);
}

function decodeAgentActorId(actorId: string): string | null {
  if (!actorId.startsWith('agent:')) return null;
  try {
    return decodeURIComponent(actorId.slice('agent:'.length));
  } catch {
    return null;
  }
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
  workflow: SpaceWorkflow | null,
  workflowNodeId?: string | null
): ActorRef[] {
  let nodes =
    workflow?.nodes.filter((node) => node.agents.some((agent) => agent.name === targetAgentName)) ??
    [];
  if (workflowNodeId != null) {
    nodes = nodes.filter((node) => node.id === workflowNodeId);
  }
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
