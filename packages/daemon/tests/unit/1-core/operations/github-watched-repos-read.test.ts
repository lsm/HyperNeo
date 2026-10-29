import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('GitHub watched repository read extraction', () => {
  test('real Space RPC watched rows and constructor-free reads stay compatible', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'github-watched-repos-read-')));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/lane-c-github-watched-repos-read.ts',
              import.meta.url
            )
          ),
          root,
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: join(root, 'home'),
            TMPDIR: root,
            NODE_ENV: 'test',
            HYPERNEO_DATA_DIR: join(root, 'data'),
            LOG_LEVEL: 'warn',
          },
          timeout: 30000,
          stdio: 'pipe',
        }
      );
      expect(
        JSON.parse(readFileSync(join(root, 'evidence/github-watched-repos-read.json'), 'utf8'))
      ).toMatchObject({
        pass: true,
        mainThreadMovementClaim: false,
        constructorFreeQueryOnlyRows: true,
        completeRowOrderAndCursorErrorsPreserved: true,
        publicRpcCharacterization: {
          mainStatementRuns: 0,
          watchedRows: 2,
          sourceWatchedAndSnapshotStayAligned: true,
          creationAndSharedCommandTimesPreserved: true,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
