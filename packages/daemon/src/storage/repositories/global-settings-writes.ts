import type { GlobalSettings } from '@hyperneo/shared';
import { keepNeoOwnedSettings } from '../../lib/global-settings-patch.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { SettingsRepository } from './settings-repository.ts';

class GlobalSettingsWriter extends SettingsRepository {
  override updateGlobalSettings(updates: Partial<GlobalSettings>): GlobalSettings {
    return super.updateGlobalSettings(keepNeoOwnedSettings(updates, this.getGlobalSettings()));
  }
}

export const globalSettingsWrites = defineRepositoryOp(
  'settings.global.write',
  'write',
  GlobalSettingsWriter,
  ['updateGlobalSettings', 'saveGlobalSettings']
);
