import { describe, expect, test } from 'bun:test';
import { keepsRoutingEnv } from '../../../../src/lib/provider-service';

describe('keepsRoutingEnv', () => {
  test.each([
    ['clears a value when not preserving user settings', 'ANTHROPIC_MODEL', 'm', 'm', false, false],
    ['keeps the user-configured value when preserving', 'ANTHROPIC_MODEL', 'm', 'm', true, true],
    ['clears a value that differs from the user setting', 'ANTHROPIC_MODEL', 'x', 'm', true, false],
    ['clears when the user configured nothing', 'ANTHROPIC_MODEL', 'm', undefined, true, false],
  ] as const)('%s', (_label, key, value, userValue, preserve, expected) => {
    expect(keepsRoutingEnv(key, value, userValue, preserve)).toBe(expected);
  });
});
