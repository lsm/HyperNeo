import { randomUUID } from 'node:crypto';
import type { ArtifactBundleEntry } from '../../lib/artifacts/bundle.ts';
import type { ArtifactRef, ArtifactFileMetadata } from '@hyperneo/shared/types/artifact-file';
import type { Database } from '../sqlite-compat.ts';
import type { ArtifactContext } from '../../lib/artifacts/file-policy.ts';

export class ArtifactFileRepository {
  readonly daemonId: string;
  constructor(private readonly db: Database) {
    db.prepare('INSERT OR IGNORE INTO artifact_file_identity VALUES (1, ?)').run(randomUUID());
    this.daemonId = (
      db.prepare('SELECT daemon_id FROM artifact_file_identity').get() as { daemon_id: string }
    ).daemon_id;
  }
  receipt(context: ArtifactContext, requestId: string) {
    return this.db
      .prepare(`SELECT fingerprint, sha256, receipt FROM artifact_files
      WHERE context_kind = ? AND context_id = ?
      AND (request_id = ? OR json_extract(receipt, '$.requestId') = ?)
      ORDER BY rowid DESC LIMIT 1`)
      .get(context.kind, context.id, requestId, requestId) as {
      fingerprint: string;
      sha256: string;
      receipt: string;
    } | null;
  }
  save(
    context: ArtifactContext,
    requestId: string,
    fingerprint: string,
    sha256: string,
    artifact: ArtifactRef,
    producer: string,
    sourcePath: string,
    revision?: ArtifactFileMetadata['revision'],
    bundle?: readonly ArtifactBundleEntry[],
    logicalRequestId?: string
  ) {
    this.db.prepare(`INSERT INTO artifact_files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      artifact.artifactId,
      context.kind,
      context.id,
      requestId,
      fingerprint,
      sha256,
      artifact.byteLength,
      JSON.stringify({
        accepted: true,
        ...(logicalRequestId ? { requestId: logicalRequestId } : {}),
        artifact,
        ...(revision ? { revision } : {}),
        ...(bundle ? { bundle } : {}),
      }),
      producer,
      sourcePath,
      Date.now()
    );
    return { accepted: true as const, artifact };
  }
}
