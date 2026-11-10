import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveFileByteLimit } from '../../../../src/lib/artifacts/live-file-content.ts';

test('caps live MP4 and QuickTime reads at 16 MiB', () => {
  expect(liveFileByteLimit('mp4')).toBe(16 * 1024 * 1024);
  expect(liveFileByteLimit('mov')).toBe(16 * 1024 * 1024);
});

test('isolated live video reads retain anchored ranges and source authority', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'live-video-')));
  for (const folder of ['home', 'bin', 'tmp']) mkdirSync(join(run, folder));
  try {
    const output = execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL('../../../../../../.claude/skills/verify/live-file-video.ts', import.meta.url)
        ),
        run,
      ],
      {
        cwd: run,
        env: {
          PATH: `${join(run, 'bin')}:${process.env.PATH}`,
          HOME: join(run, 'home'),
          HYPERNEO_DATA_DIR: join(run, 'data'),
          TMPDIR: join(run, 'tmp'),
          NODE_ENV: 'test',
          LOG_LEVEL: 'error',
        },
        encoding: 'utf8',
        timeout: 30000,
      }
    );
    expect(JSON.parse(output.trim().split('\n').at(-1)!)).toMatchObject({
      passed: true,
      mp4: true,
      quickTime: true,
      exactBytes: true,
      anchoredRange: true,
      byteLimit: 16777216,
      sourceChangeRefused: true,
      authorityRechecked: true,
      privatePathsRefused: true,
      foreignOwnerRefused: true,
      noRowsOrBlobs: true,
    });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}, 35000);
