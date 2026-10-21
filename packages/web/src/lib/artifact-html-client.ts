import type { MessageHub } from '@hyperneo/shared';
import type { ArtifactFileMetadata } from '@hyperneo/shared/types/artifact-file';
import superpipe, { type PipelineAPI } from 'superpipe';
import { invokeOperation } from './operations.ts';
import { previewStateForRefusal } from './artifact-preview-client.ts';

export interface ArtifactHtml {
  readonly document: string;
  readonly scriptsRemoved: boolean;
  readonly links: readonly { text: string; href: string }[];
}
export type ArtifactHtmlState =
  | { state: 'ready'; metadata: ArtifactFileMetadata; html: ArtifactHtml; text: string }
  | { state: 'html_source'; metadata: ArtifactFileMetadata }
  | { state: 'revoked' | 'daemon_unavailable' | 'needs_update' | 'forbidden' | 'unsupported' };

async function requestHtml(hub: MessageHub, metadata: ArtifactFileMetadata) {
  try {
    return {
      value: await invokeOperation<unknown>(hub, 'artifact.file.html', {
        artifactId: metadata.artifact.artifactId,
      }),
    };
  } catch (error) {
    return {
      reason: {
        state:
          (error as { code?: string })?.code === 'METHOD_NOT_FOUND'
            ? 'needs_update'
            : 'daemon_unavailable',
      },
    };
  }
}
function pairHtml(value: unknown, metadata: ArtifactFileMetadata): ArtifactHtmlState {
  if (!value || typeof value !== 'object') return { state: 'revoked' };
  if ('accepted' in value && value.accepted === false && 'reason' in value) {
    const state = previewStateForRefusal(String(value.reason));
    return state === 'limit' ? { state: 'html_source', metadata } : { state };
  }
  if (
    !('accepted' in value) ||
    value.accepted !== true ||
    !('sha256' in value) ||
    value.sha256 !== metadata.sha256 ||
    !('document' in value) ||
    typeof value.document !== 'string' ||
    !('scriptsRemoved' in value) ||
    typeof value.scriptsRemoved !== 'boolean' ||
    !('links' in value) ||
    !Array.isArray(value.links) ||
    value.links.length > 200 ||
    value.links.some(
      (link) => !link || typeof link.text !== 'string' || typeof link.href !== 'string'
    )
  )
    return { state: 'revoked' };
  return { state: 'ready', metadata, text: '', html: value as ArtifactHtml };
}
export const readArtifactHtml = (superpipe({})('artifact-html-read') as PipelineAPI)
  .input(['hub', 'metadata'])
  .pipe(requestHtml, ['hub', 'metadata'], 'result:html')
  .pipe(pairHtml, ['html', 'metadata'], 'html')
  .endAsync('html') as (
  hub: MessageHub,
  metadata: ArtifactFileMetadata
) => Promise<ArtifactHtmlState>;
