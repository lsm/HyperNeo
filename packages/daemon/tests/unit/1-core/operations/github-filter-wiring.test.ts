import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('GitHub filter RPC writer wiring', () => {
  test('public filter RPC commits before notification without stale overwrite or unknown replay', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'github-filter-wiring-')));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/lane-c-github-filter-wiring.ts',
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
        JSON.parse(readFileSync(join(root, 'evidence/github-filter-wiring.json'), 'utf8'))
      ).toMatchObject({
        pass: true,
        watchedRowsUnchanged: true,
        publicMutationActivated: true,
        publicFilterSnapshotAndNotificationPreserved: true,
        snapshotFailurePrecedesNotification: true,
        cursorAndOrphanFailureRollBack: true,
        knownNotifyFailureKeepsCommittedSnapshot: true,
        replyAndNotifyWaitForCommit: true,
        reorderedReceiptsNeverOverwriteNewerFilter: true,
        admissionFailureHasNoFallbackNotifyOrReplay: true,
        committedReplyLossHasNoNotifyOrReplay: true,
        authorizationPrecedesAdmission: true,
        mainSqlAttempts: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
