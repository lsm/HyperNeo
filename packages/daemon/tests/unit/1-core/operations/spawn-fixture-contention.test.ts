import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';

for (const scenario of ['space', 'task']) {
  test(`${scenario} fixture creation survives an overlapping writer without a retry`, () => {
    const run = realpathSync(mkdtempSync(join(tmpdir(), 'spawn-contention-')));
    mkdirSync(join(run, 'home'));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/spawn-fixture-contention.ts',
              import.meta.url
            )
          ),
          scenario,
          'verify',
          run,
        ],
        {
          cwd: run,
          env: {
            HOME: join(run, 'home'),
            PATH: process.env.PATH,
            NODE_ENV: 'test',
            HYPERNEO_DATA_DIR: join(run, 'data'),
            LOG_LEVEL: 'error',
          },
          timeout: 30000,
          stdio: 'pipe',
        }
      );
      const result = JSON.parse(readFileSync(join(run, 'evidence/contention.json'), 'utf8'));
      expect(result.verified).toBe(true);
      expect(result.reply.error).toBeUndefined();
      expect(result.writerValue).toEqual({ value: 1 });
      expect(result.spaceCount).toEqual({ count: 1 });
      expect(result.taskCount).toEqual({ count: scenario === 'task' ? 1 : 0 });
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  }, 30000);
}
