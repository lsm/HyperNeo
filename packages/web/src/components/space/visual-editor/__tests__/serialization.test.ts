import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  workflowToVisualState,
  visualStateToCreateParams,
  visualStateToUpdateParams,
} from '../serialization.ts';
import type { VisualEditorState } from '../serialization.ts';
import type { SpaceWorkflow, WorkflowNode } from '@hyperneo/shared';

let uuidCounter = 0;
beforeEach(() => {
  uuidCounter = 0;
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
    uuidCounter++;
    return `test-uuid-${uuidCounter}` as ReturnType<typeof crypto.randomUUID>;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeStep(id: string, name?: string, agentId?: string): WorkflowNode {
  return { id, name: name ?? id, agents: [{ agentId: agentId ?? 'agent-1', name: 'coder' }] };
}

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: 'space-1',
    name: 'Test Workflow',
    nodes: [],
    startNodeId: '',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    completionAutonomyLevel: 3,
    ...overrides,
  };
}

describe('workflowToVisualState', () => {
  it('creates one node per workflow step', () => {
    const wf = makeWorkflow({
      nodes: [makeStep('s1'), makeStep('s2')],
      startNodeId: 's1',
    });
    const state = workflowToVisualState(wf);
    expect(state.nodes).toHaveLength(2);
    expect(state.nodes.find((n) => n.step.id === 's1')?.step.id).toBe('s1');
    expect(state.nodes.find((n) => n.step.id === 's2')?.step.id).toBe('s2');
  });

  it('starts with empty edges (transitions removed from backend)', () => {
    const wf = makeWorkflow({
      nodes: [makeStep('s1'), makeStep('s2'), makeStep('s3')],
      startNodeId: 's1',
    });
    const state = workflowToVisualState(wf);
    expect(state.edges).toHaveLength(0);
  });

  it('passes startNodeId through unchanged', () => {
    const wf = makeWorkflow({
      nodes: [makeStep('s1'), makeStep('s2')],
      startNodeId: 's2',
    });
    const state = workflowToVisualState(wf);
    expect(state.startNodeId).toBe('s2');
  });

  it('falls back to first step when startNodeId does not match any step', () => {
    const wf = makeWorkflow({
      nodes: [makeStep('s1')],
      startNodeId: 'nonexistent',
    });
    const state = workflowToVisualState(wf);
    expect(state.startNodeId).toBe('s1');
  });

  it('restores positions from workflow.layout', () => {
    const wf = makeWorkflow({
      nodes: [makeStep('s1'), makeStep('s2')],
      startNodeId: 's1',
      layout: { s1: { x: 100, y: 200 }, s2: { x: 350, y: 200 } },
    });
    const state = workflowToVisualState(wf);
    expect(state.nodes.find((n) => n.step.id === 's1')?.position).toEqual({ x: 100, y: 200 });
    expect(state.nodes.find((n) => n.step.id === 's2')?.position).toEqual({ x: 350, y: 200 });
  });

  it('does not invoke autoLayout when all steps have stored positions', () => {
    const wf = makeWorkflow({
      nodes: [makeStep('s1'), makeStep('s2')],
      startNodeId: 's1',
      layout: { s1: { x: 999, y: 888 }, s2: { x: 777, y: 666 } },
    });
    const state = workflowToVisualState(wf);
    expect(state.nodes.find((n) => n.step.id === 's1')?.position).toEqual({ x: 999, y: 888 });
    expect(state.nodes.find((n) => n.step.id === 's2')?.position).toEqual({ x: 777, y: 666 });
  });

  it('uses autoLayout when no layout is provided', () => {
    const wf = makeWorkflow({
      nodes: [makeStep('s1'), makeStep('s2')],
      startNodeId: 's1',
    });
    const state = workflowToVisualState(wf);
    const s1 = state.nodes.find((n) => n.step.id === 's1')!;
    const s2 = state.nodes.find((n) => n.step.id === 's2')!;
    expect(s1.position.y).toBeLessThan(s2.position.y);
  });

  it('uses autoLayout only for steps missing from partial layout', () => {
    const wf = makeWorkflow({
      nodes: [makeStep('s1'), makeStep('s2')],
      startNodeId: 's1',
      layout: { s1: { x: 999, y: 888 } },
    });
    const state = workflowToVisualState(wf);
    expect(state.nodes.find((n) => n.step.id === 's1')?.position).toEqual({ x: 999, y: 888 });
    const s2 = state.nodes.find((n) => n.step.id === 's2');
    expect(s2?.position).toBeDefined();
  });

  it('starts with empty edges (WorkflowCondition not loaded from transitions)', () => {
    const wf = makeWorkflow({
      nodes: [makeStep('s1'), makeStep('s2')],
      startNodeId: 's1',
    });
    const state = workflowToVisualState(wf);
    expect(state.edges).toHaveLength(0);
  });

  it('passes tags through', () => {
    const wf = makeWorkflow({
      nodes: [makeStep('s1')],
      startNodeId: 's1',
      tags: ['coding', 'review'],
    });
    const state = workflowToVisualState(wf);
    expect(state.tags).toEqual(['coding', 'review']);
  });

  it('migrates legacy workflow postApproval onto the end node', () => {
    const wf = makeWorkflow({
      nodes: [makeStep('s1')],
      startNodeId: 's1',
      endNodeId: 's1',
      postApproval: { targetAgent: 'reviewer', instructions: 'Merge PR {{pr_url}}.' },
    });
    const state = workflowToVisualState(wf);
    expect(state.nodes.find((node) => node.step.id === 's1')?.step.postApproval).toEqual({
      targetAgent: 'reviewer',
      instructions: 'Merge PR {{pr_url}}.',
    });
  });

  it('assigns fresh localIds to each node', () => {
    const wf = makeWorkflow({
      nodes: [makeStep('s1'), makeStep('s2')],
      startNodeId: 's1',
    });
    const state = workflowToVisualState(wf);
    const localIds = state.nodes.map((n) => n.step.localId);
    expect(new Set(localIds).size).toBe(2);
  });

  it('passes endNodeId through when set', () => {
    const wf = makeWorkflow({
      nodes: [makeStep('s1'), makeStep('s2')],
      startNodeId: 's1',
      endNodeId: 's2',
    });
    const state = workflowToVisualState(wf);
    expect(state.endNodeId).toBe('s2');
  });

  it('endNodeId is undefined when not set on workflow', () => {
    const wf = makeWorkflow({
      nodes: [makeStep('s1'), makeStep('s2')],
      startNodeId: 's1',
    });
    const state = workflowToVisualState(wf);
    expect(state.endNodeId).toBeUndefined();
  });

  it('endNodeId falls back to undefined when referencing nonexistent node', () => {
    const wf = makeWorkflow({
      nodes: [makeStep('s1'), makeStep('s2')],
      startNodeId: 's1',
      endNodeId: 'nonexistent',
    });
    const state = workflowToVisualState(wf);
    expect(state.endNodeId).toBeUndefined();
  });
});

