import { buildFtsQuery, messageSearchPolicy } from './message-search.ts';
import type { Database as BunDatabase } from './sqlite-compat.ts';

const MATCH_CAP = 2_000;
const SNIPPETS_PER_CHAT = 2;
const FUSION_K = 60;
const VECTOR_SCAN_TURNS = 10_000;
const VECTOR_TOP_TURNS = 200;
const MIN_SIMILARITY = 0.3;
const SEMANTIC_SNIPPET_CHARS = 240;

export interface WorkChatSnippet {
  match: 'exact' | 'semantic';
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

type ChatCandidate = Omit<WorkChatMatch, 'score'>;

function chatKey(chat: ChatCandidate): string {
  return chat.taskId ?? chat.sessionId ?? '';
}

export function fuseWorkChats(
  keyword: readonly ChatCandidate[],
  semantic: readonly ChatCandidate[] = []
): WorkChatMatch[] {
  const lists = [keyword, semantic].map(
    (list) => new Map(list.map((chat, rank) => [chatKey(chat), rank]))
  );
  const union = new Map<string, ChatCandidate>();
  for (const chat of [...semantic, ...keyword]) union.set(chatKey(chat), chat);
  const candidates = [...union.values()];
  const recency = new Map(
    [...candidates].sort((a, b) => b.lastHitAt - a.lastHitAt).map((chat, rank) => [chat, rank])
  );
  return candidates
    .map((chat) => {
      const ranks = [...lists.map((list) => list.get(chatKey(chat))), recency.get(chat)];
      const fused = ranks.reduce<number>(
        (sum, rank) => (rank === undefined ? sum : sum + 1 / (FUSION_K + rank + 1)),
        0
      );
      return { ...chat, score: Math.round(fused * 1e6) / 1e3 };
    })
    .sort(
      (a, b) =>
        Number(lists[0].has(chatKey(b))) - Number(lists[0].has(chatKey(a))) ||
        b.score - a.score ||
        b.lastHitAt - a.lastHitAt
    );
}

function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) return -1;
  let dot = 0;
  let leftSize = 0;
  let rightSize = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftSize += left[index] * left[index];
    rightSize += right[index] * right[index];
  }
  return leftSize === 0 || rightSize === 0 ? -1 : dot / Math.sqrt(leftSize * rightSize);
}

export function vectorWorkChats(
  db: BunDatabase,
  tables: { sessions: boolean; spaceTasks: boolean },
  vector: Float32Array,
  model: string,
  limit: number
): ChatCandidate[] {
  const policy = messageSearchPolicy(tables);
  const scanned = db
    .prepare(
      `SELECT v.content_id AS id, v.embedding FROM (
         SELECT content_id, embedding FROM message_search_vectors
          WHERE model = ? AND dimensions = ? ORDER BY content_id DESC LIMIT ${VECTOR_SCAN_TURNS}
       ) v JOIN message_search_content msc ON msc.id = v.content_id
       ${policy.joins}
       WHERE COALESCE(msc.task_id, msc.session_id) IS NOT NULL
         AND (msc.kind != 'message' OR (1 = 1 ${policy.where}))`
    )
    .all(model, vector.length) as Array<{ id: number; embedding: Uint8Array }>;
  const top = scanned
    .map((row) => {
      const stored = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        Math.floor(row.embedding.byteLength / 4)
      );
      return { id: row.id, similarity: cosine(vector, stored) };
    })
    .filter((row) => row.similarity >= MIN_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, VECTOR_TOP_TURNS);
  if (top.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT id, COALESCE(task_id, session_id) AS chat, session_id AS sessionId, task_id AS taskId,
         COALESCE(message_id, source_id) AS messageId, COALESCE(message_type, kind) AS role,
         timestamp AS at, body FROM message_search_content
        WHERE id IN (${top.map(() => '?').join(', ')})`
    )
    .all(...top.map((row) => row.id)) as Array<
    Omit<WorkChatHitRow, 'hits' | 'lastHitAt'> & { body: string | null }
  >;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const chats = new Map<string, ChatCandidate>();
  for (const { id } of top) {
    const row = byId.get(id);
    if (!row) continue;
    const at = toTime(row.at);
    const chat = chats.get(row.chat) ?? {
      sessionId: row.sessionId,
      taskId: row.taskId,
      hits: 0,
      lastHitAt: 0,
      snippets: [],
    };
    chat.hits += 1;
    chat.lastHitAt = Math.max(chat.lastHitAt, at);
    if (chat.snippets.length < SNIPPETS_PER_CHAT) {
      const body = row.body ?? '';
      chat.snippets.push({
        match: 'semantic',
        messageId: row.messageId,
        sessionId: row.sessionId,
        role: row.role,
        at,
        text:
          body.length > SEMANTIC_SNIPPET_CHARS ? `${body.slice(0, SEMANTIC_SNIPPET_CHARS)}…` : body,
      });
    }
    chats.set(row.chat, chat);
  }
  return [...chats.values()].slice(0, limit);
}

function keywordWorkChats(
  db: BunDatabase,
  tables: { sessions: boolean; spaceTasks: boolean },
  query: string,
  limit: number
): ChatCandidate[] {
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
  const chats = new Map<string, ChatCandidate>();
  for (const row of rows) {
    const chat = chats.get(row.chat) ?? {
      sessionId: row.sessionId,
      taskId: row.taskId,
      hits: row.hits,
      lastHitAt: toTime(row.lastHitAt),
      snippets: [],
    };
    chat.snippets.push({
      match: 'exact',
      messageId: row.messageId,
      sessionId: row.sessionId,
      role: row.role,
      at: toTime(row.at),
      text: texts.get(row.id) ?? '',
    });
    chats.set(row.chat, chat);
  }
  return [...chats.values()];
}

export function searchWorkChats(
  db: BunDatabase,
  tables: { sessions: boolean; spaceTasks: boolean },
  query: string,
  limit: number,
  semantic?: { vector: Float32Array; model: string }
): WorkChatMatch[] {
  const keyword = keywordWorkChats(db, tables, query, limit);
  const similar = semantic
    ? vectorWorkChats(db, tables, semantic.vector, semantic.model, limit)
    : [];
  return fuseWorkChats(keyword, similar).slice(0, limit);
}
