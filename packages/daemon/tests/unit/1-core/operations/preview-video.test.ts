import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_KINDS, PREVIEWABLE_FILE_EXTENSIONS } from '@hyperneo/shared/types/artifact-file';
import { matchingVideoType } from '@hyperneo/shared/types/video-container';
import { liveFileByteLimit } from '../../../../src/lib/artifacts/live-file-content.ts';

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
  test('advertises registered video while clickable live video awaits its player', () => {
    expect([...ARTIFACT_KINDS]).toContain('video');
    for (const extension of ['mp4', 'mov']) {
      expect(PREVIEWABLE_FILE_EXTENSIONS.has(extension)).toBe(false);
      expect(liveFileByteLimit(extension)).toBe(16 * 1024 * 1024);
    }
  });
  test('accepts matching MP4 and modern QuickTime headers only', () => {
    const cases: [Buffer, string, ReturnType<typeof matchingVideoType>][] = [
      [container('isom', 'mp42'), 'clip.MP4', 'video/mp4'],
      [container('qt  '), 'clip.mov', 'video/quicktime'],
      [container('avif'), 'clip.mp4', null],
      [container('qt  '), 'clip.mp4', null],
      [container('mp42'), 'clip.mov', null],
      [container('mp42').subarray(0, 20), 'clip.mp4', null],
      [Buffer.from('not a video'), 'clip.mp4', null],
    ];
    const oversizedHeader = container('mp42');
    oversizedHeader.writeUInt32BE(2048, 0);
    cases.push([oversizedHeader, 'clip.mp4', null]);
    for (const [bytes, path, expected] of cases)
      expect(matchingVideoType(bytes, path)).toBe(expected);
  });
  test('proves bounded authorized video snapshots in native Bun', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'registered-video-')));
    mkdirSync(join(root, 'home'));
    try {
      const output = execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL('../../../../../../.claude/skills/verify/registered-video.ts', import.meta.url)
          ),
          root,
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: join(root, 'home'),
            NODE_ENV: 'test',
            HYPERNEO_DATA_DIR: join(root, 'data'),
          },
          encoding: 'utf8',
          timeout: 30000,
        }
      );
      expect(JSON.parse(output.trim().split('\n').at(-1)!)).toMatchObject({
        passed: true,
        registeredMp4: true,
        registeredMov: true,
        chunks: 3,
        wholeSnapshotHash: true,
        foreignWorkerRefused: true,
        authorityRechecked: true,
        exactCapAccepted: true,
        overCapNotRetained: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
