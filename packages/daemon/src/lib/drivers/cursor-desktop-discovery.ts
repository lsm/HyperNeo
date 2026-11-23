import { basename, isAbsolute, join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { skipSpaceQuery } from './hyperneo-adapter.ts';
import type { FindQuery, PlaceGroup, WorkAdapter } from './types.ts';
import { readCursorDesktopHistory } from './cursor-desktop-history.ts';

const ADAPTER = 'cursor-desktop';

export type CursorDesktopRead = { statePath: string; query: FindQuery };
export type CursorDesktopSession = {
  id: string;
  title: string;
  folder: string;
  updatedAt: number;
  archived: number;
};
type Read = (query: FindQuery) => Promise<CursorDesktopSession[]>;

export function cursorDesktopStatePath(home: string): string {
  const root =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || join(home, '.config');
  return join(root, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function groupSessions(sessions: readonly CursorDesktopSession[], machine: string): PlaceGroup[] {
  const groups = new Map<string, PlaceGroup>();
  for (const session of sessions) {
    if (!isAbsolute(session.folder)) continue;
    let group = groups.get(session.folder);
    if (!group) {
      group = {
        place: {
          machine,
          folder: session.folder,
          name: basename(session.folder) || session.folder,
        },
        lastActivityAt: session.updatedAt,
        openCount: 0,
        archivedCount: 0,
        adapters: [ADAPTER],
        work: [],
      };
      groups.set(session.folder, group);
    }
    if (session.archived) group.archivedCount++;
    else group.openCount++;
    group.work.push({
      ref: { adapter: ADAPTER, id: session.id },
      place: group.place,
      title: session.title,
      status: 'done',
      archived: Boolean(session.archived),
      lastActivityAt: session.updatedAt,
      watchHint: 'Open this session in Cursor Desktop. Discovery does not report live turn state.',
    });
  }
  return [...groups.values()];
}

const find = (superpipe({})('cursor-desktop-find') as PipelineAPI)
  .input(['query', 'read', 'machine'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe((query: FindQuery, read: Read) => read(query), ['query', 'read'], 'sessions')
  .pipe(groupSessions, ['sessions', 'machine'], 'groups')
  .endAsync('groups') as (query: FindQuery, read: Read, machine: string) => Promise<PlaceGroup[]>;

export function createCursorDesktopDiscovery(
  read: Read,
  machine: string,
  home: string
): WorkAdapter {
  const root = join(home, '.cursor', 'projects');
  return {
    id: ADAPTER,
    capabilities: ['find'],
    find: (query) => find(query, read, machine),
    readTurns: async (id, around, before, after, cursor) => {
      if (cursor && !cursor.cursorDesktop) return null;
      if (around && !around.startsWith('cursor:')) return null;
      const sessions = await read({ idPrefix: id, includeClosed: true, limit: 1 }).catch(() => []);
      return sessions.some((session) => session.id === id)
        ? readCursorDesktopHistory(root, id, around, before, after, cursor)
        : null;
    },
  };
}
