import { neoImageSize } from '../neo/image-size.ts';
import { isRecord } from '../record.ts';

type Json = Record<string, unknown>;

export const MESSAGE_IMAGE_INLINE_CHARS = 32 * 1024;

const SERVED_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const PLACEHOLDER_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAQ0lEQVR42u3PMQ0AAAgDsPnXtwM5WOAlaVIDTTuvRUBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEDgagHEMQHDqn9gAwAAAABJRU5ErkJggg==';

type StoredImage = { mediaType: string; data: string };

function storedImage(block: unknown): StoredImage | null {
  if (!isRecord(block) || block.type !== 'image' || !isRecord(block.source)) return null;
  const { type, media_type: mediaType, data } = block.source;
  return type === 'base64' && typeof mediaType === 'string' && typeof data === 'string'
    ? { mediaType, data }
    : null;
}

const decodedBytes = (data: string) =>
  Math.floor((data.length * 3) / 4) - (data.match(/=*$/)?.[0].length ?? 0);

const imagePath = (sessionId: string, uuid: string, index: number) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(uuid)}/images/${index}`;

function linkBlock(block: unknown, index: number, sessionId: string, uuid: string): unknown {
  const image = storedImage(block);
  if (!image || image.data.length <= MESSAGE_IMAGE_INLINE_CHARS) return block;
  const size = neoImageSize(image.data);
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: PLACEHOLDER_PNG },
    full: {
      url: imagePath(sessionId, uuid, index),
      mediaType: image.mediaType,
      bytes: decodedBytes(image.data),
      width: size?.width ?? null,
      height: size?.height ?? null,
    },
  };
}

export function linkMessageImages<T extends Json>(message: T, sessionId: string | null): T {
  const inner = message.message;
  const { uuid } = message;
  if (!sessionId || typeof uuid !== 'string' || !isRecord(inner) || !Array.isArray(inner.content))
    return message;
  const stored = inner.content as unknown[];
  const content = stored.map((block, index) => linkBlock(block, index, sessionId, uuid));
  return content.some((block, index) => block !== stored[index])
    ? { ...message, message: { ...inner, content } }
    : message;
}

export function messageImageAt(message: unknown, index: number): StoredImage | null {
  const inner = isRecord(message) ? message.message : null;
  const content = isRecord(inner) && Array.isArray(inner.content) ? inner.content : [];
  const image = storedImage(content[index]);
  return image && SERVED_MEDIA_TYPES.includes(image.mediaType) ? image : null;
}
