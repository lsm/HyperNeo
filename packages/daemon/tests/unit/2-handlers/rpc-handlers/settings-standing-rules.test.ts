import { describe, expect, test } from 'bun:test';
import type { GlobalSettings } from '@hyperneo/shared';
import { keepNeoOwnedSettings } from '../../../../src/lib/rpc-handlers/settings-handlers';

const current = { neo: { autoDispatch: false, standingRules: ['saved rule'] } } as GlobalSettings;

describe('keepNeoOwnedSettings', () => {
  test('stale permission settings cannot replace or invent consent references', () => {
    const standingRuleSources = { 'saved rule': { sessionId: 'neo', messageId: 'approval' } };
    const saved = { neo: { standingRules: ['saved rule'], standingRuleSources } } as GlobalSettings;
    expect(
      keepNeoOwnedSettings(
        { neo: { workerPermissionMode: 'default', standingRuleSources: {} } },
        saved
      )
    ).toEqual({
      neo: { workerPermissionMode: 'default', standingRules: ['saved rule'], standingRuleSources },
    });
    expect(keepNeoOwnedSettings({ neo: { standingRuleSources } }, {} as GlobalSettings)).toEqual({
      neo: {},
    });
  });

  test('a settings save cannot replace or drop the saved standing rules', () => {
    expect(
      keepNeoOwnedSettings({ neo: { autoDispatch: true, standingRules: ['stale'] } }, current)
    ).toEqual({ neo: { autoDispatch: true, standingRules: ['saved rule'] } });
    expect(keepNeoOwnedSettings({ neo: { autoDispatch: true } }, current)).toEqual({
      neo: { autoDispatch: true, standingRules: ['saved rule'] },
    });
  });

  test('leaves updates without neo, and settings with no saved rules, untouched', () => {
    expect(keepNeoOwnedSettings({ autoScroll: false }, current)).toEqual({ autoScroll: false });
    expect(
      keepNeoOwnedSettings(
        { neo: { autoDispatch: true, standingRules: ['x'] } },
        {} as GlobalSettings
      )
    ).toEqual({ neo: { autoDispatch: true } });
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
        { neo: { autoDispatch: true, preferences: { ...preferences, model: 'stale' } } },
        saved
      )
    ).toEqual({ neo: { autoDispatch: true, preferences } });
  });

  test('a settings save cannot replace or drop the muted sessions', () => {
    const saved = { neo: { mutedSessions: ['codex-desktop::t1'] } } as GlobalSettings;
    expect(keepNeoOwnedSettings({ neo: { autoDispatch: true } }, saved)).toEqual({
      neo: { autoDispatch: true, mutedSessions: ['codex-desktop::t1'] },
    });
    expect(
      keepNeoOwnedSettings({ neo: { autoDispatch: true, mutedSessions: ['x', 'y'] } }, saved)
    ).toEqual({ neo: { autoDispatch: true, mutedSessions: ['codex-desktop::t1'] } });
  });
});
