/**
 * End-node handoff prompt tests (PR 3/5, updated in PR 5/5)
 *
 * Verifies that every built-in workflow's end-node `customPrompt` agrees with
 * the post-approval routing contract:
 *
 *   - Coding / Research / QA end nodes each save a result artifact carrying
 *     `data.pr_url` BEFORE calling `approve_task`. The merge route itself lives
 *     on each workflow's dedicated Post-Approval (merger) node as a node-level
 *     `postApproval: { targetAgent: 'merger', instructions: <merge template> }`
 *     — approval is a task-level event, so the router fans out to whichever
 *     node declares the route regardless of which node submitted. PR 5/5
 *     removed the legacy `post_approval_action: "merge_pr"` discriminator from
 *     the data payload — post-approval routing is fully declarative on
 *     `postApproval` and nothing consumed the runtime discriminator.
 *
 *   - QA no longer embeds `gh pr merge` / worktree-sync instructions — the
 *     reviewer post-approval session runs the merge instead. The QA workflow's
 *     `completionAutonomyLevel` is dropped from 4 → 3 accordingly (no more
 *     auto-merge at QA-approve time).
 *
 *   - Review-Only intentionally does NOT declare `postApproval` (no PR to
 *     merge) and its prompt no longer carries the "runtime verifies" boilerplate.
 *
 *   - Plan & Decompose is unchanged: it closes on its own end-node directive
 *     (verify-tasks-created) and has no `postApproval` route.
 *
 * These tests protect against silent regressions where someone edits an end-
 * node prompt and accidentally removes the runtime-owned post-approval handoff, or adds a
 * `gh pr merge` back into QA, or drops one of the `postApproval` routes.
 */

