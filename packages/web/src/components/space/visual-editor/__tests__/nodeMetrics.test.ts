import { describe, expect, it } from 'vitest';
import {
  buildVisualNodePositions,
  getVisualNodeDimensions,
  MULTI_AGENT_NODE_HEIGHT,
  MULTI_AGENT_NODE_WIDTH,
  SINGLE_AGENT_NODE_HEIGHT,
  SINGLE_AGENT_NODE_WIDTH,
} from '../nodeMetrics';

describe('nodeMetrics', () => {
  it('returns multi-agent dimensions for multi-agent workflow nodes', () => {
    expect(
      getVisualNodeDimensions({
        localId: 'review',
        name: 'Code Review',
        agentId: '',

        agents: [
          { agentId: 'a1', name: 'Reviewer 1' },
          { agentId: 'a2', name: 'Reviewer 2' },
        ],
      })
    ).toEqual({
      width: MULTI_AGENT_NODE_WIDTH,
      height: MULTI_AGENT_NODE_HEIGHT,
    });
  });

  it('returns default dimensions for single-agent workflow nodes', () => {
    expect(
      getVisualNodeDimensions({
        localId: 'plan',
        name: 'Planning',
        agentId: 'planner',
      })
    ).toEqual({
      width: SINGLE_AGENT_NODE_WIDTH,
      height: SINGLE_AGENT_NODE_HEIGHT,
    });
  });

  it('builds node positions for all visual nodes using their specific dimensions', () => {
    const positions = buildVisualNodePositions([
      {
        step: {
          localId: 'review',
          name: 'Code Review',
          agentId: '',

          agents: [
            { agentId: 'a1', name: 'Reviewer 1' },
            { agentId: 'a2', name: 'Reviewer 2' },
            { agentId: 'a3', name: 'Reviewer 3' },
          ],
        },
        position: { x: 100, y: 200 },
      },
    ]);

    expect(positions.review).toEqual({
      x: 100,
      y: 200,
      width: MULTI_AGENT_NODE_WIDTH,
      height: MULTI_AGENT_NODE_HEIGHT,
    });
  });
});
