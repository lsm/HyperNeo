import { basename, isAbsolute, normalize } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { ProcessJsonRpcTransport } from '../process-json-rpc.ts';
import { buildSafeProcessEnv } from '../safe-process-env.ts';
import type { FindQuery, PlaceGroup, WorkAdapter } from './types.ts';

const ADAPTER = 'antigravity-cli';
const MAX_PAGES = 10;
const DISCOVERY_TIMEOUT_MS = 15_000;
const ListCapability = z.object({
  protocolVersion: z.literal(1),
  agentCapabilities: z.object({ sessionCapabilities: z.object({ list: z.object({}) }) }),
});
const SessionPage = z.object({
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
type Session = z.infer<typeof SessionPage>['sessions'][number];

async function listSessions(
  query: FindQuery,
  transport: ProcessJsonRpcTransport
): Promise<Session[]> {
  const request = async (method: string, params: Record<string, unknown>) => {
    const response = await transport.sendRequest(method, params);
    if ('result' in response) return response.result;
    if (response.error.code === -32000)
      throw new Error('Sign in to Antigravity CLI before listing its sessions.');
    throw new Error(`Antigravity rejected ${method} (${response.error.code}).`);
  };
  const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  if (!ListCapability.safeParse(initialized).success)
    throw new Error('This Antigravity CLI version does not advertise ACP session discovery.');
  const sessions = new Map<string, Session>();
  const seenCursors = new Set<string>();
  const folder = query.folder ? normalize(query.folder) : undefined;
  const text = query.text?.toLowerCase();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = SessionPage.safeParse(await request('session/list', { cwd: folder, cursor }));
    if (!result.success) throw new Error('Antigravity returned an invalid ACP session list.');
    for (const session of result.data.sessions) {
      if (folder && normalize(session.cwd) !== folder) continue;
      if (query.idPrefix && !session.sessionId.startsWith(query.idPrefix)) continue;
      if (
        text &&
        ![session.title ?? '', session.cwd].some((term) => term.toLowerCase().includes(text))
      )
        continue;
      if (!sessions.has(session.sessionId)) sessions.set(session.sessionId, session);
    }
    cursor = result.data.nextCursor ?? undefined;
    if (!cursor || sessions.size >= query.limit) break;
    if (seenCursors.has(cursor))
      throw new Error('Antigravity repeated an ACP session list cursor.');
    seenCursors.add(cursor);
  }
  return [...sessions.values()];
}

async function readSessions(query: FindQuery, executable: string): Promise<Session[]> {
  const transport = new ProcessJsonRpcTransport({
    command: executable,
    args: ['acp', '--disable-telemetry'],
    replaceEnv: true,
    env: buildSafeProcessEnv(),
    onStderr: () => {},
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Antigravity session discovery timed out.')),
      DISCOVERY_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([listSessions(query, transport), deadline]);
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
  const groups = new Map<string, PlaceGroup>();
  for (const session of sessions) {
    const folder = normalize(session.cwd);
    const lastActivityAt = Date.parse(session.updatedAt ?? '') || 0;
    let group = groups.get(folder);
    if (!group) {
      group = {
        place: { machine, folder, name: basename(folder) || folder },
        lastActivityAt,
        openCount: 0,
        archivedCount: 0,
        adapters: [ADAPTER],
        work: [],
      };
      groups.set(folder, group);
    }
    group.openCount += 1;
    group.lastActivityAt = Math.max(group.lastActivityAt, lastActivityAt);
    group.work.push({
      ref: { adapter: ADAPTER, id: session.sessionId },
      place: group.place,
      title: session.title?.trim() || group.place.name,
      status: 'done',
      lastActivityAt,
      watchHint: 'Open this session in Antigravity CLI. Discovery does not report live turn state.',
    });
  }
  return [...groups.values()].map((group) => ({
    ...group,
    work: group.work.sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, query.limit),
  }));
}

const find = (superpipe({})('antigravity-find') as PipelineAPI)
  .input(['query', 'executable', 'machine'])
  .pipe(readSessions, ['query', 'executable'], 'sessions')
  .pipe(groupSessions, ['sessions', 'query', 'machine'], 'groups')
  .endAsync('groups') as (
  query: FindQuery,
  executable: string,
  machine: string
) => Promise<PlaceGroup[]>;

export function createAntigravityAdapter(executable: string, machine: string): WorkAdapter {
  return {
    id: ADAPTER,
    capabilities: ['find'],
    find: (query) => (query.spaceId ? [] : find(query, executable, machine)),
  };
}
