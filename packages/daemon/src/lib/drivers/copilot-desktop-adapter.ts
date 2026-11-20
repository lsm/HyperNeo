import { basename, isAbsolute, join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { createCopilotInputReader, readCopilotHistory } from './copilot-history.ts';
import { COPILOT_CLIENT } from './copilot-discovery.ts';
import { readCopilotTurnFacts } from './copilot-observations.ts';
import { skipSpaceQuery } from './hyperneo-adapter.ts';
import { reject } from './work-operations.ts';
import type { FindQuery, PlaceGroup, WorkAdapter, WorkSummary } from './types.ts';

const DESKTOP_CONTROL =
  'Copilot Desktop exposes session links and history. Use the app to control Desktop-owned sessions.';

export function copilotDesktopStatePath(home: string) {
  return join(home, '.copilot', 'data.db');
}

export interface CopilotDesktopSession {
  id: string;
  workspaceId: string;
  title: string;
  project: string;
  folder: string;
  directory: string;
  updatedAt: string;
  running: number;
  interrupted: number;
  archived: number;
}

export type CopilotDesktopRead = {
  statePath: string;
  id?: string;
  query: FindQuery;
};

type Read = (query: FindQuery, id?: string) => Promise<CopilotDesktopSession[]>;

function summarize(session: CopilotDesktopSession, machine: string): WorkSummary {
  return {
    ref: { adapter: COPILOT_CLIENT.id, id: session.id },
    title: session.title,
    place: { machine, folder: session.folder, name: session.project || basename(session.folder) },
    ...(isAbsolute(session.directory)
      ? { execution: { directory: session.directory, machine } }
      : {}),
    status: session.archived
      ? 'done'
      : session.running
        ? 'running'
        : session.interrupted
          ? 'stopped'
          : 'done',
    archived: Boolean(session.archived),
    lastActivityAt: Date.parse(session.updatedAt) || 0,
    link: `ghapp://sessions/${encodeURIComponent(session.workspaceId)}`,
  };
}

function group(sessions: CopilotDesktopSession[], query: FindQuery, machine: string): PlaceGroup[] {
  const groups = new Map<string, PlaceGroup>();
  for (const session of sessions) {
    if (!isAbsolute(session.folder)) continue;
    const work = summarize(session, machine);
    let place = groups.get(session.folder);
    if (!place) {
      place = {
        place: work.place,
        lastActivityAt: work.lastActivityAt,
        openCount: 0,
        archivedCount: 0,
        adapters: [COPILOT_CLIENT.id],
        work: [],
      };
      groups.set(session.folder, place);
    }
    if (work.archived) place.archivedCount++;
    else place.openCount++;
    if (query.all || place.work.length < 20) place.work.push(work);
  }
  return [...groups.values()];
}

const find = (superpipe({})('copilot-desktop-find') as PipelineAPI)
  .input(['query', 'read', 'machine'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe((query: FindQuery, read: Read) => read(query), ['query', 'read'], 'sessions')
  .pipe(group, ['sessions', 'query', 'machine'], 'groups')
  .endAsync('groups') as (query: FindQuery, read: Read, machine: string) => Promise<PlaceGroup[]>;

export function createCopilotDesktopAdapter(
  read: Read,
  machine: string,
  home: string
): WorkAdapter {
  const readInput = createCopilotInputReader();
  const historyFile = async (id: string) => {
    if (!/^[\w-]+$/.test(id)) return null;
    const [session] = await read({ includeClosed: true, limit: 1 }, id);
    if (session?.id !== id || !isAbsolute(session.folder)) return null;
    return join(home, '.copilot', 'session-state', id, 'events.jsonl');
  };
  const readableHistory = (id: string) => historyFile(id).catch(() => null);
  return {
    id: COPILOT_CLIENT.id,
    capabilities: ['find', 'status', 'turns'],
    unsupportedCapabilities: {
      start: DESKTOP_CONTROL,
      send: DESKTOP_CONTROL,
      steer: DESKTOP_CONTROL,
      queue: DESKTOP_CONTROL,
      withdraw: DESKTOP_CONTROL,
      stop: DESKTOP_CONTROL,
      compact: DESKTOP_CONTROL,
      rename: DESKTOP_CONTROL,
      archive: DESKTOP_CONTROL,
    },
    find: (query) => find(query, read, machine),
    async readTurns(id, around, before, after, cursor) {
      const file = await readableHistory(id);
      return file ? readCopilotHistory(file, id, around, before, after, cursor) : null;
    },
    async readInput(id, marker) {
      const file = await readableHistory(id);
      return file ? readInput(file, id, marker) : null;
    },
    async turns(ref, cursor, limit) {
      const file = await historyFile(ref.id);
      return file
        ? readCopilotTurnFacts(file, ref.id, cursor, limit)
        : reject('not_found', 'Copilot Desktop session not found.');
    },
    async status(ref, _since, receipt) {
      const [session] = await read({ includeClosed: true, limit: 1 }, ref.id);
      if (!session || !isAbsolute(session.folder))
        return reject('not_found', 'Copilot Desktop session not found.');
      if (receipt)
        return reject('unsupported', 'Copilot Desktop only reports saved session status.');
      return { ok: true, value: summarize(session, machine) };
    },
  };
}
