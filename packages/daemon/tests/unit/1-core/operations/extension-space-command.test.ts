import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('Space extension configuration writer construction', () => {
  test('native worker commits configuration without main SQL or unknown-outcome replay', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'extension-space-command-')));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/lane-c-extension-space-command.ts',
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
        JSON.parse(readFileSync(join(root, 'evidence/extension-space-command.json'), 'utf8'))
      ).toMatchObject({
        pass: true,
        publicSpaceSetterActivated: false,
        mainSqlAttempts: 0,
        committedConfigVisibleThroughPublicRpc: true,
        creationTimeAndSuppliedUpdateTimePreserved: true,
        postStatementFailureRollsBack: true,
        foreignKeyRejectsOrphan: true,
        ackWaitsForCommit: true,
        admissionFailureDoesNotWriteOrReplay: true,
        actualCommittedReplyLossDoesNotReplay: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
