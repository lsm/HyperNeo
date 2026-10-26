import type { GlobalSettings } from '@hyperneo/shared';
import { canonicalJson } from '../../lib/agent/prompt-comparison.ts';
import { keepNeoOwnedSettings } from '../../lib/global-settings-patch.ts';
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
  ['apply', 'rollback']
);
