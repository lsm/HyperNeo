import {
  ARTIFACT_DEFAULT_LIMITS,
  ARTIFACT_KINDS,
  ARTIFACT_REFUSALS,
  type ArtifactLimits,
  type ArtifactFileMetadata,
  type ArtifactProjection,
  type ArtifactReadResult,
  type ArtifactRef,
  type ArtifactRefusal,
} from '@hyperneo/shared/types/artifact-file';
import { z } from 'zod';

const byteCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const artifactId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/);

const positiveCount = byteCount.min(1);
const limits = ARTIFACT_DEFAULT_LIMITS;

export const ArtifactLimitsSchema: z.ZodType<ArtifactLimits> = z.strictObject({
  artifactBytes: positiveCount.default(limits.artifactBytes),
  documentPreviewBytes: positiveCount.default(limits.documentPreviewBytes),
  textPreviewBytes: positiveCount.default(limits.textPreviewBytes),
  imageBytes: positiveCount.default(limits.imageBytes),
  imagePixels: positiveCount.default(limits.imagePixels),
  retainedBytes: positiveCount.default(limits.retainedBytes),
  warningRatio: z.number().gt(0).max(1).default(limits.warningRatio),
  readBytes: positiveCount.max(limits.readBytes).default(limits.readBytes),
  bundleEntries: positiveCount.default(limits.bundleEntries),
  bundleBytes: positiveCount.default(limits.bundleBytes),
});

export const ArtifactRefSchema: z.ZodType<ArtifactRef> = z.strictObject({
  daemonId: z.uuid(),
  artifactId,
  title: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => !!value.trim()),
  kind: z.enum(ARTIFACT_KINDS),
  byteLength: byteCount,
});

export const ArtifactProjectionSchema: z.ZodType<ArtifactProjection> = z.strictObject({
  artifacts: z.array(ArtifactRefSchema).max(16).optional(),
});

export const ArtifactRefusalSchema: z.ZodType<ArtifactRefusal> = z.strictObject({
  accepted: z.literal(false),
  reason: z.enum(ARTIFACT_REFUSALS),
});

export const ArtifactReadInputSchema = z.strictObject({
  artifactId,
  offset: byteCount.default(0),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(ARTIFACT_DEFAULT_LIMITS.readBytes)
    .default(ARTIFACT_DEFAULT_LIMITS.readBytes),
});

const chunk = z
  .string()
  .max(4 * Math.ceil(ARTIFACT_DEFAULT_LIMITS.readBytes / 3))
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine((data) => {
    try {
      return atob(data).length <= ARTIFACT_DEFAULT_LIMITS.readBytes;
    } catch {
      return false;
    }
  });

export const ArtifactReadResultSchema: z.ZodType<ArtifactReadResult> = z.union([
  ArtifactRefusalSchema,
  z
    .strictObject({
      accepted: z.literal(true),
      data: chunk,
      nextOffset: byteCount,
      byteLength: byteCount,
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      complete: z.boolean(),
    })
    .refine(
      (value) =>
        value.nextOffset <= value.byteLength &&
        value.complete === (value.nextOffset === value.byteLength)
    ),
]);

export const ArtifactFileMetadataSchema: z.ZodType<ArtifactFileMetadata> = z.strictObject({
  context: z.strictObject({ kind: z.enum(['todo', 'ask']), id: z.string().min(1).max(200) }),
  artifact: ArtifactRefSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: byteCount,
  sourcePath: z.string(),
  producer: z.strictObject({ adapter: z.string().min(1), id: z.string().min(1) }),
});
