import { describe, expect, test } from 'bun:test';
import {
  migratedAgentTemplateKey,
  synthesizeAgentTemplate,
  synthesizeOrphanAgentTemplate,
  type AgentTemplateSynthesisInput,
} from '../../../../src/lib/space/agents/agent-template-synthesis.ts';

function makeSynthesisInput(
  overrides: Partial<AgentTemplateSynthesisInput> = {}
): AgentTemplateSynthesisInput {
  return {
    id: 'agent-1',
    displayName: 'Research Agent',
    handle: 'research-agent',
    description: 'Does the reading.',
    instructions: 'Base contract',
    model: 'claude-opus-5',
    provider: 'anthropic',
    thinkingLevel: 'think8k',
    settingSources: ['project'],
    tools: ['Read'],
    modelPool: [{ model: 'claude-sonnet-5', maxConcurrent: 1, weight: 1 }],
    autonomyLevel: 4,
    ...overrides,
  };
}

describe('migratedAgentTemplateKey', () => {
  test('derives a stable key from the agent id', () => {
    expect(migratedAgentTemplateKey('agent-9')).toBe('migrated.agent.agent-9');
    expect(migratedAgentTemplateKey('agent-9')).toBe(migratedAgentTemplateKey('agent-9'));
  });
});

describe('synthesizeAgentTemplate', () => {
  test('maps the agent config onto template params under the migrated key', () => {
    const params = synthesizeAgentTemplate(makeSynthesisInput());

    expect(params.key).toBe('migrated.agent.agent-1');
    expect(params.handle).toBe('research-agent');
    expect(params.displayName).toBe('Research Agent');
    expect(params.description).toBe('Does the reading.');
    expect(params.instructions).toBe('Base contract');
    expect(params.suggestedAutonomyLevel).toBe(4);
    expect(params.model).toBe('claude-opus-5');
    expect(params.provider).toBe('anthropic');
    expect(params.thinkingLevel).toBe('think8k');
    expect(params.settingSources).toEqual(['project']);
    expect(params.tools).toEqual(['Read']);
    expect(params.modelPool).toEqual([{ model: 'claude-sonnet-5', maxConcurrent: 1, weight: 1 }]);
  });

  test('falls back to a slug of the display name when the handle is empty', () => {
    const params = synthesizeAgentTemplate(makeSynthesisInput({ handle: null }));
    expect(params.handle).toBe('research-agent');
  });

  test('passes null model, provider, thinking level, and setting sources through', () => {
    const params = synthesizeAgentTemplate(
      makeSynthesisInput({
        model: null,
        provider: null,
        thinkingLevel: null,
        settingSources: null,
        tools: null,
        modelPool: null,
      })
    );

    expect(params.model).toBeNull();
    expect(params.provider).toBeNull();
    expect(params.thinkingLevel).toBeNull();
    expect(params.settingSources).toBeNull();
    expect(params.tools).toBeNull();
    expect(params.modelPool).toBeNull();
  });

  test('clamps an out-of-range or missing autonomy level to the default', () => {
    expect(
      synthesizeAgentTemplate(makeSynthesisInput({ autonomyLevel: null })).suggestedAutonomyLevel
    ).toBe(2);
    expect(
      synthesizeAgentTemplate(makeSynthesisInput({ autonomyLevel: 9 })).suggestedAutonomyLevel
    ).toBe(2);
    expect(
      synthesizeAgentTemplate(makeSynthesisInput({ autonomyLevel: 1 })).suggestedAutonomyLevel
    ).toBe(1);
  });
});

describe('synthesizeOrphanAgentTemplate', () => {
  test('generates template params from the slot config with an empty base prompt', () => {
    const params = synthesizeOrphanAgentTemplate('agent-gone', {
      name: 'ghost',
      model: 'claude-haiku-4-5',
      thinkingLevel: 'think8k',
    });

    expect(params.key).toBe('migrated.agent.agent-gone');
    expect(params.handle).toBe('ghost');
    expect(params.displayName).toBe('ghost');
    expect(params.instructions).toBe('');
    expect(params.model).toBe('claude-haiku-4-5');
    expect(params.thinkingLevel).toBe('think8k');
    expect(params.suggestedAutonomyLevel).toBe(2);
    expect(params.provider).toBeNull();
    expect(params.settingSources).toBeNull();
    expect(params.tools).toBeNull();
  });

  test('falls back to the agent id for display when the slot has no name', () => {
    const params = synthesizeOrphanAgentTemplate('agent-gone', {
      name: '  ',
      model: null,
      thinkingLevel: null,
    });

    expect(params.displayName).toBe('agent-gone');
    expect(params.handle).toBe('agent-gone');
    expect(params.instructions).toBe('');
  });
});
