import type { GlobalSettings } from '@hyperneo/shared';

export function keepNeoOwnedSettings(
  updates: Partial<GlobalSettings>,
  current: GlobalSettings
): Partial<GlobalSettings> {
  if (!updates.neo) return updates;
  const {
    standingRules: _rules,
    standingRuleSources: _sources,
    preferences: _preferences,
    mutedSessions: _muted,
    ...neo
  } = updates.neo;
  const { standingRules, standingRuleSources, preferences, mutedSessions } = current.neo ?? {};
  return {
    ...updates,
    neo: {
      ...neo,
      ...(standingRules ? { standingRules } : {}),
      ...(standingRuleSources ? { standingRuleSources } : {}),
      ...(preferences ? { preferences } : {}),
      ...(mutedSessions ? { mutedSessions } : {}),
    },
  };
}