import { describe, test, expect } from 'bun:test';
import type { SpaceWorkflow } from '@hyperneo/shared';
import {
  CODING_WORKFLOW,
  FULLSTACK_QA_LOOP_WORKFLOW,
  PLAN_AND_DECOMPOSE_WORKFLOW,
  RESEARCH_WORKFLOW,
  REVIEW_ONLY_WORKFLOW,
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import { PR_MERGE_POST_APPROVAL_INSTRUCTIONS } from '../../../../src/lib/space/workflows/post-approval-merge-template.ts';
import { ChannelResolver } from '../../../../src/lib/space/runtime/channel-resolver.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an end node's single-agent prompt string.
 * Throws with a loud message if the workflow shape is wrong (no end node,
 * more than one agent on the end node) — prevents silent test passes when
 * a workflow restructuring breaks invariants this test file depends on.
 */
function endNodePrompt(wf: SpaceWorkflow): string {
  const endNode = wf.nodes.find((n) => n.id === wf.endNodeId);
  if (!endNode) {
    throw new Error(`[test-fixture] ${wf.name}: no node matches endNodeId "${wf.endNodeId}"`);
  }
  if (endNode.agents.length !== 1) {
    throw new Error(
      `[test-fixture] ${wf.name}: end node "${endNode.name}" has ${endNode.agents.length} ` +
        `agents; end-node-handoff tests assume exactly 1 reviewer-style agent`
    );
  }
  const prompt = endNode.agents[0].customPrompt?.value;
  if (!prompt) {
    throw new Error(`[test-fixture] ${wf.name}: end node "${endNode.name}" has no customPrompt`);
  }
  return prompt;
}

function postApprovalRoute(wf: SpaceWorkflow) {
  // Approval is a task-level event: the route lives on whichever node declares
  // it (the merger / Post-Approval node for merge-routed built-ins), and the
  // router fans out to it regardless of which node submitted.
  return wf.nodes.find((node) => node.postApproval)?.postApproval;
}

/** Workflows whose terminal node MUST declare a reviewer post-approval merge route. */
const MERGE_ROUTED_WORKFLOWS: Array<[string, SpaceWorkflow]> = [
  ['CODING_WORKFLOW', CODING_WORKFLOW],
  ['RESEARCH_WORKFLOW', RESEARCH_WORKFLOW],
  ['FULLSTACK_QA_LOOP_WORKFLOW', FULLSTACK_QA_LOOP_WORKFLOW],
];

/** Workflows that MUST NOT declare any post-approval route. */
const NO_POST_APPROVAL_WORKFLOWS: Array<[string, SpaceWorkflow]> = [
  ['REVIEW_ONLY_WORKFLOW', REVIEW_ONLY_WORKFLOW],
  ['PLAN_AND_DECOMPOSE_WORKFLOW', PLAN_AND_DECOMPOSE_WORKFLOW],
];

// ---------------------------------------------------------------------------
// postApproval presence
// ---------------------------------------------------------------------------

describe('Post-approval route declarations', () => {
  for (const [label, wf] of MERGE_ROUTED_WORKFLOWS) {
    test(`${label} declares node-level postApproval targeting the merger role`, () => {
      const route = postApprovalRoute(wf);
      expect(route).toBeDefined();
      expect(route!.targetAgent).toBe('merger');
      // Uses the merge prompt. The runtime appends the
      // shared mark_complete instruction separately.
      expect(route!.instructions).toBe(PR_MERGE_POST_APPROVAL_INSTRUCTIONS);
      expect(wf.postApproval).toBeUndefined();
    });

    test(`${label} postApproval targetAgent matches an actual agent name in the workflow`, () => {
      const route = postApprovalRoute(wf);
      const targetSlot = wf.nodes
        .flatMap((n) => n.agents)
        .find((a) => a.name === route!.targetAgent);
      expect(targetSlot).toBeDefined();
    });
  }

  for (const [label, wf] of NO_POST_APPROVAL_WORKFLOWS) {
    test(`${label} has NO postApproval route (end node closes directly)`, () => {
      expect(wf.postApproval).toBeUndefined();
      expect(postApprovalRoute(wf)).toBeUndefined();
    });
  }

  // The merger (Post-Approval node) must be able to route a merge conflict to
  // the upstream implementation node and receive the fix reply — otherwise
  // ChannelResolver.canSend rejects the send and conflict routing regresses.
  // (Before the role split, the merge ran as the reviewer inside the Review
  // node, which had a Coding channel.)
  const UPSTREAM_NODE: Record<string, string> = {
    CODING_WORKFLOW: 'Coding',
    RESEARCH_WORKFLOW: 'Research',
    FULLSTACK_QA_LOOP_WORKFLOW: 'Coding',
  };
  for (const [label, wf] of MERGE_ROUTED_WORKFLOWS) {
    const upstream = UPSTREAM_NODE[label]!;
    test(`${label} merger can reach ${upstream} and receive the reply (Post-Approval channels)`, () => {
      const resolver = new ChannelResolver(wf.channels ?? []);
      expect(resolver.canSend('Post-Approval', upstream)).toBe(true);
      expect(resolver.canSend(upstream, 'Post-Approval')).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// End-node prompt — runtime-owned post-approval data handoff
// ---------------------------------------------------------------------------

describe('End-node prompts save runtime post-approval data before approve_task', () => {
  for (const [label, wf] of MERGE_ROUTED_WORKFLOWS) {
    test(`${label} end-node prompt includes save_artifact data.pr_url and no task-agent relay`, () => {
      const prompt = endNodePrompt(wf);
      // Every merge-routed workflow must instruct its end-node agent to save
      // a result artifact carrying the PR URL. `dispatchPostApproval` reads
      // that artifact when interpolating `{{pr_url}}` into the merge template.
      expect(prompt).toContain('save_artifact');
      expect(prompt).toContain('pr_url');
      expect(prompt).not.toContain('target: "task-agent"');
      // PR 5/5: the legacy `post_approval_action: "merge_pr"`
      // discriminator was removed — post-approval routing is fully
      // declarative on `postApproval`. Guard against accidental
      // reintroduction.
      expect(prompt).not.toContain('post_approval_action');
    });

    test(`${label} end-node prompt places result artifact BEFORE the final approve_task call`, () => {
      const prompt = endNodePrompt(wf);
      // Anchor on the final `save_artifact(` instruction — the runtime reads
      // its `data.pr_url` before dispatching the post-approval route.
      const signalIdx = prompt.lastIndexOf('save_artifact(');
      // Use lastIndexOf: the first `approve_task()` occurrence in every
      // prompt lives in the "TOOL CONTRACT" block at the top, which is a
      // description of the tool — not the operational instruction. The
      // LAST occurrence is the step-level "Call approve_task()" directive,
      // which is what must follow the task-agent signal.
      const approveIdx = prompt.lastIndexOf('approve_task()');
      expect(signalIdx).toBeGreaterThan(-1);
      expect(approveIdx).toBeGreaterThan(-1);
      // Artifact must appear BEFORE the operational approve_task — ordering
      // matters because approve_task is the trigger that fires
      // PostApprovalRouter.route, which reads the PR URL the end node
      // just stashed via save_artifact.
      expect(signalIdx).toBeLessThan(approveIdx);
    });

    if (label === 'CODING_WORKFLOW') {
      test(`${label} end-node prompt requires unresolved review conversations to be checked`, () => {
        const prompt = endNodePrompt(wf);
        expect(prompt).toContain('unresolved GitHub');
        expect(prompt).toContain('reviewThreads');
        expect(prompt).toContain('isResolved: true');
      });
    }

    test(`${label} end-node prompt instructs the agent NOT to merge itself`, () => {
      const prompt = endNodePrompt(wf);
      // Narrow guard: the end-node agent must be told explicitly that it
      // is NOT the merger. Otherwise a careless agent might shell out to
      // `gh pr merge` and race the reviewer post-approval session.
      expect(prompt.toLowerCase()).toContain('post-approval');
      // Every merge-routed workflow's end-node prompt must contain some
      // form of "do not merge yourself" guidance.
      const mentionsSelfMergeWarning =
        prompt.includes('Do NOT attempt to merge the PR yourself') ||
        prompt.includes('Do NOT run `gh pr merge`') ||
        prompt.includes('Do NOT merge the PR yourself');
      expect(mentionsSelfMergeWarning).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Removed legacy instructions
// ---------------------------------------------------------------------------

describe('Post-approval merge prompt checks review conversations', () => {
  test('merge template verifies CI and unresolved review threads before merging', () => {
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('gh pr checks');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('reviewThreads(first:100');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('isResolved=false');
    // Auto-merge/auto-resolve of review conversations is explicitly prohibited.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('NOT allowed');
    const checkIdx = PR_MERGE_POST_APPROVAL_INSTRUCTIONS.indexOf(
      'Verify all GitHub review conversations'
    );
    const mergeIdx = PR_MERGE_POST_APPROVAL_INSTRUCTIONS.indexOf('gh pr merge');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(mergeIdx).toBeGreaterThan(checkIdx);
  });

  test('merge template includes pagination guidance for review threads', () => {
    // The post-approval merge session must paginate review threads, not
    // stop at the first 100. The GraphQL query includes $cursor and the
    // instructions explicitly tell the agent to paginate using endCursor.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('$cursor');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('endCursor');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('hasNextPage');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('Do NOT stop at the first page');
    // The template instructs the agent to pass --hostname extracted from
    // the PR URL so GitHub Enterprise PRs query the correct backend.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('--hostname');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('<host>');
  });
});

describe('Legacy merge/worktree instructions removed from QA end node', () => {
  test('FULLSTACK_QA_LOOP_WORKFLOW QA prompt does NOT embed gh pr merge', () => {
    const prompt = endNodePrompt(FULLSTACK_QA_LOOP_WORKFLOW);
    // The QA agent used to shell out to `gh pr merge` directly. In PR 3/5
    // the reviewer post-approval session owns the merge, so this command
    // must not appear in the positive/instructional branch of the QA prompt.
    // Mentions in a "Do NOT run `gh pr merge`" clause are allowed because
    // they actively prohibit the command rather than prescribe it.
    const bareMergeMatches = prompt.match(/gh pr merge/g) ?? [];
    const prohibitions = prompt.match(/Do NOT run `gh pr merge`/g) ?? [];
    expect(bareMergeMatches.length).toBe(prohibitions.length);
  });

  test('FULLSTACK_QA_LOOP_WORKFLOW QA prompt does NOT instruct worktree sync', () => {
    const prompt = endNodePrompt(FULLSTACK_QA_LOOP_WORKFLOW);
    // Worktree sync (`git checkout dev && git pull --ff-only`) was part of
    // the old QA-merges-the-PR flow. Post-approval now runs it in the
    // reviewer session, so the QA prompt must not prescribe it directly.
    expect(prompt).not.toContain('git pull --ff-only');
    expect(prompt).not.toContain('git checkout dev');
  });

  test('FULLSTACK_QA_LOOP_WORKFLOW completionAutonomyLevel is 3 (dropped from 4 in PR 3/5)', () => {
    // QA-approve is now a plain "work is good" signal — auto-merge is the
    // reviewer post-approval session's concern, gated by its own autonomy
    // check inside the merge template. Level 3 matches Coding's tier.
    expect(FULLSTACK_QA_LOOP_WORKFLOW.completionAutonomyLevel).toBe(3);
  });
});

describe('Review-Only end-node prompt loses verification boilerplate', () => {
  test('REVIEW_ONLY_WORKFLOW prompt does NOT claim "runtime verifies"', () => {
    const prompt = endNodePrompt(REVIEW_ONLY_WORKFLOW);
    // The old trailing "; the runtime verifies at least one review/comment
    // exists before accepting completion" sentence was removed — the
    // agent prompt no longer duplicates the claim. PR 4/5 removed the
    // runtime verification action and PR 5/5 deleted the schema, so the
    // review check now lives entirely in agent guidance.
    expect(prompt).not.toContain('runtime verifies');
    expect(prompt).not.toContain('before accepting completion');
  });

  test('REVIEW_ONLY_WORKFLOW prompt still requires gh pr review before approve_task', () => {
    const prompt = endNodePrompt(REVIEW_ONLY_WORKFLOW);
    // Positive assertion: the core "post to GitHub first" guarantee is
    // unchanged — this test guards against over-aggressive edits that
    // strip the requirement along with the boilerplate.
    expect(prompt).toContain('gh pr review');
    expect(prompt).toContain('save_artifact');
    expect(prompt).toContain('approve_task()');
  });
});

describe('Plan & Decompose end-node is unchanged', () => {
  test('PLAN_AND_DECOMPOSE_WORKFLOW Task Dispatcher prompt does NOT signal the task-agent', () => {
    const prompt = endNodePrompt(PLAN_AND_DECOMPOSE_WORKFLOW);
    // Plan & Decompose has no PR to merge; its completion is signalled by
    // the verify-tasks-created directive, not by a Task Agent handoff. The
    // end-node prompt MUST NOT adopt the handoff-signalling convention
    // specific to the three PR-producing workflows.
    expect(prompt).not.toContain('send_message');
    // Legacy discriminator is also still absent (PR 5/5 removed it from
    // the PR-producing workflows; this negative assertion guards against
    // drift in either direction).
    expect(prompt).not.toContain('post_approval_action');
  });

  test('PLAN_AND_DECOMPOSE_WORKFLOW Task Dispatcher still calls create_standalone_task + approve_task', () => {
    const prompt = endNodePrompt(PLAN_AND_DECOMPOSE_WORKFLOW);
    // Positive assertions mirror the existing structural tests in
    // built-in-workflows.test.ts — kept here so this file reads as a
    // complete contract of the end-node-handoff behaviour per workflow.
    expect(prompt).toContain('create_standalone_task');
    expect(prompt).toContain('approve_task');
  });
});

// ---------------------------------------------------------------------------
// Merge-template snapshot (structural, not char-for-char)
// ---------------------------------------------------------------------------

describe('Post-approval merger template (redesigned: report blockers to Reviewer)', () => {
  // The merger's only job is to MERGE. On any failure it reports blockers to the
  // Reviewer (the re-approval authority) and waits — it never self-diagnoses or
  // self-approves. This replaced the former conflict loop + Category A–F
  // self-diagnosis.

  test('merger role: merge only, never approve/push/resolve', () => {
    const text = PR_MERGE_POST_APPROVAL_INSTRUCTIONS;
    expect(text).toContain('Your ONLY job is to merge the PR');
    expect(text).toContain('NO review authority');
    expect(text).toContain('never approve');
    expect(text).not.toContain('approve_task');
    expect(text).not.toContain('mark_complete');
  });

  test('runtime tokens are present; the legacy reviewer-name label is gone', () => {
    const text = PR_MERGE_POST_APPROVAL_INSTRUCTIONS;
    expect(text).toContain('{{pr_url}}');
    expect(text).toContain('{{approval_source}}');
    expect(text).toContain('{{workspace_path}}');
    expect(text).not.toContain('{{autonomy_level}}');
    expect(text).not.toContain('[end-node reviewer]');
  });

  test('on merge failure, reports blockers to the Reviewer and waits', () => {
    const text = PR_MERGE_POST_APPROVAL_INSTRUCTIONS;
    expect(text).toContain('send_message(target="Review"');
    expect(text).toContain('reason: "merge_blocked"');
    expect(text).toContain('blockers:');
    expect(text).toContain('headRefOid');
    expect(text).toContain('WAIT for the Reviewer');
  });

  test('on Reviewer continue, re-verifies approval covers current head then retries', () => {
    const text = PR_MERGE_POST_APPROVAL_INSTRUCTIONS;
    expect(text).toContain('review now COVERS the current');
    expect(text).toContain('equals the current headRefOid');
    expect(text).toContain('re-attempt');
    expect(text).toContain('gh pr merge {{pr_url}} --squash');
  });

  test('escalates to space-agent only on cycle-cap or unresolvable blocker', () => {
    const text = PR_MERGE_POST_APPROVAL_INSTRUCTIONS;
    expect(text).toContain('send_message(target="space-agent"');
    expect(text).toContain('type: "merge_blocked"');
    expect(text).toContain('exit_reason');
    expect(text).toContain('Do NOT mark the task complete');
  });

  test('preserved: squash merge, branch deletion (separate step, fork guard), audit artifact', () => {
    const text = PR_MERGE_POST_APPROVAL_INSTRUCTIONS;
    expect(text).toContain('gh pr merge {{pr_url}} --squash');
    expect(text).not.toContain('--delete-branch');
    expect(text).toContain('HEAD_REF=$(gh pr view');
    expect(text).toContain('IS_FORK=');
    expect(text).toContain('git push origin --delete');
    expect(text).toMatch(/BEST-EFFORT/);
    expect(text).toContain('type: "result"');
  });

  test('preserved: root-repo sync uses {{workspace_path}}, branch-agnostic $BASE', () => {
    const text = PR_MERGE_POST_APPROVAL_INSTRUCTIONS;
    expect(text).toContain("SPACE_WS='{{workspace_path}}'");
    expect(text).toMatch(/git -C "\$SPACE_WS" pull --ff-only/);
    expect(text).toContain('--jq .baseRefName');
    expect(text).toContain('$BASE');
    expect(text).not.toMatch(/origin\/dev\b/);
  });

  test('preserved: review-thread resolution check before merge (paginate, host)', () => {
    const text = PR_MERGE_POST_APPROVAL_INSTRUCTIONS;
    expect(text).toContain('gh pr checks');
    expect(text).toContain('reviewThreads(first:100');
    expect(text).toContain('isResolved=false');
    expect(text).toContain('NOT allowed');
    expect(text).toContain('$cursor');
    expect(text).toContain('endCursor');
    expect(text).toContain('hasNextPage');
    expect(text).toContain('Do NOT stop at the first page');
    expect(text).toContain('--hostname');
    expect(text).toContain('<host>');
  });

  test('old elaborate self-diagnosis is gone (no Category A–F / conflict loop / merger-approves)', () => {
    const text = PR_MERGE_POST_APPROVAL_INSTRUCTIONS;
    expect(text).not.toContain('Category A');
    expect(text).not.toContain('conflict-loop step e');
    expect(text).not.toContain('approved_head_oid');
    expect(text).not.toContain('merge_conflict_loop');
    // The merger never posts a review — that is the Reviewer's job now.
    expect(text).not.toContain('post a fresh APPROVED review');
    expect(text).not.toContain('gh pr merge --queue');
  });
});
