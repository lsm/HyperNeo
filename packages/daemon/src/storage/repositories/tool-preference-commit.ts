import type { SessionToolSelection } from '@hyperneo/shared/types/session-tool-choice';
import type { Database } from '../sqlite-compat.ts';
import type { SQLiteValue } from '../types.ts';

export type ToolPreferenceKey =
  | { table: 'skills' | 'app_mcp_servers' | 'spaces'; id: string }
  | { table: 'global_settings'; id: 1 }
  | {
      table: 'mcp_enablement';
      server_id: string;
      scope_type: 'session' | 'space';
      scope_id: string;
    };
export interface ToolPreferenceSnapshot {
  key: ToolPreferenceKey;
  row: Record<string, SQLiteValue> | null;
}
export interface SessionMcpPreferenceEdit {
  before: ToolPreferenceSnapshot & { key: Extract<ToolPreferenceKey, { table: 'mcp_enablement' }> };
  enabled: boolean | null;
}
export function captureToolPreferenceRow(
  _db: Database,
  key: ToolPreferenceKey
): ToolPreferenceSnapshot {
  return { key, row: null };
}
export function commitToolPreferenceRows(
  _db: Database,
  _snapshots: readonly ToolPreferenceSnapshot[],
  _write: () => boolean
): 'won' | 'superseded' {
  return 'superseded';
}
export function commitToolDefaultUpdate(
  _db: Database,
  _target: ToolPreferenceSnapshot & {
    key: Extract<ToolPreferenceKey, { table: 'global_settings' }> | { table: 'spaces'; id: string };
  },
  _guards: readonly ToolPreferenceSnapshot[],
  _selection: SessionToolSelection,
  _writeLegacy: () => boolean
): 'won' | 'superseded' {
  return 'superseded';
}
