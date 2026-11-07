import {
  ARTIFACT_DEFAULT_LIMITS as limits,
  PREVIEWABLE_FILE_EXTENSIONS,
} from '@hyperneo/shared/types/artifact-file';
import { neoImageSize } from '../neo/image-size.ts';
import { prepareArtifactHtml } from './html-preview.ts';

const images = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
]);
export function liveFileByteLimit(extension: string): number | null {
  if (!PREVIEWABLE_FILE_EXTENSIONS.has(extension)) return null;
  return images.has(extension) ? limits.imageBytes : limits.documentPreviewBytes;
}

type Image = { kind: 'image'; mediaType: string; width: number; height: number };
type Gate<T> = { value: T } | { reason: string };

function inspectImage(content: Buffer, extension: string): Gate<Image> {
  const mediaType = images.get(extension);
  const head = content.subarray(0, 16).toString('hex');
  const magic =
    extension === 'png'
      ? content.length >= 45 &&
        head.startsWith('89504e470d0a1a0a0000000d49484452') &&
        content.toString('ascii', content.length - 8, content.length - 4) === 'IEND'
      : ['jpg', 'jpeg'].includes(extension)
        ? head.startsWith('ffd8ff') && content.subarray(-2).toString('hex') === 'ffd9'
        : extension === 'gif'
          ? content.length >= 14 &&
            /^GIF8[79]a/.test(content.toString('ascii', 0, 6)) &&
            content.at(-1) === 0x3b
          : extension === 'webp' &&
            content.length >= 30 &&
            content.toString('ascii', 0, 4) === 'RIFF' &&
            content.toString('ascii', 8, 12) === 'WEBP' &&
            content.readUInt32LE(4) + 8 === content.length;
  const size = magic ? neoImageSize(content.subarray(0, 196608).toString('base64')) : null;
  if (!mediaType || !size) return { reason: 'unsupported_type' };
  if (size.width * size.height > limits.imagePixels) return { reason: 'size_limit' };
  return { value: { kind: 'image' as const, mediaType, ...size } };
}

export function prepareLiveFileContent(content: Buffer, extension: string) {
  if (images.has(extension)) {
    const image = inspectImage(content, extension);
    return 'reason' in image ? image : { value: { bytes: content, ...image.value } };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return { reason: 'unsupported_type' };
  }
  if (content.includes(0)) return { reason: 'unsupported_type' };
  if (['html', 'htm'].includes(extension)) {
    const prepared = prepareArtifactHtml(text, {
      get: () => undefined,
      acceptRaster: (data) =>
        'value' in
        inspectImage(
          Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'),
          data.slice(11, data.indexOf(';')).toLowerCase()
        ),
    });
    if (!prepared) return { reason: 'size_limit' };
    const { document, ...metadata } = prepared;
    const bytes = Buffer.from(document);
    return bytes.length > limits.documentPreviewBytes
      ? { reason: 'size_limit' }
      : { value: { bytes, kind: 'html' as const, ...metadata } };
  }
  return {
    value: {
      bytes: content,
      kind: ['md', 'markdown'].includes(extension) ? ('markdown' as const) : ('text' as const),
    },
  };
}
