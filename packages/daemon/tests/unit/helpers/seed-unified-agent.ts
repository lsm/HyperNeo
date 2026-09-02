import type { Database } from '../../../src/storage/sqlite-compat';

export function seedUnifiedAgentMirror(
  db: Database,
  params: { id: string; spaceId: string; name: string; handle?: string | null }
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_long_horizon_agents (
       id, space_id, handle, display_name, template_key, status, instructions,
       tool_permissions_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'migration.legacy_space_agent', 'active', '', '{}', ?, ?)`
  ).run(params.id, params.spaceId, params.handle ?? params.id, params.name, now, now);
}
