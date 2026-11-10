import { readSync } from 'node:fs';
import type { ArtifactRef } from '@hyperneo/shared/types/artifact-file';
import {
  matchingVideoType,
  VIDEO_HEADER_BYTES,
  videoExtension,
} from '@hyperneo/shared/types/video-container';
import { withStoredArtifactDescriptor } from '../runtime-artifact-open.ts';

const textKinds = new Map<string, ArtifactRef['kind']>([
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['html', 'html'],
  ['htm', 'html'],
  ['json', 'json'],
  ['log', 'log'],
  ['txt', 'text'],
  ['css', 'text'],
]);

export function storedKind(root: string, hash: string, path: string) {
  return withStoredArtifactDescriptor(root, hash, (fd) => {
    const head = Buffer.alloc(VIDEO_HEADER_BYTES);
    const count = readSync(fd, head, 0, head.length, 0);
    const bytes = head.subarray(0, count);
    const extension = path.split('.').at(-1)?.toLowerCase();
    if (videoExtension(path)) return matchingVideoType(bytes, path) ? ('video' as const) : null;
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension ?? '')) {
      const magic = bytes.toString('hex');
      return (extension === 'png' && magic.startsWith('89504e470d0a1a0a')) ||
        (['jpg', 'jpeg'].includes(extension!) && magic.startsWith('ffd8ff')) ||
        (extension === 'gif' && /^GIF8[79]a/.test(bytes.toString())) ||
        (extension === 'webp' &&
          bytes.toString('ascii', 0, 4) === 'RIFF' &&
          bytes.toString('ascii', 8, 12) === 'WEBP')
        ? ('image' as const)
        : null;
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
      if (bytes.includes(0)) return null;
      return textKinds.get(extension ?? '') ?? null;
    } catch {
      return null;
    }
  });
}
