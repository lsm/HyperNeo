import { runLagPhase } from '../event-loop-activity.ts';
import { readClaudeCliStatus } from './claude-cli-status.ts';
import type { ClaudeLiveSession } from './claude-desktop-adapter.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { basename } from 'node:path';
import type { WorkChatMatch } from '../../storage/work-chat-search.ts';
import { claudeTranscriptCwd, isTempCwd } from './claude-feed.ts';
import { listFeedFilesAsync, readFeedPrefix } from './work-feed.ts';
import { skipSpaceQuery } from './hyperneo-adapter.ts';
import { mergePlaceGroups, withChatEvidence } from './places.ts';
import type { FindQuery, PlaceGroup, WorkAdapter, WorkSummary } from './types.ts';

const SESSIONS_PER_PLACE = 10;
const TITLE_CHARS = 80;
const CWD_PREFIX_BYTES = 16 * 1024;
const HEAD_READS_AT_ONCE = 32;

export interface ClaudeCodeAdapterDeps {
  projectsDir?: string;
  sendInbox?: (
    sessionId: string,
    text: string,
    context: Parameters<NonNullable<WorkAdapter['send']>>[2]
  ) => ReturnType<NonNullable<WorkAdapter['send']>>;
  liveSessions?: () => Promise<readonly ClaudeLiveSession[]>;
  machine: string;
  searchChats: (text: string) => Promise<readonly WorkChatMatch[]>;
  desktopSessions: () => Promise<ReadonlySet<string>>;
  ownedSessions?: () => ReadonlySet<string>;
}

interface ClaudeFolder {
  sessionId: string;
  folder: string;
  at: number;
}

type FolderCache = Map<string, { at: number; record: ClaudeFolder | null }>;

async function readClaudeFolder(
  path: string,
  at: number
): Promise<ClaudeFolder | null | undefined> {
  try {
    const folder =
      claudeTranscriptCwd(await readFeedPrefix(path, CWD_PREFIX_BYTES)) ||
      claudeTranscriptCwd(await readFeedPrefix(path));
    return folder ? { sessionId: basename(path, '.jsonl'), folder, at } : null;
  } catch {
    return undefined;
  }
}

export async function readClaudeCodeFolders(
  root: string,
  cache: FolderCache
): Promise<ClaudeFolder[]> {
  const files = await listFeedFilesAsync(root, Date.now() - 90 * 24 * 60 * 60_000, 2);
  const paths = new Set(files.map((file) => file.path));
  for (const path of cache.keys()) if (!paths.has(path)) cache.delete(path);
  const stale = files.filter((file) => cache.get(file.path)?.at !== file.mtime);
  for (let start = 0; start < stale.length; start += HEAD_READS_AT_ONCE) {
    const batch = stale.slice(start, start + HEAD_READS_AT_ONCE);
    const records = await Promise.all(batch.map((file) => readClaudeFolder(file.path, file.mtime)));
    batch.forEach((file, index) => {
      const record = records[index];
      if (record !== undefined) cache.set(file.path, { at: file.mtime, record });
    });
  }
  return files.flatMap((file) => {
    const known = cache.get(file.path);
    return known?.at === file.mtime && known.record ? [known.record] : [];
  });
}

export function shareInFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };
}

function sessionTitle(chat: WorkChatMatch): string {
  const text = (chat.snippets.find((snippet) => snippet.role === 'user') ?? chat.snippets[0])?.text;
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > TITLE_CHARS
    ? `${flat.slice(0, TITLE_CHARS - 1)}…`
    : flat || 'Claude Code session';
}

