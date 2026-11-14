import type { SessionToolSelection } from '@hyperneo/shared/types/session-tool-choice';
import { isDeepStrictEqual } from 'node:util';
import superpipe, { type PipelineAPI } from 'superpipe';
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
export interface ToolPreferenceSnapshot<K extends ToolPreferenceKey = ToolPreferenceKey> {
  key: K;
  row: Record<string, SQLiteValue> | null;
}
export interface SessionMcpPreferenceEdit {
  before: ToolPreferenceSnapshot<Extract<ToolPreferenceKey, { table: 'mcp_enablement' }>>;
  enabled: boolean | null;
}
type DefaultTarget = ToolPreferenceSnapshot<
  { table: 'global_settings'; id: 1 } | { table: 'spaces'; id: string }
>;
export function captureToolPreferenceRow<K extends ToolPreferenceKey>(
  db: Database,
  key: K
): ToolPreferenceSnapshot<K> {
  if (
    !['skills', 'app_mcp_servers', 'spaces', 'global_settings', 'mcp_enablement'].includes(
      key.table
    )
  )
    throw new Error('Unsupported tool preference table');
  const where =
    key.table === 'mcp_enablement' ? 'server_id=? AND scope_type=? AND scope_id=?' : 'id=?';
  const values =
    key.table === 'mcp_enablement' ? [key.server_id, key.scope_type, key.scope_id] : [key.id];
  const row = db.prepare(`SELECT * FROM ${key.table} WHERE ${where}`).get(...values) as Record<
    string,
    SQLiteValue
  > | null;
  return { key: { ...key }, row: row ? { ...row } : null };
}
function gateRows(
  db: Database,
  snapshots: readonly ToolPreferenceSnapshot[],
  write: () => boolean
): { value: () => boolean } | { reason: 'superseded' } {
  return snapshots.every((snapshot) =>
    isDeepStrictEqual(captureToolPreferenceRow(db, snapshot.key).row, snapshot.row)
  )
    ? { value: write }
    : { reason: 'superseded' };
}
const writeCaptured = (superpipe({})('commit-captured-tool-preferences') as PipelineAPI)
  .input(['db', 'snapshots', 'write'])
  .pipe(gateRows, ['db', 'snapshots', 'write'], 'result:commit')
  .pipe((write: () => boolean) => (write() ? 'won' : 'superseded'), 'commit', 'commit')
  .end('commit') as (
  db: Database,
  snapshots: readonly ToolPreferenceSnapshot[],
  write: () => boolean
) => 'won' | 'superseded';
const superseded = Symbol('tool_preferences_superseded');
export function commitToolPreferenceRows(
  db: Database,
  snapshots: readonly ToolPreferenceSnapshot[],
  write: () => boolean
): 'won' | 'superseded' {
  try {
    return db.transaction(() => {
      const outcome = writeCaptured(db, snapshots, write);
      if (outcome !== 'won') throw superseded;
      return outcome;
    })();
  } catch (error) {
    if (error === superseded) return 'superseded';
    throw error;
  }
}
export function commitToolDefaultUpdate(
  db: Database,
  target: DefaultTarget,
  guards: readonly ToolPreferenceSnapshot[],
  selection: SessionToolSelection,
  writeLegacy: () => boolean
): 'won' | 'superseded' {
  return commitToolPreferenceRows(db, [target, ...guards], () => {
    if (!target.row) return false;
    const column = target.key.table === 'spaces' ? 'config' : 'settings';
    const original = JSON.parse(String(target.row[column] ?? '{}'));
    if (!original || typeof original !== 'object' || Array.isArray(original))
      throw new Error('Tool defaults target must contain a JSON object');
    if (!writeLegacy()) return false;
    return (
      db
        .prepare(
          `UPDATE ${target.key.table} SET ${column}=json_set(COALESCE(${column},'{}'),'$.toolSelectionDefaults',json(?)),updated_at=CASE ? WHEN 'spaces' THEN ? ELSE datetime('now') END WHERE id=? AND json_type(COALESCE(${column},'{}'))='object'`
        )
        .run(JSON.stringify(selection), target.key.table, Date.now(), target.key.id).changes === 1
    );
  });
}
