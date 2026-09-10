import { describe, expect, test } from 'bun:test';
import { firstAgentFieldError } from '../../../../src/lib/space/agents/agent-field-validation';

describe('firstAgentFieldError', () => {
  test('accepts an empty object', () => {
    expect(firstAgentFieldError({})).toBeNull();
  });

  test('accepts a fully populated valid set', () => {
    expect(
      firstAgentFieldError({
        handle: 'researcher',
        displayName: 'Researcher',
        description: 'Reads things',
        instructions: 'Be brief.',
        model: 'claude-opus-5',
        provider: 'anthropic',
        sessionId: 'session-1',
        status: 'active',
        tools: ['Read', 'Grep'],
        thinkingLevel: 'think8k',
        settingSources: ['user', 'project'],
        autonomyLevel: 3,
      })
    ).toBeNull();
  });

  test('treats null as clearing rather than blank', () => {
    expect(
      firstAgentFieldError({ description: null, model: null, provider: null, sessionId: null })
    ).toBeNull();
  });

  test('reports the type error before the blank error for the same field', () => {
    expect(firstAgentFieldError({ displayName: 123 as unknown as string })).toBe(
      'displayName must be a string'
    );
  });

  test('reports a blank string field', () => {
    expect(firstAgentFieldError({ displayName: '   ' })).toBe('displayName cannot be blank');
  });

  test('distinguishes clearable fields in their blank message', () => {
    expect(firstAgentFieldError({ model: ' ' })).toBe(
      'model cannot be blank — use null to clear it'
    );
  });

  test('reports a non-array tools value', () => {
    expect(firstAgentFieldError({ tools: 'Read' as unknown as string[] })).toBe(
      'tools must be an array of strings'
    );
  });

  test('reports a tools array holding a non-string', () => {
    expect(firstAgentFieldError({ tools: ['Read', 5] as unknown as string[] })).toBe(
      'tools must be an array of strings'
    );
  });

  test('accepts an empty tools array', () => {
    expect(firstAgentFieldError({ tools: [] })).toBeNull();
  });

  test('reports every invalid settingSource', () => {
    expect(firstAgentFieldError({ settingSources: ['user', 'bogus', 'nope'] })).toBe(
      'Invalid settingSources: bogus, nope'
    );
  });

  test('reports a non-integer autonomyLevel', () => {
    expect(firstAgentFieldError({ autonomyLevel: 2.5 })).toBe('Invalid autonomyLevel: 2.5');
  });

  test.each([1, 5])('accepts autonomyLevel %i at the range boundary', (level) => {
    expect(firstAgentFieldError({ autonomyLevel: level })).toBeNull();
  });

  test.each([0, 6])('rejects autonomyLevel %i outside the range', (level) => {
    expect(firstAgentFieldError({ autonomyLevel: level })).toBe(`Invalid autonomyLevel: ${level}`);
  });

  test('checks fields in a stable order so the first error wins', () => {
    expect(firstAgentFieldError({ handle: '  ', status: 'retired' as never })).toBe(
      'handle cannot be blank'
    );
  });
});
