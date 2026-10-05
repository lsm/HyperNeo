import type { Database as BunDatabase } from './sqlite-compat.ts';

const MIN_TURN_CHARS = 20;
const TURN_EMBED_CHARS = 2_000;

export interface PendingTurn {
  id: number;
  text: string;
}

export function readPendingTurns(
  db: BunDatabase,
  model: string,
  dimensions: number,
  limit: number
): PendingTurn[] {
  const rows = db
    .prepare(
      `SELECT msc.id, msc.body AS text FROM message_search_content msc
         LEFT JOIN message_search_vectors v ON v.content_id = msc.id
        WHERE msc.kind = 'message' AND length(msc.body) >= ${MIN_TURN_CHARS}
          AND (v.content_id IS NULL OR v.model != ? OR v.dimensions != ?)
        ORDER BY msc.id DESC LIMIT ?`
    )
    .all(model, dimensions, limit) as Array<{ id: number; text: string }>;
  return rows.map((row) => ({ id: row.id, text: row.text.slice(0, TURN_EMBED_CHARS) }));
}

export function saveTurnVector(
  db: BunDatabase,
  id: number,
  model: string,
  vector: Float32Array,
  now: number
): void {
  db.prepare(
    `INSERT INTO message_search_vectors (content_id, model, dimensions, embedding, embedded_at)
     SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM message_search_content WHERE id = ?)
     ON CONFLICT(content_id) DO UPDATE SET model = excluded.model,
       dimensions = excluded.dimensions, embedding = excluded.embedding,
       embedded_at = excluded.embedded_at`
  ).run(
    id,
    model,
    vector.length,
    Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
    now,
    id
  );
}
