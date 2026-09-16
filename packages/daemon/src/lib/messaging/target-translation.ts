import type { NodeExecution, SpaceWorkflow } from '@hyperneo/shared';
import { parseAddress } from '../../../../messaging/src/address.ts';
import type { ActorRef } from '../../../../messaging/src/types.ts';
import {
  parseWorkerActorId,
  uniqueStrings,
  workerTarget,
  workflowNodeName,
} from './actor-address.ts';
import { ChannelResolver } from './channel-resolver.ts';

export interface LegacyNodeTargetTranslatorConfig {
  spaceId: string;
  workflowRunId: string;
  workflowNodeId: string;
  agentName: string;
  workflow: SpaceWorkflow | null;
  actors?: ActorRef[];
  replyRoutingLookup?: (agentName?: string | null) => string | null;
}

export interface TaskMessageTargetTranslatorConfig {
  workflowRunId: string;
  nodeExecutions: NodeExecution[];
  workflow: SpaceWorkflow | null;
}

export function translateLegacyNodeTargets(
  target: string | string[],
  config: LegacyNodeTargetTranslatorConfig
): string[] {
  const targets = Array.isArray(target) ? target : [target];
  const translated = targets.flatMap((targetRef) => {
    const matches = translateLegacyNodeTarget(targetRef, config);
    if (matches.length === 0) {
      throw new Error(`Unknown target "${targetRef}".`);
    }
    return matches;
  });
  return uniqueStrings(translated);
}

export function translateTaskMessageTarget(
  input: { target?: string | null; nodeId?: string | null },
  config: TaskMessageTargetTranslatorConfig
): string {
  const explicitTarget = input.target?.trim();
  if (explicitTarget) {
    if (explicitTarget === 'task-agent') {
      throw new Error('Target "task-agent" is no longer supported. Use a worker target.');
    }
    const address = parseAddress(explicitTarget);
    if (
      address.kind !== 'worker' &&
      address.kind !== 'session' &&
      address.kind !== 'handle' &&
      address.kind !== 'role'
    ) {
      throw new Error(
        `Generic target ${explicitTarget} is not routable from this tool. Use @handle, @role:<role>, @worker:<node>/<agent>, @worker:<run>/<node>/<agent>, @session:<task-agent-session>, or node_id.`
      );
    }
    return explicitTarget;
  }

  const nodeId = input.nodeId?.trim();
  if (!nodeId) {
    throw new Error('Target is required. Provide target or node_id.');
  }
  if (nodeId === 'task-agent') {
    throw new Error('Target "task-agent" is no longer supported. Use a worker target.');
  }

  const resolved = resolveTaskNodeExecution(config.nodeExecutions, nodeId);
  if (!resolved) {
    throw new Error(`Node not found: "${nodeId}". Expected an execution UUID or agent name.`);
  }
  const nodeName = workflowNodeName(config.workflow?.nodes ?? [], resolved.workflowNodeId);
  if (!nodeName) {
    throw new Error(`Workflow node not found for execution ${resolved.id}.`);
  }
  return workerTarget(config.workflowRunId, nodeName, resolved.agentName);
}

function translateLegacyNodeTarget(
  target: string,
  config: LegacyNodeTargetTranslatorConfig
): string[] {
  const targetRef = target.trim();
  if (!targetRef) return [];
  if (targetRef === 'task-agent') {
    throw new Error('Target "task-agent" is no longer supported. Use a worker target.');
  }
  if (targetRef.startsWith('@') || targetRef.startsWith('#')) {
    parseAddress(targetRef);
    return [targetRef];
  }
  if (targetRef === '*') {
    return permittedWorkerTargets(config);
  }
  return legacyBareTargetMatches(targetRef, config);
}

function permittedWorkerTargets(config: LegacyNodeTargetTranslatorConfig): string[] {
  const workflow = config.workflow;
  if (!workflow) return [];
  const fromNodeName = workflowNodeName(workflow.nodes, config.workflowNodeId);
  if (!fromNodeName) return [];
  const resolver = new ChannelResolver(workflow.channels ?? []);
  return uniqueStrings(
    workflow.nodes.flatMap((node) => {
      if (!resolver.canSend(fromNodeName, node.name)) return [];
      return node.agents.map((agent) => workerTarget(config.workflowRunId, node.name, agent.name));
    })
  );
}

function legacyBareTargetMatches(
  targetRef: string,
  config: LegacyNodeTargetTranslatorConfig
): string[] {
  const workflow = config.workflow;
  if (!workflow) return [];
  const nodeMatches = workflow.nodes
    .filter((node) => node.name === targetRef || node.id === targetRef)
    .flatMap((node) =>
      node.agents.map((agent) => workerTarget(config.workflowRunId, node.name, agent.name))
    );
  if (nodeMatches.length > 0) return uniqueStrings(nodeMatches);

  const actorMatches = (config.actors ?? [])
    .filter((actor) => {
      if (actor.kind !== 'worker') return false;
      const parsed = parseWorkerActorId(actor.actorId);
      return parsed?.workflowRunId === config.workflowRunId && parsed.agentName === targetRef;
    })
    .map((actor) => {
      const parsed = parseWorkerActorId(actor.actorId)!;
      const nodeName = workflowNodeName(workflow.nodes, parsed.nodeId) ?? parsed.nodeId;
      return workerTarget(parsed.workflowRunId, nodeName, parsed.agentName);
    });
  if (actorMatches.length > 0) return uniqueStrings(actorMatches);

  const agentMatches = workflow.nodes.flatMap((node) =>
    node.agents
      .filter((agent) => agent.name === targetRef)
      .map((agent) => workerTarget(config.workflowRunId, node.name, agent.name))
  );
  if (agentMatches.length > 0) return uniqueStrings(agentMatches);

  return [];
}

function resolveTaskNodeExecution(
  executions: NodeExecution[],
  selector: string
): NodeExecution | null {
  const byId = executions.find((execution) => execution.id === selector);
  if (byId) return byId;
  const targetName = selector.toLowerCase();
  const byName = executions.filter((execution) => execution.agentName.toLowerCase() === targetName);
  return byName.at(-1) ?? null;
}
