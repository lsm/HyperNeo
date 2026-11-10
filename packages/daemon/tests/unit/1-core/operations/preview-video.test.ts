import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARTIFACT_KINDS,
  type ArtifactRef,
  PREVIEWABLE_FILE_EXTENSIONS,
} from '@hyperneo/shared/types/artifact-file';
import { readArtifactChunk } from '../../../../src/lib/artifacts/read-snapshot.ts';
import { storedKind } from '../../../../src/lib/artifacts/stored-kind.ts';

function container(brand: string, compatible = brand) {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.write('ftyp', 4);
  bytes.write(brand, 8);
  bytes.write(compatible, 16);
  bytes.write(compatible, 20);
  return bytes;
}

describe('registered video classification', () => {
  test('advertises video and both preview extensions', () => {
    expect([...ARTIFACT_KINDS]).toContain('video');
    expect(PREVIEWABLE_FILE_EXTENSIONS.has('mp4')).toBe(true);
    expect(PREVIEWABLE_FILE_EXTENSIONS.has('mov')).toBe(true);
  });
  test('accepts matching MP4 and modern QuickTime headers only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'registered-video-'));
    mkdirSync(join(root, 'blobs'));
    try {
      const cases: [Buffer, string, ArtifactRef['kind'] | null][] = [
        [container('isom', 'mp42'), 'clip.MP4', 'video'],
        [container('qt  '), 'clip.mov', 'video'],
        [container('avif'), 'clip.mp4', null],
        [container('qt  '), 'clip.mp4', null],
        [container('mp42'), 'clip.mov', null],
        [container('mp42').subarray(0, 20), 'clip.mp4', null],
        [Buffer.from('not a video'), 'clip.mp4', null],
        [Buffer.from('plain text'), 'report.txt', 'text'],
      ];
      const oversizedHeader = container('mp42');
      oversizedHeader.writeUInt32BE(2048, 0);
      cases.push([oversizedHeader, 'clip.mp4', null]);
      for (const [bytes, path, expected] of cases) {
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (!existsSync(join(root, 'blobs', hash)))
          writeFileSync(join(root, 'blobs', hash), bytes, { mode: 0o400 });
        expect(await storedKind(root, hash, path)).toEqual({ accepted: true, value: expected });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('registered video limits', () => {
  test('refuses an oversized retained video before returning bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'retained-video-'));
    mkdirSync(join(root, 'blobs'));
    try {
      const bytes = Buffer.alloc(16 * 1024 * 1024 + 1);
      container('mp42').copy(bytes);
      const hash = createHash('sha256').update(bytes).digest('hex');
      writeFileSync(join(root, 'blobs', hash), bytes, { mode: 0o400 });
      const row = {
        artifact_id: 'clip',
        context_kind: 'todo' as const,
        context_id: 'todo',
        sha256: hash,
        byte_length: bytes.length,
        receipt: JSON.stringify({ artifact: { kind: 'video' } }),
        producer_ref: '{}',
        source_path: 'clip.mp4',
        created_at: 1,
      };
      expect(await readArtifactChunk(root, row, 0, 1)).toEqual({
        accepted: false,
        reason: 'size_limit',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
