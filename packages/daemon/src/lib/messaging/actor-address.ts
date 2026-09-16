import type { WorkflowChannel, WorkflowNode } from '@hyperneo/shared';
import type { ActorRef } from '../../../../messaging/src/types.ts';
import { ChannelResolver } from './channel-resolver.ts';

export function workerTarget(workflowRunId: string, nodeName: string, agentName: string): string {
  return `@worker:${encodeURIComponent(workflowRunId)}/${encodeURIComponent(nodeName)}/${encodeURIComponent(agentName)}`;
}

export function isRoutable(actor: ActorRef): boolean {
  return actor.status === 'active' || actor.status === 'inactive';
}

export function stableActors(actors: ActorRef[]): ActorRef[] {
  return [...actors].sort((left, right) => left.actorId.localeCompare(right.actorId));
}

export function actorRole(role: string): string {
  return `actor-role:${encodeURIComponent(role)}`;
}

export function workflowNodeId(nodes: WorkflowNode[], nodeRef: string): string | null {
  const node = nodes.find((candidate) => candidate.id === nodeRef || candidate.name === nodeRef);
  return node?.id ?? null;
}

export function workflowNodeName(nodes: WorkflowNode[], nodeId: string | undefined): string | null {
  if (!nodeId) return null;
  const node = nodes.find((candidate) => candidate.id === nodeId || candidate.name === nodeId);
  return node?.name ?? null;
}

export function canSendToWorkerTarget(
  channels: WorkflowChannel[],
  fromRefs: Array<string | undefined>,
  toRefs: Array<string | undefined>
): boolean {
  const resolver = new ChannelResolver(channels);
  for (const from of uniqueStrings(fromRefs)) {
    for (const to of uniqueStrings(toRefs)) {
      if (resolver.canSend(from, to)) return true;
    }
  }
  return false;
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function decodeAddressComponent(
  component: string,
  targetRef: string
): { ok: true; value: string } | { ok: false; reason: string } {
  try {
    return { ok: true, value: decodeURIComponent(component) };
  } catch (error) {
    if (error instanceof URIError) {
      return { ok: false, reason: `Invalid worker target escape in ${targetRef}` };
    }
    throw error;
  }
}

export function workerActorId(workflowRunId: string, nodeId: string, agentName: string): string {
  return `worker:${[workflowRunId, nodeId, agentName].map(encodeURIComponent).join(':')}`;
}

export function workerHandle(workflowRunId: string, nodeId: string, agentName: string): string {
  return `@worker:${[workflowRunId, nodeId, agentName].map(encodeURIComponent).join('/')}`;
}

export function parseWorkerActorId(
  actorId: string
): { workflowRunId: string; nodeId: string; agentName: string } | null {
  if (!actorId.startsWith('worker:')) return null;
  const parts = actorId.slice('worker:'.length).split(':');
  if (parts.length !== 3) return null;
  return {
    workflowRunId: decodeURIComponent(parts[0]),
    nodeId: decodeURIComponent(parts[1]),
    agentName: decodeURIComponent(parts[2]),
  };
}