describe('visualStateToCreateParams', () => {
  function makeState(overrides: Partial<VisualEditorState> = {}): VisualEditorState {
    return {
      nodes: [
        {
          step: { localId: 'local-1', id: 's1', name: 'Step 1', agentId: 'a1' },
          position: { x: 50, y: 50 },
        },
        {
          step: {
            localId: 'local-2',
            id: 's2',
            name: 'Step 2',
            agentId: 'a2',
          },
          position: { x: 300, y: 50 },
        },
      ],
      edges: [
        {
          fromStepKey: 's1',
          toStepKey: 's2',
          condition: undefined,
        },
      ],
      startNodeId: 's1',
      tags: [],
      channels: [],
      hooks: [],
      ...overrides,
    };
  }

  it('produces correct steps array', () => {
    const params = visualStateToCreateParams(makeState(), 'space-1', 'My Workflow');
    expect(params.nodes).toHaveLength(2);
    expect(params.nodes![0]).toMatchObject({ id: 's1', name: 'Step 1' });
    expect(params.nodes![0].agents).toHaveLength(1);
    expect(params.nodes![0].agents[0].agentId).toBe('a1');
    expect(params.nodes![1]).toMatchObject({ id: 's2', name: 'Step 2' });
    expect(params.nodes![1].agents[0].agentId).toBe('a2');
  });

  it('single-agent shorthand derives role name from node name (not raw agentId)', () => {
    const params = visualStateToCreateParams(makeState(), 'space-1', 'My Workflow');
    expect(params.nodes![0].agents[0].name).toBe('step-1');
    expect(params.nodes![1].agents[0].name).toBe('step-2');
  });

  it('preserves shorthand single-agent overrides on WorkflowNodeAgent', () => {
    const params = visualStateToCreateParams(
      makeState({
        nodes: [
          {
            step: {
              localId: 'local-1',
              id: 's1',
              name: 'Step 1',
              agentId: 'a1',
              model: 'claude-opus-4-6',
              thinkingLevel: 'think16k',
              customPrompt: { value: 'Use extra scrutiny.' },
              disabledSkillIds: ['skill-1'],
            },
            position: { x: 50, y: 50 },
          },
        ],
      }),
      'space-1',
      'My Workflow'
    );
    expect(params.nodes![0].agents).toEqual([
      {
        agentId: 'a1',
        name: 'step-1',
        model: 'claude-opus-4-6',
        thinkingLevel: 'think16k',
        customPrompt: { value: 'Use extra scrutiny.' },
        disabledSkillIds: ['skill-1'],
      },
    ]);
  });

  it('serializes single-agent resetContextPerTurn shorthand onto the agent slot', () => {
    const params = visualStateToCreateParams(
      makeState({
        nodes: [
          {
            step: {
              localId: 'local-1',
              id: 's1',
              name: 'Step 1',
              agentId: 'a1',
              resetContextPerTurn: true,
            },
            position: { x: 50, y: 50 },
          },
        ],
      }),
      'space-1',
      'My Workflow'
    );
    expect(params.nodes![0].agents[0].resetContextPerTurn).toBe(true);
  });

  it('serializes multi-agent slot resetContextPerTurn onto the agent slot', () => {
    const params = visualStateToCreateParams(
      makeState({
        nodes: [
          {
            step: {
              localId: 'local-1',
              id: 's1',
              name: 'Step 1',
              agentId: '',
              agents: [
                { agentId: 'a1', name: 'planner' },
                { agentId: 'a2', name: 'reviewer', resetContextPerTurn: true },
              ],
            },
            position: { x: 50, y: 50 },
          },
        ],
      }),
      'space-1',
      'My Workflow'
    );
    expect(params.nodes![0].agents[0].resetContextPerTurn).toBeUndefined();
    expect(params.nodes![0].agents[1].resetContextPerTurn).toBe(true);
  });

  it('omits resetContextPerTurn when not set (no undefined leak)', () => {
    const params = visualStateToCreateParams(makeState(), 'space-1', 'My Workflow');
    expect(params.nodes![0].agents[0].resetContextPerTurn).toBeUndefined();
    expect('resetContextPerTurn' in params.nodes![0].agents[0]).toBe(false);
  });

  it('nodes have no instructions field (removed from schema)', () => {
    const params = visualStateToCreateParams(makeState(), 'space-1', 'My Workflow');
    expect('instructions' in params.nodes![0]).toBe(false);
  });

  it('passes startNodeId through', () => {
    const params = visualStateToCreateParams(makeState(), 'space-1', 'My Workflow');
    expect(params.startNodeId).toBe('s1');
  });

  it('resolves startNodeId via localId when it references step.localId', () => {
    const state = makeState({ startNodeId: 'local-1' });
    const params = visualStateToCreateParams(state, 'space-1', 'WF');
    expect(params.startNodeId).toBe('s1');
  });

  it('builds layout from node positions', () => {
    const params = visualStateToCreateParams(makeState(), 'space-1', 'My Workflow');
    expect(params.layout).toMatchObject({
      s1: { x: 50, y: 50 },
      s2: { x: 300, y: 50 },
    });
  });

  it('passes spaceId, name, description', () => {
    const params = visualStateToCreateParams(makeState(), 'space-42', 'Cool WF', 'A description');
    expect(params.spaceId).toBe('space-42');
    expect(params.name).toBe('Cool WF');
    expect(params.description).toBe('A description');
  });

  it('includes tags', () => {
    const params = visualStateToCreateParams(makeState({ tags: ['coding'] }), 'space-1', 'WF');
    expect(params.tags).toEqual(['coding']);
  });

  it('generates a new UUID for steps without id', () => {
    const state: VisualEditorState = {
      nodes: [
        {
          step: { localId: 'local-new', name: 'New Step', agentId: 'a1' },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      startNodeId: 'local-new',
      tags: [],
      channels: [],
      hooks: [],
    };
    const params = visualStateToCreateParams(state, 'space-1', 'WF');
    expect(params.nodes![0].id).toBeTruthy();
    expect(params.startNodeId).toBe(params.nodes![0].id);
  });

  it('handles zero nodes gracefully', () => {
    const state: VisualEditorState = {
      nodes: [],
      edges: [],
      startNodeId: '',
      tags: [],
      channels: [],
      hooks: [],
    };
    const params = visualStateToCreateParams(state, 'space-1', 'WF');
    expect(params.nodes).toHaveLength(0);
    expect(params.startNodeId).toBeUndefined();
  });

  it('serializes hook node localId references to persisted node names', () => {
    const params = visualStateToCreateParams(
      makeState({
        nodes: [
          {
            step: { localId: 'local-unnamed', name: '', agentId: 'a1' },
            position: { x: 0, y: 0 },
          },
          {
            step: { localId: 'local-review', id: 'review-id', name: 'Review', agentId: 'a2' },
            position: { x: 300, y: 0 },
          },
        ],
        startNodeId: 'local-unnamed',
        hooks: [
          {
            id: 'hook-1',
            enabled: true,
            sourceNode: 'local-unnamed',
            targetNode: 'local-review',
            method: 'send_message',
            validator: { kind: 'script', interpreter: 'bash', source: 'echo ok' },
            authorizedCallers: [{ sourceNode: 'local-unnamed' }],
            poll: { intervalMs: 5000 },
          },
        ],
      }),
      'space-1',
      'WF'
    );

    expect(params.hooks).toEqual([
      expect.objectContaining({
        sourceNode: 'Step 1',
        targetNode: 'Review',
        authorizedCallers: [expect.objectContaining({ sourceNode: 'Step 1' })],
        retry: { maxAttempts: 3, delayMs: 5000, backoffMultiplier: 1 },
      }),
    ]);
    expect(params.hooks![0].poll).toBeUndefined();
  });

  it('preserves explicit hook retry settings', () => {
    const params = visualStateToCreateParams(
      makeState({
        hooks: [
          {
            id: 'hook-1',
            enabled: true,
            sourceNode: 'Step 1',
            method: 'send_message',
            validator: { kind: 'script', interpreter: 'bash', source: 'echo ok' },
            retry: { maxAttempts: 9, delayMs: 1000, backoffMultiplier: 2 },
          },
        ],
      }),
      'space-1',
      'WF'
    );

    expect(params.hooks?.[0].retry).toEqual({
      maxAttempts: 9,
      delayMs: 1000,
      backoffMultiplier: 2,
    });
  });

  it('omits retry settings for built-in pr_ready hooks', () => {
    const params = visualStateToCreateParams(
      makeState({
        hooks: [
          {
            id: 'hook-1',
            enabled: true,
            sourceNode: 'Step 1',
            method: 'send_message',
            validator: { kind: 'built_in', id: 'pr_ready' },
            retry: { maxAttempts: 3, delayMs: 5000, backoffMultiplier: 1 },
          },
        ],
      }),
      'space-1',
      'WF'
    );

    expect(params.hooks?.[0].retry).toBeUndefined();
  });

  it('drops unsupported human-only hooks without authorized callers', () => {
    const params = visualStateToCreateParams(
      makeState({
        hooks: [
          {
            id: 'hook-1',
            enabled: true,
            sourceNode: 'Step 1',
            method: 'send_message',
            humanOnly: true,
            validator: { kind: 'script', interpreter: 'bash', source: 'echo ok' },
          },
        ],
      }),
      'space-1',
      'WF'
    );

    expect(params.hooks).toBeUndefined();
  });

  it('serializes hook result contract fields and strips unsupported humanOnly', () => {
    const params = visualStateToCreateParams(
      makeState({
        hooks: [
          {
            id: 'hook-1',
            enabled: true,
            sourceNode: 'Step 1',
            targetNode: 'Step 2',
            method: 'send_message',
            label: 'PR ready',
            classification: 'validation',
            humanOnly: true,
            validator: {
              kind: 'script',
              interpreter: 'bash',
              source: 'echo {"type":"allow"}',
              timeoutMs: 2000,
              externalLookups: ['github'],
            },
            localState: {
              defaults: { pr_url: null },
              recentResultRef: { hookId: 'hook-0', key: 'lastResult' },
            },
            templateData: { banner: 'needs_pr' },
            authorizedCallers: [{ sourceNode: 'Step 1', agentSlots: ['coder'] }],
          },
        ],
      }),
      'space-1',
      'WF'
    );

    expect(params.hooks?.[0]).toMatchObject({
      id: 'hook-1',
      label: 'PR ready',
      classification: 'validation',
      sourceNode: 'Step 1',
      targetNode: 'Step 2',
      validator: {
        kind: 'script',
        interpreter: 'bash',
        source: 'echo {"type":"allow"}',
        timeoutMs: 2000,
        externalLookups: ['github'],
      },
      localState: {
        defaults: { pr_url: null },
        recentResultRef: { hookId: 'hook-0', key: 'lastResult' },
      },
      templateData: { banner: 'needs_pr' },
      authorizedCallers: [{ sourceNode: 'Step 1', agentSlots: ['coder'] }],
    });
    expect(params.hooks?.[0].humanOnly).toBeUndefined();
  });

  it('passes endNodeId through to create params', () => {
    const state = makeState({ endNodeId: 's2' });
    const params = visualStateToCreateParams(state, 'space-1', 'WF');
    expect(params.endNodeId).toBe('s2');
  });

  it('passes node postApproval through to create params', () => {
    const state = makeState({
      nodes: [
        {
          step: {
            localId: 'local-1',
            id: 's1',
            name: 'Step 1',
            agentId: 'a1',
            postApproval: {
              targetAgent: 'reviewer',
              instructions: 'Merge PR {{pr_url}}.',
            },
          },
          position: { x: 50, y: 50 },
        },
      ],
    });
    const params = visualStateToCreateParams(state, 'space-1', 'WF');
    expect(params.nodes?.[0].postApproval).toEqual({
      targetAgent: 'step-1',
      instructions: 'Merge PR {{pr_url}}.',
    });
    expect(params.postApproval).toBeUndefined();
  });

  it('preserves postApproval.requirePrMerge through create params (regression)', () => {
    const state = makeState({
      nodes: [
        {
          step: {
            localId: 'local-1',
            id: 's1',
            name: 'Step 1',
            agentId: 'a1',
            postApproval: {
              targetAgent: 'reviewer',
              instructions: 'Merge PR {{pr_url}}.',
            },
            requirePrMerge: true,
          },
          position: { x: 50, y: 50 },
        },
      ],
    });
    const params = visualStateToCreateParams(state, 'space-1', 'WF');
    expect(params.nodes?.[0].postApproval).toEqual({
      targetAgent: 'step-1',
      instructions: 'Merge PR {{pr_url}}.',
      requirePrMerge: true,
    });
  });

  it('restores requirePrMerge after the post-approval toggle deletes the route', () => {
    const state = makeState({
      nodes: [
        {
          step: {
            localId: 'local-1',
            id: 's1',
            name: 'Step 1',
            agentId: 'a1',
            postApproval: {
              targetAgent: 'reviewer',
              instructions: 'Merge PR {{pr_url}}.',
            },
            requirePrMerge: true,
          },
          position: { x: 50, y: 50 },
        },
      ],
    });
    const params = visualStateToCreateParams(state, 'space-1', 'WF');
    expect(params.nodes?.[0].postApproval?.requirePrMerge).toBe(true);
  });

  it('preserves requirePrMerge from postApproval when the sticky field is unset (template-picker path)', () => {
    const state = makeState({
      nodes: [
        {
          step: {
            localId: 'local-1',
            id: 's1',
            name: 'Step 1',
            agentId: 'a1',
            postApproval: {
              targetAgent: 'reviewer',
              instructions: 'Merge PR {{pr_url}}.',
              requirePrMerge: true,
            },
          },
          position: { x: 50, y: 50 },
        },
      ],
    });
    const params = visualStateToCreateParams(state, 'space-1', 'WF');
    expect(params.nodes?.[0].postApproval?.requirePrMerge).toBe(true);
  });

  it('omits postApproval.requirePrMerge when not set (no undefined leak)', () => {
    const state = makeState({
      nodes: [
        {
          step: {
            localId: 'local-1',
            id: 's1',
            name: 'Step 1',
            agentId: 'a1',
            postApproval: {
              targetAgent: 'reviewer',
              instructions: 'Merge PR {{pr_url}}.',
            },
          },
          position: { x: 50, y: 50 },
        },
      ],
    });
    const params = visualStateToCreateParams(state, 'space-1', 'WF');
    expect(params.nodes?.[0].postApproval).not.toHaveProperty('requirePrMerge');
  });

  it('endNodeId is undefined when not set on state', () => {
    const state = makeState();
    const params = visualStateToCreateParams(state, 'space-1', 'WF');
    expect(params.endNodeId).toBeUndefined();
  });
});

describe('handoff transition preservation', () => {
  function makeHandoffState(overrides: Partial<VisualEditorState> = {}): VisualEditorState {
    return {
      nodes: [
        {
          step: {
            localId: 'l1',
            id: 's1',
            name: 'Coder',
            agentId: 'a1',
            handoffTransitions: [{ id: 't', target: 'Review' }],
          },
          position: { x: 0, y: 0 },
        },
        {
          step: { localId: 'l2', id: 's2', name: 'Review', agentId: 'a2' },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      startNodeId: 's1',
      tags: [],
      channels: [],
      hooks: [],
      ...overrides,
    };
  }

  it('drops a handoff transition whose target no longer exists', () => {
    const params = visualStateToUpdateParams(
      makeHandoffState({
        nodes: [
          {
            step: {
              localId: 'l1',
              id: 's1',
              name: 'Coder',
              agentId: 'a1',
              handoffTransitions: [
                { id: 'stale', target: 'Gone' },
                { id: 'ok', target: 'Review' },
              ],
            },
            position: { x: 0, y: 0 },
          },
          {
            step: { localId: 'l2', id: 's2', name: 'Review', agentId: 'a2' },
            position: { x: 0, y: 0 },
          },
        ],
      })
    );
    expect(params.nodes![0].transitions).toEqual([{ id: 'ok', target: 'Review' }]);
  });

  it('drops a handoff transition when its target node is renamed', () => {
    const params = visualStateToUpdateParams(
      makeHandoffState({
        nodes: [
          {
            step: {
              localId: 'l1',
              id: 's1',
              name: 'Coder',
              agentId: 'a1',
              handoffTransitions: [{ id: 't', target: 'Review' }],
            },
            position: { x: 0, y: 0 },
          },
          {
            step: { localId: 'l2', id: 's2', name: 'Reviewer', agentId: 'a2' },
            position: { x: 0, y: 0 },
          },
        ],
      })
    );
    expect(params.nodes![0].transitions).toBeUndefined();
  });

  it('drops a handoff transition whose target becomes ambiguous after a rename', () => {
    const params = visualStateToUpdateParams(
      makeHandoffState({
        nodes: [
          {
            step: {
              localId: 'l1',
              id: 's1',
              name: 'Coder',
              agentId: 'a1',
              handoffTransitions: [{ id: 't', target: 'shared' }],
            },
            position: { x: 0, y: 0 },
          },
          {
            step: {
              localId: 'l2',
              id: 's2',
              name: 'Review',
              agentId: '',
              agents: [
                { agentId: 'a2', name: 'shared' },
                { agentId: 'a3', name: 'other' },
              ],
            },
            position: { x: 0, y: 0 },
          },
          {
            step: {
              localId: 'l3',
              id: 's3',
              name: 'QA',
              agentId: '',
              agents: [{ agentId: 'a4', name: 'shared' }],
            },
            position: { x: 0, y: 0 },
          },
        ],
      })
    );
    expect(params.nodes![0].transitions).toBeUndefined();
  });

  it('drops handoff transitions whose referenced hook was removed', () => {
    const params = visualStateToUpdateParams(
      makeHandoffState({
        nodes: [
          {
            step: {
              localId: 'l1',
              id: 's1',
              name: 'Coder',
              agentId: 'a1',
              handoffTransitions: [
                { id: 'stale-hook', target: 'Review', hookId: 'gone-hook' },
                { id: 'ok', target: 'Review' },
              ],
            },
            position: { x: 0, y: 0 },
          },
          {
            step: { localId: 'l2', id: 's2', name: 'Review', agentId: 'a2' },
            position: { x: 0, y: 0 },
          },
        ],
      })
    );
    expect(params.nodes![0].transitions).toEqual([{ id: 'ok', target: 'Review' }]);
  });
});

describe('round-trip serialization', () => {
  it('produces equivalent steps after round-trip', () => {
    const original = makeWorkflow({
      nodes: [makeStep('s1', 'Plan', 'agent-p'), makeStep('s2', 'Code', 'agent-c')],
      startNodeId: 's1',
      layout: { s1: { x: 50, y: 50 }, s2: { x: 50, y: 200 } },
      tags: ['coding'],
    });

    const visualState = workflowToVisualState(original);
    const params = visualStateToUpdateParams(visualState);

    expect(params.nodes).toHaveLength(2);
    expect(params.nodes![0]).toMatchObject({ id: 's1', name: 'Plan' });
    expect(params.nodes![0].agents).toHaveLength(1);
    expect(params.nodes![0].agents[0].agentId).toBe('agent-p');
    expect(params.nodes![1]).toMatchObject({ id: 's2', name: 'Code' });
    expect(params.nodes![1].agents).toHaveLength(1);
    expect(params.nodes![1].agents[0].agentId).toBe('agent-c');
  });

  it('preserves startNodeId after round-trip', () => {
    const original = makeWorkflow({
      nodes: [makeStep('s1'), makeStep('s2')],
      startNodeId: 's2',
    });
    const params = visualStateToUpdateParams(workflowToVisualState(original));
    expect(params.startNodeId).toBe('s2');
  });

  it('preserves layout positions after round-trip', () => {
    const original = makeWorkflow({
      nodes: [makeStep('s1'), makeStep('s2')],
      startNodeId: 's1',
      layout: { s1: { x: 111, y: 222 }, s2: { x: 333, y: 444 } },
    });
    const params = visualStateToUpdateParams(workflowToVisualState(original));
    expect(params.layout).toMatchObject({
      s1: { x: 111, y: 222 },
      s2: { x: 333, y: 444 },
    });
  });

  it('produces empty transitions after round-trip (transitions removed from backend)', () => {
    const original = makeWorkflow({
      nodes: [makeStep('s1'), makeStep('s2')],
      startNodeId: 's1',
    });
    const visualState = workflowToVisualState(original);
    expect(visualState.edges).toHaveLength(0);
  });

  it('preserves tags after round-trip', () => {
    const original = makeWorkflow({
      nodes: [makeStep('s1')],
      startNodeId: 's1',
      tags: ['research', 'review'],
    });
    const params = visualStateToUpdateParams(workflowToVisualState(original));
    expect(params.tags).toEqual(['research', 'review']);
  });

  it('edges are empty after round-trip (transitions removed from backend)', () => {
    const original = makeWorkflow({
      nodes: [makeStep('s1'), makeStep('s2')],
      startNodeId: 's1',
    });
    const visualState = workflowToVisualState(original);
    expect(visualState.edges).toHaveLength(0);
  });

  it('is lossless for a 3-step workflow with all features', () => {
    const original = makeWorkflow({
      nodes: [
        makeStep('s1', 'Plan', 'agent-p'),
        makeStep('s2', 'Code', 'agent-c'),
        makeStep('s3', 'Review', 'agent-r'),
      ],
      startNodeId: 's1',
      layout: { s1: { x: 50, y: 50 }, s2: { x: 50, y: 200 }, s3: { x: 50, y: 350 } },
      tags: ['coding'],
    });

    const visualState = workflowToVisualState(original);
    const params = visualStateToUpdateParams(visualState);

    expect(params.nodes).toHaveLength(3);
    const stepIds = params.nodes!.map((s) => s.id);
    expect(stepIds).toContain('s1');
    expect(stepIds).toContain('s2');
    expect(stepIds).toContain('s3');

    expect(params.startNodeId).toBe('s1');

    expect(params.layout).toMatchObject({
      s1: { x: 50, y: 50 },
      s2: { x: 50, y: 200 },
      s3: { x: 50, y: 350 },
    });

    expect(params.tags).toEqual(['coding']);
  });

  it('preserves endNodeId after round-trip', () => {
    const original = makeWorkflow({
      nodes: [makeStep('s1'), makeStep('s2')],
      startNodeId: 's1',
      endNodeId: 's2',
    });
    const params = visualStateToUpdateParams(workflowToVisualState(original));
    expect(params.endNodeId).toBe('s2');
  });

  it('round-trip preserves endNodeId as null when not set', () => {
    const original = makeWorkflow({
      nodes: [makeStep('s1'), makeStep('s2')],
      startNodeId: 's1',
    });
    const params = visualStateToUpdateParams(workflowToVisualState(original));
    expect(params.endNodeId).toBeNull();
  });
});

describe('visualStateToUpdateParams', () => {
  it('applies name/description overrides', () => {
    const state: VisualEditorState = {
      nodes: [
        {
          step: { localId: 'l1', id: 's1', name: 'S1', agentId: 'a' },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      startNodeId: 's1',
      tags: [],
      channels: [],
      hooks: [],
    };
    const params = visualStateToUpdateParams(state, {
      name: 'Updated Name',
      description: 'New desc',
    });
    expect(params.name).toBe('Updated Name');
    expect(params.description).toBe('New desc');
  });

  it('passes endNodeId through to update params', () => {
    const state: VisualEditorState = {
      nodes: [
        {
          step: { localId: 'l1', id: 's1', name: 'S1', agentId: 'a' },
          position: { x: 0, y: 0 },
        },
        {
          step: { localId: 'l2', id: 's2', name: 'S2', agentId: 'a' },
          position: { x: 200, y: 0 },
        },
      ],
      edges: [],
      startNodeId: 's1',
      endNodeId: 's2',
      tags: [],
      channels: [],
      hooks: [],
    };
    const params = visualStateToUpdateParams(state);
    expect(params.endNodeId).toBe('s2');
  });

  it('passes node postApproval through to update params and clears legacy workflow route', () => {
    const state: VisualEditorState = {
      nodes: [
        {
          step: {
            localId: 'l1',
            id: 's1',
            name: 'S1',
            agentId: 'a',
            postApproval: {
              targetAgent: 'reviewer',
              instructions: 'Publish release.',
            },
          },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      startNodeId: 's1',
      tags: [],
      channels: [],
      hooks: [],
    };
    const params = visualStateToUpdateParams(state);
    expect(params.nodes?.[0].postApproval).toEqual({
      targetAgent: 's1',
      instructions: 'Publish release.',
    });
    expect(params.postApproval).toBeNull();
  });

  it('endNodeId is null when not set on state', () => {
    const state: VisualEditorState = {
      nodes: [
        {
          step: { localId: 'l1', id: 's1', name: 'S1', agentId: 'a' },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      startNodeId: 's1',
      tags: [],
      channels: [],
      hooks: [],
    };
    const params = visualStateToUpdateParams(state);
    expect(params.endNodeId).toBeNull();
  });
});

describe('multi-agent step serialization', () => {
  it('workflowToVisualState preserves agents array from WorkflowNode', () => {
    const workflow = makeWorkflow({
      nodes: [
        {
          id: 's1',
          name: 'Parallel Step',
          agents: [
            { agentId: 'a1', name: 'coder' },
            {
              agentId: 'a2',
              name: 'reviewer',
              customPrompt: { value: 'focus on security' },
            },
          ],
        },
      ],
    });
    const state = workflowToVisualState(workflow);
    const step = state.nodes.find((n) => n.step.id === 's1')!.step;
    expect(step.agents).toHaveLength(2);
    expect(step.agents![0].agentId).toBe('a1');
    expect(step.agents![1].agentId).toBe('a2');
    expect(step.agents![1].customPrompt).toEqual({ value: 'focus on security' });
    expect(step.agentId).toBe('');
  });

  it('workflowToVisualState preserves channels array at workflow level', () => {
    const workflow = makeWorkflow({
      channels: [],
      nodes: [
        {
          id: 's1',
          name: 'Parallel Step',
          agents: [
            { agentId: 'a1', name: 'coder' },
            { agentId: 'a2', name: 'reviewer' },
          ],
        },
      ],
    });
    const state = workflowToVisualState(workflow);
  });

  it('visualStateToCreateParams outputs agents array for multi-agent steps', () => {
    const state: VisualEditorState = {
      nodes: [
        {
          step: {
            localId: 'local-1',
            id: 's1',
            name: 'Parallel Step',
            agentId: '',
            agents: [
              { agentId: 'a1', name: 'coder' },
              {
                agentId: 'a2',
                name: 'reviewer',
                customPrompt: { value: 'custom' },
              },
            ],
          },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      startNodeId: 's1',
      tags: [],
      channels: [],
      hooks: [],
    };
    const params = visualStateToCreateParams(state, 'space-1', 'WF');
    const step = params.nodes![0];
    expect(step.agents).toHaveLength(2);
    expect(step.agents![0].agentId).toBe('a1');
    expect(step.agents![1].customPrompt).toEqual({ value: 'custom' });
    expect((step as unknown as Record<string, unknown>)['agentId']).toBeUndefined();
  });

  it('visualStateToCreateParams omits empty channels array', () => {
    const state: VisualEditorState = {
      nodes: [
        {
          step: {
            localId: 'local-1',
            id: 's1',
            name: 'Step',
            agentId: '',
            agents: [{ agentId: 'a1', name: 'coder' }],
          },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      startNodeId: 's1',
      tags: [],
      channels: [],
      hooks: [],
    };
    const params = visualStateToCreateParams(state, 'space-1', 'WF');
  });

  it('single-agent step round-trip: agents preserved through workflowToVisualState and serialized output', () => {
    const workflow = makeWorkflow({
      nodes: [makeStep('s1', 'Code', 'agent-coder')],
    });
    const state = workflowToVisualState(workflow);
    const s1Node = state.nodes.find((n) => n.step.id === 's1')!;
    expect(s1Node.step.agents).toHaveLength(1);
    expect(s1Node.step.agents![0].agentId).toBe('agent-coder');

    const params = visualStateToCreateParams(state, 'space-1', 'WF');
    expect(params.nodes![0].agents).toHaveLength(1);
    expect(params.nodes![0].agents[0].agentId).toBe('agent-coder');
  });

  it('full round-trip workflowToVisualState -> visualStateToUpdateParams preserves multi-agent data', () => {
    const workflow = makeWorkflow({
      channels: [
        { from: 'coder', to: 'reviewer' },
        { from: 'reviewer', to: ['coder', 'qa'] },
      ],
      nodes: [
        {
          id: 's1',
          name: 'Parallel',
          agents: [
            {
              agentId: 'a1',
              name: 'coder',
              customPrompt: { value: 'focus on tests' },
            },
            { agentId: 'a2', name: 'reviewer' },
          ],
        },
      ],
      layout: { s1: { x: 0, y: 0 } },
    });
    const state = workflowToVisualState(workflow);
    const params = visualStateToUpdateParams(state);

    const step = params.nodes![0];
    expect(step.agents).toHaveLength(2);
    expect(step.agents![0].agentId).toBe('a1');
    expect(step.agents![0].customPrompt).toEqual({ value: 'focus on tests' });
    expect(step.agents![1].agentId).toBe('a2');
    expect(step.agents![1].customPrompt).toBeUndefined();
    expect((step as unknown as Record<string, unknown>)['agentId']).toBeUndefined();
    expect(params.channels).toHaveLength(2);
    expect(params.channels![0]).toMatchObject({
      from: 'coder',
      to: 'reviewer',
    });
    expect(params.channels![1]).toMatchObject({
      from: 'reviewer',
      to: ['coder', 'qa'],
    });
  });
});

describe('per-slot agent overrides round-trip', () => {
  it('workflowToVisualState preserves customPrompt override on agents', () => {
    const wf = makeWorkflow({
      nodes: [
        {
          id: 's1',
          name: 'Review',
          agents: [
            {
              agentId: 'a1',
              name: 'strict-reviewer',
              customPrompt: { value: 'Be strict.' },
            },
            { agentId: 'a1', name: 'quick-reviewer' },
          ],
        },
      ],
      startNodeId: 's1',
    });
    const state = workflowToVisualState(wf);
    const node = state.nodes.find((n) => n.step.id === 's1')!;
    expect(node.step.agents).toHaveLength(2);
    expect(node.step.agents![0].name).toBe('strict-reviewer');
    expect(node.step.agents![0].customPrompt).toMatchObject({ value: 'Be strict.' });
    expect(node.step.agents![1].customPrompt).toBeUndefined();
  });

  it('workflowToVisualState preserves customPrompt override on single-slot agents', () => {
    const wf = makeWorkflow({
      nodes: [
        {
          id: 's1',
          name: 'Code',
          agents: [
            {
              agentId: 'a1',
              name: 'coder',
              customPrompt: { value: 'You are a strict TypeScript expert.' },
            },
          ],
        },
      ],
      startNodeId: 's1',
    });
    const state = workflowToVisualState(wf);
    const node = state.nodes.find((n) => n.step.id === 's1')!;
    expect(node.step.agents![0].customPrompt).toMatchObject({
      value: 'You are a strict TypeScript expert.',
    });
  });

  it('visualStateToCreateParams passes customPrompt override through to output', () => {
    const wf = makeWorkflow({
      nodes: [
        {
          id: 's1',
          name: 'Review',
          agents: [
            {
              agentId: 'a1',
              name: 'strict-reviewer',
              customPrompt: { value: 'Be strict.' },
            },
            { agentId: 'a2', name: 'quick-reviewer' },
          ],
        },
      ],
      startNodeId: 's1',
    });
    const state = workflowToVisualState(wf);
    const params = visualStateToCreateParams(state, 'space-1', 'WF');

    const node = params.nodes![0];
    expect(node.agents).toHaveLength(2);
    expect(node.agents![0].name).toBe('strict-reviewer');
    expect(node.agents![0].customPrompt).toMatchObject({ value: 'Be strict.' });
    expect(node.agents![1].customPrompt).toBeUndefined();
  });

  it('full round-trip: workflow->visualState->createParams preserves customPrompt fields', () => {
    const wf = makeWorkflow({
      nodes: [
        {
          id: 's1',
          name: 'Multi Review',
          agents: [
            {
              agentId: 'a1',
              name: 'coder',
              customPrompt: { value: 'Fast coder. Focus on speed.' },
            },
            {
              agentId: 'a1',
              name: 'coder-2',
              customPrompt: { value: 'Focus on quality.' },
            },
          ],
        },
      ],
      startNodeId: 's1',
    });
    const state = workflowToVisualState(wf);
    const params = visualStateToCreateParams(state, 'space-1', 'WF');

    const [slot1, slot2] = params.nodes![0].agents!;
    expect(slot1.name).toBe('coder');
    expect(slot1.customPrompt).toMatchObject({ value: 'Fast coder. Focus on speed.' });
    expect(slot2.name).toBe('coder-2');
    expect(slot2.customPrompt).toMatchObject({ value: 'Focus on quality.' });
  });

  it('same agent added twice with different roles: both preserved in create params', () => {
    const wf = makeWorkflow({
      nodes: [
        {
          id: 's1',
          name: 'Dual Review',
          agents: [
            { agentId: 'reviewer-agent', name: 'reviewer' },
            {
              agentId: 'reviewer-agent',
              name: 'reviewer-2',
              customPrompt: { value: 'Be thorough.' },
            },
          ],
        },
      ],
      startNodeId: 's1',
    });
    const state = workflowToVisualState(wf);
    const params = visualStateToCreateParams(state, 'space-1', 'WF');
    const agents = params.nodes![0].agents!;
    expect(agents).toHaveLength(2);
    expect(agents[0].agentId).toBe('reviewer-agent');
    expect(agents[0].name).toBe('reviewer');
    expect(agents[1].agentId).toBe('reviewer-agent');
    expect(agents[1].name).toBe('reviewer-2');
    expect(agents[1].customPrompt).toMatchObject({ value: 'Be thorough.' });
  });

  it('role rename in visual state is reflected in serialized output', () => {
    const wf = makeWorkflow({
      nodes: [
        {
          id: 's1',
          name: 'Code',
          agents: [{ agentId: 'a1', name: 'coder' }],
        },
      ],
      channels: [{ from: 'planner', to: 'coder' }],
      startNodeId: 's1',
    });
    const state = workflowToVisualState(wf);

    const nodeIdx = state.nodes.findIndex((n) => n.step.id === 's1');
    state.nodes[nodeIdx].step.agents = [{ agentId: 'a1', name: 'lead-coder' }];

    const params = visualStateToCreateParams(state, 'space-1', 'WF');
    const node = params.nodes![0];

    expect(node.agents![0].name).toBe('lead-coder');
    expect(params.channels).toHaveLength(1);
    expect(params.channels![0]).toMatchObject({
      from: 'planner',
      to: 'coder',
    });
  });
});
