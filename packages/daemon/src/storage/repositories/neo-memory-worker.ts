import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { admitVectorHits, cosineSimilarity } from '../vector-similarity.ts';

export interface NeoMemory {
  key: string;
  content: string;
  createdBySession: string | null;
  createdAt: number;
  updatedAt: number;
}

interface NeoMemoryRow {
  key: string;
  content: string;
  created_by_session: string | null;
  created_at: number;
  updated_at: number;
}

interface NeoMemoryVectorRow extends NeoMemoryRow {
  embedding: Uint8Array;
}

const VECTOR_FILL_LIMIT = 25;
const STOPWORDS = new Set(
  (
    'about above after again all also and any are because been before being below between both ' +
    'but can could did does doing down during each few for from further had has have having her ' +
    'here hers him his how into its just more most nor not now off once only other our ours out ' +
    'over own same she should some such than that the their theirs them then there these they ' +
    'this those through too under until very was were what when where which while who whom why ' +
    'will with would you your yours'
  ).split(' ')
);
const MAX_QUERY_CHARS = 2_000;
const MAX_QUERY_TERMS = 64;
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

export function buildMemoryFtsQuery(query: string): string | null {
  const terms = new Set<string>();
  const half = MAX_QUERY_CHARS / 2;
  const text =
    query.length > MAX_QUERY_CHARS ? `${query.slice(0, half)} ${query.slice(-half)}` : query;
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}_./:-]+/u)) {
    for (const run of word.match(CJK_RUN) ?? []) {
      for (let at = 0; at + 3 <= run.length; at++) terms.add(run.slice(at, at + 3));
    }
    for (const raw of word.replace(CJK_RUN, ' ').split(' ')) {
      const part = raw.replace(/^[_./:-]+|[_./:-]+$/g, '');
      if (part.length >= 3 && !STOPWORDS.has(part)) terms.add(part);
    }
  }
  if (terms.size === 0) return null;
  const all = [...terms];
  const kept =
    all.length > MAX_QUERY_TERMS
      ? [...all.slice(0, MAX_QUERY_TERMS / 2), ...all.slice(-MAX_QUERY_TERMS / 2)]
      : all;
  return kept.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

function toMemory(row: NeoMemoryRow): NeoMemory {
  return {
    key: row.key,
    content: row.content,
    createdBySession: row.created_by_session,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class NeoMemoryRows {
  constructor(private readonly db: Database) {}

  save(input: { key: string; content: string; sessionId?: string }): NeoMemory {
    const now = Date.now();
    return toMemory(
      this.db
        .prepare(
          `INSERT INTO neo_memories (key, content, created_by_session, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at,
             embedding = CASE WHEN content = excluded.content THEN embedding END
           RETURNING key, content, created_by_session, created_at, updated_at`
        )
        .get(
          input.key.trim(),
          input.content.trim(),
          input.sessionId ?? null,
          now,
          now
        ) as NeoMemoryRow
    );
  }

  read(key: string): NeoMemory | null {
    const row = this.db.prepare(`SELECT * FROM neo_memories WHERE key = ?`).get(key.trim()) as
      | NeoMemoryRow
      | undefined;
    return row ? toMemory(row) : null;
  }

  delete(key: string): boolean {
    return this.db.prepare(`DELETE FROM neo_memories WHERE key = ?`).run(key.trim()).changes > 0;
  }

  unembedded(model: string): Array<{ id: number; text: string; content: string }> {
    return this.db
      .prepare(
        `SELECT id, key || char(10) || content AS text, content FROM neo_memories
         WHERE embedding IS NULL OR embedding_model IS NOT ? ORDER BY id LIMIT ?`
      )
      .all(model, VECTOR_FILL_LIMIT) as Array<{ id: number; text: string; content: string }>;
  }

  storeVector(id: number, content: string, model: string, vector: Float32Array): void {
    this.db
      .prepare(
        `UPDATE neo_memories SET embedding = ?, embedding_model = ? WHERE id = ? AND content = ?`
      )
      .run(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), model, id, content);
  }

  searchVector(query: Float32Array, model: string, limit: number): NeoMemory[] {
    const rows = this.db
      .prepare(`SELECT * FROM neo_memories WHERE embedding IS NOT NULL AND embedding_model = ?`)
      .all(model) as NeoMemoryVectorRow[];
    const ranked = rows
      .map((row) => ({
        row,
        rank:
          cosineSimilarity(query, new Float32Array(Uint8Array.from(row.embedding).buffer)) ??
          Number.NEGATIVE_INFINITY,
      }))
      .sort((a, b) => b.rank - a.rank || b.row.updated_at - a.row.updated_at);
    return admitVectorHits(ranked)
      .slice(0, limit)
      .map((item) => toMemory(item.row));
  }

  search(query: string, limit: number): NeoMemory[] {
    const match = buildMemoryFtsQuery(query);
    if (!match) return [];
    return (
      this.db
        .prepare(
          `SELECT m.* FROM neo_memories_fts
           JOIN neo_memories m ON m.id = neo_memories_fts.rowid
           WHERE neo_memories_fts MATCH ?
           ORDER BY bm25(neo_memories_fts), m.updated_at DESC, m.key
           LIMIT ?`
        )
        .all(match, limit) as NeoMemoryRow[]
    ).map(toMemory);
  }
}

export const neoMemoryReads = defineRepositoryOp('neo_memories.read', 'read', NeoMemoryRows, [
  'read',
  'search',
  'searchVector',
  'unembedded',
]);
export const neoMemoryWrites = defineRepositoryOp('neo_memories.write', 'write', NeoMemoryRows, [
  'save',
  'delete',
  'storeVector',
]);
