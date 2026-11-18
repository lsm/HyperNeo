import type { Database } from '../sqlite-compat.ts';

export function runMigration525(db: Database): void {
  db.exec(`INSERT OR IGNORE INTO neo_pack_preferences
    (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
    SELECT 'core', 'global', '', 'sessionReuse',
      CASE value_json WHEN '"long_lived"' THEN '"long_lived"' ELSE '"per_todo"' END,
      set_by, set_at
    FROM neo_pack_preferences WHERE pack = 'coding' AND key = 'sessionStrategy'
      AND scope_kind = 'global' AND value_json IN ('"long_lived"', '"per_task"', '"per_pr"');
    INSERT OR IGNORE INTO neo_pack_preferences
      (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
    SELECT 'core', 'project', project_id, 'sessionReuse',
      CASE value_json WHEN '"long_lived"' THEN '"long_lived"' ELSE '"per_todo"' END,
      set_by, set_at FROM (
      SELECT w.project_id, p.value_json, p.set_by, p.set_at,
        ROW_NUMBER() OVER (PARTITION BY w.project_id ORDER BY p.set_at DESC, p.scope_key) AS rank
      FROM neo_pack_preferences p JOIN neo_project_workspaces w ON
        lower(p.scope_key) = lower(CASE WHEN w.alias LIKE 'repository:github.com/%'
          THEN substr(w.alias, length('repository:github.com/') + 1)
          ELSE substr(w.alias, 6, instr(w.alias || char(0), char(0)) - 6) END)
      WHERE p.pack = 'coding' AND p.key = 'sessionStrategy' AND p.scope_kind = 'repo'
        AND p.value_json IN ('"long_lived"', '"per_task"', '"per_pr"')
        AND (w.alias LIKE 'repository:github.com/%' OR w.alias LIKE 'repo:%')
    ) WHERE rank = 1`);
}
