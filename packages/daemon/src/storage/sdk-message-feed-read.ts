import type { Database } from './sqlite-compat.ts';
import { hashRows, type LiveQueryEvaluation } from './live-query.ts';
import { expandSessionMessages } from '../lib/live-query/queries/message-children.ts';
import {
  MESSAGES_BY_SESSION_SQL,
  BACKGROUND_TASK_METADATA_SQL,
  mapMessageRow,
  mapThinMessageRow,
  messageRowFingerprint,
} from '../lib/live-query/queries/messages.ts';

export type MessageFeedArgs = { feed: 'full' | 'compact'; sessionId: string; limit: number };

export function readMessageFeed(db: Database, args: MessageFeedArgs): LiveQueryEvaluation {
  const { sessionId, limit, feed } = args;
  if (!db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId))
    throw new Error(`Unauthorized: session "${sessionId}" not found`);
  const rows = expandSessionMessages(
    db.prepare(MESSAGES_BY_SESSION_SQL).all(sessionId, limit) as Record<string, unknown>[],
    [sessionId, limit],
    db
  );
  const hashes = hashRows(rows, messageRowFingerprint);
  const map = feed === 'compact' ? mapThinMessageRow : mapMessageRow;
  const metadata = db
    .prepare(BACKGROUND_TASK_METADATA_SQL)
    .all(sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId) as Record<
    string,
    unknown
  >[];
  return {
    rows: rows.map(map),
    hashes: { hash: hashes.hash, rowHashes: hashes.rowHashes ? [...hashes.rowHashes] : null },
    metadata: { backgroundTaskMessages: metadata.map(map).reverse() },
  };
}
