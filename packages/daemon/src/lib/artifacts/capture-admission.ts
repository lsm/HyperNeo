import type { ArtifactLimits, ArtifactRefusal } from '@hyperneo/shared/types/artifact-file';
import superpipe, { type PipelineAPI } from 'superpipe';

type Gate =
  | { value: number }
  | { reason: ArtifactRefusal & { actualBytes?: number; limitBytes?: number } };

export function gateArtifactSize(byteLength: number, limits: ArtifactLimits): Gate {
  return Number.isSafeInteger(byteLength) && byteLength >= 0 && byteLength <= limits.artifactBytes
    ? { value: byteLength }
    : {
        reason: {
          accepted: false,
          reason: 'size_limit',
          actualBytes: byteLength,
          limitBytes: limits.artifactBytes,
        },
      };
}

export function gateArtifactQuota(
  byteLength: number,
  limits: ArtifactLimits,
  used: number,
  reserved: number
): Gate {
  return byteLength <= limits.retainedBytes - used - reserved
    ? { value: byteLength }
    : { reason: { accepted: false, reason: 'quota_full' } };
}

export const admitArtifactStorage = (superpipe({})('artifact-storage-admission') as PipelineAPI)
  .input(['byteLength', 'limits', 'used', 'reserved'])
  .pipe(gateArtifactSize, ['byteLength', 'limits'], 'result:admission')
  .pipe(gateArtifactQuota, ['admission', 'limits', 'used', 'reserved'], 'result:admission')
  .end('admission') as (
  byteLength: number,
  limits: ArtifactLimits,
  used: number,
  reserved: number
) => number | ArtifactRefusal;
