// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, waitFor } from '@testing-library/preact';
import { signal, computed } from '@preact/signals';
import type { SpaceWorkerAgent, SpaceWorkflow, NodeExecution } from '@hyperneo/shared';

let mockWorkflows = signal<SpaceWorkflow[]>([]);
let mockAgents = signal<SpaceWorkerAgent[]>([]);
let mockNodeExecutions = signal<NodeExecution[]>([]);
let mockNodeExecutionsByNodeId = computed(() => {
  const map = new Map<string, NodeExecution[]>();
  for (const exec of mockNodeExecutions.value) {
    let arr = map.get(exec.workflowNodeId);
    if (!arr) {
      arr = [];
      map.set(exec.workflowNodeId, arr);
    }
    arr.push(exec);
  }
  return map;
});

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      workflows: mockWorkflows,
      agents: mockAgents,
      nodeExecutionsByNodeId: mockNodeExecutionsByNodeId,
      workflowVersions: signal(new Map()),
      fetchWorkflowDetail: vi.fn((id: string) =>
        Promise.resolve(mockWorkflows.value.find((w) => w.id === id) ?? null)
      ),
    };
  },
}));

const mockEventListeners = new Map<string, Array<(data: unknown) => void>>();
const mockHub = {
  request: vi.fn().mockResolvedValue({}),
  onEvent: vi.fn((event: string, handler: (data: unknown) => void) => {
    if (!mockEventListeners.has(event)) mockEventListeners.set(event, []);
    mockEventListeners.get(event)!.push(handler);
    return () => {
      const handlers = mockEventListeners.get(event) ?? [];
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    };
  }),
};

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: vi.fn(() => mockHub),
    getHub: vi.fn(() => Promise.resolve(mockHub)),
  },
}));

mockWorkflows = signal<SpaceWorkflow[]>([]);
mockAgents = signal<SpaceWorkerAgent[]>([]);
mockNodeExecutions = signal<NodeExecution[]>([]);
mockNodeExecutionsByNodeId = computed(() => {
  const map = new Map<string, NodeExecution[]>();
  for (const exec of mockNodeExecutions.value) {
    let arr = map.get(exec.workflowNodeId);
    if (!arr) {
      arr = [];
      map.set(exec.workflowNodeId, arr);
    }
    arr.push(exec);
  }
  return map;
});

import { useRuntimeCanvasData } from '../useRuntimeCanvasData';

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: 'sp-1',
    name: 'Test Workflow',
    description: '',
    nodes: [
      { id: 'n1', name: 'Planner', agents: [] },
      { id: 'n2', name: 'Coder', agents: [] },
    ],
    startNodeId: 'n1',
    endNodeId: 'n2',
    channels: [],
    gates: [],
    tags: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeNodeExecution(overrides: Partial<NodeExecution> = {}): NodeExecution {
  return {
    id: 'nexec-1',
    workflowRunId: 'run-1',
    workflowNodeId: 'n1',
    agentName: 'Planner',
    agentId: null,
    agentSessionId: null,
    status: 'done',
    result: null,
    createdAt: 1000,
    startedAt: 1000,
    completedAt: 2000,
    ...overrides,
  };
}

describe('useRuntimeCanvasData', () => {
  beforeEach(() => {
    mockWorkflows.value = [];
    mockAgents.value = [];
    mockNodeExecutions.value = [];
    mockEventListeners.clear();
    mockHub.request.mockClear();
    mockHub.request.mockResolvedValue({});
    mockHub.onEvent.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('returns empty nodeData and channelEdges when workflowId is null', () => {
    const { result } = renderHook(() => useRuntimeCanvasData(null, null));
    expect(result.current.nodeData).toEqual([]);
    expect(result.current.channelEdges).toEqual([]);
    expect(result.current.workflow).toBeNull();
  });

  it('correctly maps SpaceWorkflow nodes to WorkflowNodeData with stepIndex, isStartNode, isEndNode', async () => {
    mockWorkflows.value = [makeWorkflow()];
    const { result } = renderHook(() => useRuntimeCanvasData('wf-1', null));

    await waitFor(() => {
      expect(result.current.nodeData.length).toBe(2);
    });

    const { nodeData } = result.current;
    const first = nodeData[0];
    expect(first.stepIndex).toBe(0);
    expect(first.step.id).toBe('n1');
    expect(first.isStartNode).toBe(true);
    expect(first.isEndNode).toBe(false);

    const second = nodeData[1];
    expect(second.stepIndex).toBe(1);
    expect(second.step.id).toBe('n2');
    expect(second.isStartNode).toBe(false);
    expect(second.isEndNode).toBe(true);
  });

  it('derives nodeTaskStates from nodeExecutionsByNodeId filtered by runId', async () => {
    mockWorkflows.value = [makeWorkflow()];
    mockNodeExecutions.value = [
      makeNodeExecution({
        workflowRunId: 'run-1',
        workflowNodeId: 'n1',
        agentName: 'Planner',
        status: 'done',
      }),
      makeNodeExecution({
        id: 'nexec-2',
        workflowRunId: 'run-OTHER',
        workflowNodeId: 'n1',
        agentName: 'Planner',
        status: 'pending',
      }),
    ];

    const { result } = renderHook(() => useRuntimeCanvasData('wf-1', 'run-1'));

    await waitFor(() => {
      expect(result.current.nodeData.length).toBeGreaterThan(0);
    });

    const { nodeData } = result.current;
    const n1 = nodeData.find((n) => n.step.id === 'n1');
    expect(n1?.nodeTaskStates).toHaveLength(1);
    expect(n1?.nodeTaskStates?.[0].status).toBe('done');
    expect(n1?.nodeTaskStates?.[0].agentName).toBe('Planner');
  });

  it('builds channelEdges from workflow channels with fromStepId/toStepId/direction/isCyclic', async () => {
    mockWorkflows.value = [
      makeWorkflow({
        channels: [
          {
            id: 'ch-1',
            from: 'Planner',
            to: 'Coder',
            label: 'Handoff',
          },
        ],
      }),
    ];

    const { result } = renderHook(() => useRuntimeCanvasData('wf-1', 'run-1'));

    await waitFor(() => {
      expect(result.current.channelEdges.length).toBeGreaterThan(0);
    });

    const edge = result.current.channelEdges[0];
    expect(edge.fromStepId).toBeDefined();
    expect(edge.toStepId).toBeDefined();
    expect(edge.direction).toMatch(/^(one-way|bidirectional)$/);
    expect(edge.isCyclic).toBeDefined();
  });
});
