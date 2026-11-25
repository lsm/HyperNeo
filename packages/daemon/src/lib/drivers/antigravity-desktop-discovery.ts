import { basename, join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { skipSpaceQuery } from './hyperneo-adapter.ts';
import type { FindQuery, PlaceGroup, WorkAdapter } from './types.ts';

const ADAPTER = 'antigravity-desktop';

export type AntigravityDesktopRead = { statePath: string; query?: FindQuery };
export type AntigravityDesktopSession = {
  id: string;
  title: string;
  folder?: string;
  updatedAt: number;
};
type Read = (query: FindQuery) => Promise<AntigravityDesktopSession[]>;

export function antigravityDesktopStatePath(home: string): string {
  return join(home, '.gemini', 'antigravity', 'conversation_summaries.db');
}

function groupSessions(sessions: readonly AntigravityDesktopSession[], machine: string) {
  const groups = new Map<string | undefined, PlaceGroup>();
  for (const { id, title, folder, updatedAt } of sessions) {
    let group = groups.get(folder);
    if (!group) {
      group = {
        place: {
          machine,
          folder,
          name: folder ? basename(folder) || folder : 'Antigravity Desktop',
        },
        lastActivityAt: updatedAt,
        openCount: 0,
        archivedCount: 0,
        adapters: [ADAPTER],
        work: [],
      };
      groups.set(folder, group);
    }
    group.openCount++;
    group.lastActivityAt = Math.max(group.lastActivityAt, updatedAt);
    group.work.push({
      ref: { adapter: ADAPTER, id },
      place: group.place,
      title,
      status: 'done',
      lastActivityAt: updatedAt,
      watchHint:
        'Open this session in Antigravity Desktop. Discovery does not report live turn state.',
    });
  }
  return [...groups.values()];
}

const find = (superpipe({})('antigravity-desktop-find') as PipelineAPI)
  .input(['query', 'read', 'machine'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe((query: FindQuery, read: Read) => read(query), ['query', 'read'], 'sessions')
  .pipe(groupSessions, ['sessions', 'machine'], 'groups')
  .endAsync('groups') as (query: FindQuery, read: Read, machine: string) => Promise<PlaceGroup[]>;

export function createAntigravityDesktopDiscovery(read: Read, machine: string): WorkAdapter {
  return { id: ADAPTER, capabilities: ['find'], find: (query) => find(query, read, machine) };
}
