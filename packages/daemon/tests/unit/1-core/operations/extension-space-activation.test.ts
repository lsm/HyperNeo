import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('Space extension configuration setter activation', () => {
  test('public RPC commits config before callbacks and never replays unknown admission', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'extension-space-activation-')));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/lane-c-extension-space-activation.ts',
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
        JSON.parse(readFileSync(join(root, 'evidence/extension-space-activation.json'), 'utf8'))
      ).toMatchObject({
        pass: true,
        publicSpaceSetterActivated: true,
        startupLogEvidenceDrained: true,
        mainSqlAttempts: 0,
        mainGuardSelfCheckPassed: true,
        publicCommitBeforeNotificationAndReply: true,
        rollbackDoesNotUndoAlreadyCommittedUpstreamRemoval: true,
        foreignKeyPreserved: true,
        preAdmissionClockAndCommitFencePreserved: true,
        refusalHasNoFallbackNotificationOrReplay: true,
        actualCommittedReplyLossHasNoReplayOrNotification: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
