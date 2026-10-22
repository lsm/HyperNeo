import {
  ARTIFACT_DEFAULT_LIMITS,
  type ArtifactRefusal,
} from '@hyperneo/shared/types/artifact-file';
import { z } from 'zod';
import type { Database } from '../../storage/sqlite-compat.ts';
import {
  ArtifactFileReadRepository,
  type StoredArtifactFile,
} from '../../storage/repositories/artifact-file-read-repository.ts';
import type { ArtifactContext } from './file-policy.ts';

const alias = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !/[\\\u0000-\u001f\u007f:%?#]/.test(path) &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
export const ArtifactBundleSchema = z
  .array(
    z.strictObject({
      path: alias,
      artifactId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/),
    })
  )
  .min(1)
  .max(ARTIFACT_DEFAULT_LIMITS.bundleEntries - 1)
  .refine((entries) => new Set(entries.map((entry) => entry.path)).size === entries.length);
export type ArtifactBundleEntry = z.infer<typeof ArtifactBundleSchema>[number];
export interface BoundBundleAsset {
  readonly path: string;
  readonly row: StoredArtifactFile;
  readonly mediaType: string;
}

export function bindArtifactBundle(
  db: Database,
  context: ArtifactContext,
  entries: readonly ArtifactBundleEntry[]
): { value: BoundBundleAsset[] } | { reason: ArtifactRefusal } {
  const repo = new ArtifactFileReadRepository(db);
  const assets: BoundBundleAsset[] = [];
  for (const entry of entries) {
    const row = repo.get(entry.artifactId);
    if (!row || row.context_kind !== context.kind || row.context_id !== context.id)
      return { reason: { accepted: false as const, reason: 'unavailable' as const } };
    const kind = JSON.parse(row.receipt).artifact.kind;
    const extension = row.source_path.split('.').at(-1)?.toLowerCase() ?? '';
    const mediaType =
      kind === 'text' && extension === 'css'
        ? 'text/css'
        : kind === 'image'
          ? (
              {
                png: 'image/png',
                jpg: 'image/jpeg',
                jpeg: 'image/jpeg',
                gif: 'image/gif',
                webp: 'image/webp',
              } as Record<string, string>
            )[extension]
          : undefined;
    if (!mediaType)
      return { reason: { accepted: false as const, reason: 'unsupported_type' as const } };
    assets.push({ path: entry.path, row, mediaType });
  }
  return { value: assets };
}

export function artifactBundleLimit(
  documentBytes: number,
  assets: readonly { row: Pick<StoredArtifactFile, 'byte_length'> }[],
  limit = ARTIFACT_DEFAULT_LIMITS.bundleBytes
): ArtifactRefusal | null {
  return assets.reduce((total, asset) => total + asset.row.byte_length, documentBytes) > limit
    ? { accepted: false, reason: 'size_limit' }
    : null;
}
