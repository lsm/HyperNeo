import type { MessageHub } from '@hyperneo/shared';
import { VIDEO_MAX_BYTES } from '@hyperneo/shared/types/video-container';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { ArtifactPreviewTarget } from './artifact-preview-store.ts';
import { prepareVideoBlob } from './artifact-video-client.ts';
import { invokeOperation } from './operations.ts';

type Reference = Extract<ArtifactPreviewTarget, { kind: 'reference' }>;
type Chunk = {
  accepted: true;
  path?: string;
  kind: 'text' | 'markdown' | 'html' | 'image' | 'video';
  data: string;
  version: string;
  byteLength: number;
  nextOffset: number;
  complete: boolean;
  mediaType?: string;
  scriptsRemoved?: boolean;
  links?: { text: string; href: string }[];
};

export const isLiveReference = (
  target: ArtifactPreviewTarget
): target is Reference & { file?: never } =>
  target.kind === 'reference' && !target.file && !/^https?:\/\//i.test(target.reference);

async function collect(hub: MessageHub, target: Reference, signal: AbortSignal) {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let first: Chunk | undefined;
  let offset = 0;
  for (;;) {
    signal.throwIfAborted();
    if (target.handoff && !['question', 'publication'].includes(target.source.kind))
      throw new Error('forbidden');
    const chunk = await invokeOperation<Chunk | { accepted: false; reason: string }>(
      hub,
      target.handoff ? 'file.handoff.read' : 'file.reference.read',
      target.handoff
        ? {
            source: { kind: target.source.kind, id: target.source.id },
            reference: target.handoff,
            offset,
            maxBytes: 262144,
            version: first?.version,
          }
        : {
            sourceMessageOrCard: target.source,
            reference: target.reference,
            offset,
            maxBytes: 262144,
            version: first?.version,
          }
    );
    signal.throwIfAborted();
    if (!chunk.accepted) throw new Error(chunk.reason);
    if (target.handoff && chunk.path !== undefined) throw new Error('file_changed');
    const bytes = Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0));
    const limit =
      chunk.kind === 'video'
        ? VIDEO_MAX_BYTES
        : chunk.kind === 'image'
          ? 32 * 1024 * 1024
          : 2 * 1024 * 1024;
    if (chunk.byteLength > limit) throw new Error('size_limit');
    if (
      (first &&
        (chunk.version !== first.version ||
          chunk.path !== first.path ||
          chunk.kind !== first.kind ||
          chunk.mediaType !== first.mediaType ||
          chunk.byteLength !== first.byteLength)) ||
      bytes.length > 262144 ||
      chunk.nextOffset !== offset + bytes.length ||
      chunk.nextOffset > chunk.byteLength ||
      chunk.complete !== (chunk.nextOffset === chunk.byteLength) ||
      (!bytes.length && !chunk.complete)
    )
      throw new Error('file_changed');
    first ??= chunk;
    parts.push(bytes);
    if (chunk.complete)
      return {
        first,
        blob: new Blob(parts, {
          type: chunk.mediaType ?? (chunk.kind === 'html' ? 'text/html' : 'text/plain'),
        }),
      };
    offset = chunk.nextOffset;
  }
}

async function present({ first, blob }: Awaited<ReturnType<typeof collect>>, target: Reference) {
  if (first.kind === 'video') {
    const prepared = await prepareVideoBlob(blob, first.path ?? target.reference);
    if ('reason' in prepared) throw new Error(prepared.reason);
    blob = prepared.value;
  }
  const text = first.kind === 'image' || first.kind === 'video' ? '' : await blob.text();
  return {
    path: first.path,
    kind: first.kind,
    blob,
    text,
    html: {
      document: text,
      scriptsRemoved: first.scriptsRemoved ?? false,
      links: first.links ?? [],
    },
  };
}

export const readLiveFile = (superpipe({})('read-live-file-preview') as PipelineAPI)
  .input(['hub', 'target', 'signal'])
  .pipe(collect, ['hub', 'target', 'signal'], 'loaded')
  .pipe(present, ['loaded', 'target'], 'file')
  .endAsync('file') as (
  hub: MessageHub,
  target: Reference,
  signal: AbortSignal
) => ReturnType<typeof present>;
