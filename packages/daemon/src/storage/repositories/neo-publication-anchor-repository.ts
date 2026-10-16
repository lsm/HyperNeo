import {
  NeoConversationCursorSchema,
  type NeoConversationCursor,
} from './neo-conversation-reader.ts';
import type { Database } from '../sqlite-compat.ts';

export type NeoPublicationAnchor = { cursor: NeoConversationCursor | null; compaction: number };

export class NeoPublicationAnchorRepository {
  constructor(private readonly db: Database) {}

  get(sessionId: string): NeoPublicationAnchor | null {
    const row = this.db
      .prepare(
        'SELECT cursor_json AS cursor, compaction FROM neo_publication_anchors WHERE session_id = ?'
      )
      .get(sessionId) as { cursor: string | null; compaction: number } | null;
    return row
      ? {
          cursor: row.cursor ? NeoConversationCursorSchema.parse(JSON.parse(row.cursor)) : null,
          compaction: row.compaction,
        }
      : null;
  }

  save(sessionId: string, anchor: NeoPublicationAnchor): void {
    this.db
      .prepare(`INSERT INTO neo_publication_anchors(session_id, sequence, compaction, cursor_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET sequence = excluded.sequence,
        compaction = excluded.compaction, cursor_json = excluded.cursor_json`)
      .run(
        sessionId,
        anchor.cursor?.sequence ?? 0,
        anchor.compaction,
        anchor.cursor ? JSON.stringify(anchor.cursor) : null
      );
  }
}
