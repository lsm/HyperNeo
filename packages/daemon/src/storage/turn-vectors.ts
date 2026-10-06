import type { Database as BunDatabase } from './sqlite-compat.ts';

const MIN_TURN_CHARS = 20;
const TURN_EMBED_CHARS = 2_000;
const ELIGIBLE_TURN = `kind IN ('message', 'codex', 'claude') AND message_type IN ('user', 'assistant')
  AND length(body) >= ${MIN_TURN_CHARS}`;

export interface PendingTurn {
  id: number;
  text: string;
  bodyLength: number;
}

function embeddedRange(
  db: BunDatabase,
  model: string,
  dimensions: number
): { low: number | null; high: number | null } {
  return db
    .prepare(
      `SELECT MIN(content_id) AS low, MAX(content_id) AS high FROM message_search_vectors
        WHERE model = ? AND dimensions = ?`
    )
    .get(model, dimensions) as { low: number | null; high: number | null };
}

export function readPendingTurns(
  db: BunDatabase,
  model: string,
  dimensions: number,
  limit: number
): PendingTurn[] {
  const select = `SELECT id, substr(body, 1, ${TURN_EMBED_CHARS}) AS text, length(body) AS bodyLength
    FROM message_search_content WHERE ${ELIGIBLE_TURN}`;
  const { low, high } = embeddedRange(db, model, dimensions);
  if (high === null || low === null) {
    return db.prepare(`${select} ORDER BY id DESC LIMIT ?`).all(limit) as PendingTurn[];
  }
  const fresh = db
    .prepare(`${select} AND id > ? ORDER BY id ASC LIMIT ?`)
    .all(high, limit) as PendingTurn[];
  if (fresh.length > 0) return fresh;
  return db
    .prepare(`${select} AND id < ? ORDER BY id DESC LIMIT ?`)
    .all(low, limit) as PendingTurn[];
}

export function countPendingTurns(db: BunDatabase, model: string, dimensions: number): number {
  const { low, high } = embeddedRange(db, model, dimensions);
  const where = low === null || high === null ? '' : 'AND (id > ? OR id < ?)';
  const bounds = low === null || high === null ? [] : [high, low];
  const row = db
    .prepare(
      `SELECT COUNT(*) AS pending FROM message_search_content WHERE ${ELIGIBLE_TURN} ${where}`
    )
    .get(...bounds) as { pending: number } | undefined;
  return row?.pending ?? 0;
}

export function saveTurnVector(
  db: BunDatabase,
  turn: Pick<PendingTurn, 'id' | 'bodyLength'>,
  model: string,
  vector: Float32Array,
  now: number
): void {
  db.prepare(
    `INSERT INTO message_search_vectors (content_id, model, dimensions, embedding, embedded_at)
     SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM message_search_content WHERE id = ? AND length(body) = ?)
     ON CONFLICT(content_id) DO UPDATE SET model = excluded.model,
       dimensions = excluded.dimensions, embedding = excluded.embedding,
       embedded_at = excluded.embedded_at`
  ).run(
    turn.id,
    model,
    vector.length,
    Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
    now,
    turn.id,
    turn.bodyLength
  );
}
