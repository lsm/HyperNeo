import type { ToolsConfig } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import { sessionToolPreferenceReads } from '../../storage/repositories/session-tool-preference-read.ts';
import {
  changeSessionToolChoice,
  type SessionToolChoiceChangeResult,
} from './change-session-tool-choice.ts';
import type { LegacyToolPreference } from './legacy-tool-preferences.ts';

export type PreferenceDatabase = Pick<Database, 'gateway' | 'casSessionToolPreferences'>;
export type SessionToolPreferenceWriter = (
  id: string,
  request: LegacyToolPreference,
  tools?: ToolsConfig
) => Promise<SessionToolChoiceChangeResult & { deleted?: boolean }>;
function capture(
  id: string,
  request: LegacyToolPreference,
  tools: ToolsConfig | undefined,
  db: PreferenceDatabase
) {
  return db.gateway.call(sessionToolPreferenceReads, 'capture', id, request, tools);
}
type Prepared = Extract<Awaited<ReturnType<typeof capture>>, { value: unknown }>['value'];
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
