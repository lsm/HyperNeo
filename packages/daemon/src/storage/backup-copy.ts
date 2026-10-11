import * as fs from 'node:fs';
import { closeSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';

export const STREAM_COPY_MIN_BYTES = 1024 ** 3;
export const STREAM_COPY_KEEP_MAX = 3;
const STREAM_COPY_RESERVE_MIN_BYTES = 1024 ** 3;
const STREAM_COPY_CHUNK_BYTES = 16 * 1024 ** 2;

export function shouldStreamCopyBackup(platform: string, dbBytes: number): boolean {
  return platform === 'darwin' && dbBytes >= STREAM_COPY_MIN_BYTES;
}

export function hasRoomForBackupCopy(freeBytes: number, dbBytes: number): boolean {
  return freeBytes >= dbBytes + Math.max(STREAM_COPY_RESERVE_MIN_BYTES, dbBytes * 0.1);
}

export function shouldRotateStreamBackups(progress: {
  backupCount: number;
  freeBytes: number;
  dbBytes: number;
}): boolean {
  if (progress.backupCount > STREAM_COPY_KEEP_MAX) return true;
  return progress.backupCount > 1 && progress.freeBytes < 2 * progress.dbBytes;
}

export function freeBytesAt(path: string): number {
  const statfs = (fs as { statfsSync?: typeof fs.statfsSync }).statfsSync;
  if (typeof statfs !== 'function') return Number.POSITIVE_INFINITY;
  const stats = statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

export function streamCopyFile(source: string, destination: string): void {
  const input = openSync(source, 'r');
  try {
    const output = openSync(destination, 'w');
    try {
      const chunk = Buffer.allocUnsafe(STREAM_COPY_CHUNK_BYTES);
      let position = 0;
      for (;;) {
        const read = readSync(input, chunk, 0, chunk.length, position);
        if (read === 0) break;
        let written = 0;
        while (written < read) {
          written += writeSync(output, chunk, written, read - written);
        }
        position += read;
      }
      fsyncSync(output);
    } finally {
      closeSync(output);
    }
  } finally {
    closeSync(input);
  }
}
