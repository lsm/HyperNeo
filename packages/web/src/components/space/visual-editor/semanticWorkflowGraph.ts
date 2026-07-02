import type { Gate, WorkflowChannel } from '@hyperneo/shared';
import { getVisualNodeDimensions } from './nodeMetrics';
import type { VisualNode } from './serialization';

export type AnchorSide = 'top' | 'bottom' | 'left' | 'right';

export interface SemanticWorkflowEdge {
  id: string;
  fromStepId: string;
  toStepId: string;
  channelCount: number;
  hasGate: boolean;
  hasCyclic: boolean;
  /**
   * Visual direction derived from the channel topology.
   * 'bidirectional' means channels exist in both directions (rendered as ↔).
   * 'one-way' means a single direction.
   */
  direction: 'one-way' | 'bidirectional';
  /**
   * Gate type for the forward direction (from→to / lowId→highId).
   * For one-way edges this is the only gate. For bidirectional edges
   * it is the gate on the fromStepId→toStepId direction specifically.
   */
  gateType?: 'human' | 'condition' | 'task_result' | 'check' | 'count';
  /** Custom badge label for the forward gate. `undefined` → heuristic fallback. */
  gateLabel?: string;
  /** Custom badge color for the forward gate (hex `#rrggbb`). `undefined` → heuristic fallback. */
  gateColor?: string;
  /** Whether the forward gate has a script-based pre-check. */
  hasScript?: boolean;
  /**
   * Gate type for the reverse direction (to→from / highId→lowId).
   * Only set on bidirectional edges where the reverse direction has a gate.
   */
  reverseGateType?: 'human' | 'condition' | 'task_result' | 'check' | 'count';
  /** Custom badge label for the reverse gate. `undefined` → heuristic fallback. */
  reverseGateLabel?: string;
  /** Custom badge color for the reverse gate (hex `#rrggbb`). `undefined` → heuristic fallback. */
  reverseGateColor?: string;
  /** Whether the reverse gate has a script-based pre-check. */
  reverseHasScript?: boolean;
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
  hasGate: boolean;
  hasCyclic: boolean;
  /** Gate type for channels travelling lowId → highId */
  lowToHighGateType?: 'human' | 'condition' | 'task_result' | 'check' | 'count';
  /** Custom badge label for the lowId → highId gate. */
  lowToHighGateLabel?: string;
  /** Custom badge color for the lowId → highId gate. */
  lowToHighGateColor?: string;
  /** Whether the lowId → highId gate has a script-based pre-check. */
  lowToHighHasScript?: boolean;
  /** Gate type for channels travelling highId → lowId */
  highToLowGateType?: 'human' | 'condition' | 'task_result' | 'check' | 'count';
  /** Custom badge label for the highId → lowId gate. */
  highToLowGateLabel?: string;
  /** Custom badge color for the highId → lowId gate. */
  highToLowGateColor?: string;
  /** Whether the highId → lowId gate has a script-based pre-check. */
  highToLowHasScript?: boolean;
  channelIndexes: Set<number>;
}

interface ResolvedGateInfo {
  type: SemanticWorkflowEdge['gateType'];
  label?: string;
  color?: string;
  hasScript: boolean;
}

