import type { DbGateway } from './db-gateway/db-gateway.ts';
import { defineDbOp } from './db-gateway/db-op.ts';
import type { Database as BunDatabase } from './sqlite-compat.ts';

const BODY_CHARS = 16_000;
const DELETE_BATCH_ROWS = 64;

export type WorkFeedKind = 'codex' | 'claude';

export interface WorkFeedTurn {
  sourceId: string;
  messageId: string;
  sessionId: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

export interface WorkFeedOffset {
  offset: number;
  size: number;
  mtime: number;
}

const feedOffsets = new WeakMap<BunDatabase, Map<string, WorkFeedOffset>>();

function knownWorkFeedOffsets(db: BunDatabase): Map<string, WorkFeedOffset> {
  let known = feedOffsets.get(db);
  if (!known) {
    known = new Map(
      (
        db.prepare('SELECT path, offset, size, mtime FROM work_feed_offsets').all() as Array<
          WorkFeedOffset & { path: string }
        >
      ).map(({ path, ...offset }) => [path, Object.freeze(offset)])
    );
    feedOffsets.set(db, known);
  }
  return known;
}

export function readWorkFeedOffsets(db: BunDatabase): Map<string, WorkFeedOffset> {
  return new Map(knownWorkFeedOffsets(db));
}

export function saveWorkFeedChunk(
  db: BunDatabase,
  kind: WorkFeedKind,
  title: string,
  turns: readonly WorkFeedTurn[],
  path: string,
  offset: WorkFeedOffset
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO message_search_content
       (kind, source_id, message_id, session_id, message_type, title, body, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const mark = db.prepare(
    `INSERT INTO work_feed_offsets (path, offset, size, mtime) VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, size = excluded.size,
       mtime = excluded.mtime`
  );
  db.transaction(() => {
    for (const turn of turns)
      insert.run(
        kind,
        turn.sourceId,
        turn.messageId,
        turn.sessionId,
        turn.role,
        title,
        turn.text.slice(0, BODY_CHARS),
        turn.at
      );
    mark.run(path, offset.offset, offset.size, offset.mtime);
  })();
  knownWorkFeedOffsets(db).set(path, Object.freeze({ ...offset }));
}

export const deleteWorkFeedBatch = defineDbOp({
  name: 'workFeed.deleteBatch',
  mode: 'write',
  run: (db: BunDatabase, { kind, sessions }: { kind: WorkFeedKind; sessions: string }): number =>
    db
      .prepare(
        `DELETE FROM message_search_content WHERE id IN (
           SELECT id FROM message_search_content INDEXED BY idx_message_search_content_feed_turns
           WHERE kind IN ('codex', 'claude') AND kind = ?
             AND session_id IN (SELECT value FROM json_each(?)) LIMIT ${DELETE_BATCH_ROWS}
         )`
      )
      .run(kind, sessions).changes,
});

export async function deleteWorkFeedSessions(
  db: BunDatabase,
  kind: WorkFeedKind,
  sessionIds: readonly string[]
): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const sessions = JSON.stringify(sessionIds);
  let total = 0;
  for (;;) {
    const changed = deleteWorkFeedBatch.run(db, { kind, sessions });
    if (changed === 0) return total;
    total += changed;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export async function dropWorkFeedSession(
  db: BunDatabase,
  kind: WorkFeedKind,
  sessionId: string,
  path: string
): Promise<number> {
  const dropped = await deleteWorkFeedSessions(db, kind, [sessionId]);
  db.prepare('DELETE FROM work_feed_offsets WHERE path = ?').run(path);
  knownWorkFeedOffsets(db).delete(path);
  return dropped;
}

export function rereadWorkFeedPaths(db: BunDatabase, paths: readonly string[]): void {
  if (paths.length === 0) return;
  db.prepare(
    'UPDATE work_feed_offsets SET offset = 0, size = -1 WHERE path IN (SELECT value FROM json_each(?))'
  ).run(JSON.stringify(paths));
  const known = knownWorkFeedOffsets(db);
  for (const path of paths) {
    const offset = known.get(path);
    if (offset) known.set(path, Object.freeze({ ...offset, offset: 0, size: -1 }));
  }
}

export async function purgeWorkFeedSessions(
  db: DbGateway,
  kind: WorkFeedKind,
  sessionIds: readonly string[]
): Promise<void> {
  if (sessionIds.length === 0) return;
  const sessions = JSON.stringify(sessionIds);
  for (;;) if ((await db.run(deleteWorkFeedBatch, { kind, sessions })) === 0) return;
}
