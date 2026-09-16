import { parseAddress } from '../../../../messaging/src/address.ts';
import type { ParsedAddress, WorkerAddress } from '../../../../messaging/src/address.ts';
import type { ActorRef, MessageRecord } from '../../../../messaging/src/types.ts';
import type {
  ActorResolver,
  ResolvedTarget,
  ResolveTargetsResult,
  UnresolvedTarget,
} from '../../../../messaging/src/contracts.ts';
import type { SpaceWorkflowRepository } from '../../storage/repositories/space-workflow-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository.ts';
import type { SpaceWorkflow } from '@hyperneo/shared';
import {
  actorRole,
  canSendToWorkerTarget,
  decodeAddressComponent,
  isRoutable,
  parseWorkerActorId,
  stableActors,
  uniqueStrings,
  workerActorId,
  workerHandle,
  workflowNodeId,
  workflowNodeName,
} from './actor-address.ts';
import type { SpaceActorRegistryAdapter } from './actor-registry.ts';

export type { SpaceDeliveryFacadeConfig } from './delivery-facade.ts';
export { SpaceDeliveryFacade } from './delivery-facade.ts';
export type {
  LegacyNodeTargetTranslatorConfig,
  TaskMessageTargetTranslatorConfig,
} from './target-translation.ts';
export { translateLegacyNodeTargets, translateTaskMessageTarget } from './target-translation.ts';

export interface SpaceMessageResolverContext {
  spaceId: string;
  workflowRunId?: string;
  nodeId?: string;
  agentName?: string;
}

export interface SpaceMessageResolverConfig {
  actorRegistry: SpaceActorRegistryAdapter;
  workflowRepo: SpaceWorkflowRepository;
  workflowRunRepo: SpaceWorkflowRunRepository;
}

export class SpaceMessageResolver implements ActorResolver {
  constructor(
    private readonly config: SpaceMessageResolverConfig,
    private readonly context: SpaceMessageResolverContext
  ) {}