export function buildClaudeCodeGroups(
  chats: readonly WorkChatMatch[],
  desktop: ReadonlySet<string>,
  query: FindQuery,
  machine: string,
  folders: readonly ClaudeFolder[] = [],
  owned: ReadonlySet<string> = new Set()
): PlaceGroup[] {
  const bySession = new Map(folders.map((record) => [record.sessionId, record]));
  const excluded = new Set([
    ...desktop,
    ...owned,
    ...folders.filter((record) => isTempCwd(record.folder)).map((record) => record.sessionId),
  ]);
  const work: WorkSummary[] = chats
    .filter((chat) => chat.kind === 'claude' && chat.sessionId && !excluded.has(chat.sessionId))
    .filter((chat) => !query.folder || bySession.get(chat.sessionId ?? '')?.folder === query.folder)
    .slice(0, SESSIONS_PER_PLACE)
    .map((chat) =>
      withChatEvidence(
        {
          ref: { adapter: 'claude-code', id: chat.sessionId ?? '' },
          title: sessionTitle(chat),
          place: {
            machine,
            name: 'Claude Code',
            folder: bySession.get(chat.sessionId ?? '')?.folder,
          },
          status: 'done',
          lastActivityAt: chat.lastHitAt,
        },
        chat
      )
    );
  const groups: PlaceGroup[] = work.map((item) => ({
    place: item.place,
    lastActivityAt: item.lastActivityAt,
    openCount: 0,
    archivedCount: 1,
    adapters: ['claude-code'],
    work: [item],
  }));
  for (const record of folders) {
    if (excluded.has(record.sessionId) || (query.folder && record.folder !== query.folder))
      continue;
    if (query.text && !record.folder.toLowerCase().includes(query.text.toLowerCase())) continue;
    groups.push({
      place: { machine, folder: record.folder, name: basename(record.folder) },
      lastActivityAt: record.at,
      openCount: 0,
      archivedCount: 0,
      adapters: ['claude-code'],
      work: [],
    });
  }
  return mergePlaceGroups(groups, query.limit);
}

const runClaudeCodeFind = (superpipe({})('claude-code-find-work') as PipelineAPI)
  .input(['query', 'deps', 'scan'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe(
    async (query: FindQuery, deps: ClaudeCodeAdapterDeps) =>
      query.text ? await deps.searchChats(query.text) : [],
    ['query', 'deps'],
    'chats'
  )
  .pipe((deps: ClaudeCodeAdapterDeps) => deps.desktopSessions(), 'deps', 'desktop')
  .pipe((deps: ClaudeCodeAdapterDeps) => deps.ownedSessions?.() ?? new Set(), 'deps', 'owned')
  .pipe((scan: () => Promise<ClaudeFolder[]>) => scan(), 'scan', 'folders')
  .pipe(
    (
      chats: WorkChatMatch[],
      desktop: ReadonlySet<string>,
      query: FindQuery,
      deps: ClaudeCodeAdapterDeps,
      folders: ClaudeFolder[],
      owned: ReadonlySet<string>
    ) => buildClaudeCodeGroups(chats, desktop, query, deps.machine, folders, owned),
    ['chats', 'desktop', 'query', 'deps', 'folders', 'owned'],
    'groups'
  )
  .endAsync('groups') as (
  query: FindQuery,
  deps: ClaudeCodeAdapterDeps,
  scan: () => Promise<ClaudeFolder[]>
) => Promise<PlaceGroup[]>;

export function createClaudeCodeAdapter(deps: ClaudeCodeAdapterDeps): WorkAdapter {
  const cache: FolderCache = new Map();
  const projectsDir = deps.projectsDir;
  const scan = projectsDir
    ? shareInFlight(() =>
        runLagPhase('scanner:claude_code', () => readClaudeCodeFolders(projectsDir, cache))
      )
    : async () => [];
  const liveSessions = deps.liveSessions ? shareInFlight(deps.liveSessions) : undefined;
  const status: WorkAdapter['status'] = liveSessions
    ? (ref, since, receipt) =>
        readClaudeCliStatus(ref, since, receipt, {
          machine: deps.machine,
          projectsDir: projectsDir ?? '',
          liveSessions,
          folder: async (id) =>
            (await scan()).find((record) => record.sessionId === id)?.folder ?? null,
        })
    : undefined;
  const sendInbox = deps.sendInbox;
  const send: WorkAdapter['send'] = sendInbox
    ? (ref, message, context) => sendInbox(ref.id, message, context)
    : undefined;
  return {
    id: 'claude-code',
    capabilities: [
      'find',
      ...(status ? (['status'] as const) : []),
      ...(send ? (['send', 'steer'] as const) : []),
    ],
    ...(send ? { send, steer: send } : {}),
    ...(status ? { status } : {}),
    find: (query) => runClaudeCodeFind(query, deps, scan),
  };
}
