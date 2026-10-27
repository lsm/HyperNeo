import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const field of ['blockedReason', 'nextAction']) {
  test(`resolves a home file mentioned only in the todo ${field}`, () => {
    const run = realpathSync(mkdtempSync(join(tmpdir(), 'todo-status-reference-')));
    mkdirSync(join(run, 'home'));
    try {
      const output = execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/todo-status-file-references.ts',
              import.meta.url
            )
          ),
          'native',
          field,
          run,
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: join(run, 'home'),
            TMPDIR: run,
            NODE_ENV: 'test',
            HYPERNEO_DATA_DIR: join(run, 'data'),
          },
          encoding: 'utf8',
          timeout: 30000,
        }
      );
      const proof = JSON.parse(output);
      expect(proof.passed).toBe(true);
      expect(proof.cases).toEqual([
        expect.objectContaining({ field: 'title', exactBytesRead: true, retryStable: true }),
        expect.objectContaining({ field, exactBytesRead: true, retryStable: true }),
      ]);
      expect(proof.unmentioned.accepted).toBe(false);
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  });
}
