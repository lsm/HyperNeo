import type { WorkflowChannel, WorkflowNode } from '@hyperneo/shared';
import type { VisualTransition } from './types';

export interface Point {
  x: number;
  y: number;
}

const H_GAP = 250;
const V_GAP = 170;
const START_X = 80;
const START_Y = 96;

interface LayoutEdge {
  from: string;
  to: string;
}

function buildEndpointNodeLookup(nodes: WorkflowNode[]): Map<string, string> {
  const lookup = new Map<string, string>();

  for (const node of nodes) {
    if (node.name) lookup.set(node.name, node.id);

    for (const agent of node.agents) {
      if (agent.name) lookup.set(agent.name, node.id);
      if (agent.agentId) lookup.set(agent.agentId, node.id);
    }
  }

  return lookup;
}

function buildForwardLayoutEdges(
  nodes: WorkflowNode[],
  transitions: VisualTransition[],
  channels: WorkflowChannel[]
): LayoutEdge[] {
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const endpointLookup = buildEndpointNodeLookup(nodes);
  const edges = new Map<string, LayoutEdge>();

  const addEdge = (from: string, to: string) => {
    if (from === to) return;
    if (!order.has(from) || !order.has(to)) return;

    const fromOrder = order.get(from)!;
    const toOrder = order.get(to)!;
    if (fromOrder === toOrder) return;

    const orientedFrom = fromOrder < toOrder ? from : to;
    const orientedTo = fromOrder < toOrder ? to : from;
    edges.set(`${orientedFrom}:${orientedTo}`, { from: orientedFrom, to: orientedTo });
  };

  for (const transition of transitions) {
    addEdge(transition.from, transition.to);
  }

  for (const channel of channels) {
    if (channel.from === '*') continue;
    const fromNodeId = endpointLookup.get(channel.from);
    if (!fromNodeId) continue;

    const targets = Array.isArray(channel.to) ? channel.to : [channel.to];
    for (const target of targets) {
      if (target === '*') continue;
      const toNodeId = endpointLookup.get(target);
      if (!toNodeId) continue;
      addEdge(fromNodeId, toNodeId);
    }
  }

  return Array.from(edges.values());
}

function isReviewerLaneNode(node: WorkflowNode): boolean {
  if (/review/i.test(node.name)) return true;
  if (node.agents && node.agents.length > 0) {
    return node.agents.every((agent) => /review/i.test(agent.name ?? ''));
  }
  return false;
}

function findNearestOpenLane(occupiedLanes: Set<number>, desiredLane: number): number {
  if (!occupiedLanes.has(desiredLane)) return desiredLane;
  for (let distance = 1; distance < 12; distance += 1) {
    const right = desiredLane + distance;
    if (!occupiedLanes.has(right)) return right;
    const left = desiredLane - distance;
    if (!occupiedLanes.has(left)) return left;
  }
  return desiredLane + occupiedLanes.size;
}

export function autoLayout(
  nodes: WorkflowNode[],
  transitions: VisualTransition[],
  startNodeId: string,
  channels: WorkflowChannel[] = []
): Map<string, Point> {
  const positions = new Map<string, Point>();
  if (nodes.length === 0) return positions;

  const stepIds = new Set(nodes.map((node) => node.id));
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const forwardEdges = buildForwardLayoutEdges(nodes, transitions, channels);

  const successors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  for (const node of nodes) {
    successors.set(node.id, []);
    predecessors.set(node.id, []);
  }
  for (const edge of forwardEdges) {
    if (!stepIds.has(edge.from) || !stepIds.has(edge.to)) continue;
    successors.get(edge.from)!.push(edge.to);
    predecessors.get(edge.to)!.push(edge.from);
  }

  const reachable = new Set<string>();
  const queue: string[] = [];
  if (stepIds.has(startNodeId)) {
    reachable.add(startNodeId);
    queue.push(startNodeId);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of successors.get(current) ?? []) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }

  const depth = new Map<string, number>();
  const inDegree = new Map<string, number>();
  for (const id of reachable) {
    let degree = 0;
    for (const pred of predecessors.get(id) ?? []) {
      if (reachable.has(pred)) degree += 1;
    }
    inDegree.set(id, degree);
    if (degree === 0) depth.set(id, 0);
  }

  const topo = Array.from(reachable).filter((id) => (inDegree.get(id) ?? 0) === 0);
  topo.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  while (topo.length > 0) {
    const current = topo.shift()!;
    const currentDepth = depth.get(current) ?? 0;
    for (const next of successors.get(current) ?? []) {
      if (!reachable.has(next)) continue;
      depth.set(next, Math.max(depth.get(next) ?? 0, currentDepth + 1));
      const remaining = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) topo.push(next);
    }
    topo.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }

  const maxAssignedDepth = depth.size > 0 ? Math.max(...depth.values()) : 0;
  let orphanDepth = maxAssignedDepth + 1;
  for (const node of nodes) {
    if (!depth.has(node.id)) {
      depth.set(node.id, orphanDepth);
    }
  }

  const occupiedByDepth = new Map<number, Set<number>>();
  const laneById = new Map<string, number>();

  for (const node of nodes) {
    const nodeDepth = depth.get(node.id) ?? orphanDepth;
    const occupied = occupiedByDepth.get(nodeDepth) ?? new Set<number>();
    occupiedByDepth.set(nodeDepth, occupied);

    let desiredLane = isReviewerLaneNode(node) ? 1 : 0;
    const preds = (predecessors.get(node.id) ?? []).filter((pred) => laneById.has(pred));
    if (!isReviewerLaneNode(node) && preds.length > 0) {
      const avgPredLane =
        preds.reduce((sum, pred) => sum + (laneById.get(pred) ?? 0), 0) / preds.length;
      desiredLane = Math.round(avgPredLane * 0.35);
    }

    const lane = findNearestOpenLane(occupied, desiredLane);
    occupied.add(lane);
    laneById.set(node.id, lane);
  }

  const usedLanes = Array.from(laneById.values());
  const minLane = usedLanes.length > 0 ? Math.min(...usedLanes) : 0;

  for (const node of nodes) {
    const nodeDepth = depth.get(node.id) ?? 0;
    const lane = laneById.get(node.id) ?? 0;
    positions.set(node.id, {
      x: START_X + (lane - minLane) * H_GAP,
      y: START_Y + nodeDepth * V_GAP,
    });
  }

  return positions;
}
