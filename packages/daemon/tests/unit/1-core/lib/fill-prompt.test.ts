import { describe, expect, test } from 'bun:test';
import { fillPrompt } from '@hyperneo/prompts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';

describe('fillPrompt', () => {
  test('substitutes every placeholder with its value', () => {
    expect(fillPrompt('Ask {{ask_id}} has {{count}} left.', { ask_id: 'a1', count: '3' })).toBe(
      'Ask a1 has 3 left.'
    );
  });

  test('inserts values verbatim without rescanning them', () => {
    expect(fillPrompt('Say {{text}}.', { text: '{{other}} $& $1' })).toBe('Say {{other}} $& $1.');
  });

  test('throws when a placeholder has no value', () => {
    expect(() => fillPrompt('Hi {{name}}', {})).toThrow('missing prompt value name');
    expect(() => fillPrompt('Hi {{userId2}}', {})).toThrow('missing prompt value userId2');
  });

  test('renders a present but undefined value the way a template literal does', () => {
    const values = { name: undefined } as unknown as Record<string, string>;
    expect(fillPrompt('Hi {{name}}', values)).toBe(`Hi ${undefined}`);
  });

  test('leaves no placeholder in either Neo system prompt', () => {
    expect(neoPrompt(null)).not.toContain('{{');
    expect(neoPrompt('concern-1')).not.toContain('{{');
  });
});
