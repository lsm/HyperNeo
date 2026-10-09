import { describe, expect, test } from 'bun:test';
import type { GlobalSettings } from '@hyperneo/shared';
import { keepStandingRules } from '../../../../src/lib/rpc-handlers/settings-handlers';

const current = { neo: { routeTimeoutMs: 1, standingRules: ['saved rule'] } } as GlobalSettings;

describe('keepStandingRules', () => {
  test('a settings save cannot replace or drop the saved standing rules', () => {
    expect(
      keepStandingRules({ neo: { routeTimeoutMs: 9, standingRules: ['stale'] } }, current)
    ).toEqual({ neo: { routeTimeoutMs: 9, standingRules: ['saved rule'] } });
    expect(keepStandingRules({ neo: { routeTimeoutMs: 9 } }, current)).toEqual({
      neo: { routeTimeoutMs: 9, standingRules: ['saved rule'] },
    });
  });

  test('leaves updates without neo, and settings with no saved rules, untouched', () => {
    expect(keepStandingRules({ autoScroll: false }, current)).toEqual({ autoScroll: false });
    expect(
      keepStandingRules({ neo: { routeTimeoutMs: 9, standingRules: ['x'] } }, {} as GlobalSettings)
    ).toEqual({ neo: { routeTimeoutMs: 9 } });
  });
});
