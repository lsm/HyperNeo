import { parseJson, type SessionConfig, type ToolsConfig } from '@hyperneo/shared';
import type { SessionToolSelection } from '@hyperneo/shared/types/session-tool-choice';
import type { Database } from '../sqlite-compat.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import { ChangeRecorder, defineRepositoryOp } from '../db-gateway/db-op.ts';
import { SessionRepository } from './session-repository.ts';
import { SkillRepository } from './skill-repository.ts';
import { AppMcpServerRepository } from './app-mcp-server-repository.ts';
import { McpEnablementRepository } from './mcp-enablement-repository.ts';
import { captureToolPreferenceRow, type ToolPreferenceSnapshot } from './tool-preference-commit.ts';
import { pinnedSlotVetoes } from './session-tool-selection-migration.ts';
import { scopeChainForSession } from '../../lib/mcp/resolve-mcp-servers.ts';
import {
  translateLegacyToolPreference,
  selectSessionToolDefaults,
  type LegacyToolPreference,
} from '../../lib/tools/legacy-tool-preferences.ts';

type CaptureDatabase = {
  getDatabase: () => Database;
  captureSessionRuntimeSettings: SessionRepository['captureSessionRuntimeSettings'];
  skills: SkillRepository;
  appMcpServers: AppMcpServerRepository;
  mcpEnablement: McpEnablementRepository;
};
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
  db: CaptureDatabase
) {
  const raw = db.getDatabase();
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
}

class SessionToolPreferenceReader {
  constructor(private db: Database) {}

  capture(id: string, request: LegacyToolPreference, tools?: ToolsConfig) {
    const changes = new ChangeRecorder() as unknown as ReactiveDatabase;
    const sessions = new SessionRepository(this.db);
    return capture(id, request, tools, {
      getDatabase: () => this.db,
      captureSessionRuntimeSettings: (sessionId) =>
        sessions.captureSessionRuntimeSettings(sessionId),
      skills: new SkillRepository(this.db, changes),
      appMcpServers: new AppMcpServerRepository(this.db, changes),
      mcpEnablement: new McpEnablementRepository(this.db, changes),
    });
  }
}

export const sessionToolPreferenceReads = defineRepositoryOp(
  'session_tool_preferences.read',
  'read',
  SessionToolPreferenceReader,
  ['capture'] as const
);
