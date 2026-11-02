import { test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('old local taps require a client upgrade without new snapshots; live reads and saved attachments survive', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'retire-local-tap-')));
  for (const name of ['home', 'bin', 'tmp']) mkdirSync(join(run, name));
  try {
    const output = execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL('../../../../../../.claude/skills/verify/retire-local-tap.ts', import.meta.url)
        ),
        run,
      ],
      {
        env: {
          HOME: join(run, 'home'),
          HYPERNEO_DATA_DIR: join(run, 'data'),
          TMPDIR: join(run, 'tmp'),
          NODE_ENV: 'test',
          PATH: process.env.PATH,
          LOG_LEVEL: 'error',
        },
        encoding: 'utf8',
        timeout: 30000,
      }
    );
    expect(JSON.parse(output)).toMatchObject({
      passed: true,
      localTapsRefused: true,
      noNewRowsOrBlobs: true,
      liveReadEditDelete: true,
      savedAttachmentUnchanged: true,
    });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});
