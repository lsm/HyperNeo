import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { ensureArtifactFileIdentity } from './artifact-file-identity.ts';

class ArtifactIdentityWriter {
  constructor(private readonly db: Database) {}

  ensure(candidateId: string) {
    return ensureArtifactFileIdentity(this.db, candidateId);
  }
}

export const artifactIdentityWrites = defineRepositoryOp(
  'artifact.identity.ensure.write',
  'write',
  ArtifactIdentityWriter,
  ['ensure'] as const
);
