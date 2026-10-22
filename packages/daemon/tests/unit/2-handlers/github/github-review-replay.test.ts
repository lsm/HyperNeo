import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function observe() {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'github-review-replay-')));
  mkdirSync(join(run, 'home'));
  try {
    execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL(
            '../../../../../../.claude/skills/verify/github-review-replay.ts',
            import.meta.url
          )
        ),
        'observe',
        run,
      ],
      {
        cwd: run,
        env: {
          HOME: join(run, 'home'),
          PATH: `${join(run, 'bin')}:${process.env.PATH}`,
          NODE_ENV: 'test',
          HYPERNEO_DATA_DIR: join(run, 'data'),
          LOG_LEVEL: 'error',
        },
        timeout: 30000,
        stdio: 'pipe',
      }
    );
    return JSON.parse(readFileSync(join(run, 'evidence/review-replay.json'), 'utf8'));
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}

describe('GitHub review delivery through the public poll RPC', () => {
  test('partial legacy cursors do not replay merged reviews, while fresh events survive and dedupe', () => {
    expect(observe().counts).toEqual({ historical: 0, fresh: 1, next: 1, prior: 1, archived: 0 });
  });
});
