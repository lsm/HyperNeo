import superpipe, { type PipelineAPI } from 'superpipe';
import type { WorkChatMatch } from '../../storage/work-chat-search.ts';
import { skipSpaceQuery } from './hyperneo-adapter.ts';
import { withChatEvidence } from './places.ts';
import type { FindQuery, PlaceGroup, WorkAdapter, WorkSummary } from './types.ts';

const SESSIONS_PER_PLACE = 10;
const TITLE_CHARS = 80;

export interface ClaudeCodeAdapterDeps {
  machine: string;
  searchChats: (text: string) => Promise<readonly WorkChatMatch[]>;
  desktopSessions: () => Promise<ReadonlySet<string>>;
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
  machine: string
): PlaceGroup[] {
  if (query.folder) return [];
  const work: WorkSummary[] = chats
    .filter((chat) => chat.kind === 'claude' && chat.sessionId && !desktop.has(chat.sessionId))
    .slice(0, SESSIONS_PER_PLACE)
    .map((chat) =>
      withChatEvidence(
        {
          ref: { adapter: 'claude-code', id: chat.sessionId ?? '' },
          title: sessionTitle(chat),
          place: { machine, name: 'Claude Code' },
          status: 'done',
          lastActivityAt: chat.lastHitAt,
        },
        chat
      )
    );
  return work.length === 0
    ? []
    : [
        {
          place: { machine, name: 'Claude Code' },
          lastActivityAt: Math.max(...work.map((item) => item.lastActivityAt)),
          openCount: 0,
          archivedCount: work.length,
          adapters: ['claude-code'],
          work,
        },
      ];
}

const runClaudeCodeFind = (superpipe({})('claude-code-find-work') as PipelineAPI)
  .input(['query', 'deps'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe(
    async (query: FindQuery, deps: ClaudeCodeAdapterDeps) =>
      query.text ? await deps.searchChats(query.text) : [],
    ['query', 'deps'],
    'chats'
  )
  .pipe((deps: ClaudeCodeAdapterDeps) => deps.desktopSessions(), 'deps', 'desktop')
  .pipe(
    (
      chats: WorkChatMatch[],
      desktop: ReadonlySet<string>,
      query: FindQuery,
      deps: ClaudeCodeAdapterDeps
    ) => buildClaudeCodeGroups(chats, desktop, query, deps.machine),
    ['chats', 'desktop', 'query', 'deps'],
    'groups'
  )
  .endAsync('groups') as (query: FindQuery, deps: ClaudeCodeAdapterDeps) => Promise<PlaceGroup[]>;

export function createClaudeCodeAdapter(deps: ClaudeCodeAdapterDeps): WorkAdapter {
  return {
    id: 'claude-code',
    capabilities: ['find'],
    find: (query) => runClaudeCodeFind(query, deps),
  };
}
