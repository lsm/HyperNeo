import type { WorkflowChannel, WorkflowNode } from '../types/space.ts';

export function buildEndpointNodeIdLookup(nodes: WorkflowNode[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of nodes) {
    if (node.id) map.set(node.id, node.id);
    if (node.name) map.set(node.name, node.id);
  }
  return map;
}

export function buildNodeOrder(nodes: WorkflowNode[]): Map<string, number> {
  return new Map(nodes.map((node, index) => [node.id, index]));
}

function resolveChannelTargetNodeIds(
  channel: WorkflowChannel,
  endpointLookup: Map<string, string>
): string[] {
  const targets = Array.isArray(channel.to) ? channel.to : [channel.to];
  return targets
    .map((target) => endpointLookup.get(target) ?? null)
    .filter((nodeId): nodeId is string => !!nodeId);
}

function doesPathExist(
  channels: WorkflowChannel[],
  endpointLookup: Map<string, string>,
  startNodeId: string,
  targetNodeId: string,
  ignoreChannelIndex?: number
): boolean {
  if (startNodeId === targetNodeId) return true;

  const adjacency = new Map<string, Set<string>>();
  for (const [index, channel] of channels.entries()) {
    if (ignoreChannelIndex === index) continue;

    const fromNodeId = endpointLookup.get(channel.from);
    if (!fromNodeId) continue;

    for (const toNodeId of resolveChannelTargetNodeIds(channel, endpointLookup)) {
      if (toNodeId === fromNodeId) continue;
      const targets = adjacency.get(fromNodeId) ?? new Set<string>();
      targets.add(toNodeId);
      adjacency.set(fromNodeId, targets);
    }
  }

  const visited = new Set<string>();
  const queue = [startNodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === targetNodeId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        queue.push(next);
      }
    }
  }

  return false;
}

export function isChannelCyclic(
  channelIndex: number,
  channels: WorkflowChannel[],
  nodes: WorkflowNode[],
  endpointLookup?: Map<string, string>,
  nodeOrder?: Map<string, number>,
  ignoreChannelIndex?: number
): boolean {
  const channel = channels[channelIndex];
  if (!channel) return false;

  const lookup = endpointLookup ?? buildEndpointNodeIdLookup(nodes);
  const order = nodeOrder ?? buildNodeOrder(nodes);

  const fromNodeId = lookup.get(channel.from);
  if (!fromNodeId) return false;

  for (const toNodeId of resolveChannelTargetNodeIds(channel, lookup)) {
    if (toNodeId === fromNodeId) continue;
    const fromOrder = order.get(fromNodeId) ?? Number.MAX_SAFE_INTEGER;
    const toOrder = order.get(toNodeId) ?? Number.MAX_SAFE_INTEGER;
    if (toOrder > fromOrder) continue;
    if (doesPathExist(channels, lookup, toNodeId, fromNodeId, ignoreChannelIndex)) {
      return true;
    }
  }

  return false;
}

export function getCyclicChannelIndexes(
  channels: WorkflowChannel[],
  nodes: WorkflowNode[]
): Set<number> {
  const lookup = buildEndpointNodeIdLookup(nodes);
  const order = buildNodeOrder(nodes);
  const result = new Set<number>();
  for (let i = 0; i < channels.length; i++) {
    if (isChannelCyclic(i, channels, nodes, lookup, order)) {
      result.add(i);
    }
  }
  return result;
}
