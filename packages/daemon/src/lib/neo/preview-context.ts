import type {
  NeoPreviewContext,
  NeoPreviewReference,
} from '@hyperneo/shared/types/neo-preview-context';
import type { Database } from '../../storage/sqlite-compat.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { z } from 'zod';
import { createArtifactReadOperations } from '../artifacts/read-operations.ts';
import {
  ArtifactFileMetadataSchema,
  ArtifactReadInputSchema,
} from '../artifacts/file-contracts.ts';

export const NeoPreviewContextSchema = z.strictObject({
  artifactId: ArtifactReadInputSchema.shape.artifactId,
  snapshot: z.string().regex(/^[a-f0-9]{64}$/),
});
export const NeoPreviewReferenceSchema = NeoPreviewContextSchema.extend({
  displayName: z.string().min(1).max(200),
  state: z.enum(['available', 'unavailable']),
}).strict();
const Metadata = z.object({ accepted: z.literal(true), metadata: ArtifactFileMetadataSchema });

async function readReference(
  context: NeoPreviewContext & { displayName?: string },
  db: Database,
  caller: OperationCaller
): Promise<NeoPreviewReference> {
  const get = createArtifactReadOperations(() => db).find(
    (entry) => entry.name === 'artifact.file.get'
  )!;
  const parsed = Metadata.safeParse(await get.execute({ artifactId: context.artifactId }, caller));
  const available = parsed.success && parsed.data.metadata.sha256 === context.snapshot;
  return {
    artifactId: context.artifactId,
    snapshot: context.snapshot,
    displayName: available ? parsed.data.metadata.artifact.title : (context.displayName ?? 'File'),
    state: available ? 'available' : 'unavailable',
  };
}

export async function admitNeoPreviewContext(
  context: NeoPreviewContext | undefined,
  stored: NeoPreviewReference | undefined,
  db: Database,
  caller: OperationCaller
): Promise<{ value: NeoPreviewReference | null } | { reason: { ok: false; reason: string } }> {
  if (!context) return { value: null };
  if (stored?.artifactId === context.artifactId && stored.snapshot === context.snapshot)
    return { value: stored };
  const reference = await readReference(context, db, caller);
  return reference.state === 'available'
    ? { value: reference }
    : { reason: { ok: false, reason: 'This Preview snapshot is no longer available.' } };
}

export async function presentNeoPreviewAsk<T extends { previewContext?: NeoPreviewReference }>(
  ask: T,
  db: Database,
  caller: OperationCaller
): Promise<T> {
  return ask.previewContext
    ? { ...ask, previewContext: await readReference(ask.previewContext, db, caller) }
    : ask;
}
