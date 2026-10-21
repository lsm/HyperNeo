import type { MessageHub } from '@hyperneo/shared';
import {
  ARTIFACT_DEFAULT_LIMITS,
  type ArtifactFileMetadata,
  type ArtifactReadResult,
} from '@hyperneo/shared/types/artifact-file';
import superpipe, { type PipelineAPI } from 'superpipe';
import { readArtifactHtml, type ArtifactHtml } from './artifact-html-client.ts';
import { invokeOperation } from './operations.ts';

export type ArtifactPreviewState =
  | { state: 'ready'; metadata: ArtifactFileMetadata; text: string; html?: ArtifactHtml }
  | { state: 'html_source'; metadata: ArtifactFileMetadata }
  | { state: 'limit' | 'unsupported'; metadata: ArtifactFileMetadata }
  | { state: 'forbidden' | 'revoked' | 'daemon_unavailable' | 'needs_update' };

type Refused = { accepted: false; reason: string };
type MetadataGate = { value: ArtifactFileMetadata } | { reason: ArtifactPreviewState };

const forbiddenReasons = new Set(['outside_roots', 'sensitive_path', 'unsafe_path']);

export function previewStateForRefusal(reason: string) {
  if (forbiddenReasons.has(reason)) return 'forbidden';
  if (reason === 'size_limit') return 'limit';
  if (reason === 'unsupported_type') return 'unsupported';
  if (reason === 'owning_daemon_unavailable' || reason === 'safe_open_unavailable')
    return 'daemon_unavailable';
  return 'revoked';
}

const refusedState = (reason: string) =>
  ({ state: previewStateForRefusal(reason) }) as ArtifactPreviewState;

export async function loadArtifactMetadata(hub: MessageHub, artifactId: string) {
  const result = await invokeOperation<
    { accepted: true; metadata: ArtifactFileMetadata } | Refused
  >(hub, 'artifact.file.get', { artifactId }).catch((error: { code?: string }) =>
    error?.code === 'METHOD_NOT_FOUND' ? 'needs_update' : null
  );
  if (!result) return { reason: { state: 'daemon_unavailable' } } as MetadataGate;
  if (result === 'needs_update') return { reason: { state: 'needs_update' } } as MetadataGate;
  return result.accepted ? { value: result.metadata } : { reason: refusedState(result.reason) };
}

export function gatePreviewableKind(metadata: ArtifactFileMetadata): MetadataGate {
  return ['markdown', 'html'].includes(metadata.artifact.kind)
    ? { value: metadata }
    : { reason: { state: 'unsupported', metadata } };
}

export function gatePreviewLimit(metadata: ArtifactFileMetadata): MetadataGate {
  return metadata.artifact.byteLength > ARTIFACT_DEFAULT_LIMITS.documentPreviewBytes
    ? { reason: { state: 'limit', metadata } }
    : { value: metadata };
}

async function readText(
  hub: MessageHub,
  metadata: ArtifactFileMetadata
): Promise<ArtifactPreviewState> {
  const decoder = new TextDecoder();
  const { artifactId } = metadata.artifact;
  let text = '';
  for (let offset = 0; ; ) {
    const chunk = await invokeOperation<ArtifactReadResult>(hub, 'artifact.file.read', {
      artifactId,
      offset,
      maxBytes: ARTIFACT_DEFAULT_LIMITS.readBytes,
    }).catch(() => null);
    if (!chunk) return { state: 'daemon_unavailable' };
    if (!chunk.accepted) return refusedState(chunk.reason);
    const bytes = Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0));
    text += decoder.decode(bytes, { stream: !chunk.complete });
    if (chunk.complete) return { state: 'ready', metadata, text };
    offset = chunk.nextOffset;
  }
}

export const readArtifactPreview = (superpipe({})('artifact-preview-read') as PipelineAPI)
  .input(['hub', 'artifactId'])
  .pipe(loadArtifactMetadata, ['hub', 'artifactId'], 'result:preview')
  .pipe(gatePreviewableKind, 'preview', 'result:preview')
  .pipe(gatePreviewLimit, 'preview', 'result:preview')
  .pipe(
    (hub: MessageHub, metadata: ArtifactFileMetadata) =>
      metadata.artifact.kind === 'html' ? readArtifactHtml(hub, metadata) : readText(hub, metadata),
    ['hub', 'preview'],
    'preview'
  )
  .endAsync('preview') as (hub: MessageHub, artifactId: string) => Promise<ArtifactPreviewState>;

export const readArtifactSource = (superpipe({})('artifact-source-read') as PipelineAPI)
  .input(['hub', 'metadata'])
  .pipe(gatePreviewLimit, 'metadata', 'result:source')
  .pipe(readText, ['hub', 'source'], 'source')
  .endAsync('source') as (
  hub: MessageHub,
  metadata: ArtifactFileMetadata
) => Promise<ArtifactPreviewState>;
