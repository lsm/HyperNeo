import type { Database as BunDatabase } from './sqlite-compat.ts';

const BODY_CHARS = 16_000;

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

export function readWorkFeedOffsets(db: BunDatabase): Map<string, WorkFeedOffset> {
  return new Map(
    (
      db.prepare('SELECT path, offset, size, mtime FROM work_feed_offsets').all() as Array<
        WorkFeedOffset & { path: string }
      >
    ).map(({ path, ...offset }) => [path, offset])
  );
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
}

export function dropWorkFeedSession(
  db: BunDatabase,
  kind: WorkFeedKind,
  sessionId: string,
  path: string
): void {
  db.transaction(() => {
    db.prepare('DELETE FROM message_search_content WHERE kind = ? AND session_id = ?').run(
      kind,
      sessionId
    );
    db.prepare('DELETE FROM work_feed_offsets WHERE path = ?').run(path);
  })();
}

export function rereadWorkFeedPaths(db: BunDatabase, paths: readonly string[]): void {
  if (paths.length === 0) return;
  db.prepare(
    'UPDATE work_feed_offsets SET offset = 0, size = -1 WHERE path IN (SELECT value FROM json_each(?))'
  ).run(JSON.stringify(paths));
}

export function purgeWorkFeedSessions(
  db: BunDatabase,
  kind: WorkFeedKind,
  sessionIds: readonly string[]
): void {
  if (sessionIds.length === 0) return;
  db.prepare(
    `DELETE FROM message_search_content
      WHERE kind = ? AND session_id IN (SELECT value FROM json_each(?))`
  ).run(kind, JSON.stringify(sessionIds));
}
