import type { ToolsConfig } from '@hyperneo/shared';
import type { Database } from '../../storage/database.ts';
import type { SessionToolChoiceChangeResult } from './change-session-tool-choice.ts';
import type { LegacyToolPreference } from './legacy-tool-preferences.ts';

export type PreferenceDatabase = Pick<
  Database,
  | 'getDatabase'
  | 'captureSessionRuntimeSettings'
  | 'casSessionToolPreferences'
  | 'skills'
  | 'appMcpServers'
  | 'mcpEnablement'
>;
export type SessionToolPreferenceWriter = (
  id: string,
  request: LegacyToolPreference,
  tools?: ToolsConfig
) => Promise<SessionToolChoiceChangeResult & { deleted?: boolean }>;
export function createSessionToolPreferenceWriter(
  _db: PreferenceDatabase,
  _committed: (id: string) => Promise<void>
): SessionToolPreferenceWriter {
  return async () => ({ ok: false, reason: 'session_not_found' });
}
