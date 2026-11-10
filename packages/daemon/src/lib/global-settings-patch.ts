import type { GlobalSettings } from '@hyperneo/shared';

export function keepNeoOwnedSettings(
  updates: Partial<GlobalSettings>,
  current: GlobalSettings
): Partial<GlobalSettings> {
  updates = { ...updates };
  delete updates.driverHealth;
  if (!updates.neo) return updates;
  const {
    relaySenders: _relaySenders,
    standingRules: _rules,
    standingRuleSources: _sources,
    preferences: _preferences,
    mutedSessions: _muted,
    ...neo
  } = updates.neo;
  const { relaySenders, standingRules, standingRuleSources, preferences, mutedSessions } =
    current.neo ?? {};
  return {
    ...updates,
    neo: {
      ...neo,
      ...(relaySenders ? { relaySenders } : {}),
      ...(standingRules ? { standingRules } : {}),
      ...(standingRuleSources ? { standingRuleSources } : {}),
      ...(preferences ? { preferences } : {}),
      ...(mutedSessions ? { mutedSessions } : {}),
    },
  };
}
