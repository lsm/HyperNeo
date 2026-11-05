import superpipe, { type PipelineAPI } from 'superpipe';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { ArtifactFileRepository } from './artifact-file-repository.ts';
import {
  ArtifactFileReadRepository,
  type StoredArtifactFile,
} from './artifact-file-read-repository.ts';
import { serializeArtifactReceipt } from './artifact-file-receipt.ts';

type PublicationArgs = Parameters<ArtifactFileRepository['save']>;
type RetainedRow = StoredArtifactFile & { request_id: string; fingerprint: string };
type Receipt = ReturnType<ArtifactFileRepository['save']> & {
  receipt: string;
  createdAt: number;
};

const publish = (superpipe({})('artifact-file-row-publish') as PipelineAPI)
  .input(['db', 'args'])
  .pipe(
    (db: Database, args: PublicationArgs) =>
      new ArtifactFileRepository(db, args[4].daemonId).save(...args),
    ['db', 'args'],
    'saved'
  )
  .pipe(
    (db: Database, args: PublicationArgs) =>
      new ArtifactFileReadRepository(db).get(args[4].artifactId) as RetainedRow | null,
    ['db', 'args'],
    'row'
  )
  .pipe(
    (
      args: PublicationArgs,
      saved: ReturnType<ArtifactFileRepository['save']>,
      row: RetainedRow | null
    ) => {
      const receipt = serializeArtifactReceipt(args[4], args[7], args[8], args[9]);
      if (
        !row ||
        row.artifact_id !== args[4].artifactId ||
        row.context_kind !== args[0].kind ||
        row.context_id !== args[0].id ||
        row.request_id !== args[1] ||
        row.fingerprint !== args[2] ||
        row.sha256 !== args[3] ||
        row.byte_length !== args[4].byteLength ||
        row.receipt !== receipt ||
        row.producer_ref !== args[5] ||
        row.source_path !== args[6]
      )
        throw new Error('Artifact publication receipt mismatch');
      return { ...saved, receipt: row.receipt, createdAt: row.created_at };
    },
    ['args', 'saved', 'row'],
    'receipt'
  )
  .end('receipt') as (db: Database, args: PublicationArgs) => Receipt;

class ArtifactFileRowWriter {
  constructor(private readonly db: Database) {}

  publish(...args: PublicationArgs) {
    return publish(this.db, args);
  }
}

export const artifactFileRowWrites = defineRepositoryOp(
  'artifact.file.row.write',
  'write',
  ArtifactFileRowWriter,
  ['publish'] as const
);
