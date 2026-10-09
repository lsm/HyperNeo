import { describe, expect, test } from 'bun:test';
import type { GlobalSettings } from '@hyperneo/shared';
import { keepNeoOwnedSettings } from '../../../../src/lib/rpc-handlers/settings-handlers';

const current = { neo: { routeTimeoutMs: 1, standingRules: ['saved rule'] } } as GlobalSettings;

describe('keepNeoOwnedSettings', () => {
  test('a settings save cannot replace or drop the saved standing rules', () => {
    expect(
      keepNeoOwnedSettings({ neo: { routeTimeoutMs: 9, standingRules: ['stale'] } }, current)
    ).toEqual({ neo: { routeTimeoutMs: 9, standingRules: ['saved rule'] } });
    expect(keepNeoOwnedSettings({ neo: { routeTimeoutMs: 9 } }, current)).toEqual({
      neo: { routeTimeoutMs: 9, standingRules: ['saved rule'] },
    });
  });

  test('leaves updates without neo, and settings with no saved rules, untouched', () => {
    expect(keepNeoOwnedSettings({ autoScroll: false }, current)).toEqual({ autoScroll: false });
    expect(
      keepNeoOwnedSettings(
        { neo: { routeTimeoutMs: 9, standingRules: ['x'] } },
        {} as GlobalSettings
      )
    ).toEqual({ neo: { routeTimeoutMs: 9 } });
  });

  test('a settings save cannot replace or drop the saved Neo model preference', () => {
    const preferences = {
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      thinkingLevel: 'off' as const,
    };
    const saved = { neo: { preferences } } as GlobalSettings;
    expect(
      keepNeoOwnedSettings(
        { neo: { routeTimeoutMs: 9, preferences: { ...preferences, model: 'stale' } } },
        saved
      )
    ).toEqual({ neo: { routeTimeoutMs: 9, preferences } });
  });
});
