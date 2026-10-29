import { describe, expect, test } from 'bun:test';
import { runArtifactProofChild } from '../../helpers/artifact-proof-child';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('artifact registration committed row admission', () => {
  test('startup backup retains directory access while the session socket binds privately', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-backup-bind-')));
    try {
      runArtifactProofChild(
        fileURLToPath(
          new URL(
            '../../../../../../.claude/skills/verify/sdk-backup-directory-umask.ts',
            import.meta.url
          )
        ),
        root
      );
      expect(
        JSON.parse(readFileSync(join(root, 'evidence/permissions.json'), 'utf8'))
      ).toMatchObject({
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
  });

  test('RPC publication preserves receipts and bytes while fencing lost replies and revoked access', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-registration-row-')));
    try {
      runArtifactProofChild(
        fileURLToPath(
          new URL(
            '../../../../../../.claude/skills/verify/lane-c-artifact-registration-row.ts',
            import.meta.url
          )
        ),
        root
      );
      expect(
        JSON.parse(readFileSync(join(root, 'evidence/artifact-registration-row.json'), 'utf8'))
      ).toMatchObject({
        pass: true,
        registrationMainInsertRuns: 0,
        concurrentLaneAndReceiptRetryPreserved: true,
        publicSnapshotBytesRetained: true,
        admissionFailureHasNoFallbackOrReplay: true,
        unknownOutcomeNeverAutomaticallyReplayed: true,
        explicitRetryReadsCommittedReceipt: true,
        postCommitAccessRevocationWithholdsReference: true,
        publicReceiptWaitsForCommit: true,
        changedSourceCreatesImmutableRevision: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
