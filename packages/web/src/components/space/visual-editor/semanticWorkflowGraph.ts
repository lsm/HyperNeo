import type { WorkflowChannel } from '@hyperneo/shared';
import { getVisualNodeDimensions } from './nodeMetrics';
import type { VisualNode } from './serialization';

export type AnchorSide = 'top' | 'bottom' | 'left' | 'right';

export interface SemanticWorkflowEdge {
  id: string;
  fromStepId: string;
  toStepId: string;
  channelCount: number;
  hasCyclic: boolean;
  direction: 'one-way' | 'bidirectional';
  channelIndexes: number[];
}

export interface RoutedSemanticWorkflowEdge extends SemanticWorkflowEdge {
  sourceSide: AnchorSide;
  targetSide: AnchorSide;
}

interface PairAggregate {
  lowId: string;
  highId: string;
  lowToHigh: boolean;
  highToLow: boolean;
  channelCount: number;
  hasCyclic: boolean;
  channelIndexes: Set<number>;
}

function buildEndpointNodeLookup(nodes: VisualNode[]): Map<string, string> {
  const lookup = new Map<string, string>();

  for (const node of nodes) {
    if (node.step.agentId) {
      lookup.set(node.step.agentId, node.step.localId);
    }

    if (node.step.name) {
      lookup.set(node.step.name, node.step.localId);
    }

    for (const agent of node.step.agents ?? []) {
      if (agent.name) {
        lookup.set(agent.name, node.step.localId);
      }
      if (agent.agentId) {
        lookup.set(agent.agentId, node.step.localId);
      }
    }
  }

  return lookup;
}

export function buildSemanticWorkflowEdges(
  nodes: VisualNode[],
  channels: WorkflowChannel[],
  cyclicChannelIndexes?: Set<number>
): SemanticWorkflowEdge[] {
  const endpointLookup = buildEndpointNodeLookup(nodes);
  const nodeOrder = new Map(nodes.map((node, index) => [node.step.localId, index]));
  const aggregates = new Map<string, PairAggregate>();

  for (const [channelIndex, channel] of channels.entries()) {
    if (channel.from === '*') continue;

    const fromStepId = endpointLookup.get(channel.from);
    if (!fromStepId) continue;

    const targets = Array.isArray(channel.to) ? channel.to : [channel.to];
    for (const rawTarget of targets) {
      if (rawTarget === '*') continue;

      const toStepId = endpointLookup.get(rawTarget);
      if (!toStepId || toStepId === fromStepId) continue;

      const fromOrder = nodeOrder.get(fromStepId) ?? Number.MAX_SAFE_INTEGER;
      const toOrder = nodeOrder.get(toStepId) ?? Number.MAX_SAFE_INTEGER;
      const fromIsLow =
        fromOrder < toOrder || (fromOrder === toOrder && fromStepId.localeCompare(toStepId) <= 0);
      const lowId = fromIsLow ? fromStepId : toStepId;
      const highId = fromIsLow ? toStepId : fromStepId;
      const pairKey = `${lowId}::${highId}`;

      const aggregate = aggregates.get(pairKey) ?? {
        lowId,
        highId,
        lowToHigh: false,
        highToLow: false,
        channelCount: 0,
        hasCyclic: false,
        channelIndexes: new Set<number>(),
      };

      aggregate.channelCount += 1;
      if (cyclicChannelIndexes?.has(channelIndex)) {
        aggregate.hasCyclic = true;
      }
      aggregate.channelIndexes.add(channelIndex);

      if (fromIsLow) {
        aggregate.lowToHigh = true;
      } else {
        aggregate.highToLow = true;
      }

      aggregates.set(pairKey, aggregate);
    }
  }

  return Array.from(aggregates.values()).map((aggregate) => {
    if (aggregate.lowToHigh && aggregate.highToLow) {
      return {
        id: `${aggregate.lowId}:${aggregate.highId}`,
        fromStepId: aggregate.lowId,
        toStepId: aggregate.highId,
        direction: 'bidirectional' as const,
        channelCount: aggregate.channelCount,
        hasCyclic: aggregate.hasCyclic,
        channelIndexes: Array.from(aggregate.channelIndexes),
      };
    }

    if (aggregate.lowToHigh) {
      return {
        id: `${aggregate.lowId}:${aggregate.highId}`,
        fromStepId: aggregate.lowId,
        toStepId: aggregate.highId,
        direction: 'one-way' as const,
        channelCount: aggregate.channelCount,
        hasCyclic: aggregate.hasCyclic,
        channelIndexes: Array.from(aggregate.channelIndexes),
      };
    }

    return {
      id: `${aggregate.highId}:${aggregate.lowId}`,
      fromStepId: aggregate.highId,
      toStepId: aggregate.lowId,
      direction: 'one-way' as const,
      channelCount: aggregate.channelCount,
      hasCyclic: aggregate.hasCyclic,
      channelIndexes: Array.from(aggregate.channelIndexes),
    };
  });
}

export function routeSemanticWorkflowEdges(
  nodes: VisualNode[],
  semanticEdges: SemanticWorkflowEdge[]
): RoutedSemanticWorkflowEdge[] {
  const positionByNodeId = new Map(
    nodes.map((node) => {
      const { width, height } = getVisualNodeDimensions(node.step);
      return [
        node.step.localId,
        {
          centerX: node.position.x + width / 2,
          centerY: node.position.y + height / 2,
        },
      ];
    })
  );

  return semanticEdges.map((edge) => {
    const from = positionByNodeId.get(edge.fromStepId);
    const to = positionByNodeId.get(edge.toStepId);

    if (!from || !to) {
      return {
        ...edge,
        sourceSide: 'bottom',
        targetSide: 'top',
      };
    }

    const dx = to.centerX - from.centerX;
    const dy = to.centerY - from.centerY;

    const horizontalDominant = Math.abs(dx) > Math.abs(dy) * 0.85;
    if (horizontalDominant) {
      return {
        ...edge,
        sourceSide: dx >= 0 ? 'right' : 'left',
        targetSide: dx >= 0 ? 'left' : 'right',
      };
    }

    return {
      ...edge,
      sourceSide: dy >= 0 ? 'bottom' : 'top',
      targetSide: dy >= 0 ? 'top' : 'bottom',
    };
  });
}

export function buildNodeAnchorUsage(
  routedEdges: RoutedSemanticWorkflowEdge[]
): Map<string, AnchorSide[]> {
  const usage = new Map<string, Set<AnchorSide>>();

  for (const edge of routedEdges) {
    const fromSet = usage.get(edge.fromStepId) ?? new Set<AnchorSide>();
    fromSet.add(edge.sourceSide);
    usage.set(edge.fromStepId, fromSet);

    const toSet = usage.get(edge.toStepId) ?? new Set<AnchorSide>();
    toSet.add(edge.targetSide);
    usage.set(edge.toStepId, toSet);
  }

  return new Map(Array.from(usage.entries()).map(([nodeId, sides]) => [nodeId, Array.from(sides)]));
}
