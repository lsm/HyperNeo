/**
 * Unit tests for workflow-templates.ts
 *
 * Covers the utility functions extracted from the legacy WorkflowEditor:
 * - filterAgents: excludes 'leader' agents
 * - buildTemplateNodes: builds NodeDraft array from a template + agent list
 * - getAvailableTemplates: converts SpaceWorkflow list to WorkflowTemplate list,
 *   filtering out entries without valid start/end step names
 */

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

// ============================================================================
// filterAgents
// ============================================================================

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

// ============================================================================
// buildTemplateNodes — stepRoles (legacy single-agent)
// ============================================================================

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
    // fallback uses agents[0]
    expect(node.agentId).toBe('a1');
  });
});

// ============================================================================
// buildTemplateNodes — rich steps (multi-agent)
// ============================================================================

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

// ============================================================================
// getAvailableTemplates / workflowToTemplate
// ============================================================================

describe('getAvailableTemplates', () => {
  it('converts workflows to templates', () => {
    const wf = makeWorkflow();
    const templates = getAvailableTemplates([wf]);
    expect(templates).toHaveLength(1);
    expect(templates[0].label).toBe('Test Workflow');
  });

  it('filters out workflows without valid start/end step names', () => {
    // Workflow with no endNodeId — endStepName will be undefined
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
    // A workflow cloned via the template picker must keep its handoff contract:
    // workflowToTemplate copies node transitions onto the step, and
    // buildTemplateNodes copies them onto the NodeDraft so the save serializer
    // can re-emit them.
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

  it('preserves workflow-level hook bindings through conversion', () => {
    // Without preserving hook bindings, cloning a built-in workflow silently
    // drops its runtime enforcement. Verify hookBindings survive
    // workflowToTemplate as shallow clones.
    const wf = makeWorkflow({
      hookBindings: [
        {
          hookId: 'post-approval-gate',
          sourceNode: 'Coding',
          targetNode: 'QA',
          method: 'send_message',
          order: 0,
          enabled: true,
        },
      ],
    });
    const template = workflowToTemplate(wf);
    expect(template.hookBindings).toHaveLength(1);
    expect(template.hookBindings![0]).toMatchObject({
      hookId: 'post-approval-gate',
      sourceNode: 'Coding',
      targetNode: 'QA',
      method: 'send_message',
    });
    // Shallow clone — not the same reference as the source binding.
    expect(template.hookBindings![0]).not.toBe(wf.hookBindings![0]);
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
    // Cloned, not the same reference.
    expect(template.steps![0].agentSlots![0].toolGuards![0]).not.toBe(coderNoMergeGuard);
    // Slots without guards stay undefined.
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
