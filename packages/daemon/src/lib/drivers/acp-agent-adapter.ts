import { existsSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { runLagPhase } from '../event-loop-activity.ts';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { AcpClient } from '../acp/acp-client.ts';
import { buildAcpSafeEnv } from '../acp/acp-command.ts';
import { isTempCwd } from './claude-feed.ts';
import { skipSpaceQuery } from './hyperneo-adapter.ts';
import type { FindQuery, PlaceGroup, WorkAdapter, WorkStatus, WorkSummary } from './types.ts';

const SESSIONS_PER_PLACE = 20;
const RECENT_MS = 2 * 60_000;
const LIST_REUSE_MS = 60_000;
const LIST_PAGES = 10;
const LIST_HORIZON_MS = 90 * 24 * 60 * 60_000;
const LIST_TIMEOUT_MS = 10_000;
const LIST_OVERALL_TIMEOUT_MS = 15_000;
const TITLE_LIMIT = 80;
const HEAD_BYTES = 8192;

export interface AcpAgentSpec {
  id: string;
  name: string;
  bin: string;
  args: readonly string[];
  sessionFolder?: (sessionId: string) => Promise<string | null>;
  app?: { path: string; link: (session: AcpAgentSession) => string };
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

export const ACP_AGENTS: readonly AcpAgentSpec[] = [
  {
    id: 'copilot-cli',
    name: 'Copilot CLI',
    bin: 'copilot',
    args: ['--acp'],
    sessionFolder: (sessionId) => copilotSessionFolder(sessionId),
    app: {
      path: '/Applications/GitHub Copilot.app',
      link: (session) => `ghapp://sessions/${encodeURIComponent(session.sessionId)}`,
    },
  },
  { id: 'opencode', name: 'OpenCode', bin: 'opencode', args: ['acp'] },
];

export interface AcpAgentSession {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: number;
}

export interface AcpAgentAdapterDeps {
  agent: AcpAgentSpec;
  machine: string;
  now: () => number;
  listSessions: () => Promise<readonly AcpAgentSession[]>;
  ownSessions: () => Pick<ReadonlySet<string>, 'has'>;
  projectFolder: (folder: string) => string | Promise<string>;
  link?: (session: AcpAgentSession) => string;
}

const worktreeProjects = new Map<string, { stamp: string; project: Promise<string> }>();

export async function gitWorktreeProject(folder: string): Promise<string> {
  try {
    const path = join(folder, '.git');
    const info = await runLagPhase('scanner:worktree:metadata', () => stat(path));
    if (info.isDirectory())
      return readFile(join(path, 'hyperneo-source-checkout'), 'utf8')
        .then((source) => source.trim() || folder)
        .catch(() => folder);
    const stamp = `${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    const cached = worktreeProjects.get(folder);
    if (cached?.stamp === stamp) return cached.project;
    const project = runLagPhase('scanner:worktree:read', () => readFile(path, 'utf8'))
      .then((text) => {
        const pointer = text.match(/^gitdir:\s*(.+)$/m)?.[1];
        const at = pointer?.trim().lastIndexOf('/.git/worktrees/') ?? -1;
        return pointer && at > 0 ? pointer.trim().slice(0, at) : folder;
      })
      .catch(() => {
        if (worktreeProjects.get(folder)?.project === project) worktreeProjects.delete(folder);
        return folder;
      });
    worktreeProjects.set(folder, { stamp, project });
    return project;
  } catch {
    worktreeProjects.delete(folder);
    return folder;
  }
}

export function findAcpAgentBinary(bin: string, path = process.env.PATH ?? ''): string | null {
  for (const dir of path.split(delimiter)) {
    if (dir && existsSync(join(dir, bin))) return join(dir, bin);
  }
  return null;
}

export function acpSessionTitle(title: string | null | undefined): string {
  const flat = (title ?? '')
    .replace(/^\[User\]:\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.slice(0, TITLE_LIMIT) || 'Untitled session';
}

export async function readAcpSessionPages(
  client: Pick<AcpClient, 'initialize' | 'canListSessions' | 'listSessions'>,
  agent: Pick<AcpAgentSpec, 'sessionFolder'>,
  cwd: string,
  since: number
): Promise<AcpAgentSession[]> {
  await client.initialize();
  if (!client.canListSessions()) return [];
  const sessions: AcpAgentSession[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < LIST_PAGES; page++) {
    const result = await client.listSessions(cursor ? { cursor } : {});
    for (const session of result.sessions)
      sessions.push({
        sessionId: session.sessionId,
        cwd:
          (session.cwd === cwd ? await agent.sessionFolder?.(session.sessionId) : null) ??
          session.cwd,
        title: acpSessionTitle(session.title),
        updatedAt: session.updatedAt ? Date.parse(session.updatedAt) || 0 : 0,
      });
    cursor = result.nextCursor;
    const oldest = sessions.at(-1)?.updatedAt;
    if (!cursor || (oldest && oldest < since)) break;
  }
  return sessions;
}

export async function listAcpAgentSessions(
  command: string,
  agent: Pick<AcpAgentSpec, 'args' | 'sessionFolder'>,
  cwd = homedir(),
  overallTimeoutMs = LIST_OVERALL_TIMEOUT_MS,
  now = Date.now()
): Promise<AcpAgentSession[]> {
  const client = new AcpClient({
    command,
    args: [...agent.args],
    cwd,
    env: buildAcpSafeEnv(),
    replaceEnv: true,
    requestTimeoutMs: LIST_TIMEOUT_MS,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Listing sessions timed out after ${overallTimeoutMs}ms`)),
      overallTimeoutMs
    );
  });
  try {
    return await Promise.race([
      readAcpSessionPages(client, agent, cwd, now - LIST_HORIZON_MS),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
    await client.close();
  }
}

export function reuseAcpSessionList(
  list: () => Promise<readonly AcpAgentSession[]>,
  now: () => number
): () => Promise<readonly AcpAgentSession[]> {
  let last: { at: number; sessions: Promise<readonly AcpAgentSession[]> } | null = null;
  let listed: readonly AcpAgentSession[] | null = null;
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

function acpStatus(session: AcpAgentSession, now: number): WorkStatus {
  return now - session.updatedAt < RECENT_MS ? 'running' : 'done';
}

export async function loadAcpAgentSessions(deps: AcpAgentAdapterDeps) {
  const own = deps.ownSessions();
  return (await deps.listSessions()).filter(
    (session) => !own.has(session.sessionId) && !isTempCwd(session.cwd)
  );
}

async function resolveAcpFolders(sessions: readonly AcpAgentSession[], deps: AcpAgentAdapterDeps) {
  return new Map(
    await Promise.all(
      [...new Set(sessions.map((session) => session.cwd))].map(
        async (folder) => [folder, await deps.projectFolder(folder)] as const
      )
    )
  );
}

export function buildAcpAgentGroups(
  sessions: readonly AcpAgentSession[],
  query: FindQuery,
  deps: AcpAgentAdapterDeps,
  folders: ReadonlyMap<string, string>
): PlaceGroup[] {
  const text = query.text?.toLowerCase();
  const now = deps.now();
  const byFolder = new Map<string, AcpAgentSession[]>();
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
        ref: { adapter: deps.agent.id, id: session.sessionId },
        title: session.title,
        place,
        status: acpStatus(session, now),
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
        adapters: [deps.agent.id],
        work,
      },
    ];
  });
}

const runAcpAgentFind = (superpipe({})('acp-agent-find-work') as PipelineAPI)
  .input(['query', 'deps'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe(loadAcpAgentSessions, 'deps', 'sessions')
  .pipe(resolveAcpFolders, ['sessions', 'deps'], 'folders')
  .pipe(buildAcpAgentGroups, ['sessions', 'query', 'deps', 'folders'], 'groups')
  .endAsync('groups') as (query: FindQuery, deps: AcpAgentAdapterDeps) => Promise<PlaceGroup[]>;

export function createAcpAgentAdapter(deps: AcpAgentAdapterDeps): WorkAdapter {
  return {
    id: deps.agent.id,
    capabilities: ['find'],
    find: (query) => runAcpAgentFind(query, deps),
  };
}
