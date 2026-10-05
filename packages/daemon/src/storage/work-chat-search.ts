import { buildFtsQuery, messageSearchPolicy } from './message-search.ts';
import type { Database as BunDatabase } from './sqlite-compat.ts';

const MATCH_CAP = 2_000;
const SNIPPETS_PER_CHAT = 2;
const FUSION_K = 60;

export interface WorkChatSnippet {
  messageId: string;
  sessionId: string | null;
  role: string;
  at: number;
  text: string;
}

export interface WorkChatMatch {
  sessionId: string | null;
  taskId: string | null;
  hits: number;
  lastHitAt: number;
  score: number;
  snippets: WorkChatSnippet[];
}

interface WorkChatHitRow {
  id: number;
  chat: string;
  sessionId: string | null;
  taskId: string | null;
  messageId: string;
  role: string;
  at: number | string | null;
  hits: number;
  lastHitAt: number | string | null;
}

function toTime(value: number | string | null): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function fuseWorkChats(chats: readonly Omit<WorkChatMatch, 'score'>[]): WorkChatMatch[] {
  const recency = new Map(
    [...chats].sort((a, b) => b.lastHitAt - a.lastHitAt).map((chat, rank) => [chat, rank])
  );
  return chats
    .map((chat, relevance) => {
      const fused = 1 / (FUSION_K + relevance + 1) + 1 / (FUSION_K + (recency.get(chat) ?? 0) + 1);
      return { ...chat, score: Math.round(fused * 1e6) / 1e3 };
    })
    .sort((a, b) => b.score - a.score || b.lastHitAt - a.lastHitAt);
}

export function searchWorkChats(
  db: BunDatabase,
  tables: { sessions: boolean; spaceTasks: boolean },
  query: string,
  limit: number
): WorkChatMatch[] {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];
  const policy = messageSearchPolicy(tables);
  const rows = db
    .prepare(
      `WITH matched AS (
         SELECT rowid AS id, bm25(message_search_fts) AS score FROM message_search_fts
          WHERE message_search_fts MATCH ? ORDER BY rowid DESC LIMIT ${MATCH_CAP}
       ),
       hits AS (
         SELECT m.id, m.score, COALESCE(msc.task_id, msc.session_id) AS chat,
           msc.session_id AS sessionId, msc.task_id AS taskId,
           COALESCE(msc.message_id, msc.source_id) AS messageId,
           COALESCE(msc.message_type, msc.kind) AS role, msc.timestamp AS at
         FROM matched m JOIN message_search_content msc ON msc.id = m.id
         ${policy.joins}
         WHERE COALESCE(msc.task_id, msc.session_id) IS NOT NULL
           AND (msc.kind != 'message' OR (1 = 1 ${policy.where}))
       ),
       ranked AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY chat ORDER BY score, at DESC) AS rn,
           COUNT(*) OVER (PARTITION BY chat) AS hits,
           MAX(at) OVER (PARTITION BY chat) AS lastHitAt,
           MIN(score) OVER (PARTITION BY chat) AS best
         FROM hits
       )
       SELECT id, chat, sessionId, taskId, messageId, role, at, hits, lastHitAt FROM ranked
        WHERE rn <= ${SNIPPETS_PER_CHAT}
        ORDER BY best, lastHitAt DESC, chat, rn
        LIMIT ?`
    )
    .all(ftsQuery, limit * SNIPPETS_PER_CHAT) as WorkChatHitRow[];
  if (rows.length === 0) return [];
  const texts = new Map(
    (
      db
        .prepare(
          `SELECT rowid AS id, snippet(message_search_fts, 1, '', '', '…', 16) AS text
             FROM message_search_fts
            WHERE rowid IN (${rows.map(() => '?').join(', ')}) AND message_search_fts MATCH ?`
        )
        .all(...rows.map((row) => row.id), ftsQuery) as Array<{ id: number; text: string | null }>
    ).map((row) => [row.id, row.text ?? ''])
  );
  const chats = new Map<string, Omit<WorkChatMatch, 'score'>>();
  for (const row of rows) {
    const chat = chats.get(row.chat) ?? {
      sessionId: row.sessionId,
      taskId: row.taskId,
      hits: row.hits,
      lastHitAt: toTime(row.lastHitAt),
      snippets: [],
    };
    chat.snippets.push({
      messageId: row.messageId,
      sessionId: row.sessionId,
      role: row.role,
      at: toTime(row.at),
      text: texts.get(row.id) ?? '',
    });
    chats.set(row.chat, chat);
  }
  return fuseWorkChats([...chats.values()]);
}
