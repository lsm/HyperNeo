import { describe, expect, test } from 'bun:test';
import { runArtifactProofChild } from '../../helpers/artifact-proof-child';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('artifact registration committed row admission', () => {
  test.each([false, true])(
    'startup backup retains directory access while the session socket binds privately (recover %s)',
    (recover) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-backup-bind-')));
      try {
        runArtifactProofChild(
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/sdk-backup-directory-umask.ts',
              import.meta.url
            )
          ),
          root,
          recover ? ['--recover'] : []
        );
        expect(
          JSON.parse(readFileSync(join(root, 'evidence/permissions.json'), 'utf8'))
        ).toMatchObject({
          initialDirectoryMode: recover ? '600' : null,
          backupVerifiedDuringBind: true,
          observedMask: '177',
          directoryMode: '700',
          backupMode: '600',
          socketMode: '600',
          error: '',
          backup: { quickCheck: 'ok', rows: 0 },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
