import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('global extension configuration setter activation', () => {
  test('public RPC commits config before callbacks and never replays unknown admission', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'extension-global-activation-')));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/lane-c-extension-global-activation.ts',
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
        JSON.parse(readFileSync(join(root, 'evidence/extension-global-activation.json'), 'utf8'))
      ).toMatchObject({
        pass: true,
        publicSetterActivated: true,
        mainSqlAttempts: 0,
        publicEnableDisableListPreserved: true,
        concurrentEnablesStartOnce: true,
        failedStartRestoresKnownCommittedConfig: true,
        failedWriterRollsBackBeforeCallback: true,
        callbackAndReplyWaitForCommit: true,
        preAdmissionTimestampRetained: true,
        rejectedAdmissionHasNoFallbackStartOrReplay: true,
        actualLostCommittedReplyNeverStartsOrReplays: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
