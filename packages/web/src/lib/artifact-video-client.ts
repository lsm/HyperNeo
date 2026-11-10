import {
  matchingVideoType,
  VIDEO_HEADER_BYTES,
  VIDEO_MAX_BYTES,
} from '@hyperneo/shared/types/video-container';

export async function prepareVideoBlob(blob: Blob, path: string) {
  if (blob.size > VIDEO_MAX_BYTES) return { reason: 'size_limit' as const };
  const header = new Uint8Array(await blob.slice(0, VIDEO_HEADER_BYTES).arrayBuffer());
  const mediaType = matchingVideoType(header, path);
  return mediaType
    ? { value: blob.slice(0, blob.size, mediaType) }
    : { reason: 'unsupported_type' as const };
}
