export const MCP_SERVERS_GLOBAL_SQL = `
SELECT
  id,
  name,
  description,
  source_type  AS sourceType,
  command,
  args,
  env,
  url,
  headers,
  enabled,
  last_attach_error AS lastAttachError,
  created_at   AS createdAt,
  updated_at   AS updatedAt
FROM app_mcp_servers
ORDER BY name, id ASC
`.trim();

export function mapMcpServerRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    sourceType: row.sourceType,
    enabled: row.enabled === 1,
    ...(row.description != null ? { description: row.description } : {}),
    ...(row.command != null ? { command: row.command } : {}),
    ...(row.url != null ? { url: row.url } : {}),
    ...(row.args != null ? { args: JSON.parse(row.args as string) as string[] } : {}),
    ...(row.env != null ? { env: JSON.parse(row.env as string) as Record<string, string> } : {}),
    ...(row.headers != null
      ? { headers: JSON.parse(row.headers as string) as Record<string, string> }
      : {}),
    ...(row.lastAttachError != null ? { lastAttachError: row.lastAttachError } : {}),
    ...(row.createdAt != null ? { createdAt: row.createdAt } : {}),
    ...(row.updatedAt != null ? { updatedAt: row.updatedAt } : {}),
  };
}

export const SKILLS_LIST_SQL = `
SELECT
  id,
  name,
  display_name        AS displayName,
  description,
  source_type         AS sourceType,
  config,
  enabled,
  built_in            AS builtIn,
  validation_status   AS validationStatus,
  created_at          AS createdAt
FROM skills
ORDER BY built_in DESC, created_at ASC, id ASC
`.trim();

export function mapSkillRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    description: row.description,
    sourceType: row.sourceType,
    ...(row.config != null ? { config: JSON.parse(row.config as string) as unknown } : {}),
    enabled: row.enabled === 1,
    builtIn: row.builtIn === 1,
    validationStatus: row.validationStatus,
    ...(row.createdAt != null ? { createdAt: row.createdAt } : {}),
  };
}

export const MCP_ENABLEMENT_BY_SPACE_SQL = `
SELECT
  ams.id                                                       AS serverId,
  ams.name                                                     AS name,
  ams.description                                              AS description,
  ams.source_type                                              AS sourceType,
  ams.source                                                   AS source,
  ams.source_path                                              AS sourcePath,
  ams.enabled                                                  AS globallyEnabled,
  CASE WHEN me.enabled IS NOT NULL THEN 1 ELSE 0 END           AS overridden,
  COALESCE(me.enabled, ams.enabled)                            AS enabled
FROM app_mcp_servers ams
LEFT JOIN mcp_enablement me
  ON me.server_id = ams.id
 AND me.scope_type = 'space'
 AND me.scope_id = ?
ORDER BY ams.source ASC, ams.created_at IS NULL, ams.created_at ASC, ams.id ASC
`.trim();

export function mapMcpEnablementBySpaceRow(row: Record<string, unknown>): Record<string, unknown> {
  const sourceRaw = typeof row.source === 'string' ? row.source : null;
  const normalisedSource =
    sourceRaw === 'builtin' || sourceRaw === 'imported' || sourceRaw === 'user'
      ? sourceRaw
      : 'user';
  const out: Record<string, unknown> = {
    serverId: row.serverId,
    name: row.name,
    sourceType: row.sourceType,
    source: normalisedSource,
    globallyEnabled: row.globallyEnabled === 1,
    overridden: row.overridden === 1,
    enabled: row.enabled === 1,
  };
  if (row.description != null) out.description = row.description;
  if (row.sourcePath != null) out.sourcePath = row.sourcePath;
  return out;
}
