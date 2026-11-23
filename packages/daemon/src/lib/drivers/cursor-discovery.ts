import { basename, isAbsolute } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { ProcessJsonRpcTransport } from '../process-json-rpc.ts';
import { buildSafeProcessEnv } from '../safe-process-env.ts';
import { skipSpaceQuery } from './hyperneo-adapter.ts';
import type { FindQuery, PlaceGroup, WorkAdapter, WorkSummary } from './types.ts';

const ADAPTER = 'cursor-cli';
const MAX_PAGES = 10;
const DISCOVERY_TIMEOUT_MS = 15_000;
const InitializeResult = z.object({
  protocolVersion: z.literal(1),
  agentCapabilities: z.object({
    sessionCapabilities: z.object({ list: z.object({}) }),
  }),
});
const SessionList = z.object({
  sessions: z.array(
    z.object({
      sessionId: z.string().min(1),
      cwd: z.string().refine(isAbsolute),
      title: z.string().nullish(),
      updatedAt: z.string().nullish(),
    })
  ),
  nextCursor: z.string().nullish(),
});
type Session = z.infer<typeof SessionList>['sessions'][number];

async function listSessions(command: string, home: string, folder: string | undefined) {
  const transport = new ProcessJsonRpcTransport({
    command,
    args: ['acp'],
    cwd: home,
    env: buildSafeProcessEnv(),
    replaceEnv: true,
    requestTimeoutMs: 5_000,
    onStderr: () => {},
  });
  async function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const response = await transport.sendRequest(method, params);
    if ('result' in response) return response.result;
    if (response.error.message === 'Authentication required')
      throw new Error('Cursor CLI authentication required. Run cursor-agent login.');
    throw new Error(`Cursor CLI rejected ${method} (${response.error.code}).`);
  }

  async function readPages(): Promise<Session[]> {
    const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    if (!InitializeResult.safeParse(init).success)
      throw new Error('Cursor CLI does not support ACP session listing.');
    const sessions = new Map<string, Session>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = SessionList.safeParse(await request('session/list', { cwd: folder, cursor }));
      if (!result.success) throw new Error('Cursor CLI returned invalid session metadata.');
      for (const session of result.data.sessions)
        if (!sessions.has(session.sessionId)) sessions.set(session.sessionId, session);
      const next = result.data.nextCursor;
      if (!next) return [...sessions.values()];
      if (seenCursors.has(next)) throw new Error('Cursor CLI repeated an ACP session cursor.');
      seenCursors.add(next);
      cursor = next;
    }
    throw new Error('Cursor CLI exceeded the ACP session page limit.');
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Cursor CLI session discovery timed out.')),
      DISCOVERY_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([readPages(), deadline]);
  } finally {
    clearTimeout(timer);
    await transport.close();
  }
}

function groupSessions(
  sessions: readonly Session[],
  query: FindQuery,
  machine: string
): PlaceGroup[] {
  const text = query.text?.toLowerCase();
  const groups = new Map<string, PlaceGroup>();
  for (const session of sessions) {
    const folder = session.cwd;
    if (query.folder && query.folder !== folder) continue;
    if (query.idPrefix && !session.sessionId.startsWith(query.idPrefix)) continue;
    const name = basename(folder) || folder;
    const title = session.title?.trim() || 'Untitled Cursor session';
    if (text && !`${title} ${folder}`.toLowerCase().includes(text)) continue;
    const place = { machine, folder, name };
    const lastActivityAt = Date.parse(session.updatedAt ?? '') || 0;
    const work: WorkSummary = {
      ref: { adapter: ADAPTER, id: session.sessionId },
      place,
      title,
      lastActivityAt,
      status: 'done',
      watchHint: 'Open this session in Cursor CLI. Discovery does not report live turn state.',
    };
    const group = groups.get(folder);
    if (group) {
      group.work.push(work);
      group.openCount++;
      group.lastActivityAt = Math.max(group.lastActivityAt, lastActivityAt);
    } else {
      groups.set(folder, {
        place,
        work: [work],
        adapters: [ADAPTER],
        lastActivityAt,
        openCount: 1,
        archivedCount: 0,
      });
    }
  }
  return [...groups.values()];
}

const find = (superpipe({})('cursor-discovery-find') as PipelineAPI)
  .input(['query', 'command', 'home', 'machine'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe(
    (command: string, home: string, query: FindQuery) => listSessions(command, home, query.folder),
    ['command', 'home', 'query'],
    'sessions'
  )
  .pipe(groupSessions, ['sessions', 'query', 'machine'], 'groups')
  .endAsync('groups') as (
  query: FindQuery,
  command: string,
  home: string,
  machine: string
) => Promise<PlaceGroup[]>;

export function createCursorDiscovery(command: string, home: string, machine: string): WorkAdapter {
  return {
    id: ADAPTER,
    capabilities: ['find'],
    find: (query) => find(query, command, home, machine),
  };
}
