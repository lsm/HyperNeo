import type { Database } from '../sqlite-compat.ts';

export type NeoPublicationAnchor = { sequence: number; compaction: number };

export class NeoPublicationAnchorRepository {
  constructor(private readonly db: Database) {}

  get(sessionId: string): NeoPublicationAnchor | null {
    return (
      (this.db
        .prepare('SELECT sequence, compaction FROM neo_publication_anchors WHERE session_id = ?')
        .get(sessionId) as NeoPublicationAnchor | undefined) ?? null
    );
  }

  save(sessionId: string, anchor: NeoPublicationAnchor): void {
    this.db
      .prepare(
        `INSERT INTO neo_publication_anchors(session_id, sequence, compaction) VALUES (?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET sequence = excluded.sequence,
            compaction = excluded.compaction`
      )
      .run(sessionId, anchor.sequence, anchor.compaction);
  }
}
