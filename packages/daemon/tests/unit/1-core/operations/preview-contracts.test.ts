import { describe, expect, test } from 'bun:test';
import type { ArtifactRef } from '@hyperneo/shared/types/artifact-file';
import type { NeoPublicationArtifactInput } from '@hyperneo/shared/types/neo-publication';
import type { NeoTodoArtifactProjection } from '@hyperneo/shared/types/neo-ask';
import { ARTIFACT_DEFAULT_LIMITS, ARTIFACT_REFUSALS } from '@hyperneo/shared/types/artifact-file';
import {
  ArtifactLimitsSchema,
  ArtifactRefSchema,
  ArtifactProjectionSchema,
  ArtifactRefusalSchema,
  ArtifactReadInputSchema,
  ArtifactReadResultSchema,
} from '../../../../src/lib/artifacts/file-contracts.ts';

const reference: ArtifactRef = {
  daemonId: '56a723f9-7f02-4adf-90ea-34e4f9709376',
  artifactId: 'synthetic-immutable-id',
  title: 'Synthetic report 🦊',
  kind: 'markdown',
  byteLength: 42,
};

describe('artifact file contracts', () => {
  test('keeps optional publication/card references backward compatible', () => {
    const publication: Pick<NeoPublicationArtifactInput, 'artifacts'> = { artifacts: [reference] };
    const card: Pick<NeoTodoArtifactProjection, 'artifacts'> = {};
    expect(ArtifactRefSchema.parse(reference)).toEqual(reference);
    expect(ArtifactProjectionSchema.parse(publication)).toEqual(publication);
    expect(ArtifactProjectionSchema.parse(card)).toEqual({});
    expect(
      ArtifactProjectionSchema.safeParse({ artifacts: [{ ...reference, title: '' }] }).success
    ).toBe(false);
  });
  test.each(['path', 'token', 'url', 'ownerId'])('rejects extra authority field %s', (key) => {
    expect(ArtifactRefSchema.safeParse({ ...reference, [key]: 'synthetic' }).success).toBe(false);
  });
  test.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    'rejects byte count %s',
    (byteLength) => {
      expect(ArtifactRefSchema.safeParse({ ...reference, byteLength }).success).toBe(false);
    }
  );
  test('rejects malformed display hints without coercing values', () => {
    for (const patch of [
      { daemonId: 'not-a-daemon' },
      { artifactId: '../report' },
      { artifactId: '' },
      { title: '   ' },
      { kind: 'javascript' },
      { byteLength: '42' },
    ]) {
      expect(ArtifactRefSchema.safeParse({ ...reference, ...patch }).success).toBe(false);
    }
    expect(
      ArtifactProjectionSchema.safeParse({ artifacts: Array(17).fill(reference) }).success
    ).toBe(false);
    expect(
      ArtifactReadResultSchema.safeParse({
        accepted: true,
        data: '',
        nextOffset: 0,
        byteLength: 0,
        sha256: 'a'.repeat(64),
        complete: true,
      }).success
    ).toBe(true);
  });
  test('pins defaults without limiting metadata for human-adjusted policies', () => {
    expect(ARTIFACT_DEFAULT_LIMITS).toEqual({
      artifactBytes: 64 * 1024 * 1024,
      documentPreviewBytes: 2 * 1024 * 1024,
      textPreviewBytes: 256 * 1024,
      imageBytes: 32 * 1024 * 1024,
      imagePixels: 16_000_000,
      retainedBytes: 10 * 1024 * 1024 * 1024,
      warningRatio: 0.8,
      readBytes: 256 * 1024,
      bundleEntries: 64,
      bundleBytes: 64 * 1024 * 1024,
    });
    expect(
      ArtifactRefSchema.safeParse({ ...reference, byteLength: 128 * 1024 * 1024 }).success
    ).toBe(true);
  });
  test('validates human policy defaults while retaining the hard transport ceiling', () => {
    expect(ArtifactLimitsSchema.parse({})).toEqual(ARTIFACT_DEFAULT_LIMITS);
    expect(ArtifactLimitsSchema.parse({ artifactBytes: 128 * 1024 * 1024 }).artifactBytes).toBe(
      128 * 1024 * 1024
    );
    for (const input of [
      { artifactBytes: -1 },
      { retainedBytes: 0 },
      { warningRatio: 1.1 },
      { readBytes: 256 * 1024 + 1 },
      { token: 'synthetic' },
    ]) {
      expect(ArtifactLimitsSchema.safeParse(input).success).toBe(false);
    }
  });

  test('accepts typed refusals without path or existence detail', () => {
    for (const reason of ARTIFACT_REFUSALS) {
      expect(ArtifactRefusalSchema.parse({ accepted: false, reason })).toEqual({
        accepted: false,
        reason,
      });
    }
    expect(ArtifactRefusalSchema.safeParse({ accepted: false, reason: 'not_found' }).success).toBe(
      false
    );
    expect(
      ArtifactRefusalSchema.safeParse({
        accepted: false,
        reason: 'unavailable',
        path: '/synthetic',
      }).success
    ).toBe(false);
  });
  test('bounds read requests and decoded bytes at base64 padding edges', () => {
    expect(ArtifactReadInputSchema.parse({ artifactId: reference.artifactId })).toEqual({
      artifactId: reference.artifactId,
      offset: 0,
      maxBytes: 256 * 1024,
    });
    for (const input of [
      { maxBytes: 256 * 1024 + 1 },
      { maxBytes: 0 },
      { offset: -1 },
      { offset: 0.5 },
    ]) {
      expect(
        ArtifactReadInputSchema.safeParse({ artifactId: reference.artifactId, ...input }).success
      ).toBe(false);
    }
    const result = {
      accepted: true,
      data: Buffer.alloc(256 * 1024).toString('base64'),
      nextOffset: 256 * 1024,
      byteLength: 256 * 1024,
      sha256: 'a'.repeat(64),
      complete: true,
    };
    expect(ArtifactReadResultSchema.safeParse(result).success).toBe(true);
    for (const data of ['not base64!', Buffer.alloc(256 * 1024 + 1).toString('base64')]) {
      expect(ArtifactReadResultSchema.safeParse({ ...result, data }).success).toBe(false);
    }
    expect(
      ArtifactReadResultSchema.safeParse({ ...result, nextOffset: result.byteLength + 1 }).success
    ).toBe(false);
    expect(ArtifactReadResultSchema.safeParse({ ...result, complete: false }).success).toBe(false);
    expect(ArtifactReadResultSchema.safeParse({ ...result, sha256: 'no hash' }).success).toBe(
      false
    );
  });
});
