import type { Database } from '../../storage/sqlite-compat.ts';

export interface NeoPackPreferenceScope {
  kind: 'global' | 'repo' | 'project';
  key: string;
}

export interface NeoPackPreference {
  value: unknown;
  scope: NeoPackPreferenceScope;
  setBy: string;
  setAt: number;
}

export function getNeoPackPreference(
  db: Database,
  pack: string,
  scope: NeoPackPreferenceScope,
  key: string
): NeoPackPreference | null {
  const row = db
    .prepare(`SELECT value_json, scope_kind, scope_key, set_by, set_at
    FROM neo_pack_preferences WHERE pack = ? AND key = ?
      AND ((scope_kind = ? AND scope_key = ?) OR (scope_kind = 'global' AND scope_key = ''))
    ORDER BY CASE WHEN scope_kind = ? AND scope_key = ? THEN 0 ELSE 1 END LIMIT 1`)
    .get(pack, key, scope.kind, scope.key, scope.kind, scope.key) as
    | {
        value_json: string;
        scope_kind: NeoPackPreferenceScope['kind'];
        scope_key: string;
        set_by: string;
        set_at: number;
      }
    | undefined;
  return row
    ? {
        value: JSON.parse(row.value_json),
        scope: { kind: row.scope_kind, key: row.scope_key },
        setBy: row.set_by,
        setAt: row.set_at,
      }
    : null;
}

export function saveNeoPackPreference(
  db: Database,
  pack: string,
  scope: NeoPackPreferenceScope,
  key: string,
  value: unknown,
  now: number
): void {
  db.prepare(`INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
    VALUES (?, ?, ?, ?, ?, 'human', ?) ON CONFLICT (pack, scope_kind, scope_key, key)
    DO UPDATE SET value_json=excluded.value_json, set_by=excluded.set_by, set_at=excluded.set_at`).run(
    pack,
    scope.kind,
    scope.key,
    key,
    JSON.stringify(value),
    now
  );
}
