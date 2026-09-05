import type { Database } from '../../../src/storage/sqlite-compat';

export interface SeedWorkerMirrorParams {
  id: string;
  spaceId: string;
  name: string;
  handle?: string | null;
  status?: string | null;
  instructions?: string | null;
  tools?: string[];
  model?: string | null;
  provider?: string | null;
  thinkingLevel?: string | null;
  description?: string | null;
}

export function seedWorkerMirror(db: Database, params: SeedWorkerMirrorParams): void {
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO space_long_horizon_agents (
       id, space_id, handle, display_name, template_key, status, instructions, model,
       provider, thinking_level, description, tool_permissions_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'migration.legacy_space_agent', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.id,
    params.spaceId,
    params.handle ?? params.id,
    params.name,
    params.status ?? 'active',
    params.instructions ?? '',
    params.model ?? null,
    params.provider ?? null,
    params.thinkingLevel ?? null,
    params.description ?? null,
    JSON.stringify(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
    now,
    now
  );
}
