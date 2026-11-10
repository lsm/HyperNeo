import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('public question cards read current files from the recorded owner with no registration', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'file-card-b1-')));
  for (const name of ['home', 'bin', 'tmp']) mkdirSync(join(run, name));
  try {
    const output = execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL(
            '../../../../../../.claude/skills/verify/file-reference-cards-b1-source.ts',
            import.meta.url
          )
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
    expect(JSON.parse(output.trim().split('\n').at(-1)!)).toEqual({
      passed: true,
      recordedOwner: true,
      rootFallback: true,
      publicDocument: true,
      metadataRefused: true,
      remoteAndUnknownWorkspaceRefused: true,
      currentReadEditDelete: true,
      noRowsOrBlobs: true,
      resourcesClosed: true,
    });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}, 35000);
