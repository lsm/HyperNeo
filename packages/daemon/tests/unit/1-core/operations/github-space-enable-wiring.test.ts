import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('GitHub Space enable RPC writer wiring', () => {
  test('public RPC commits before lifecycle without main target writes or unknown replay', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'github-space-enable-wiring-')));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/lane-c-github-space-enable-wiring.ts',
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
        JSON.parse(readFileSync(join(root, 'evidence/github-space-enable-wiring.json'), 'utf8'))
      ).toMatchObject({
        pass: true,
        publicMutationActivated: true,
        mainSqlAttempts: 0,
        publicEnableDisableSnapshotAndLifecyclePreserved: true,
        zeroIntervalDoesNotRearmPolling: true,
        writerRollbackPrecedesLifecycle: true,
        knownPostCommitCallbackFailureKeepsConsistentSnapshot: true,
        lifecycleAndRpcReplyWaitForCommit: true,
        preAdmissionTimestampRetained: true,
        admissionFailureHasNoFallbackLifecycleOrReplay: true,
        actualCommittedReplyLossHasNoLifecycleOrReplay: true,
        authorizationPrecedesAdmission: true,
        supersededReceiptDoesNotReenableUnusedPolling: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
