/**
 * Handler-level tests for the `merge_pr` tool (task #866).
 *
 * Injects a fully-mocked {@link MergePrDeps} (no gh / network) and asserts the
 * handler: returns structured blockers when validation fails, performs the merge
 * bound to the validated head when ready, and classifies a failed merge. The
 * pure decision logic is covered by merge-pr-validator.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { runMergePr } from '../../../../src/lib/space/tools/merge-pr-handler';
import type { SpaceAgentToolsConfig } from '../../../../src/lib/space/tools/space-agent-tools';
import type { MergePrDeps } from '../../../../src/lib/space/runtime/merge-pr-gh';
import type {
  MergeOutcome,
  PrMergeSnapshot,
} from '../../../../src/lib/space/runtime/merge-pr-validator';
import type { ToolResult } from '../../../../src/lib/space/tools/tool-result';

const PR_URL = 'https://github.com/acme/repo/pull/42';
const HEAD = 'e7be0167';
const OLD_HEAD = '5f5be646';

function greenSnapshot(head = HEAD, reviews: PrMergeSnapshot['reviews'] = []): PrMergeSnapshot {
  return {
    prUrl: PR_URL,
    state: 'OPEN',
    open: true,
    headRefOid: head,
    baseRefName: 'dev',
    headRefName: 'feature/x',
    isCrossRepository: false,
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    reviews,
    unresolvedThreadCount: 0,
    checkFailureCount: 0,
    fetchErrors: [],
  };
}

function withDeps(deps: MergePrDeps): SpaceAgentToolsConfig {
  // Only `mergePrDeps` is read when it is injected (no gh/spawn/cwd path taken).
  return { mergePrDeps: deps } as unknown as SpaceAgentToolsConfig;
}

function payload(result: ToolResult): any {
  return JSON.parse((result.content[0] as { text: string }).text);
}

describe('runMergePr (merge_pr tool)', () => {
  test('stale approval (#857 shape) returns blockers and does NOT merge', async () => {
    const mergeCalls: Array<{ prUrl: string; head: string }> = [];
    const deps: MergePrDeps = {
      fetchSnapshot: async () =>
        greenSnapshot(HEAD, [
          { commitOid: OLD_HEAD, state: 'APPROVED', body: null, authorLogin: 'r' },
        ]),
      performMerge: async (prUrl, head) => {
        mergeCalls.push({ prUrl, head });
        return {
          ok: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          stateAfter: 'MERGED',
        } as MergeOutcome;
      },
    };
    const result = await runMergePr({ pr_url: PR_URL }, withDeps(deps));
    const data = payload(result);
    expect(data.ok).toBe(false);
    expect(data.merged).toBe(false);
    expect(data.blockers.map((b: any) => b.kind)).toContain('stale_approval');
    expect(mergeCalls).toEqual([]); // never attempted
  });

  test('current-head approval performs the merge bound to the validated head', async () => {
    const mergeCalls: Array<{ prUrl: string; head: string }> = [];
    const deps: MergePrDeps = {
      fetchSnapshot: async () =>
        greenSnapshot(HEAD, [{ commitOid: HEAD, state: 'APPROVED', body: null, authorLogin: 'r' }]),
      performMerge: async (prUrl, head) => {
        mergeCalls.push({ prUrl, head });
        return {
          ok: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          stateAfter: 'MERGED',
        } as MergeOutcome;
      },
    };
    const result = await runMergePr({ pr_url: PR_URL, task_id: 't1' }, withDeps(deps));
    const data = payload(result);
    expect(data.ok).toBe(true);
    expect(data.merged).toBe(true);
    expect(data.headRefOid).toBe(HEAD);
    expect(mergeCalls).toEqual([{ prUrl: PR_URL, head: HEAD }]); // bound via --match-head-commit
  });

  test('concurrent push (head changed at merge time) fails safely', async () => {
    const deps: MergePrDeps = {
      fetchSnapshot: async () =>
        greenSnapshot(HEAD, [{ commitOid: HEAD, state: 'APPROVED', body: null, authorLogin: 'r' }]),
      performMerge: async () =>
        ({
          ok: false,
          exitCode: 1,
          stdout: '',
          stderr: 'head ref did not match the expected commit',
          stateAfter: null,
        }) as MergeOutcome,
    };
    const result = await runMergePr({ pr_url: PR_URL }, withDeps(deps));
    const data = payload(result);
    expect(data.ok).toBe(false);
    expect(data.merged).toBe(false);
    expect(data.blockers.map((b: any) => b.kind)).toContain('head_changed');
  });

  test('missing pr_url is rejected with a structured blocker', async () => {
    const deps: MergePrDeps = {
      fetchSnapshot: async () => greenSnapshot(),
      performMerge: async () =>
        ({ ok: true, exitCode: 0, stdout: '', stderr: '', stateAfter: 'MERGED' }) as MergeOutcome,
    };
    const result = await runMergePr({ pr_url: '' }, withDeps(deps));
    const data = payload(result);
    expect(data.ok).toBe(false);
    expect(data.blockers.map((b: any) => b.kind)).toContain('fetch_failed');
  });

  test('enqueued (state OPEN after exit 0) reports merged=false without blockers', async () => {
    const deps: MergePrDeps = {
      fetchSnapshot: async () =>
        greenSnapshot(HEAD, [{ commitOid: HEAD, state: 'APPROVED', body: null, authorLogin: 'r' }]),
      performMerge: async () =>
        ({ ok: true, exitCode: 0, stdout: '', stderr: '', stateAfter: 'OPEN' }) as MergeOutcome,
    };
    const result = await runMergePr({ pr_url: PR_URL }, withDeps(deps));
    const data = payload(result);
    expect(data.ok).toBe(true); // merge command accepted
    expect(data.merged).toBe(false); // but not yet MERGED (queued)
    expect(data.state).toBe('OPEN');
  });
});
