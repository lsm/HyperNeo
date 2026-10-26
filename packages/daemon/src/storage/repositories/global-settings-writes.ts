import type { GlobalSettings } from '@hyperneo/shared';
import { neoStandingRules, type NeoModelPreference } from '@hyperneo/shared/types/settings';
import { canonicalJson } from '../../lib/agent/prompt-comparison.ts';
import { keepNeoOwnedSettings } from '../../lib/global-settings-patch.ts';
import { planNeoRuleEdit } from '../../lib/neo/saved-rules.ts';
import { planNeoSessionMutes } from '../../lib/neo/session-watch.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { SettingsRepository } from './settings-repository.ts';

type Patch = Partial<GlobalSettings>;
export type GlobalSettingsRollback = { before: Patch; after: Patch };
export type GlobalSettingsCommit = GlobalSettingsRollback & { settings: GlobalSettings };

function selectedSettings(settings: GlobalSettings, patch: Patch): Patch {
  return Object.fromEntries(
    Object.keys(patch).map((key) => [key, settings[key as keyof GlobalSettings]])
  );
}

class GlobalSettingsWriter extends SettingsRepository {
  neoPreferences(preferences: NeoModelPreference): GlobalSettings {
    const neo = this.getGlobalSettings().neo;
    const fallbacks = preferences.fallbacks ?? neo?.preferences?.fallbacks;
    return super.updateGlobalSettings({
      neo: {
        ...neo,
        preferences: { ...preferences, ...(fallbacks === undefined ? {} : { fallbacks }) },
      },
    });
  }

  neoMute(key: string, muted: boolean): GlobalSettings {
    const neo = this.getGlobalSettings().neo;
    return super.updateGlobalSettings({
      neo: { ...neo, mutedSessions: planNeoSessionMutes(neo?.mutedSessions ?? [], key, muted) },
    });
  }

  neoRules(edit: { add?: readonly string[]; remove?: readonly string[] }) {
    const neo = this.getGlobalSettings().neo;
    const plan = planNeoRuleEdit(neoStandingRules(neo), edit);
    if ('reason' in plan) return plan;
    return { value: super.updateGlobalSettings({ neo: { ...neo, standingRules: plan.value } }) };
  }

  apply(updates: Patch): GlobalSettingsCommit {
    const current = this.getGlobalSettings();
    const patch = keepNeoOwnedSettings(updates, current);
    const settings = super.updateGlobalSettings(patch);
    return {
      settings,
      before: selectedSettings(current, patch),
      after: selectedSettings(this.getGlobalSettings(), patch),
    };
  }

  rollback({ before, after }: GlobalSettingsRollback): void {
    const current = this.getGlobalSettings();
    const expected = keepNeoOwnedSettings(after, current);
    const inverse: Patch = Object.fromEntries(
      Object.entries(before).filter(
        ([key]) =>
          canonicalJson(current[key as keyof GlobalSettings]) ===
          canonicalJson(expected[key as keyof GlobalSettings])
      )
    );
    if (Object.hasOwn(inverse, 'neo')) {
      const neo = keepNeoOwnedSettings({ neo: inverse.neo ?? {} }, current).neo;
      inverse.neo = Object.keys(neo ?? {}).length ? neo : inverse.neo;
    }
    if (Object.keys(inverse).length)
      super.updateGlobalSettings(keepNeoOwnedSettings(inverse, current));
  }
}

export const globalSettingsWrites = defineRepositoryOp(
  'settings.global.write',
  'write',
  GlobalSettingsWriter,
  ['apply', 'rollback', 'neoPreferences', 'neoMute', 'neoRules']
);
