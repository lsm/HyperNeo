import type { GlobalSettings } from '@hyperneo/shared';

export function keepNeoOwnedSettings(
  updates: Partial<GlobalSettings>,
  current: GlobalSettings
): Partial<GlobalSettings> {
  if (!updates.neo) return updates;
  const {
    standingRules: _rules,
    preferences: _preferences,
    mutedSessions: _muted,
    ...neo
  } = updates.neo;
  const { standingRules, preferences, mutedSessions } = current.neo ?? {};
  return {
    ...updates,
    neo: {
      ...neo,
      ...(standingRules ? { standingRules } : {}),
      ...(preferences ? { preferences } : {}),
      ...(mutedSessions ? { mutedSessions } : {}),
    },
  };
}
