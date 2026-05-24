import type { NodeDraft } from '../WorkflowNodeCard';
import { isMultiAgentNode } from '../WorkflowNodeCard';
import type { NodePosition } from './types';
import type { VisualNode } from './serialization';

export const SINGLE_AGENT_NODE_WIDTH = 160;
export const SINGLE_AGENT_NODE_HEIGHT = 80;
export const MULTI_AGENT_NODE_WIDTH = 200;
export const MULTI_AGENT_NODE_HEIGHT = 112;

export function getVisualNodeDimensions(step: NodeDraft): { width: number; height: number } {
  if (isMultiAgentNode(step)) {
    return {
      width: MULTI_AGENT_NODE_WIDTH,
      height: MULTI_AGENT_NODE_HEIGHT,
    };
  }

  return {
    width: SINGLE_AGENT_NODE_WIDTH,
    height: SINGLE_AGENT_NODE_HEIGHT,
  };
}

export function buildVisualNodePositions(nodes: VisualNode[]): NodePosition {
  const positions: NodePosition = {};

  for (const node of nodes) {
    const { width, height } = getVisualNodeDimensions(node.step);
    positions[node.step.localId] = {
      x: node.position.x,
      y: node.position.y,
      width,
      height,
    };
  }

  return positions;
}
