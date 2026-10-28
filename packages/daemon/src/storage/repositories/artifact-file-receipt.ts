import type { ArtifactRef, ArtifactFileMetadata } from '@hyperneo/shared/types/artifact-file';
import type { ArtifactBundleEntry } from '../../lib/artifacts/bundle.ts';

export function serializeArtifactReceipt(
  artifact: ArtifactRef,
  revision?: ArtifactFileMetadata['revision'],
  bundle?: readonly ArtifactBundleEntry[],
  logicalRequestId?: string
): string {
  return JSON.stringify({
    accepted: true,
    ...(logicalRequestId ? { requestId: logicalRequestId } : {}),
    artifact,
    ...(revision ? { revision } : {}),
    ...(bundle ? { bundle } : {}),
  });
}
