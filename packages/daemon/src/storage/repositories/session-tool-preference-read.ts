import type { ToolsConfig } from '@hyperneo/shared';
import type { LegacyToolPreference } from '../../lib/tools/legacy-tool-preferences.ts';
import { defineDbOp } from '../db-gateway/db-op.ts';

export const readSessionToolPreferences = defineDbOp({
  name: 'session.tool-preferences.capture',
  mode: 'read',
  run: (_db, _args: { id: string; request: LegacyToolPreference; tools?: ToolsConfig }) => ({
    reason: { ok: false as const, reason: 'session_not_found' as const },
  }),
});
