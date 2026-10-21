import { sha256 } from '@noble/hashes/sha2.js';
import type { MessageHub } from '@hyperneo/shared';
import {
  type ArtifactFileMetadata,
  type ArtifactReadResult,
  ARTIFACT_DEFAULT_LIMITS as limits,
} from '@hyperneo/shared/types/artifact-file';
import { invokeOperation } from './operations.ts';

export async function readArtifactRange(
  hub: MessageHub,
  metadata: ArtifactFileMetadata,
  offset: number,
  maxBytes: number
) {
  const chunk = await invokeOperation<ArtifactReadResult>(hub, 'artifact.file.read', {
    artifactId: metadata.artifact.artifactId,
    offset,
    maxBytes,
  });
  if (!chunk.accepted) throw new Error(chunk.reason);
  const bytes = Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0));
  if (
    chunk.sha256 !== metadata.sha256 ||
    chunk.byteLength !== metadata.artifact.byteLength ||
    bytes.length > maxBytes ||
    chunk.nextOffset !== offset + bytes.length ||
    chunk.complete !== (chunk.nextOffset === chunk.byteLength) ||
    (!bytes.length && !chunk.complete)
  )
    throw new Error('unavailable');
  return bytes;
}

export async function downloadArtifact(
  hub: MessageHub,
  metadata: ArtifactFileMetadata,
  signal: AbortSignal,
  write: (bytes: Uint8Array<ArrayBuffer>) => Promise<void>
) {
  const hash = sha256.create();
  let offset = 0;
  do {
    signal.throwIfAborted();
    const bytes = await readArtifactRange(
      hub,
      metadata,
      offset,
      Math.min(limits.readBytes, metadata.artifact.byteLength - offset) || limits.readBytes
    );
    signal.throwIfAborted();
    await write(bytes);
    hash.update(bytes);
    offset += bytes.length;
  } while (offset < metadata.artifact.byteLength);
  signal.throwIfAborted();
  if (
    hash.digest().reduce((hex, byte) => hex + byte.toString(16).padStart(2, '0'), '') !==
    metadata.sha256
  )
    throw new Error('unavailable');
}

export async function readMediaPreview(hub: MessageHub, metadata: ArtifactFileMetadata) {
  const { kind, byteLength } = metadata.artifact;
  if (kind === 'image') {
    if (byteLength > limits.imageBytes) return { state: 'limit' as const, metadata };
    const parts: Uint8Array<ArrayBuffer>[] = [];
    await downloadArtifact(hub, metadata, new AbortController().signal, async (part) => {
      parts.push(part);
    });
    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    const image = rasterInfo(bytes);
    if (!image || !image.width || !image.height) return { state: 'unsupported' as const, metadata };
    if (image.width * image.height > limits.imagePixels)
      return { state: 'limit' as const, metadata };
    return {
      state: 'ready' as const,
      metadata,
      text: '',
      image: new Blob(parts, { type: image.mime }),
    };
  }
  const half = limits.textPreviewBytes / 2;
  const omittedBytes = Math.max(0, byteLength - limits.textPreviewBytes);
  const head = await readArtifactRange(
    hub,
    metadata,
    0,
    Math.min(byteLength, omittedBytes ? half : limits.textPreviewBytes) || limits.textPreviewBytes
  );
  const decoder = new TextDecoder();
  let text = decoder.decode(head);
  if (omittedBytes)
    text += `\n…\n${decoder.decode(await readArtifactRange(hub, metadata, byteLength - half, half))}`;
  const sourceText = text;
  if (kind === 'json' && !omittedBytes) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {}
  }
  return { state: 'ready' as const, metadata, text, sourceText, omittedBytes };
}

function rasterInfo(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, count: number) =>
    String.fromCharCode(...bytes.slice(start, start + count));
  if (bytes.length >= 24 && ascii(1, 3) === 'PNG' && view.getUint32(0) === 0x89504e47)
    return { mime: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(ascii(0, 6)))
    return { mime: 'image/gif', width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const type = ascii(12, 4);
    if (type === 'VP8X')
      return {
        mime: 'image/webp',
        width: 1 + (view.getUint32(24, true) & 0xffffff),
        height: 1 + (view.getUint32(26, true) >>> 8),
      };
    if (type === 'VP8 ')
      return {
        mime: 'image/webp',
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    if (type === 'VP8L') {
      const bits = view.getUint32(21, true);
      return {
        mime: 'image/webp',
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
      };
    }
  }
  if (bytes.length >= 4 && view.getUint16(0) === 0xffd8) {
    for (let pos = 2; pos + 8 < bytes.length; ) {
      if (bytes[pos] !== 0xff) return null;
      const marker = bytes[pos + 1];
      if (marker === 0xff) {
        pos++;
        continue;
      }
      if ([0xc0, 0xc1, 0xc2].includes(marker))
        return {
          mime: 'image/jpeg',
          width: view.getUint16(pos + 7),
          height: view.getUint16(pos + 5),
        };
      const size = view.getUint16(pos + 2);
      if (size < 2) return null;
      pos += size + 2;
    }
  }
  return null;
}
