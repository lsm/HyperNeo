import type { ToolsConfig } from '@hyperneo/shared';
import type { LegacyToolPreference } from '../../lib/tools/legacy-tool-preferences.ts';
import { captureSessionToolPreferenceState } from '../../lib/tools/write-session-tool-preferences.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { Database } from '../sqlite-compat.ts';
import { SessionRepository } from './session-repository.ts';
import { SkillRepository } from './skill-repository.ts';
import { AppMcpServerRepository } from './app-mcp-server-repository.ts';
import { McpEnablementRepository } from './mcp-enablement-repository.ts';

class SessionToolPreferenceReadRepository {
  constructor(
    private db: Database,
    private changes?: ReactiveDatabase
  ) {}
  capture(id: string, request: LegacyToolPreference, tools?: ToolsConfig) {
    const sessions = new SessionRepository(this.db);
    return captureSessionToolPreferenceState(id, request, tools, {
      getDatabase: () => this.db,
      captureSessionRuntimeSettings: (id) => sessions.captureSessionRuntimeSettings(id),
      skills: new SkillRepository(this.db, this.changes!),
      appMcpServers: new AppMcpServerRepository(this.db, this.changes!),
      mcpEnablement: new McpEnablementRepository(this.db, this.changes!),
    });
  }
}
export const readSessionToolPreferences = defineRepositoryOp(
  'session.tool-preferences.capture',
  'read',
  SessionToolPreferenceReadRepository,
  ['capture']
);
