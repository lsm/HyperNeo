import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('isolated live media RPC sanitizes current HTML and bounds raster images without storage', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'live-media-a3-')));
  for (const folder of ['home', 'bin', 'tmp']) mkdirSync(join(run, folder));
  try {
    const output = execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL('../../../../../../.claude/skills/verify/live-file-media-a3.ts', import.meta.url)
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
    const result = JSON.parse(output.trim().split('\n').at(-1)!);
    expect(result).toMatchObject({
      passed: true,
      htmlSanitized: true,
      currentHtmlEditDelete: true,
      imageEditDelete: true,
      inlineImagesBounded: true,
      remoteRequests: 0,
      noRowsOrBlobs: true,
      resourcesClosed: true,
      processVersionsIsolated: true,
    });
    expect(result.imageBytes).toBeGreaterThan(2097152);
    expect(result.imageChunks).toBeGreaterThan(1);
    expect(result.htmlChunks).toBeGreaterThan(1);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}, 35000);
