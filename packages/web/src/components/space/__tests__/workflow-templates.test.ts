import { describe, it, expect } from 'vitest';
import type { SpaceWorkerAgent, SpaceWorkflow } from '@hyperneo/shared';
import {
  filterAgents,
  buildTemplateNodes,
  getAvailableTemplates,
  workflowToTemplate,
} from '../workflow-templates';

function makeAgent(id: string, name: string): SpaceWorkerAgent {
  return {
    id,
    spaceId: 'space-1',
    name,
    handle: id,
    customPrompt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
  const step1Id = 'step-1';
  const step2Id = 'step-2';
  return {
    id: 'wf-1',
    spaceId: 'space-1',
    name: 'Test Workflow',
    description: 'A test workflow',
    nodes: [
      { id: step1Id, name: 'Plan', agents: [{ agentId: 'agent-1', name: 'planner' }] },
      { id: step2Id, name: 'Code', agents: [{ agentId: 'agent-2', name: 'coder' }] },
    ],
    startNodeId: step1Id,
    endNodeId: step2Id,
    tags: [],
    completionAutonomyLevel: 3,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('filterAgents', () => {
  it('removes agents named "leader" (case-insensitive)', () => {
    const agents = [
      makeAgent('a1', 'Coder'),
      makeAgent('a2', 'leader'),
      makeAgent('a3', 'Leader'),
      makeAgent('a4', 'LEADER'),
      makeAgent('a5', 'Reviewer'),
    ];
    const result = filterAgents(agents);
    expect(result.map((a) => a.id)).toEqual(['a1', 'a5']);
  });

  it('returns all agents when none are named leader', () => {
    const agents = [makeAgent('a1', 'Coder'), makeAgent('a2', 'Reviewer')];
    expect(filterAgents(agents)).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(filterAgents([])).toEqual([]);
  });
});

describe('buildTemplateNodes — stepRoles', () => {
  const agents = [makeAgent('a1', 'planner'), makeAgent('a2', 'coder')];

  it('builds one NodeDraft per stepRole', () => {
    const template = { label: 'T', description: '', stepRoles: ['planner', 'coder'] };
    const nodes = buildTemplateNodes(template, agents);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].name).toBe('Planner');
    expect(nodes[1].name).toBe('Coder');
  });

  it('assigns matching agent by role name', () => {
    const template = { label: 'T', description: '', stepRoles: ['coder'] };
    const [node] = buildTemplateNodes(template, agents);
    expect(node.agentId).toBe('a2');
  });

  it('each node has a non-empty localId', () => {
    const template = { label: 'T', description: '', stepRoles: ['planner'] };
    const [node] = buildTemplateNodes(template, agents);
    expect(node.localId).toBeTruthy();
  });

  it('falls back to first agent when no role match', () => {
    const template = { label: 'T', description: '', stepRoles: ['unknown-role'] };
    const [node] = buildTemplateNodes(template, agents);
    expect(node.agentId).toBe('a1');
  });
});

describe('buildTemplateNodes — rich steps', () => {
  const agents = [makeAgent('a1', 'coder'), makeAgent('a2', 'reviewer')];

  it('builds single-agent step from rich step with role', () => {
    const template = {
      label: 'T',
      description: '',
      steps: [{ name: 'Build', role: 'coder' }],
    };
    const [node] = buildTemplateNodes(template, agents);
    expect(node.name).toBe('Build');
    expect(node.agentId).toBe('a1');
  });

  it('builds multi-agent step from agentSlots', () => {
    const template = {
      label: 'T',
      description: '',
      steps: [
        {
          name: 'Review',
          agentSlots: [
            { name: 'Reviewer 1', role: 'reviewer' },
            { name: 'Coder 1', role: 'coder' },
          ],
        },
      ],
    };
    const [node] = buildTemplateNodes(template, agents);
    expect(node.agents).toHaveLength(2);
    expect(node.agents![0].agentId).toBe('a2');
    expect(node.agents![1].agentId).toBe('a1');
  });

  it('wraps systemPrompt in WorkflowNodeAgentOverride object', () => {
    const template = {
      label: 'T',
      description: '',
      steps: [{ name: 'Build', role: 'coder', systemPrompt: 'You are a coder' }],
    };
    const [node] = buildTemplateNodes(template, agents);
    expect(node.agents![0].customPrompt).toEqual({ value: 'You are a coder' });
  });

  it('carries resetContextPerTurn from template slot to NodeDraft (multi + single)', () => {
    const multiTemplate = {
      label: 'T',
      description: '',
      steps: [
        {
          name: 'Review',
          agentSlots: [
            { name: 'Reviewer 1', role: 'reviewer', resetContextPerTurn: true },
            { name: 'Coder 1', role: 'coder' },
          ],
        },
      ],
    };
    const [multi] = buildTemplateNodes(multiTemplate, agents);
    expect(multi.agents![0].resetContextPerTurn).toBe(true);
    expect(multi.agents![1].resetContextPerTurn).toBeUndefined();

    const singleTemplate = {
      label: 'T',
      description: '',
      steps: [{ name: 'Review', role: 'reviewer', resetContextPerTurn: true }],
    };
    const [single] = buildTemplateNodes(singleTemplate, agents);
    expect(single.agents![0].resetContextPerTurn).toBe(true);
  });

  it('returns empty array for template with no steps and no stepRoles', () => {
    const template = { label: 'T', description: '' };
    expect(buildTemplateNodes(template, agents)).toEqual([]);
  });
});

describe('getAvailableTemplates', () => {
  it('converts workflows to templates', () => {
    const wf = makeWorkflow();
    const templates = getAvailableTemplates([wf]);
    expect(templates).toHaveLength(1);
    expect(templates[0].label).toBe('Test Workflow');
  });

  it('filters out workflows without valid start/end step names', () => {
    const wf = makeWorkflow({ endNodeId: undefined });
    const templates = getAvailableTemplates([wf]);
    expect(templates).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(getAvailableTemplates([])).toEqual([]);
  });
});

describe('workflowToTemplate', () => {
  it('maps startNodeId to startStepName', () => {
    const wf = makeWorkflow();
    const template = workflowToTemplate(wf);
    expect(template.startStepName).toBe('Plan');
    expect(template.endStepName).toBe('Code');
  });

  it('preserves tags', () => {
    const wf = makeWorkflow({ tags: ['coding', 'review'] });
    const template = workflowToTemplate(wf);
    expect(template.tags).toEqual(['coding', 'review']);
  });

  it('carries handoff transitions through to template steps and built nodes', () => {
    const transitions = [{ id: 'to-code', target: 'Code' }];
    const wf = makeWorkflow({
      nodes: [
        {
          id: 'step-1',
          name: 'Plan',
          agents: [{ agentId: 'agent-1', name: 'planner' }],
          transitions,
        },
        { id: 'step-2', name: 'Code', agents: [{ agentId: 'agent-2', name: 'coder' }] },
      ],
    });
    const template = workflowToTemplate(wf);
    expect(template.steps![0].handoffTransitions).toEqual(transitions);

    const agents = [makeAgent('agent-1', 'planner'), makeAgent('agent-2', 'coder')];
    const [node] = buildTemplateNodes(template, agents);
    expect(node.handoffTransitions).toEqual(transitions);
  });

  it('maps single-agent nodes to steps with role', () => {
    const wf = makeWorkflow();
    const template = workflowToTemplate(wf);
    expect(template.steps).toHaveLength(2);
    expect(template.steps![0].role).toBe('planner');
    expect(template.steps![1].role).toBe('coder');
  });

  it('preserves workflow-level hooks through conversion', () => {
    const wf = makeWorkflow({
      hooks: [
        {
          id: 'coding-to-qa-post-approval',
          enabled: true,
          sourceNode: 'Coding',
          targetNode: 'QA',
          method: 'send_message',
          validator: { kind: 'built_in', id: 'post_approval_only' },
        },
      ],
    });
    const template = workflowToTemplate(wf);
    expect(template.hooks).toHaveLength(1);
    expect(template.hooks![0]).toMatchObject({
      id: 'coding-to-qa-post-approval',
      sourceNode: 'Coding',
      targetNode: 'QA',
      method: 'send_message',
    });
    expect(template.hooks![0]).not.toBe(wf.hooks![0]);
  });

  it('preserves per-slot toolGuards on multi-agent nodes', () => {
    const coderNoMergeGuard = {
      matcher: 'Bash',
      pattern: 'gh pr merge',
      decision: 'deny' as const,
      reason: 'no raw merge',
    };
    const wf = makeWorkflow({
      nodes: [
        {
          id: 'step-1',
          name: 'Review',
          agents: [
            { agentId: 'agent-1', name: 'coder', toolGuards: [coderNoMergeGuard] },
            { agentId: 'agent-2', name: 'reviewer' },
          ],
        },
        { id: 'step-2', name: 'Done', agents: [{ agentId: 'agent-2', name: 'general' }] },
      ],
      endNodeId: 'step-2',
    });
    const template = workflowToTemplate(wf);
    expect(template.steps![0].agentSlots![0].toolGuards).toEqual([coderNoMergeGuard]);
    expect(template.steps![0].agentSlots![0].toolGuards![0]).not.toBe(coderNoMergeGuard);
    expect(template.steps![0].agentSlots![1].toolGuards).toBeUndefined();
  });

  it('preserves toolGuards on single-agent nodes', () => {
    const coderNoMergeGuard = {
      matcher: 'Bash',
      pattern: 'gh pr merge',
      decision: 'deny' as const,
      reason: 'no raw merge',
    };
    const wf = makeWorkflow({
      nodes: [
        { id: 'step-1', name: 'Plan', agents: [{ agentId: 'agent-1', name: 'planner' }] },
        {
          id: 'step-2',
          name: 'Code',
          agents: [{ agentId: 'agent-2', name: 'coder', toolGuards: [coderNoMergeGuard] }],
        },
      ],
      endNodeId: 'step-2',
    });
    const template = workflowToTemplate(wf);
    expect(template.steps![1].toolGuards).toEqual([coderNoMergeGuard]);
    expect(template.steps![1].toolGuards![0]).not.toBe(coderNoMergeGuard);
  });
});

describe('buildTemplateNodes — toolGuards round-trip', () => {
  const agents = [makeAgent('a1', 'coder'), makeAgent('a2', 'reviewer')];
  const coderNoMergeGuard = {
    matcher: 'Bash',
    pattern: 'gh pr merge',
    decision: 'deny' as const,
    reason: 'no raw merge',
  };

  it('carries step toolGuards into the single-agent slot', () => {
    const template = {
      label: 'T',
      description: '',
      steps: [{ name: 'Code', role: 'coder', toolGuards: [coderNoMergeGuard] }],
    };
    const [node] = buildTemplateNodes(template, agents);
    expect(node.agents![0].toolGuards).toEqual([coderNoMergeGuard]);
    expect(node.agents![0].toolGuards![0]).not.toBe(coderNoMergeGuard);
  });

  it('carries slot toolGuards into each multi-agent slot', () => {
    const template = {
      label: 'T',
      description: '',
      steps: [
        {
          name: 'Review',
          agentSlots: [
            { name: 'Reviewer 1', role: 'reviewer', toolGuards: [coderNoMergeGuard] },
            { name: 'Coder 1', role: 'coder' },
          ],
        },
      ],
    };
    const [node] = buildTemplateNodes(template, agents);
    expect(node.agents![0].toolGuards).toEqual([coderNoMergeGuard]);
    expect(node.agents![1].toolGuards).toBeUndefined();
  });
});