  async resolveTargets(message: MessageRecord): Promise<ResolveTargetsResult> {
    const resolved: ResolvedTarget[] = [];
    const unresolved: UnresolvedTarget[] = [];
    const seen = new Set<string>();

    if (message.spaceId !== this.context.spaceId) {
      return {
        resolved,
        unresolved: message.targets.map((targetRef) => ({
          targetRef,
          reason: `Message space ${message.spaceId} does not match resolver space ${this.context.spaceId}`,
        })),
      };
    }

    if (
      this.context.workflowRunId &&
      message.workflowRunId &&
      message.workflowRunId !== this.context.workflowRunId
    ) {
      return {
        resolved,
        unresolved: message.targets.map((targetRef) => ({
          targetRef,
          reason: `Message workflowRunId ${message.workflowRunId} does not match resolver workflowRunId ${this.context.workflowRunId}`,
        })),
      };
    }

    for (const targetRef of message.targets) {
      let address: ParsedAddress;
      try {
        address = parseAddress(targetRef);
      } catch (error) {
        unresolved.push({
          targetRef,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const result = this.resolveAddress(targetRef, address, message);
      for (const actor of result.actors) {
        const key = `${targetRef}\0${actor.actorId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        resolved.push({ targetRef, address, actor });
      }
      if (result.reason) {
        unresolved.push({ targetRef, address, reason: result.reason });
      }
    }

    return { resolved, unresolved };
  }

  private resolveAddress(
    targetRef: string,
    address: ParsedAddress,
    message: MessageRecord
  ): { actors: ActorRef[]; reason?: string } {
    const spaceId = message.spaceId || this.context.spaceId;
    const actors = this.config.actorRegistry.listActors(spaceId);

    switch (address.kind) {
      case 'handle': {
        const handle = `@${address.handle}`;
        const matches = actors.filter((actor) => actor.handle === handle && isRoutable(actor));
        return matches.length > 0
          ? { actors: stableActors(matches) }
          : { actors: [], reason: `No routable actor found for handle ${handle}` };
      }
      case 'role': {
        const role = actorRole(address.role);
        const workflowRunId = message.workflowRunId ?? this.context.workflowRunId;
        const holders = this.permitRoleActors([
          ...actors.filter((actor) => this.actorHasRole(actor, address.role, role, workflowRunId)),
          ...this.declaredRoleActors(workflowRunId, address.role, actors),
        ]);
        const active = holders.filter((actor) => actor.status === 'active');
        const inactive = holders.filter((actor) => actor.status === 'inactive');
        const routable = active.length > 0 ? active : inactive;
        return routable.length > 0
          ? { actors: stableActors(routable) }
          : { actors: [], reason: `No routable actor found for role ${address.role}` };
      }
      case 'session': {
        const actorId = `session:${address.sessionId}`;
        const actor = actors.find(
          (candidate) => candidate.actorId === actorId && isRoutable(candidate)
        );
        return actor
          ? { actors: [actor] }
          : { actors: [], reason: `No routable session actor found for ${address.sessionId}` };
      }
      case 'worker':
        return this.resolveWorker(targetRef, address, message, actors);
      case 'channel':
        return {
          actors: [],
          reason: `Channel targets are not enabled in Space messaging v1: #${address.name}`,
        };
    }
  }

  private resolveWorker(
    targetRef: string,
    address: WorkerAddress,
    message: MessageRecord,
    actors: ActorRef[]
  ): { actors: ActorRef[]; reason?: string } {
    const workflowRunId =
      address.workflowRunId ?? message.workflowRunId ?? this.context.workflowRunId;
    if (!workflowRunId) {
      return {
        actors: [],
        reason: `Worker target ${targetRef} requires workflowRunId or @worker:<run>/<node>/<agent>`,
      };
    }

    const workflow = this.workflowForRun(workflowRunId);
    const nodeId = decodeAddressComponent(address.nodeId, targetRef);
    if (!nodeId.ok) return { actors: [], reason: nodeId.reason };
    const targetNodeId = workflowNodeId(workflow?.nodes ?? [], nodeId.value) ?? nodeId.value;
    const agentName = address.agentName
      ? decodeAddressComponent(address.agentName, targetRef)
      : undefined;
    if (agentName && !agentName.ok) return { actors: [], reason: agentName.reason };
    const workerActors = actors.filter(
      (actor) =>
        actor.kind === 'worker' &&
        parseWorkerActorId(actor.actorId)?.workflowRunId === workflowRunId
    );
    const matches = workerActors.filter((actor) => {
      const parsed = parseWorkerActorId(actor.actorId);
      if (!parsed) return false;
      if (parsed.nodeId !== targetNodeId) return false;
      return agentName ? parsed.agentName === agentName.value : true;
    });
    const declaredAgentName = this.declaredAgentName(workflow, targetNodeId, agentName?.value);
    const declaredAgentNames = this.declaredAgentNames(workflow, targetNodeId);
    if (declaredAgentName) {
      const declared = this.declaredWorkerActor(workflowRunId, targetNodeId, declaredAgentName);
      const hasDeclared = matches.some((actor) => actor.actorId === declared?.actorId);
      if (declared && !hasDeclared) matches.push(declared);
    }
    let routable = matches.filter(isRoutable);
    if (!agentName && declaredAgentNames.length > 1 && !declaredAgentName) {
      return {
        actors: [],
        reason: `Worker target ${targetRef} is ambiguous; specify @worker:<node>/<agent>`,
      };
    }
    if (!agentName && this.context.agentName) {
      const contextMatches = routable.filter(
        (actor) => parseWorkerActorId(actor.actorId)?.agentName === this.context.agentName
      );
      if (contextMatches.length > 0 || declaredAgentName === this.context.agentName) {
        routable = contextMatches;
      }
    }
    if (routable.length === 0) {
      return { actors: [], reason: `No routable worker actor found for ${targetRef}` };
    }
    if (!agentName && routable.length > 1) {
      return {
        actors: [],
        reason: `Worker target ${targetRef} is ambiguous; specify @worker:<node>/<agent>`,
      };
    }

    const permitted = routable.filter((actor) =>
      this.canSendToWorker(workflowRunId, actor, address)
    );
    if (permitted.length === 0) {
      return {
        actors: [],
        reason: `Channel topology does not permit worker target ${targetRef}`,
      };
    }
    return { actors: stableActors(permitted) };
  }

  private actorHasRole(
    actor: ActorRef,
    role: string,
    encodedRole: string,
    workflowRunId: string | undefined
  ): boolean {
    if (actor.kind !== 'worker') {
      return actor.roles?.includes(role) || actor.roles?.includes(encodedRole) || false;
    }
    const parsed = parseWorkerActorId(actor.actorId);
    if (!parsed) return false;
    if (workflowRunId && parsed.workflowRunId !== workflowRunId) return false;
    return Boolean(
      actor.roles?.includes(role) ||
        actor.roles?.includes(encodedRole) ||
        this.workerNodeMatchesRole(workflowRunId ?? parsed.workflowRunId, parsed.nodeId, role)
    );
  }

  private permitRoleActors(actors: ActorRef[]): ActorRef[] {
    if (!this.context.workflowRunId || !this.context.nodeId) return actors;
    return actors.filter((actor) => {
      if (actor.kind !== 'worker') return true;
      const parsed = parseWorkerActorId(actor.actorId);
      if (!parsed || parsed.workflowRunId !== this.context.workflowRunId) return false;
      return this.canSendToWorker(this.context.workflowRunId!, actor);
    });
  }

  private canSendToWorker(
    workflowRunId: string,
    actor: ActorRef,
    address?: WorkerAddress
  ): boolean {
    const run = this.config.workflowRunRepo.getRun(workflowRunId);
    if (!run || run.spaceId !== this.context.spaceId) return false;
    const workflow = this.config.workflowRepo.getWorkflowForRun(run);
    if (!workflow) return false;
    const parsed = parseWorkerActorId(actor.actorId);
    if (!parsed) return false;

    if (address?.workflowRunId && !this.context.nodeId) return true;

    const fromNodeName = workflowNodeName(workflow.nodes, this.context.nodeId);
    const targetNodeName = workflowNodeName(workflow.nodes, parsed.nodeId);
    if (!fromNodeName || !targetNodeName) return false;
    if (!workflow.channels || workflow.channels.length === 0) return false;
    return canSendToWorkerTarget(
      workflow.channels,
      [fromNodeName, this.context.agentName],
      [targetNodeName, parsed.agentName]
    );
  }

  private declaredRoleActors(
    workflowRunId: string | undefined,
    role: string,
    actors: ActorRef[]
  ): ActorRef[] {
    if (!workflowRunId) return [];
    const workflow = this.workflowForRun(workflowRunId);
    if (!workflow) return [];
    return workflow.nodes.flatMap((node) =>
      node.agents
        .filter(
          (agent) =>
            agent.name === role ||
            actorRole(agent.name) === role ||
            node.id === role ||
            node.name === role ||
            actorRole(node.id) === role ||
            actorRole(node.name) === role
        )
        .map((agent) => {
          const actorId = workerActorId(workflowRunId, node.id, agent.name);
          if (actors.some((actor) => actor.actorId === actorId)) return null;
          return this.declaredWorkerActor(workflowRunId, node.id, agent.name);
        })
        .filter((actor): actor is ActorRef => Boolean(actor))
    );
  }

  private workerNodeMatchesRole(workflowRunId: string, nodeId: string, role: string): boolean {
    const workflow = this.workflowForRun(workflowRunId);
    const node = workflow?.nodes.find((candidate) => candidate.id === nodeId);
    return Boolean(
      node &&
        (node.id === role ||
          node.name === role ||
          actorRole(node.id) === role ||
          actorRole(node.name) === role)
    );
  }

  private declaredWorkerActor(
    workflowRunId: string,
    nodeId: string,
    agentName: string | undefined
  ): ActorRef | null {
    if (!agentName) return null;
    const workflow = this.workflowForRun(workflowRunId);
    const node = workflow?.nodes.find((candidate) => candidate.id === nodeId);
    if (!node?.agents.some((agent) => agent.name === agentName)) return null;
    return {
      actorId: workerActorId(workflowRunId, nodeId, agentName),
      kind: 'worker',
      spaceId: this.context.spaceId,
      handle: workerHandle(workflowRunId, nodeId, agentName),
      roles: uniqueStrings([actorRole(agentName), actorRole(nodeId)]),
      status: 'inactive',
    };
  }

  private declaredAgentName(
    workflow: SpaceWorkflow | null,
    nodeId: string,
    explicitAgentName: string | undefined
  ): string | undefined {
    const agentNames = this.declaredAgentNames(workflow, nodeId);
    if (agentNames.length === 0) return explicitAgentName;
    if (explicitAgentName)
      return agentNames.includes(explicitAgentName) ? explicitAgentName : undefined;
    if (this.context.agentName && agentNames.includes(this.context.agentName)) {
      return this.context.agentName;
    }
    return agentNames.length === 1 ? agentNames[0] : undefined;
  }

  private declaredAgentNames(workflow: SpaceWorkflow | null, nodeId: string): string[] {
    const node = workflow?.nodes.find((candidate) => candidate.id === nodeId);
    return node?.agents.map((agent) => agent.name) ?? [];
  }

  private workflowForRun(workflowRunId: string) {
    const run = this.config.workflowRunRepo.getRun(workflowRunId);
    if (!run || run.spaceId !== this.context.spaceId) return null;
    return this.config.workflowRepo.getWorkflowForRun(run) ?? null;
  }
}
