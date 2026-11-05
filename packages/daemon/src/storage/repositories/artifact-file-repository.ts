import { serializeArtifactReceipt } from './artifact-file-receipt.ts';
import { ensureArtifactFileIdentity } from './artifact-file-identity.ts';
import type { ArtifactBundleEntry } from '../../lib/artifacts/bundle.ts';
import type { ArtifactRef, ArtifactFileMetadata } from '@hyperneo/shared/types/artifact-file';
import type { Database } from '../sqlite-compat.ts';
import type { ArtifactContext } from '../../lib/artifacts/file-policy.ts';

export class ArtifactFileRepository {
  readonly daemonId: string;
  constructor(
    private readonly db: Database,
    committedDaemonId?: string
  ) {
    this.daemonId = committedDaemonId ?? ensureArtifactFileIdentity(db);
  }
  receipt(context: ArtifactContext, requestId: string) {
    return this.db
      .prepare(`SELECT fingerprint, sha256, receipt, producer_ref FROM artifact_files
      WHERE context_kind = ? AND context_id = ?
      AND (request_id = ? OR json_extract(receipt, '$.requestId') = ?)
      ORDER BY rowid DESC LIMIT 1`)
      .get(context.kind, context.id, requestId, requestId) as {
      fingerprint: string;
      sha256: string;
      receipt: string;
      producer_ref: string;
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
    this.db
      .prepare(`INSERT INTO artifact_files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        artifact.artifactId,
        context.kind,
        context.id,
        requestId,
        fingerprint,
        sha256,
        artifact.byteLength,
        serializeArtifactReceipt(artifact, revision, bundle, logicalRequestId),
        producer,
        sourcePath,
        Date.now()
      );
    return { accepted: true as const, artifact };
  }
}
