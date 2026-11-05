import { describe, expect, test } from 'bun:test';
import { runArtifactProofChild } from '../../helpers/artifact-proof-child';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('Git artifact committed row admission', () => {
  test('RPC publication preserves receipts and bytes while fencing lost replies and revoked access', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-git-row-')));
    try {
      runArtifactProofChild(
        fileURLToPath(
          new URL(
            '../../../../../../.claude/skills/verify/lane-c-artifact-git-row.ts',
            import.meta.url
          )
        ),
        root
      );
      expect(
        JSON.parse(readFileSync(join(root, 'evidence/artifact-git-row.json'), 'utf8'))
      ).toMatchObject({
        pass: true,
        GitMainInsertRuns: 0,
        concurrentLaneAndReceiptRetryPreserved: true,
        commitProvenanceAndFullSnapshotBytesRetained: true,
        admissionFailureHasNoFallbackOrReplay: true,
        unknownOutcomeNeverAutomaticallyReplayed: true,
        explicitRetryReadsCommittedReceiptWithoutLookup: true,
        postCommitBindingChangeWithholdsReference: true,
        publicReceiptWaitsForCommit: true,
        explicitOfflineRetryReadsWithoutLookupOrPublication: true,
        postCommitSourceRevocationWithholdsReference: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
