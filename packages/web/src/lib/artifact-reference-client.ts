import type { MessageHub } from '@hyperneo/shared';
import type { ArtifactPrSummary } from '@hyperneo/shared/types/artifact-pr';
import { invokeOperation } from './operations.ts';
import { previewStateForRefusal } from './artifact-preview-client.ts';
import type { ArtifactPreviewContext, ArtifactPreviewTarget } from './artifact-preview-store.ts';

export type ArtifactResolution =
  | { kind: 'artifact'; artifactId: string }
  | { kind: 'pr'; pr: ArtifactPrSummary }
  | { kind: 'choices'; choices: ArtifactPreviewContext[] }
  | { kind: 'state'; state: ReturnType<typeof previewStateForRefusal> | 'needs_update' };

type Resolved =
  | { accepted: true; artifact: { artifactId: string } }
  | { accepted: true; pr: ArtifactPrSummary }
  | { accepted: false; reason: string; choices?: ArtifactPreviewContext[] };

export function presentResolution(result: Resolved): ArtifactResolution {
  if (result.accepted)
    return 'pr' in result
      ? { kind: 'pr', pr: result.pr }
      : { kind: 'artifact', artifactId: result.artifact.artifactId };
  return result.reason === 'ambiguous_context' && result.choices
    ? { kind: 'choices', choices: result.choices }
    : { kind: 'state', state: previewStateForRefusal(result.reason) };
}

const requestIds = new WeakMap<object, string>();

export function resolveArtifactReference(
  hub: MessageHub,
  target: Omit<Extract<ArtifactPreviewTarget, { kind: 'reference' }>, 'kind'>
): Promise<ArtifactResolution> {
  const { source, reference, file, context } = target;
  const requestId = requestIds.get(target) ?? crypto.randomUUID();
  requestIds.set(target, requestId);
  return invokeOperation<Resolved>(hub, 'artifact.reference.resolve', {
    sourceMessageOrCard: source,
    requestId,
    reference,
    ...(file ? { file } : {}),
    ...(context ? { context } : {}),
  }).then(presentResolution, (error: { code?: string }) => ({
    kind: 'state',
    state: error?.code === 'METHOD_NOT_FOUND' ? 'needs_update' : 'daemon_unavailable',
  }));
}
