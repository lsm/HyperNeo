/**
 * Handler-level tests for the `merge_pr` tool (task #866).
 *
 * Injects a fully-mocked {@link MergePrDeps} (no gh / network) and a mock task
 * repo, and asserts the handler: authorizes only this task's designated
 * post-approval merger session, returns structured blockers when validation
 * fails, performs the merge bound to the validated head when ready, and
 * classifies a failed merge. The pure decision logic is covered by
 * merge-pr-validator.test.ts.
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
import type { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import type { SpaceTask } from '@hyperneo/shared';

const PR_URL = 'https://github.com/acme/repo/pull/42';
const HEAD = 'e7be0167';
const OLD_HEAD = '5f5be646';
const SPACE_ID = 'space-1';
const TASK_ID = 'task-1';
const MERGER_SESSION = 'merger-session-1';

function greenSnapshot(head = HEAD, reviews: PrMergeSnapshot['reviews'] = []): PrMergeSnapshot {
  return {
    prUrl: PR_URL,
    state: 'OPEN',
    open: true,
    headRefOid: head,
    prAuthorLogin: 'author',
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

function approvedTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: TASK_ID,
    spaceId: SPACE_ID,
    status: 'approved',
    postApprovalSessionId: MERGER_SESSION,
    workflowRunId: 'run-1',
    ...overrides,
  } as unknown as SpaceTask;
}

interface MockOpts {
  deps: MergePrDeps;
  task?: SpaceTask | null;
  mySessionId?: string;
  spaceId?: string;
}

function withConfig(opts: MockOpts): SpaceAgentToolsConfig {
  const task = opts.task === undefined ? approvedTask() : opts.task;
  const taskRepo = {
    getTask: () => task,
  } as unknown as SpaceTaskRepository;
  return {
    spaceId: opts.spaceId ?? SPACE_ID,
    taskRepo,
    mySessionId: opts.mySessionId ?? MERGER_SESSION,
    mergePrDeps: opts.deps,
  } as unknown as SpaceAgentToolsConfig;
}

function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse((result.content[0] as { text: string }).text);
}

function mergeDeps(opts?: {
  snapshot?: PrMergeSnapshot;
  outcome?: MergeOutcome;
  onMerge?: (prUrl: string, head: string) => void;
}): MergePrDeps {
  return {
    fetchSnapshot: async () =>
      opts?.snapshot ??
      greenSnapshot(HEAD, [
        { commitOid: HEAD, state: 'APPROVED', body: null, authorLogin: 'rev', submittedAt: null },
      ]),
    performMerge: async (prUrl, head) => {
      opts?.onMerge?.(prUrl, head);
      return (
        opts?.outcome ?? { ok: true, exitCode: 0, stdout: '', stderr: '', stateAfter: 'MERGED' }
      );
    },
  };
}

describe('runMergePr — authorization (task #866 P1)', () => {
  test('requires task_id', async () => {
    const result = await runMergePr(
      { task_id: '', pr_url: PR_URL },
      withConfig({ deps: mergeDeps() })
    );
    const data = payload(result);
    expect(data.ok).toBe(false);
  });

  test('rejects a caller that is not this task’s merger session', async () => {
    const mergeCalls: string[] = [];
    const deps = mergeDeps({
      onMerge: () => {
        mergeCalls.push('called');
      },
    });
    const result = await runMergePr(
      { task_id: TASK_ID, pr_url: PR_URL },
      withConfig({ deps, mySessionId: 'some-other-session' })
    );
    const data = payload(result);
    expect(data.ok).toBe(false);
    expect((data.blockers as Array<{ kind: string }>).map((b) => b.kind)).toContain('unauthorized');
    expect(mergeCalls).toEqual([]);
  });

  test('rejects when the task is not approved', async () => {
    const result = await runMergePr(
      { task_id: TASK_ID, pr_url: PR_URL },
      withConfig({ deps: mergeDeps(), task: approvedTask({ status: 'in_progress' }) })
    );
    const data = payload(result);
    expect(data.ok).toBe(false);
    expect((data.blockers as Array<{ kind: string }>).map((b) => b.kind)).toContain('unauthorized');
  });

  test('rejects a cross-space task', async () => {
    const result = await runMergePr(
      { task_id: TASK_ID, pr_url: PR_URL },
      withConfig({ deps: mergeDeps(), spaceId: 'other-space' })
    );
    const data = payload(result);
    expect(data.ok).toBe(false);
    expect((data.blockers as Array<{ kind: string }>).map((b) => b.kind)).toContain('unauthorized');
  });
});

describe('runMergePr — gate + merge', () => {
  test('stale approval (#857 shape) returns blockers and does NOT merge', async () => {
    const mergeCalls: Array<{ prUrl: string; head: string }> = [];
    const deps: MergePrDeps = {
      fetchSnapshot: async () =>
        greenSnapshot(HEAD, [
          {
            commitOid: OLD_HEAD,
            state: 'APPROVED',
            body: null,
            authorLogin: 'r',
            submittedAt: null,
          },
        ]),
      performMerge: async (prUrl, head) => {
        mergeCalls.push({ prUrl, head });
        return { ok: true, exitCode: 0, stdout: '', stderr: '', stateAfter: 'MERGED' };
      },
    };
    const result = await runMergePr({ task_id: TASK_ID, pr_url: PR_URL }, withConfig({ deps }));
    const data = payload(result);
    expect(data.ok).toBe(false);
    expect(data.merged).toBe(false);
    expect((data.blockers as Array<{ kind: string }>).map((b) => b.kind)).toContain(
      'stale_approval'
    );
    expect(mergeCalls).toEqual([]);
  });

  test('current-head approval performs the merge bound to the validated head', async () => {
    const mergeCalls: Array<{ prUrl: string; head: string }> = [];
    const deps = mergeDeps({
      onMerge: (prUrl, head) => {
        mergeCalls.push({ prUrl, head });
      },
    });
    const result = await runMergePr({ task_id: TASK_ID, pr_url: PR_URL }, withConfig({ deps }));
    const data = payload(result);
    expect(data.ok).toBe(true);
    expect(data.merged).toBe(true);
    expect(data.headRefOid).toBe(HEAD);
    expect(mergeCalls).toEqual([{ prUrl: PR_URL, head: HEAD }]);
  });

  test('own-PR author "Recommendation: APPROVE" marker on the head merges', async () => {
    const deps = mergeDeps({
      snapshot: greenSnapshot(HEAD, [
        {
          commitOid: HEAD,
          state: 'COMMENTED',
          body: 'Recommendation: APPROVE',
          authorLogin: 'author', // matches prAuthorLogin in greenSnapshot
          submittedAt: null,
        },
      ]),
    });
    const result = await runMergePr({ task_id: TASK_ID, pr_url: PR_URL }, withConfig({ deps }));
    const data = payload(result);
    expect(data.ok).toBe(true);
    expect(data.merged).toBe(true);
  });

  test('outstanding CHANGES_REQUESTED on the head blocks even with an approval', async () => {
    const deps = mergeDeps({
      snapshot: greenSnapshot(HEAD, [
        {
          commitOid: HEAD,
          state: 'APPROVED',
          body: null,
          authorLogin: 'rev1',
          submittedAt: '2026-01-01T00:00:00Z',
        },
        {
          commitOid: HEAD,
          state: 'CHANGES_REQUESTED',
          body: null,
          authorLogin: 'rev2',
          submittedAt: '2026-01-02T00:00:00Z',
        },
      ]),
    });
    const result = await runMergePr({ task_id: TASK_ID, pr_url: PR_URL }, withConfig({ deps }));
    const data = payload(result);
    expect(data.ok).toBe(false);
    expect((data.blockers as Array<{ kind: string }>).map((b) => b.kind)).toContain(
      'changes_requested'
    );
  });

  test('concurrent push (head changed at merge time) fails safely', async () => {
    const deps = mergeDeps({
      outcome: {
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: 'head ref did not match the expected commit',
        stateAfter: null,
      },
    });
    const result = await runMergePr({ task_id: TASK_ID, pr_url: PR_URL }, withConfig({ deps }));
    const data = payload(result);
    expect(data.ok).toBe(false);
    expect((data.blockers as Array<{ kind: string }>).map((b) => b.kind)).toContain('head_changed');
  });

  test('enqueued (state OPEN after exit 0) reports merged=false without blockers', async () => {
    const deps = mergeDeps({
      outcome: { ok: true, exitCode: 0, stdout: '', stderr: '', stateAfter: 'OPEN' },
    });
    const result = await runMergePr({ task_id: TASK_ID, pr_url: PR_URL }, withConfig({ deps }));
    const data = payload(result);
    expect(data.ok).toBe(true);
    expect(data.merged).toBe(false);
    expect(data.state).toBe('OPEN');
  });
});