function resolveSemanticGateType(
  channel: WorkflowChannel,
  gateLookup: Map<string, Gate>
): ResolvedGateInfo {
  const noGate: ResolvedGateInfo = { type: undefined, hasScript: false };

  if (channel.gateId) {
    const gate = gateLookup.get(channel.gateId);
    if (!gate) return { type: 'check', hasScript: false };

    // Gate label is the authoritative display text — no heuristic type inference.
    // Use 'check' as a generic type so the badge renders (isGated check).
    return {
      type: 'check',
      label: gate.label,
      color: gate.color,
      hasScript: !!gate.script,
    };
  }

  return noGate;
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
  gates: Gate[] = [],
  cyclicChannelIndexes?: Set<number>
): SemanticWorkflowEdge[] {
  const endpointLookup = buildEndpointNodeLookup(nodes);
  const nodeOrder = new Map(nodes.map((node, index) => [node.step.localId, index]));
  const aggregates = new Map<string, PairAggregate>();
  const gateLookup = new Map(gates.map((gate) => [gate.id, gate]));

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
        hasGate: false,
        hasCyclic: false,
        lowToHighGateType: undefined,
        lowToHighGateLabel: undefined,
        lowToHighGateColor: undefined,
        lowToHighHasScript: undefined,
        highToLowGateType: undefined,
        highToLowGateLabel: undefined,
        highToLowGateColor: undefined,
        highToLowHasScript: undefined,
        channelIndexes: new Set<number>(),
      };

      aggregate.channelCount += 1;
      const gateInfo = resolveSemanticGateType(channel, gateLookup);
      if (gateInfo.type) {
        aggregate.hasGate = true;
      }
      if (cyclicChannelIndexes?.has(channelIndex)) {
        aggregate.hasCyclic = true;
      }
      aggregate.channelIndexes.add(channelIndex);

      if (fromIsLow) {
        aggregate.lowToHigh = true;
        if (gateInfo.type) {
          aggregate.lowToHighGateType ??= gateInfo.type;
          aggregate.lowToHighGateLabel ??= gateInfo.label;
          aggregate.lowToHighGateColor ??= gateInfo.color;
          if (gateInfo.hasScript) aggregate.lowToHighHasScript = true;
        }
      } else {
        aggregate.highToLow = true;
        if (gateInfo.type) {
          aggregate.highToLowGateType ??= gateInfo.type;
          aggregate.highToLowGateLabel ??= gateInfo.label;
          aggregate.highToLowGateColor ??= gateInfo.color;
          if (gateInfo.hasScript) aggregate.highToLowHasScript = true;
        }
      }

      aggregates.set(pairKey, aggregate);
    }
  }

  return Array.from(aggregates.values()).map((aggregate) => {
    if (aggregate.lowToHigh && aggregate.highToLow) {
      // Two one-way channels in opposite directions — rendered as a bidirectional arrow.
      return {
        id: `${aggregate.lowId}:${aggregate.highId}`,
        fromStepId: aggregate.lowId,
        toStepId: aggregate.highId,
        direction: 'bidirectional' as const,
        channelCount: aggregate.channelCount,
        hasGate: aggregate.hasGate,
        hasCyclic: aggregate.hasCyclic,
        gateType: aggregate.lowToHighGateType,
        gateLabel: aggregate.lowToHighGateLabel,
        gateColor: aggregate.lowToHighGateColor,
        hasScript: aggregate.lowToHighHasScript,
        reverseGateType: aggregate.highToLowGateType,
        reverseGateLabel: aggregate.highToLowGateLabel,
        reverseGateColor: aggregate.highToLowGateColor,
        reverseHasScript: aggregate.highToLowHasScript,
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
        hasGate: aggregate.hasGate,
        hasCyclic: aggregate.hasCyclic,
        gateType: aggregate.lowToHighGateType,
        gateLabel: aggregate.lowToHighGateLabel,
        gateColor: aggregate.lowToHighGateColor,
        hasScript: aggregate.lowToHighHasScript,
        channelIndexes: Array.from(aggregate.channelIndexes),
      };
    }

    return {
      id: `${aggregate.highId}:${aggregate.lowId}`,
      fromStepId: aggregate.highId,
      toStepId: aggregate.lowId,
      direction: 'one-way' as const,
      channelCount: aggregate.channelCount,
      hasGate: aggregate.hasGate,
      hasCyclic: aggregate.hasCyclic,
      gateType: aggregate.highToLowGateType,
      gateLabel: aggregate.highToLowGateLabel,
      gateColor: aggregate.highToLowGateColor,
      hasScript: aggregate.highToLowHasScript,
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
