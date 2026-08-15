/**
 * pr_merged — positive-decision identity binding (round 76). A concurrent
 * pr_ready replacement (prior reviewed PR closed) can swap the run's identity
 * while the merge lookup is in flight; the MERGED decision must bind to the
 * identity it was made about.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { HookAction, HookContext, HookArtifact } from '@hyperneo/shared/types/workflow-hooks';
import { setGhRunnerForTests } from '../src/github';
import { prMergedHook } from '../src/hooks/pr-merged';
import { VALIDATED_PR_ARTIFACT_KEY } from '../src/primary-link';

const LINK_A = 'https://github.com/org/repo/pull/1';
const LINK_B = 'https://github.com/org/repo/pull/2';

function makeCtx(artifacts: HookArtifact[]): HookContext {
  return {
    runId: 'run-1',
    workspacePath: '/tmp/ws',
    taskId: 'task-1',
    sourceNode: 'Coding',
    readState: () => undefined,
    recordState: () => {},
    queueFollowUp: () => {},
    writeArtifact: () => {},
    readArtifacts: () => artifacts,
    refreshArtifacts: () => artifacts,
  };
}

const stamp = (link: string): HookArtifact => ({
  artifactType: 'link',
  artifactKey: VALIDATED_PR_ARTIFACT_KEY,
  data: { link, kind: 'pr' },
});

const mergedPrView = (state: string) =>
  JSON.stringify({ state, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });

afterEach(() => setGhRunnerForTests(null));

describe('pr_merged — identity binding', () => {
  test('MERGED on an unchanged identity continues', async () => {
    setGhRunnerForTests(async () => ({ ok: true, data: mergedPrView('MERGED') }));
    const ret = await prMergedHook.run({} as HookAction, makeCtx([stamp(LINK_A)]));
    expect(ret.flow).toBe('continue');
  });

  test('a concurrent identity swap converts the positive decision to a retry', async () => {
    // The lookup resolves A as MERGED, but between the read and the decision
    // pr_ready replaced the stamp with B — the decision was about A and must
    // not complete the run whose identity is now B.
    let call = 0;
    let artifacts: HookArtifact[] = [stamp(LINK_A)];
    const ctx: HookContext = {
      runId: 'run-1',
      workspacePath: '/tmp/ws',
      taskId: 'task-1',
      sourceNode: 'Coding',
      readState: () => undefined,
      recordState: () => {},
      queueFollowUp: () => {},
      writeArtifact: () => {},
      readArtifacts: () => artifacts,
      refreshArtifacts: () => artifacts,
    };
    setGhRunnerForTests(async () => {
      call += 1;
      if (call === 1) {
        // Swap the identity AFTER the merge lookup resolved A as MERGED.
        artifacts = [stamp(LINK_B)];
        return { ok: true, data: mergedPrView('MERGED') };
      }
      return { ok: true, data: mergedPrView('OPEN') };
    });
    const ret = await prMergedHook.run({} as HookAction, ctx);
    expect(ret.flow).toBe('retry');
    if (ret.flow === 'retry') expect(ret.reason).toContain('identity changed');
  });
});
