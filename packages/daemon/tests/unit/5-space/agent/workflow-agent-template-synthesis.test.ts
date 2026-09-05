import { describe, expect, test } from 'bun:test';
import type { SpaceWorkerAgent } from '@hyperneo/shared';
import {
  allocateMigratedTemplateKey,
  MIGRATED_WORKFLOW_TEMPLATE_PREFIX,
  synthesizeOrphanWorkflowAgentTemplate,
  synthesizeWorkflowAgentTemplate,
} from '../../../../src/lib/space/agents/workflow-agent-template-synthesis.ts';

describe('allocateMigratedTemplateKey', () => {
  test('derives the key from the slugified seed under the migrated prefix', () => {
    expect(allocateMigratedTemplateKey('Code Reviewer', 'agent-1', new Set())).toBe(
      `${MIGRATED_WORKFLOW_TEMPLATE_PREFIX}code-reviewer`
    );
  });

  test('falls back to the default slug when the seed has no usable characters', () => {
    expect(allocateMigratedTemplateKey('???', 'agent-1', new Set())).toBe(
      `${MIGRATED_WORKFLOW_TEMPLATE_PREFIX}unnamed-space`
    );
  });

  test('suffixes with the agent id fragment when the base key is claimed', () => {
    const claimed = new Set([`${MIGRATED_WORKFLOW_TEMPLATE_PREFIX}coder`]);
    expect(allocateMigratedTemplateKey('coder', 'a1b2c3d4-e5f6', claimed)).toBe(
      `${MIGRATED_WORKFLOW_TEMPLATE_PREFIX}coder.a1b2c3d4`
    );
  });

  test('counts up when the agent-id-suffixed key is claimed too', () => {
    const claimed = new Set([
      `${MIGRATED_WORKFLOW_TEMPLATE_PREFIX}coder`,
      `${MIGRATED_WORKFLOW_TEMPLATE_PREFIX}coder.a1b2c3d4`,
      `${MIGRATED_WORKFLOW_TEMPLATE_PREFIX}coder.a1b2c3d4.2`,
    ]);
    expect(allocateMigratedTemplateKey('coder', 'a1b2c3d4-0000', claimed)).toBe(
      `${MIGRATED_WORKFLOW_TEMPLATE_PREFIX}coder.a1b2c3d4.3`
    );
  });

  test('does not mutate the claimed set', () => {
    const claimed = new Set<string>();
    allocateMigratedTemplateKey('coder', 'agent-1', claimed);
    expect(claimed.size).toBe(0);
  });
});

describe('synthesizeWorkflowAgentTemplate', () => {
  test('copies the agent config into template params under the allocated key', () => {
    const params = synthesizeWorkflowAgentTemplate(
      {
        id: 'agent-1',
        handle: 'registry-agent',
        displayName: 'Registry Agent',
        description: 'Does the work',
        instructions: 'Be thorough',
        autonomyLevel: 3,
        model: 'claude-x',
        provider: 'anthropic',
        thinkingLevel: 'think8k',
        settingSources: ['user', 'project'],
        tools: ['Read', 'Bash(gh pr view:*)'],
        modelPool: [{ model: 'claude-x', maxConcurrent: 2, weight: 1 }],
      },
      'migrated.registry-agent'
    );

    expect(params).toEqual({
      key: 'migrated.registry-agent',
      handle: 'registry-agent',
      displayName: 'Registry Agent',
      description: 'Does the work',
      instructions: 'Be thorough',
      suggestedAutonomyLevel: 3,
      model: 'claude-x',
      provider: 'anthropic',
      modelPool: [{ model: 'claude-x', maxConcurrent: 2, weight: 1 }],
      thinkingLevel: 'think8k',
      settingSources: ['user', 'project'],
      tools: ['Read', 'Bash(gh pr view:*)'],
    });
  });

  test('normalizes missing config to template defaults', () => {
    const params = synthesizeWorkflowAgentTemplate(
      { id: 'agent-2', handle: '', displayName: '', instructions: null },
      'migrated.agent-2'
    );

    expect(params.handle).toBe('agent-2');
    expect(params.displayName).toBe('');
    expect(params.description).toBe('');
    expect(params.instructions).toBe('');
    expect(params.suggestedAutonomyLevel).toBe(2);
    expect(params.model).toBeNull();
    expect(params.provider).toBeNull();
    expect(params.modelPool).toBeNull();
    expect(params.thinkingLevel).toBeNull();
    expect(params.settingSources).toBeNull();
    expect(params.tools).toBeNull();
  });

  test('copies array fields onto fresh arrays instead of sharing the source', () => {
    const tools = ['Read'];
    const pool = [{ model: 'claude-x', maxConcurrent: 1, weight: 1 }];
    const params = synthesizeWorkflowAgentTemplate(
      {
        id: 'agent-3',
        handle: 'a3',
        displayName: 'A3',
        instructions: 'x',
        tools,
        modelPool: pool,
        settingSources: ['user'],
      },
      'migrated.a3'
    );

    expect(params.tools).toEqual(tools);
    expect(params.tools).not.toBe(tools);
    expect(params.modelPool).toEqual(pool);
    expect(params.modelPool).not.toBe(pool);
    expect(params.settingSources).toEqual(['user']);
  });
});

