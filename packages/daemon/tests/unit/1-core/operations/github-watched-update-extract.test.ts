import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('GitHub watched UPDATE SQL extraction', () => {
  test('real GitHub watched RPC preserves existing UPDATE and saved configuration', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'github-watched-update-')));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/lane-c-github-watched-update-extract.ts',
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
        JSON.parse(readFileSync(join(root, 'evidence/github-watched-update-extract.json'), 'utf8'))
      ).toMatchObject({
        pass: true,
        mainThreadMovementClaim: false,
        publicRpc: {
          existingUpdatesObserved: true,
          identityTimeAndCursorPolicyPreserved: true,
          peerIsolationAndSavedConfigPreserved: true,
        },
        constructorFreeSuppliedTimeFailureAndRollbackPreserved: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
