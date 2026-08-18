import { describe, it, expect } from 'bun:test';
import {
  buildAgentTemplateFingerprint,
  computeAgentTemplateHash,
  agentTemplatesMatch,
  type AgentTemplateInput,
} from '../../../../src/lib/space/agents/agent-template-hash';

function makeAgent(overrides: Partial<AgentTemplateInput> = {}): AgentTemplateInput {
  return {
    name: 'Coder',
    description: 'Implementation worker',
    tools: ['Read', 'Write', 'Bash'],
    customPrompt: 'You are an expert coder.',
    ...overrides,
  };
}

describe('buildAgentTemplateFingerprint', () => {
  it('lowercases and trims the agent name', () => {
    const fp = buildAgentTemplateFingerprint(makeAgent({ name: '  CODER  ' }));
    expect(fp.name).toBe('coder');
  });

  it('sorts the tools array alphabetically', () => {
    const fp = buildAgentTemplateFingerprint(makeAgent({ tools: ['Write', 'Read', 'Bash'] }));
    expect(fp.tools).toEqual(['Bash', 'Read', 'Write']);
  });

  it('returns an empty tools array when none supplied', () => {
    const fp = buildAgentTemplateFingerprint(makeAgent({ tools: [] }));
    expect(fp.tools).toEqual([]);
  });

  it('preserves description and customPrompt verbatim', () => {
    const fp = buildAgentTemplateFingerprint(
      makeAgent({ description: 'Hello\nWorld', customPrompt: '  Pad  ' })
    );
    expect(fp.description).toBe('Hello\nWorld');
    expect(fp.customPrompt).toBe('  Pad  ');
  });

  it('coerces undefined fields to safe defaults', () => {
    const fp = buildAgentTemplateFingerprint({
      name: undefined as unknown as string,
      description: undefined as unknown as string,
      tools: undefined as unknown as string[],
      customPrompt: undefined as unknown as string,
    });
    expect(fp).toEqual({
      name: '',
      description: '',
      tools: [],
      customPrompt: '',
    });
  });

  it('does not mutate the caller-supplied tools array', () => {
    const tools = ['Write', 'Read', 'Bash'];
    buildAgentTemplateFingerprint(makeAgent({ tools }));
    expect(tools).toEqual(['Write', 'Read', 'Bash']);
  });
});

describe('computeAgentTemplateHash', () => {
  it('returns a 64-character lower-case hex string', () => {
    const hash = computeAgentTemplateHash(makeAgent());
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for identical input', () => {
    const a = makeAgent();
    expect(computeAgentTemplateHash(a)).toBe(computeAgentTemplateHash(a));
  });

  it('is stable regardless of tool ordering', () => {
    const a = makeAgent({ tools: ['Write', 'Read', 'Bash'] });
    const b = makeAgent({ tools: ['Bash', 'Write', 'Read'] });
    expect(computeAgentTemplateHash(a)).toBe(computeAgentTemplateHash(b));
  });

  it('is stable regardless of name casing or surrounding whitespace', () => {
    const a = makeAgent({ name: 'Coder' });
    const b = makeAgent({ name: '  CODER  ' });
    expect(computeAgentTemplateHash(a)).toBe(computeAgentTemplateHash(b));
  });

  it('changes when description changes', () => {
    const a = makeAgent({ description: 'A' });
    const b = makeAgent({ description: 'B' });
    expect(computeAgentTemplateHash(a)).not.toBe(computeAgentTemplateHash(b));
  });

  it('changes when customPrompt changes', () => {
    const a = makeAgent({ customPrompt: 'old' });
    const b = makeAgent({ customPrompt: 'new' });
    expect(computeAgentTemplateHash(a)).not.toBe(computeAgentTemplateHash(b));
  });

  it('changes when tools list contents change (addition)', () => {
    const a = makeAgent({ tools: ['Read'] });
    const b = makeAgent({ tools: ['Read', 'Write'] });
    expect(computeAgentTemplateHash(a)).not.toBe(computeAgentTemplateHash(b));
  });

  it('changes when tools list contents change (removal)', () => {
    const a = makeAgent({ tools: ['Read', 'Write'] });
    const b = makeAgent({ tools: ['Read'] });
    expect(computeAgentTemplateHash(a)).not.toBe(computeAgentTemplateHash(b));
  });

  it('changes when name changes meaningfully (not just casing)', () => {
    const a = makeAgent({ name: 'Coder' });
    const b = makeAgent({ name: 'Reviewer' });
    expect(computeAgentTemplateHash(a)).not.toBe(computeAgentTemplateHash(b));
  });

  it('treats whitespace-only customPrompt difference as a real change', () => {
    const a = makeAgent({ customPrompt: 'a' });
    const b = makeAgent({ customPrompt: 'a ' });
    expect(computeAgentTemplateHash(a)).not.toBe(computeAgentTemplateHash(b));
  });
});

describe('agentTemplatesMatch', () => {
  it('returns true for templates with identical fingerprints', () => {
    expect(agentTemplatesMatch(makeAgent(), makeAgent())).toBe(true);
  });

  it('returns true for templates differing only in tool ordering', () => {
    const a = makeAgent({ tools: ['Read', 'Write'] });
    const b = makeAgent({ tools: ['Write', 'Read'] });
    expect(agentTemplatesMatch(a, b)).toBe(true);
  });

  it('returns false for templates with any meaningful difference', () => {
    const a = makeAgent({ description: 'old' });
    const b = makeAgent({ description: 'new' });
    expect(agentTemplatesMatch(a, b)).toBe(false);
  });
});
