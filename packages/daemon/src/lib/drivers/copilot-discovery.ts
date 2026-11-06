import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { CopilotClient, RuntimeConnection, type SessionMetadata } from '@github/copilot-sdk';
import { buildSafeProcessEnv } from '../safe-process-env.ts';
import { isTempCwd } from './claude-feed.ts';
import { skipSpaceQuery } from './hyperneo-adapter.ts';
import type { FindQuery, PlaceGroup, WorkAdapter, WorkStatus, WorkSummary } from './types.ts';

const SESSIONS_PER_PLACE = 20;
const RECENT_MS = 2 * 60_000;
const LIST_REUSE_MS = 60_000;
const LIST_PAGE_SIZE = 50;
const LIST_PAGES = 10;
const LIST_HORIZON_MS = 90 * 24 * 60 * 60_000;
const LIST_OVERALL_TIMEOUT_MS = 15_000;
const TITLE_LIMIT = 80;
const HEAD_BYTES = 8192;

export interface CopilotSession {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: number;
}

export const COPILOT_CLIENT = {
  id: 'copilot-cli',
  bin: 'copilot',
  app: {
    path: '/Applications/GitHub Copilot.app',
    link: (session: CopilotSession) => `ghapp://sessions/${encodeURIComponent(session.sessionId)}`,
  },
} as const;

export interface CopilotDiscoveryDeps {
  machine: string;
  now: () => number;
  listSessions: () => Promise<readonly CopilotSession[]>;
  ownSessions: () => Pick<ReadonlySet<string>, 'has'>;
  projectFolder: (folder: string) => string | Promise<string>;
  link?: (session: CopilotSession) => string;
}

