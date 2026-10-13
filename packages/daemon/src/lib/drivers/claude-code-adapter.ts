import superpipe, { type PipelineAPI } from 'superpipe';
import { basename } from 'node:path';
import type { WorkChatMatch } from '../../storage/work-chat-search.ts';
import { claudeTranscriptCwd, isTempCwd } from './claude-feed.ts';
import { listFeedFiles, readFeedHead } from './work-feed.ts';
import { skipSpaceQuery } from './hyperneo-adapter.ts';
import { mergePlaceGroups, withChatEvidence } from './places.ts';
import type { FindQuery, PlaceGroup, WorkAdapter, WorkSummary } from './types.ts';

const SESSIONS_PER_PLACE = 10;
const TITLE_CHARS = 80;

export interface ClaudeCodeAdapterDeps {
  projectsDir?: string;
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

export function readClaudeCodeFolders(root: string, cache: FolderCache): ClaudeFolder[] {
  const files = listFeedFiles(root, 0, 2);
  const paths = new Set(files.map((file) => file.path));
  for (const path of cache.keys()) if (!paths.has(path)) cache.delete(path);
  return files.flatMap((file) => {
    const known = cache.get(file.path);
    if (known?.at === file.mtime) return known.record ? [known.record] : [];
    try {
      const folder = claudeTranscriptCwd(readFeedHead(file.path));
      const record = folder
        ? { sessionId: basename(file.path, '.jsonl'), folder, at: file.mtime }
        : null;
      cache.set(file.path, { at: file.mtime, record });
      return record ? [record] : [];
    } catch {
      return [];
    }
  });
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
  .input(['query', 'deps', 'cache'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe(
    async (query: FindQuery, deps: ClaudeCodeAdapterDeps) =>
      query.text ? await deps.searchChats(query.text) : [],
    ['query', 'deps'],
    'chats'
  )
  .pipe((deps: ClaudeCodeAdapterDeps) => deps.desktopSessions(), 'deps', 'desktop')
  .pipe((deps: ClaudeCodeAdapterDeps) => deps.ownedSessions?.() ?? new Set(), 'deps', 'owned')
  .pipe(
    (deps: ClaudeCodeAdapterDeps, cache: FolderCache) =>
      deps.projectsDir ? readClaudeCodeFolders(deps.projectsDir, cache) : [],
    ['deps', 'cache'],
    'folders'
  )
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
  cache: FolderCache
) => Promise<PlaceGroup[]>;

export function createClaudeCodeAdapter(deps: ClaudeCodeAdapterDeps): WorkAdapter {
  const cache: FolderCache = new Map();
  return {
    id: 'claude-code',
    capabilities: ['find'],
    find: (query) => runClaudeCodeFind(query, deps, cache),
  };
}
