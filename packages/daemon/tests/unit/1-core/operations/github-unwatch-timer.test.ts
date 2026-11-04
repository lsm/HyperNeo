import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('Public unwatch timer reader activation', () => {
  test('native unwatch RPC awaits timer ownership decisions', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'github-unwatch-timer-')));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/lane-c-github-unwatch-timer.ts',
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
        JSON.parse(readFileSync(join(root, 'evidence/github-unwatch-timer.json'), 'utf8'))
      ).toMatchObject({
        pass: true,
        timerCallerActivated: true,
        otherTimerCallersActivated: false,
        activeTimerBeforeMeasurement: true,
        publicRpcReadback: true,
        removalSnapshotAndIntentPreserved: true,
        activeOrphanKeepsTimer: true,
        newEnableWaitsForTimerDecision: true,
        replacedTimerSurvivesOldReply: true,
        failurePreservesKnownWriteAndTimerWithoutReplay: true,
        mainSqlAttempts: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
