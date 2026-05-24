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
import type { SpaceAgent, SpaceWorkflow } from '@neokai/shared';
import {
  filterAgents,
  buildTemplateNodes,
  getAvailableTemplates,
  workflowToTemplate,
} from '../workflow-templates';

function makeAgent(id: string, name: string): SpaceAgent {
  return {
    id,
    spaceId: 'space-1',
    name,
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

  it('maps single-agent nodes to steps with role', () => {
    const wf = makeWorkflow();
    const template = workflowToTemplate(wf);
    expect(template.steps).toHaveLength(2);
    expect(template.steps![0].role).toBe('planner');
    expect(template.steps![1].role).toBe('coder');
  });
});
