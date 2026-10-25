import { parseJson, type SessionConfig, type ToolsConfig } from '@hyperneo/shared';
import type { SessionToolSelection } from '@hyperneo/shared/types/session-tool-choice';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import {
  captureToolPreferenceRow,
  type ToolPreferenceSnapshot,
} from '../../storage/repositories/tool-preference-commit.ts';
import { pinnedSlotVetoes } from '../../storage/repositories/session-tool-selection-migration.ts';
import { scopeChainForSession } from '../mcp/resolve-mcp-servers.ts';
import {
  changeSessionToolChoice,
  type SessionToolChoiceChangeResult,
} from './change-session-tool-choice.ts';
import {
  translateLegacyToolPreference,
  selectSessionToolDefaults,
  type LegacyToolPreference,
} from './legacy-tool-preferences.ts';

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
function storedDefaults(raw: unknown): SessionToolSelection | undefined {
  const value = JSON.parse(String(raw ?? '{}'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Tool defaults must contain a JSON object');
  if (Object.hasOwn(value, 'toolSelectionDefaults') && !value.toolSelectionDefaults)
    throw new Error('selection_version_unsupported');
  return value.toolSelectionDefaults;
}
function capture(
  id: string,
  request: LegacyToolPreference,
  tools: ToolsConfig | undefined,
  db: PreferenceDatabase
) {
  const raw = db.getDatabase();
  return raw.transaction(() => {
    const snapshot = db.captureSessionRuntimeSettings(id);
    if (!snapshot) return { reason: { ok: false as const, reason: 'session_not_found' as const } };
    const config = JSON.parse(snapshot.config) as SessionConfig;
    if (Object.hasOwn(config, 'toolSelection') && !config.toolSelection)
      return { reason: { ok: false as const, reason: 'selection_version_unsupported' as const } };
    const session = { id, context: parseJson<{ spaceId?: string }>(snapshot.sessionContext, {}) };
    const scopes = scopeChainForSession(session);
    const skills = db.skills.findAll();
    const registry = db.appMcpServers.list();
    const catalog = {
      session,
      skills,
      registry,
      overrides: db.mcpEnablement.listForScopes(scopes),
    };
    const guards: ToolPreferenceSnapshot[] = [
      ...skills.map((skill) => captureToolPreferenceRow(raw, { table: 'skills', id: skill.id })),
      ...registry.map((server) =>
        captureToolPreferenceRow(raw, { table: 'app_mcp_servers', id: server.id })
      ),
      ...scopes.flatMap((scope) =>
        registry.map((server) =>
          captureToolPreferenceRow(raw, {
            table: 'mcp_enablement',
            server_id: server.id,
            scope_type: scope.scopeType,
            scope_id: scope.scopeId,
          })
        )
      ),
    ];
    let defaults: SessionToolSelection | undefined;
    if (request.kind === 'mcp' && request.enabled === null) {
      const global = captureToolPreferenceRow(raw, { table: 'global_settings', id: 1 });
      const space = session.context.spaceId
        ? captureToolPreferenceRow(raw, { table: 'spaces', id: session.context.spaceId })
        : undefined;
      guards.push(global, ...(space ? [space] : []));
      const globalDefaults = storedDefaults(global.row?.settings);
      const spaceDefaults = storedDefaults(space?.row?.config);
      defaults = selectSessionToolDefaults(
        session,
        globalDefaults,
        space && spaceDefaults ? { id: space.key.id, selection: spaceDefaults } : undefined
      );
    }
    const toolsPatch =
      request.kind === 'skills'
        ? { ...(tools ?? config.tools), disabledSkills: [...request.disabledSkills] }
        : tools && { ...tools, disabledSkills: config.tools?.disabledSkills };
    const translated = translateLegacyToolPreference(catalog, config, request, defaults);
    if (!translated.ok) return { reason: translated };
    const override =
      request.kind === 'mcp'
        ? {
            before: captureToolPreferenceRow(raw, {
              table: 'mcp_enablement',
              server_id: request.serverId,
              scope_type: 'session',
              scope_id: id,
            }),
            enabled: request.enabled,
          }
        : undefined;
    return {
      value: {
        snapshot,
        toolsPatch,
        catalog,
        guards,
        changes: translated.changes,
        override,
        pinned: pinnedSlotVetoes(raw, snapshot.metadata),
      },
    };
  })();
}
type Prepared = Extract<ReturnType<typeof capture>, { value: unknown }>['value'];
async function persist(prepared: Prepared, db: PreferenceDatabase) {
  const result = await changeSessionToolChoice(
    { sessionId: prepared.snapshot.id, changes: prepared.changes },
    {
      capture: () => prepared.snapshot,
      catalog: () => prepared.catalog,
      pinnedSlotVetoes: () => prepared.pinned,
      commit: (snapshot, patch) =>
        db.casSessionToolPreferences(
          snapshot,
          { ...patch, tools: prepared.toolsPatch },
          prepared.guards,
          prepared.override
        ),
    }
  );
  return result.ok
    ? {
        value: {
          ...result,
          deleted: prepared.override?.enabled === null && prepared.override.before.row !== null,
        },
      }
    : { reason: result };
}
const write = (superpipe({})('write-session-tool-preferences') as PipelineAPI)
  .input(['id', 'request', 'tools', 'db', 'committed'])
  .pipe(capture, ['id', 'request', 'tools', 'db'], 'result:write')
  .pipe(persist, ['write', 'db'], 'result:write')
  .pipe(
    async (
      result: SessionToolChoiceChangeResult,
      id: string,
      committed: (id: string) => Promise<void>
    ) => {
      await committed(id).catch(() => {});
      return result;
    },
    ['write', 'id', 'committed'],
    'write'
  )
  .endAsync('write') as (
  id: string,
  request: LegacyToolPreference,
  tools: ToolsConfig | undefined,
  db: PreferenceDatabase,
  committed: (id: string) => Promise<void>
) => ReturnType<SessionToolPreferenceWriter>;
export function createSessionToolPreferenceWriter(
  db: PreferenceDatabase,
  committed: (id: string) => Promise<void>
): SessionToolPreferenceWriter {
  return (id, request, tools) => write(id, request, tools, db, committed);
}