describe('synthesizeOrphanWorkflowAgentTemplate', () => {
  test('generates an empty template named after the slot', () => {
    const params = synthesizeOrphanWorkflowAgentTemplate(
      { agentId: 'deleted-agent', slotName: 'Ghost Writer' },
      'migrated.ghost-writer'
    );

    expect(params).toEqual({
      key: 'migrated.ghost-writer',
      handle: 'ghost-writer',
      displayName: 'Ghost Writer',
      description: '',
      instructions: '',
      suggestedAutonomyLevel: 2,
      model: null,
      provider: null,
      modelPool: null,
      thinkingLevel: null,
      settingSources: null,
      tools: null,
    });
  });

  test('falls back to the agent id when the slot name is blank', () => {
    const params = synthesizeOrphanWorkflowAgentTemplate(
      { agentId: 'deleted-agent', slotName: '  ' },
      'migrated.deleted-agent'
    );

    expect(params.displayName).toBe('deleted-agent');
    expect(params.handle).toBe('deleted-agent');
  });
});

describe('synthesis round trip preserves agent-facing fields', () => {
  test('synthesized params cover the fields a SpaceWorkerAgent spawn reads', () => {
    const agent: SpaceWorkerAgent = {
      id: 'agent-1',
      spaceId: 'space-1',
      name: 'Registry Agent',
      handle: 'registry-agent',
      customPrompt: 'Be thorough',
      model: 'claude-x',
      provider: 'anthropic',
      thinkingLevel: 'think8k',
      settingSources: ['user'],
      tools: ['Read'],
      modelPool: [{ model: 'claude-x', maxConcurrent: 2, weight: 1 }],
      createdAt: 100,
      updatedAt: 200,
    };
    const params = synthesizeWorkflowAgentTemplate(
      {
        id: agent.id,
        handle: agent.handle,
        displayName: agent.name,
        instructions: agent.customPrompt,
        model: agent.model ?? null,
        provider: agent.provider ?? null,
        thinkingLevel: agent.thinkingLevel ?? null,
        settingSources: agent.settingSources ?? null,
        tools: agent.tools ?? null,
        modelPool: agent.modelPool ?? null,
      },
      'migrated.registry-agent'
    );

    expect(params.instructions).toBe(agent.customPrompt);
    expect(params.model).toBe(agent.model);
    expect(params.provider).toBe(agent.provider);
    expect(params.thinkingLevel).toBe(agent.thinkingLevel);
    expect(params.settingSources).toEqual(agent.settingSources);
    expect(params.tools).toEqual(agent.tools);
    expect(params.modelPool).toEqual(agent.modelPool);
    expect(params.displayName).toBe(agent.name);
    expect(params.handle).toBe(agent.handle);
  });
});
