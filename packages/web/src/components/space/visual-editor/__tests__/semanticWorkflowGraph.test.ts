import type { WorkflowChannel } from '@hyperneo/shared';
import { describe, expect, it } from 'vitest';
import { buildSemanticWorkflowEdges } from '../semanticWorkflowGraph';
import type { VisualNode } from '../serialization';

const NODES: VisualNode[] = [
  {
    step: {
      localId: 'plan',
      name: 'Planning',
      agentId: 'planner-id',
    },
    position: { x: 50, y: 170 },
  },
  {
    step: {
      localId: 'review',
      name: 'Code Review',
      agentId: '',

      agents: [
        { agentId: 'reviewer-1-id', name: 'Reviewer 1' },
        { agentId: 'reviewer-2-id', name: 'Reviewer 2' },
        { agentId: 'reviewer-3-id', name: 'Reviewer 3' },
      ],
    },
    position: { x: 50, y: 320 },
  },
  {
    step: {
      localId: 'qa',
      name: 'QA',
      agentId: 'qa-id',
    },
    position: { x: 50, y: 470 },
  },
];

describe('buildSemanticWorkflowEdges', () => {
  it('preserves a node-level channel between a single-agent node and a multi-agent node', () => {
    const channels: WorkflowChannel[] = [{ from: 'Planning', to: 'Code Review' }];

    expect(buildSemanticWorkflowEdges(NODES, channels)).toEqual([
      {
        id: 'plan:review',
        fromStepId: 'plan',
        toStepId: 'review',
        direction: 'one-way',
        channelCount: 1,
        hasCyclic: false,
        channelIndexes: [0],
      },
    ]);
  });

  it('collapses opposite directions into one bidirectional semantic edge', () => {
    const channels: WorkflowChannel[] = [
      { from: 'Planning', to: 'Code Review' },
      { from: 'Code Review', to: 'Planning' },
    ];

    expect(buildSemanticWorkflowEdges(NODES, channels)).toEqual([
      {
        id: 'plan:review',
        fromStepId: 'plan',
        toStepId: 'review',
        direction: 'bidirectional',
        channelCount: 2,
        hasCyclic: false,
        channelIndexes: [0, 1],
      },
    ]);
  });

  it('ignores unresolved and intra-node channels for the semantic canvas graph', () => {
    const channels: WorkflowChannel[] = [
      { from: 'Unknown', to: 'Planning' },
      { from: 'Reviewer 1', to: 'Reviewer 2' },
      { from: 'Code Review', to: 'QA' },
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('review:qa');
    expect(result[0].fromStepId).toBe('review');
    expect(result[0].toStepId).toBe('qa');
    expect(result[0].direction).toBe('one-way');
  });

  it('marks an edge as cyclic when a channel index is listed as cyclic', () => {
    const channels: WorkflowChannel[] = [{ from: 'Planning', to: 'Code Review' }];

    const result = buildSemanticWorkflowEdges(NODES, channels, new Set<number>([0]));
    expect(result).toHaveLength(1);
    expect(result[0].hasCyclic).toBe(true);
  });

  it('keeps hasCyclic false when no cyclic channel indexes are provided', () => {
    const channels: WorkflowChannel[] = [{ from: 'Planning', to: 'Code Review' }];

    const result = buildSemanticWorkflowEdges(NODES, channels);
    expect(result[0].hasCyclic).toBe(false);
  });

  it('preserves per-edge channel indexes across a bidirectional pair', () => {
    const channels: WorkflowChannel[] = [
      { from: 'Planning', to: 'Code Review' },
      { from: 'Code Review', to: 'Planning' },
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels);
    expect(result).toHaveLength(1);
    expect(result[0].direction).toBe('bidirectional');
    expect(result[0].channelIndexes).toEqual([0, 1]);
  });
});
