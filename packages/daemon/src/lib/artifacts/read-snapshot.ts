import { createHash } from 'node:crypto';
import { fstatSync, read } from 'node:fs';
import { promisify } from 'node:util';
import type { ArtifactReadResult } from '@hyperneo/shared/types/artifact-file';
import type { StoredArtifactFile } from '../../storage/repositories/artifact-file-read-repository.ts';
import { withStoredArtifactDescriptor } from '../runtime-artifact-open.ts';

const readDescriptor = promisify(read);
export async function readArtifactChunk(
  root: string,
  row: StoredArtifactFile,
  offset: number,
  maxBytes: number
): Promise<ArtifactReadResult> {
  const unavailable = { accepted: false as const, reason: 'unavailable' as const };
  const result = await withStoredArtifactDescriptor(root, row.sha256, async (fd, initial) => {
    if (initial.size !== row.byte_length || offset > initial.size) return unavailable;
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(Math.min(maxBytes, initial.size - offset));
    const buffer = Buffer.alloc(256 * 1024);
    let position = 0;
    while (position < initial.size) {
      const { bytesRead } = await readDescriptor(
        fd,
        buffer,
        0,
        Math.min(buffer.length, initial.size - position),
        position
      );
      if (!bytesRead) return unavailable;
      hash.update(buffer.subarray(0, bytesRead));
      const start = Math.max(offset, position);
      const end = Math.min(offset + chunk.length, position + bytesRead);
      if (end > start) buffer.copy(chunk, start - offset, start - position, end - position);
      position += bytesRead;
    }
    const after = fstatSync(fd);
    if (
      after.dev !== initial.dev ||
      after.ino !== initial.ino ||
      after.size !== initial.size ||
      after.mtimeMs !== initial.mtimeMs ||
      after.ctimeMs !== initial.ctimeMs ||
      after.nlink !== initial.nlink ||
      hash.digest('hex') !== row.sha256
    )
      return unavailable;
    return {
      accepted: true as const,
      data: chunk.toString('base64'),
      nextOffset: offset + chunk.length,
      byteLength: initial.size,
      sha256: row.sha256,
      complete: offset + chunk.length === initial.size,
    };
  });
  return result.accepted
    ? result.value
    : result.reason === 'safe_open_unavailable'
      ? result
      : unavailable;
}
