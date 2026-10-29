import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('atomic GitHub Space enabled writer construction', () => {
  test('native worker atomically commits source and saved config without main target SQL or replay', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'github-space-enabled-command-')));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/lane-c-github-space-enabled-command.ts',
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
        JSON.parse(readFileSync(join(root, 'evidence/github-space-enabled-command.json'), 'utf8'))
      ).toMatchObject({
        pass: true,
        publicMutationActivated: false,
        mainSqlAttempts: 0,
        atomicReceiptVisibleThroughPublicRpc: true,
        creationAndSharedSuppliedTimesPreserved: true,
        snapshotFailureRollsBackSourceWatchedAndConfig: true,
        orphanAndInvalidIdLeaveNoPartialState: true,
        cursorFailureRollsBackSourceAndWatched: true,
        otherSpaceAndConstructorBackfillUntouched: true,
        ackWaitsForAtomicCommit: true,
        admissionFailureDoesNotWriteOrReplay: true,
        actualCommittedReplyLossDoesNotReplay: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
