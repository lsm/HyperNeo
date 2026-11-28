import { basename, isAbsolute, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import superpipe, { type PipelineAPI } from 'superpipe';
import { createCopilotInputReader, readCopilotHistory } from './copilot-history.ts';
import { COPILOT_CLIENT } from './copilot-discovery.ts';
import {
  readCopilotInputs,
  readCopilotObservations,
  readCopilotTurnFacts,
} from './copilot-observations.ts';
import { skipSpaceQuery } from './hyperneo-adapter.ts';
import { reject } from './work-operations.ts';
import type { FindQuery, PlaceGroup, WorkAdapter, WorkSummary } from './types.ts';
import { createCopilotDesktopControl } from './copilot-desktop-control.ts';

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
  model?: string | null;
  effort?: string | null;
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
    copilotClient: 'desktop',
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
    ...(session.model ? { model: session.model } : {}),
    ...(session.effort ? { effort: session.effort } : {}),
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
  home: string,
  controlAvailable?: () => boolean
): WorkAdapter {
  const readInput = createCopilotInputReader();
  const historyFile = async (id: string) => {
    if (!/^[\w-]+$/.test(id)) return null;
    const [session] = await read({ includeClosed: true, limit: 1 }, id);
    if (session?.id !== id || !isAbsolute(session.folder)) return null;
    return join(home, '.copilot', 'session-state', id, 'events.jsonl');
  };
  const readableHistory = (id: string) => historyFile(id).catch(() => null);
  const control = createCopilotDesktopControl({
    machine,
    homeDir: home,
    folderExists: existsSync,
    makeFolder: (folder) => mkdirSync(folder),
    find: async (id) => (await read({ includeClosed: true, limit: 1 }, id))[0],
    summarize: (session) => summarize(session, machine),
    observedInput: async (id, inputId) => {
      const file = await readableHistory(id);
      return (
        file !== null &&
        readCopilotInputs(file, id, {}, (observed) => observed === inputId)[inputId]?.state ===
          'observed'
      );
    },
  });
  return {
    id: COPILOT_CLIENT.id,
    identity: { fixedProvider: 'github-copilot', configurable: true },
    get copilotClients(): NonNullable<WorkAdapter['copilotClients']> {
      return controlAvailable?.() ? ['desktop'] : [];
    },
    steerBehavior: 'best_effort',
    get capabilities(): WorkAdapter['capabilities'] {
      return controlAvailable?.()
        ? [
            'find',
            'status',
            'turns',
            'start',
            'send',
            'steer',
            'queue',
            'withdraw',
            'stop',
            'compact',
            'rename',
            'archive',
          ]
        : ['find', 'status', 'turns'];
    },
    get unsupportedCapabilities() {
      return controlAvailable?.()
        ? {}
        : {
            start: DESKTOP_CONTROL,
            send: DESKTOP_CONTROL,
            steer: DESKTOP_CONTROL,
            queue: DESKTOP_CONTROL,
            withdraw: DESKTOP_CONTROL,
            stop: DESKTOP_CONTROL,
            rename: DESKTOP_CONTROL,
            archive: DESKTOP_CONTROL,
          };
    },
    ...control,
    start: (request, context) =>
      request.copilotClient === 'cli'
        ? Promise.resolve(
            reject('unreachable', 'Copilot CLI is unavailable on this machine.', true)
          )
        : control.start(request, context),
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
    async status(ref, since, receipt) {
      const [session] = await read({ includeClosed: true, limit: 1 }, ref.id);
      if (!session || !isAbsolute(session.folder))
        return reject('not_found', 'Copilot Desktop session not found.');
      const value = summarize(session, machine);
      if (receipt && receipt.executionId !== ref.id)
        return reject('not_found', 'Receipt belongs to another Copilot session.');
      const file = receipt || since !== undefined ? await readableHistory(ref.id) : null;
      const input =
        receipt && file
          ? readCopilotInputs(file, ref.id, {}, (id) => id === receipt.inputId)[receipt.inputId]
          : undefined;
      return {
        ok: true,
        value: {
          ...value,
          ...(file && since !== undefined
            ? readCopilotObservations(file, ref.id, {}, () => false, since)
            : {}),
          ...(receipt
            ? {
                inputEvidence:
                  input?.state === 'observed'
                    ? {
                        receipt,
                        state: 'observed',
                        exchange: [],
                        exchangeCut: true,
                        replyReport: input.replyReport,
                        replyAvailability: input.replyAvailability,
                      }
                    : { receipt, state: 'unavailable' },
              }
            : {}),
          ...(input?.replyReport ? { lastReply: input.replyReport } : {}),
        },
      };
    },
  };
}
