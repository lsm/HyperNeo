import { z } from 'zod';
import { ArtifactReadInputSchema } from '../artifacts/file-contracts.ts';

export const NeoPreviewContextSchema = z.strictObject({
  artifactId: ArtifactReadInputSchema.shape.artifactId,
  snapshot: z.string().regex(/^[a-f0-9]{64}$/),
});
export const NeoPreviewReferenceSchema = NeoPreviewContextSchema.extend({
  displayName: z.string().min(1).max(200),
  state: z.enum(['available', 'unavailable']),
}).strict();
