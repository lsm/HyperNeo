import type { Session, SkillEnablementOverride } from '@hyperneo/shared';
import type { SessionToolSelection } from '@hyperneo/shared/types/session-tool-choice';
import type { Database } from '../sqlite-compat.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import { ChangeRecorder } from '../db-gateway/db-op.ts';
import { SkillRepository } from './skill-repository.ts';
import { AppMcpServerRepository } from './app-mcp-server-repository.ts';
import { McpEnablementRepository } from './mcp-enablement-repository.ts';
import { captureToolPreferenceRow } from './tool-preference-commit.ts';
import { selectSessionToolDefaults } from '../../lib/tools/legacy-tool-preferences.ts';
import { prepareInitialSessionToolSelection } from '../../lib/tools/session-tool-inputs.ts';

function defaults(db: Database, spaceId?: string): SessionToolSelection | undefined {
  const target = captureToolPreferenceRow(
    db,
    spaceId ? { table: 'spaces', id: spaceId } : { table: 'global_settings', id: 1 }
  );
  const config = JSON.parse(String(target.row?.[spaceId ? 'config' : 'settings'] ?? '{}'));
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Tool defaults must contain a JSON object');
  return config.toolSelectionDefaults;
}

export function initialSessionToolSelection(
  db: Database,
  session: Session,
  skillOverrides?: SkillEnablementOverride[]
): SessionToolSelection {
  if (session.config.toolSelection !== undefined) return session.config.toolSelection;
  const spaceId = session.context?.spaceId;
  const scoped = spaceId ? defaults(db, spaceId) : undefined;
  const chosen = selectSessionToolDefaults(
    session,
    defaults(db),
    spaceId && scoped !== undefined ? { id: spaceId, selection: scoped } : undefined
  );
  if (chosen === null) throw new Error('selection_version_unsupported');
  const changes = new ChangeRecorder() as unknown as ReactiveDatabase;
  const initial = prepareInitialSessionToolSelection(
    {
      session,
      skills: new SkillRepository(db, changes).findAll(),
      registry: new AppMcpServerRepository(db, changes).list(),
      overrides: new McpEnablementRepository(db, changes).listAll(),
      disabledSkillIds: session.config.tools?.disabledSkills,
      skillOverrides,
    },
    [],
    chosen
  );
  if (!initial.ok) throw new Error(initial.reason);
  return initial.selection;
}
