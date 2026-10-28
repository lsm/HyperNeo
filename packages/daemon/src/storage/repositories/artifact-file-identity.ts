import { randomUUID } from 'node:crypto';
import type { Database } from '../sqlite-compat.ts';

export function ensureArtifactFileIdentity(db: Database, candidateId?: string): string {
  db.prepare('INSERT OR IGNORE INTO artifact_file_identity VALUES (1, ?)').run(
    candidateId ?? randomUUID()
  );
  return (db.prepare('SELECT daemon_id FROM artifact_file_identity').get() as { daemon_id: string })
    .daemon_id;
}
