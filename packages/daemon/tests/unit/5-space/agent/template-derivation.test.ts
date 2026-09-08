import { describe, expect, test } from 'bun:test';
import {
  type AgentTemplateDerivationSource,
  deriveAgentTemplate,
} from '../../../../src/lib/space/agents/template-derivation.ts';

function makeSource(
  overrides: Partial<AgentTemplateDerivationSource> = {}
): AgentTemplateDerivationSource {
  return {
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

describe('deriveAgentTemplate', () => {
  test('maps the agent source onto template params under the caller-supplied key', () => {
    const params = deriveAgentTemplate(makeSource(), { key: 'worker-custom.agent-1' });

    expect(params.key).toBe('worker-custom.agent-1');
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

  test('derives a safe minimal prompt when the instructions are empty', () => {
    const params = deriveAgentTemplate(makeSource({ instructions: '' }), {
      key: 'worker-custom.a',
    });

    expect(params.instructions).not.toBe('');
    expect(params.instructions).toContain('Research Agent');
  });

  test('lets the caller pin an explicit empty-instructions value', () => {
    const params = deriveAgentTemplate(makeSource({ instructions: '' }), {
      key: 'migrated.agent.a',
      emptyInstructions: '',
    });

    expect(params.instructions).toBe('');
  });

  test('keeps non-empty instructions verbatim', () => {
    const params = deriveAgentTemplate(makeSource({ instructions: 'Keep me.' }), {
      key: 'worker-custom.a',
      emptyInstructions: 'Fallback',
    });

    expect(params.instructions).toBe('Keep me.');
  });

  test('falls back to a slug of the display name when the handle is empty', () => {
    expect(deriveAgentTemplate(makeSource({ handle: null }), { key: 'k' }).handle).toBe(
      'research-agent'
    );
    expect(deriveAgentTemplate(makeSource({ handle: '   ' }), { key: 'k' }).handle).toBe(
      'research-agent'
    );
  });

  test('passes null model, provider, thinking level, and setting sources through', () => {
    const params = deriveAgentTemplate(
      makeSource({
        model: null,
        provider: null,
        thinkingLevel: null,
        settingSources: null,
        tools: null,
        modelPool: null,
      }),
      { key: 'k' }
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
      deriveAgentTemplate(makeSource({ autonomyLevel: null }), { key: 'k' }).suggestedAutonomyLevel
    ).toBe(2);
    expect(
      deriveAgentTemplate(makeSource({ autonomyLevel: 9 }), { key: 'k' }).suggestedAutonomyLevel
    ).toBe(2);
    expect(
      deriveAgentTemplate(makeSource({ autonomyLevel: 1 }), { key: 'k' }).suggestedAutonomyLevel
    ).toBe(1);
  });

  test('treats a missing description as an empty description', () => {
    expect(deriveAgentTemplate(makeSource({ description: null }), { key: 'k' }).description).toBe(
      ''
    );
  });
});
