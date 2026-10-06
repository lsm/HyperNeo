import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import { readWorkFeedOffsets, type WorkFeedTurn } from '../../storage/work-feed.ts';
import {
  changedFeedFiles,
  type FeedFile,
  type FeedFileMeta,
  type FeedSource,
  feedWorkFiles,
  listFeedFiles,
  pruneVanishedFeeds,
} from './work-feed.ts';

export const WORK_FEED_CODEX = 'work.feed.codex';
const FEED_INTERVAL_MS = 60_000;
const FEED_WINDOW_MS = 90 * 24 * 60 * 60_000;
const ROLLOUT_ID_CHARS = 36;

export function codexSessionsRoot(): string {
  return join(homedir(), '.codex', 'sessions');
}

export interface CodexRolloutMeta {
  threadId: string;
  cwd: string;
  subagent: boolean;
}

type Block = { type?: string; text?: string };

export function codexRolloutMeta(line: string): CodexRolloutMeta | null {
  try {
    const record = JSON.parse(line) as {
      type?: string;
      payload?: { id?: string; cwd?: string; source?: unknown };
    };
    const payload = record.payload;
    if (record.type !== 'session_meta' || !payload?.id) return null;
    return {
      threadId: payload.id,
      cwd: payload.cwd ?? '',
      subagent: typeof payload.source === 'object' && payload.source !== null,
    };
  } catch {
    return null;
  }
}

function spokenText(content: unknown): string {
  return (Array.isArray(content) ? (content as Block[]) : [])
    .filter(
      (block) =>
        (block.type === 'input_text' || block.type === 'output_text') &&
        typeof block.text === 'string' &&
        !block.text.startsWith('<') &&
        !block.text.startsWith('# AGENTS.md instructions')
    )
    .map((block) => (block.text ?? '').trim())
    .filter(Boolean)
    .join('\n');
}

export function codexRolloutTurns(lines: readonly string[], threadId: string): WorkFeedTurn[] {
  return lines.flatMap((line) => {
    try {
      const record = JSON.parse(line) as {
        type?: string;
        timestamp?: string;
        payload?: { type?: string; id?: string; role?: string; content?: unknown };
      };
      const payload = record.payload;
      if (record.type !== 'response_item' || payload?.type !== 'message') return [];
      if (payload.role !== 'user' && payload.role !== 'assistant') return [];
      const text = spokenText(payload.content);
      const at = Date.parse(record.timestamp ?? '');
      if (!text || !Number.isFinite(at)) return [];
      const messageId = payload.id ?? `${record.timestamp}:${payload.role}`;
      return [
        {
          sourceId: `${threadId}:${messageId}`,
          messageId,
          sessionId: threadId,
          role: payload.role,
          text,
          at,
        },
      ];
    } catch {
      return [];
    }
  });
}

export function scheduleCodexFeed(queue: JobQueueRepository): void {
  queue.enqueueUniquePending({
    queue: WORK_FEED_CODEX,
    payload: { scope: 'codex' },
    matchPayload: { scope: 'codex' },
    activeStatuses: ['pending'],
    runAt: Date.now() + FEED_INTERVAL_MS,
  });
}

export const codexFeedSource: FeedSource<CodexRolloutMeta & FeedFileMeta> = {
  kind: 'codex',
  sessionOf: (path) => basename(path, '.jsonl').slice(-ROLLOUT_ID_CHARS),
  meta: (_path, head) => {
    const meta = codexRolloutMeta(head.split('\n', 1)[0]);
    return meta && !meta.subagent
      ? { ...meta, sessionId: meta.threadId, title: basename(meta.cwd) }
      : null;
  },
  turns: (lines, meta) => codexRolloutTurns(lines, meta.threadId),
};

export function feedCodexFiles(
  db: BunDatabase,
  files: readonly FeedFile[]
): Promise<{ files: number; turns: number }> {
  return feedWorkFiles(db, files, codexFeedSource);
}

export const runCodexFeed = (superpipe({})('work-feed-codex') as PipelineAPI)
  .input(['queue', 'db', 'root', 'now'])
  .pipe(scheduleCodexFeed, 'queue')
  .pipe(
    (db: BunDatabase, root: string) => pruneVanishedFeeds(db, root, codexFeedSource),
    ['db', 'root'],
    'pruned'
  )
  .pipe(
    (root: string, now: number) => listFeedFiles(root, now - FEED_WINDOW_MS),
    ['root', 'now'],
    'files'
  )
  .pipe(
    (db: BunDatabase, files: FeedFile[]) => changedFeedFiles(files, readWorkFeedOffsets(db)),
    ['db', 'files'],
    'changed'
  )
  .pipe(feedCodexFiles, ['db', 'changed'], 'result')
  .endAsync('result') as (
  queue: JobQueueRepository,
  db: BunDatabase,
  root: string,
  now: number
) => Promise<{ files: number; turns: number }>;
