import { test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('real publication receipts and read pages carry safe native Open targets', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'publication-target-')));
  for (const name of ['home', 'bin', 'tmp']) mkdirSync(join(run, name));
  try {
    const output = execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL(
            '../../../../../../.claude/skills/verify/publication-open-target.ts',
            import.meta.url
          )
        ),
        run,
      ],
      {
        cwd: run,
        env: {
          HOME: join(run, 'home'),
          HYPERNEO_DATA_DIR: join(run, 'data'),
          NODE_ENV: 'test',
          LOG_LEVEL: 'error',
          PATH: `${join(run, 'bin')}:${process.env.PATH}`,
          TMPDIR: join(run, 'tmp'),
        },
        encoding: 'utf8',
        timeout: 30000,
      }
    );
    expect(JSON.parse(output.trim().split('\n').at(-1)!)).toEqual({
      passed: true,
      wireField: 'sessionSource',
      qualifiedAndBare: true,
      localNeoAndSpace: true,
      safeLinks: true,
      producerCannotInject: true,
      retryAndRevision: true,
      bothReadDoors: true,
      batchDedup: true,
      storedPayloadUnchanged: true,
      resourcesClosed: true,
    });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}, 35000);
