import type { Database } from '../sqlite-compat.ts';
import type { ArtifactContext } from '../../lib/artifacts/file-policy.ts';

export interface StoredArtifactFile {
  artifact_id: string;
  context_kind: ArtifactContext['kind'];
  context_id: string;
  sha256: string;
  byte_length: number;
  receipt: string;
  producer_ref: string;
  source_path: string;
  created_at: number;
}

export class ArtifactFileReadRepository {
  constructor(private readonly db: Database) {}
  daemonId(): string | null {
    return (
      (
        this.db.prepare('SELECT daemon_id FROM artifact_file_identity').get() as {
          daemon_id: string;
        } | null
      )?.daemon_id ?? null
    );
  }
  get(id: string): StoredArtifactFile | null {
    return this.db
      .prepare('SELECT * FROM artifact_files WHERE artifact_id = ?')
      .get(id) as StoredArtifactFile | null;
  }
  list(context: ArtifactContext, cursor: string | undefined, limit: number) {
    const anchor = cursor ? this.get(cursor) : null;
    if (
      cursor &&
      (!anchor || anchor.context_kind !== context.kind || anchor.context_id !== context.id)
    )
      return null;
    return this.db
      .prepare(`SELECT * FROM artifact_files WHERE context_kind = ?1 AND context_id = ?2
      AND (?3 IS NULL OR (created_at, artifact_id) > (SELECT created_at, artifact_id FROM artifact_files WHERE artifact_id = ?3))
      ORDER BY created_at, artifact_id LIMIT ?4`)
      .all(context.kind, context.id, cursor ?? null, limit) as StoredArtifactFile[];
  }
}
