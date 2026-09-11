import { KNOWN_TOOLS } from '@hyperneo/shared';
import { describe, expect, it } from 'vitest';
import { extraToolsOf, withExtraTool, withoutExtraTool } from '../template-extra-tools';

const known = KNOWN_TOOLS[0] as string;

describe('extraToolsOf', () => {
  it('keeps only tools outside the known set', () => {
    expect(extraToolsOf([known, 'mcp__custom__do', 'another'])).toEqual([
      'mcp__custom__do',
      'another',
    ]);
  });

  it('is empty when every tool is known', () => {
    expect(extraToolsOf([known])).toEqual([]);
  });
});

describe('withExtraTool', () => {
  it('appends a new tool and marks the selection overridden', () => {
    expect(withExtraTool({ tools: [], toolsOverridden: false }, 'custom')).toEqual({
      tools: ['custom'],
      toolsOverridden: true,
    });
  });

  it('returns the same selection when the tool is already present', () => {
    const selection = { tools: ['custom'], toolsOverridden: false };

    expect(withExtraTool(selection, 'custom')).toBe(selection);
  });
});

describe('withoutExtraTool', () => {
  it('drops the tool and keeps the selection overridden while others remain', () => {
    expect(withoutExtraTool({ tools: ['a', 'b'], toolsOverridden: true }, 'a')).toEqual({
      tools: ['b'],
      toolsOverridden: true,
    });
  });

  it('clears the overridden flag once the last tool goes', () => {
    expect(withoutExtraTool({ tools: ['a'], toolsOverridden: true }, 'a')).toEqual({
      tools: [],
      toolsOverridden: false,
    });
  });

  it('leaves the selection alone when the tool is absent', () => {
    expect(withoutExtraTool({ tools: ['a'], toolsOverridden: true }, 'zzz')).toEqual({
      tools: ['a'],
      toolsOverridden: true,
    });
  });
});