export async function copilotSessionFolder(
  sessionId: string,
  stateDir = join(homedir(), '.copilot', 'session-state')
): Promise<string | null> {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  try {
    const handle = await open(join(stateDir, sessionId, 'events.jsonl'));
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(HEAD_BYTES), 0, HEAD_BYTES, 0);
      const start = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0]);
      const cwd = start?.data?.context?.cwd;
      return typeof cwd === 'string' && cwd ? cwd : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export function copilotSessionTitle(title: string | null | undefined): string {
  const flat = (title ?? '')
    .replace(/^\[User\]:\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.slice(0, TITLE_LIMIT) || 'Untitled session';
}

export function planCopilotSessionWindow(
  metadata: readonly SessionMetadata[],
  since: number
): SessionMetadata[] {
  const ordered = [...metadata].sort((a, b) => b.modifiedTime.getTime() - a.modifiedTime.getTime());
  const limit = Math.min(ordered.length, LIST_PAGES * LIST_PAGE_SIZE);
  for (let end = LIST_PAGE_SIZE; end < limit; end += LIST_PAGE_SIZE) {
    const oldest = ordered[end - 1].modifiedTime.getTime();
    if (oldest && oldest < since) return ordered.slice(0, end);
  }
  return ordered.slice(0, limit);
}

async function resolveCopilotSessionFolders(
  metadata: readonly SessionMetadata[],
  cwd: string
): Promise<CopilotSession[]> {
  const sessions: CopilotSession[] = [];
  for (const session of metadata) {
    const folder = session.context?.workingDirectory ?? cwd;
    sessions.push({
      sessionId: session.sessionId,
      cwd:
        (folder === cwd
          ? await copilotSessionFolder(session.sessionId, join(cwd, '.copilot', 'session-state'))
          : null) ?? folder,
      title: copilotSessionTitle(session.summary),
      updatedAt: session.modifiedTime.getTime() || 0,
    });
  }
  return sessions;
}

const readCopilotSessions = (superpipe({})('copilot-discovery-list') as PipelineAPI)
  .input(['client', 'cwd', 'since'])
  .pipe(
    async (client: Pick<CopilotClient, 'start' | 'listSessions'>) => {
      await client.start();
      return client.listSessions();
    },
    'client',
    'metadata'
  )
  .pipe(planCopilotSessionWindow, ['metadata', 'since'], 'metadata')
  .pipe(resolveCopilotSessionFolders, ['metadata', 'cwd'], 'sessions')
  .endAsync('sessions') as (
  client: Pick<CopilotClient, 'start' | 'listSessions'>,
  cwd: string,
  since: number
) => Promise<CopilotSession[]>;

export async function listCopilotSessions(
  command: string,
  cwd = homedir(),
  overallTimeoutMs = LIST_OVERALL_TIMEOUT_MS,
  now = Date.now()
): Promise<CopilotSession[]> {
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({
      path: command,
      args: ['--no-remote', '--no-remote-export', '--no-custom-instructions'],
      env: buildSafeProcessEnv(),
    }),
    mode: 'empty',
    baseDirectory: join(cwd, '.copilot'),
    workingDirectory: cwd,
    logLevel: 'error',
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Listing sessions timed out after ${overallTimeoutMs}ms`)),
      overallTimeoutMs
    );
  });
  try {
    return await Promise.race([readCopilotSessions(client, cwd, now - LIST_HORIZON_MS), timedOut]);
  } finally {
    clearTimeout(timer);
    await client.forceStop();
  }
}

export function reuseCopilotSessionList(
  list: () => Promise<readonly CopilotSession[]>,
  now: () => number
): () => Promise<readonly CopilotSession[]> {
  let last: { at: number; sessions: Promise<readonly CopilotSession[]> } | null = null;
  let listed: readonly CopilotSession[] | null = null;
  return () => {
    if (last && now() - last.at < LIST_REUSE_MS)
      return listed ? Promise.resolve(listed) : last.sessions;
    const sessions = list();
    last = { at: now(), sessions };
    sessions.then(
      (fresh) => {
        listed = fresh;
      },
      () => {}
    );
    return listed ? Promise.resolve(listed) : sessions;
  };
}

function copilotStatus(session: CopilotSession, now: number): WorkStatus {
  return now - session.updatedAt < RECENT_MS ? 'running' : 'done';
}

export async function loadCopilotSessions(deps: CopilotDiscoveryDeps) {
  const own = deps.ownSessions();
  return (await deps.listSessions()).filter(
    (session) => !own.has(session.sessionId) && !isTempCwd(session.cwd)
  );
}

async function resolveCopilotFolders(
  sessions: readonly CopilotSession[],
  deps: CopilotDiscoveryDeps
) {
  return new Map(
    await Promise.all(
      [...new Set(sessions.map((session) => session.cwd))].map(
        async (folder) => [folder, await deps.projectFolder(folder)] as const
      )
    )
  );
}

export function buildCopilotGroups(
  sessions: readonly CopilotSession[],
  query: FindQuery,
  deps: CopilotDiscoveryDeps,
  folders: ReadonlyMap<string, string>
): PlaceGroup[] {
  const text = query.text?.toLowerCase();
  const now = deps.now();
  const byFolder = new Map<string, CopilotSession[]>();
  for (const session of sessions) {
    const folder = folders.get(session.cwd)!;
    if (query.folder && folder !== query.folder) continue;
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), session]);
  }
  return [...byFolder].flatMap(([folder, inFolder]) => {
    const name = basename(folder) || folder;
    const placeMatches = !text || `${name} ${folder}`.toLowerCase().includes(text);
    const place = { machine: deps.machine, folder, name };
    const work: WorkSummary[] = inFolder
      .filter((session) => placeMatches || session.title.toLowerCase().includes(text ?? ''))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, SESSIONS_PER_PLACE)
      .map((session) => ({
        ref: { adapter: COPILOT_CLIENT.id, id: session.sessionId },
        title: session.title,
        place,
        status: copilotStatus(session, now),
        lastActivityAt: session.updatedAt,
        ...(deps.link ? { link: deps.link(session) } : {}),
      }));
    if (!placeMatches && work.length === 0) return [];
    return [
      {
        place,
        lastActivityAt: Math.max(0, ...inFolder.map((session) => session.updatedAt)),
        openCount: inFolder.length,
        archivedCount: 0,
        adapters: [COPILOT_CLIENT.id],
        work,
      },
    ];
  });
}

const runCopilotFind = (superpipe({})('copilot-discovery-find') as PipelineAPI)
  .input(['query', 'deps'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe(loadCopilotSessions, 'deps', 'sessions')
  .pipe(resolveCopilotFolders, ['sessions', 'deps'], 'folders')
  .pipe(buildCopilotGroups, ['sessions', 'query', 'deps', 'folders'], 'groups')
  .endAsync('groups') as (query: FindQuery, deps: CopilotDiscoveryDeps) => Promise<PlaceGroup[]>;

export function createCopilotDiscovery(deps: CopilotDiscoveryDeps): WorkAdapter {
  return {
    id: COPILOT_CLIENT.id,
    capabilities: ['find'],
    find: (query) => runCopilotFind(query, deps),
  };
}
