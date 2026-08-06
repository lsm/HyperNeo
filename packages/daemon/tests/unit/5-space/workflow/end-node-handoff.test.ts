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

describe('Shared merge template canonical content', () => {
  test('template references the documented §1.6 runtime tokens', () => {
    // The merge template is interpolated by
    // post-approval-template.ts::interpolatePostApprovalTemplate at routing
    // time. These are the runtime-populated tokens the plan guarantees (see
    // post-approval-merge-template.ts header).
    //
    // `{{reviewer_name}}` is intentionally NOT in the set: see the file-level
    // NOTE in post-approval-merge-template.ts. It was collapsed to the
    // static label `[end-node reviewer]` in PR 3/5 because nothing in
    // `dispatchPostApproval` populates `routeContext.reviewer_name`, and
    // leaving a literal placeholder in the kickoff degrades the reviewer
    // sub-session. A follow-up PR will thread the approving agent's slot
    // name through and restore the token.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('{{pr_url}}');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('{{approval_source}}');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('{{autonomy_level}}');
    // Locked: `{{reviewer_name}}` must NOT appear — swap to static label.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('{{reviewer_name}}');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('[end-node reviewer]');
  });

  test('merge template does not include the runtime-owned completion step', () => {
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('mark_complete');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('approve_task');
  });

  test('merge template does not ask for redundant approval after task approval', () => {
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('Approve merging PR');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('approval_source != "human"');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('autonomy_level < 4');
  });

  test('merge template does not auto-resolve review conversations', () => {
    // The merge template must NOT instruct the reviewer to resolve threads
    // with the resolveReviewThread mutation — auto-merge is not allowed.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('resolveReviewThread');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('auto-resolve');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('NOT allowed');
  });

  test('template contains the squash-merge command and conflict guard', () => {
    // Specific command shapes: protects against well-intentioned edits
    // that swap `--squash` for `--merge` or drop the conflict guard.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('gh pr merge {{pr_url}} --squash');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('--delete-branch');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('merge conflict');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('do NOT force');
  });

  test('remote branch deletion is a separate step after merge, no delete flag on merge', () => {
    // Owner-requested: after a successful squash-merge, delete the PR remote
    // branch via a SEPARATE command. The merge command must never carry a
    // delete flag.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('gh pr merge {{pr_url}} --squash');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain(
      'gh pr merge {{pr_url}} --squash --delete-branch'
    );
    // Separate delete step using the PR head branch name.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('headRefName');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('git push origin --delete');
    // Forked PR heads live in the fork — guard deletion to same-repo heads.
    // HEAD_REF and IS_FORK must be assigned (via --jq) before the delete, not
    // left as unset shell variables.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('isCrossRepository');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('HEAD_REF=$(gh pr view');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('IS_FORK=');
    // Branch cleanup is best-effort: a failed delete (protected branch, missing
    // permission) must NOT block completion after the PR is already merged.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/BEST-EFFORT/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/do NOT let a/);
    // The delete step must come AFTER the merge command.
    const mergeIdx = PR_MERGE_POST_APPROVAL_INSTRUCTIONS.indexOf('gh pr merge {{pr_url}} --squash');
    const deleteIdx = PR_MERGE_POST_APPROVAL_INSTRUCTIONS.indexOf('git push origin --delete');
    expect(mergeIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(mergeIdx);
  });

  test('root-repo sync uses the supplied workspace path, not git inference or a literal', () => {
    // Regression history for step 5's Space-checkout path:
    //  - Round 1 referenced the worktree-isolation banner + a literal `<mainRepoPath>`.
    //    Broken: the post-approval session has no `session.worktree` (worker sub-session
    //    via createCustomAgentInit carries only workspacePath), so the banner is never
    //    appended, and `<mainRepoPath>` is NOT an interpolation token (only `{{...}}` is).
    //  - Round 2 derived the path from `git rev-parse --git-common-dir`. ALSO broken:
    //    that resolves to the shared main-repo `.git`, whose parent is a DIFFERENT
    //    checkout when the Space workspace is itself a linked worktree — so it syncs the
    //    main repo and leaves the actual Space checkout (what createTaskWorktree bases
    //    future task worktrees on, via `git worktree add … HEAD` with cwd=workspacePath)
    //    stale. The configured workspace path is already threaded into the post-approval
    //    context as {{workspace_path}} (PostApprovalRouteContext.workspace_path =
    //    space.workspacePath), so the template must use that token directly.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain(
      'handled outside the isolated worktree'
    );
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('<mainRepoPath>');
    // The git-inferred $ROOT derivation is gone; use the supplied workspace token.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('$ROOT');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain("SPACE_WS='{{workspace_path}}'");
    // The verbatim-interpolated path must be SINGLE-quoted so shell metacharacters in it
    // ($, backticks, $(), \) are not re-expanded at assignment — double quotes would expand them.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('SPACE_WS="{{workspace_path}}"');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/git -C "\$SPACE_WS" pull --ff-only/);
    // Guards: refuse to pull into a non-base branch, and refuse to claim sync when
    // local $BASE is ahead of origin/$BASE ("Already up to date" hides stray commits).
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('rev-parse --abbrev-ref HEAD');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/space \$BASE ahead of origin\/\$BASE/);
  });

  test('merge template is branch-agnostic — base derived from the PR, no hard-coded dev', () => {
    // These are PRODUCT built-ins: the same Coding/Research/QA workflows ship with
    // HyperNeo and run against arbitrary user repos (dev/main/master/release-...).
    // A hard-coded `dev` breaks any repo whose base branch differs, so the template
    // must derive the base from the PR's baseRefName (the branch it merges INTO —
    // not the repo default, which can differ, e.g. a release branch) and use $BASE
    // everywhere. Guards against regressing to a literal dev/origin/dev.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('--jq .baseRefName');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toMatch(/origin\/dev\b/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('$BASE');
  });
});

// ---------------------------------------------------------------------------
// Merge-conflict routing: reviewer routes conflicts to the coder, not a human
// ---------------------------------------------------------------------------

describe('Post-approval merge conflict routes to coder, not human', () => {
  test('first conflict is routed to the upstream coder, not a human', () => {
    // The old template told the reviewer to call request_human_input on a
    // conflict ("let the human resolve"). That path is gone: a conflict ALONE
    // routes to the coder.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('let the human resolve');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/do NOT escalate to a\s+human/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('list_reachable_agents');
    // request_human_input is NOT on the post-approval node-agent surface (only
    // the Task Agent surface registers it), so the template must never instruct
    // calling it — otherwise the reviewer invokes a tool it does not have.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('request_human_input');
  });

  test('full conflict-fix delta is inspected before retrying the merge', () => {
    // The approval covered the pre-conflict head; a bad conflict resolution can
    // pass CI, so the reviewer must inspect the FULL delta (fetching the
    // current PR head, not local HEAD) against approved_head_oid and only merge
    // when it is sound.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/approval no longer covers/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/FULL delta against the/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('CUR_HEAD=');
    // The PR head object must be fetched (refs/pull/<number>/head), not just
    // the OID — otherwise merge-tree/diff hit an unknown object after a restart.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('refs/pull/<number>/head');
    // The OLD approved head must also be fetched before the diff — it may no
    // longer be local after a restart/cache miss.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain(
      '"$APPROVED_HEAD_OID" "refs/pull/<number>/head"'
    );
    // A request-changes on a bad fix posts a formal CHANGES_REQUESTED review for
    // non-own PRs (the gate requires it); PR-comment fallback is own-PR only.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('CHANGES_REQUESTED');
    // If a CHANGES_REQUESTED was posted in this loop and is now resolved, post
    // a fresh APPROVED before retrying (required-review repos block otherwise).
    // Any conflict-fix force-push can dismiss stale approvals, so re-approve on
    // EVERY retry — not only after a CHANGES_REQUESTED.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/fresh APPROVED/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/every retry/);
  });

  test('exhausted retries escalate to space-agent with real count/exit reason (no false completion)', () => {
    // The post-approval node-agent surface has no block/request-human tool, so
    // escalation is a non-result artifact + space-agent message; the task must
    // NOT be marked complete (the PR is not merged).
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('request_human_input');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('do NOT mark the task complete');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('exit_reason');
    // The escalation artifact must NOT be a "result" artifact — mark_complete
    // picks up the latest result-artifact summary as the task result, so a
    // "Merge unresolved" result would poison a later completion. It uses a
    // dedicated non-result type instead (the step-6 success artifact is the
    // only "result" artifact, and it carries data, not a failure summary).
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('type: "merge_blocked"');
    // The escalation must report the real attempt count, not a hard-coded 2 —
    // the loop can end early via a cycle-cap rejection before 2 attempts.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('unresolved after 2 coder attempts');
  });

  test('review_url lookup paginates, passes the host, and falls back to PR comments', () => {
    // gh pr view --json reviews exposes no URL; the REST reviews API must be
    // paginated (--paginate, default per_page hides older approvals) and use the
    // same <host> step 2 extracts for GitHub Enterprise. Own-PR setups may have
    // only a COMMENTED review or a PR comment, so accept COMMENTED reviews and
    // fall back to the (paginated) comment URL.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('--hostname <host>');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('--paginate');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/APPROVED or COMMENTED/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('/issues/<number>/comments');
    // The merger runs in the Post-Approval node and routes conflicts over the
    // ungated Post-Approval → <upstream> channel, so no review_url is needed
    // for the handoff (review-posted-gate guards the Review phase, not this
    // post-approval loop). The gated-lookup block is retained defensively.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('list_channels');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/Post-Approval → <upstream node>/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/UNGATED/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/ONLY when the route is gated/);
  });

  test('request-changes handoff posts fresh formal evidence', () => {
    // The "request changes" send after a bad conflict fix travels the same
    // Review → Coding channel (review-posted-gate, resetOnCycle). For non-own
    // PRs the gate requires a formal CHANGES_REQUESTED review; the PR-comment
    // fallback is own-PR only. Evidence must be fresh, not the prior approval.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/fresh formal CHANGES_REQUESTED/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/fresh PR comment/);
    // The bad-fix handoff must re-supply pr_url on every send (the conflict
    // route is ungated, so no review_url is needed).
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/always re-supply/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/pr_url/);
  });

  test('conflict detection keys on DIRTY mergeStateStatus and conflict markers', () => {
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('mergeStateStatus: DIRTY');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/conflict markers/);
  });

  test('coder handoff carries pr_url over the ungated Post-Approval route (no review_url required)', () => {
    // The merger runs in the Post-Approval node; its conflict handoff to the
    // coder travels the ungated Post-Approval → <upstream> channel, so it only
    // needs pr_url — NOT review_url. (Before the role split the merge ran as
    // the reviewer in the Review node, whose Review → Coding channel was gated
    // by review-posted-gate and so required review_url; that no longer applies.)
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('pr_url: "{{pr_url}}"');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/Post-Approval → <upstream node>/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/UNGATED/);
  });

  test('coder handoff carries PR URL, base branch, and conflicting files', () => {
    // The send_message payload to the coder must include everything the coder
    // needs to rebase and resolve.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('base_branch: "<base branch>"');
    // $BASE is a shell variable — invalid inside a tool-call (MCP/JSON) payload, where it
    // would be sent literally. The base_branch field must use the resolved-value placeholder.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toMatch(/base_branch: "\$BASE"/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('conflicting_files');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('reason: "merge_conflict"');
  });

  test('conflict files are derived from the merge output, not PR file list', () => {
    // `gh pr view --json files` lists every PR file, not the conflict subset —
    // using it would hand the coder every changed file. Derive actual conflict
    // paths from the merge failure output / a merge-tree trial instead.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('--json headRefName,files');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('merge-tree');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/Do NOT use/);
  });

  test('coder is told to rebase, resolve, test, push, then report back', () => {
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/Rebase onto latest/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('origin/$BASE');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/resolve the listed conflicts/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/run the tests/);
    // A rebase rewrites commits already on the remote PR branch, so a plain push
    // is rejected — the coder must use --force-with-lease to publish the fix.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('--force-with-lease');
    // The reactivated coder must NOT complete the task — only the Reviewer
    // merges/closes. mark_complete is mirrored on every node-agent session, so
    // the handoff must forbid it explicitly.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/Do NOT mark the task complete/);
    // The coder reports back to the merger (Post-Approval), not "Review" — the
    // merger lives in its own node now, so a reply addressed to Review would
    // miss it and stall the conflict loop.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/report back to the merger/);
  });

  test('conflict loops continue until merge succeeds; escalation only on non-conflict blocker or cycle cap', () => {
    // Operator direction: there is NO fixed conflict-count cap. New conflicts
    // after a rebase are normal, so the reviewer keeps routing rounds back to
    // the coder until the merge succeeds. The backstop is the channel cycle
    // budget or a genuine non-conflict blocker.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('2-attempt cap');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('after 2 rounds');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/NO fixed conflict-count/);
    // Each failed retry must restart at steps a/b (recompute conflicts + fresh
    // artifact) so a later round never reuses stale conflicting_files.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/RESTART at steps a\/b/);
    // Escalation target is space-agent, not a human, and only on a real
    // non-conflict blocker or cycle-cap — NOT on conflict count.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('send_message(target="space-agent"');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/NON-CONFLICT blocker/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('non_conflict_blocker');
    // The "do NOT escalate to a human" directive precedes the space-agent
    // escalation — the first reaction to a conflict is coder routing.
    const noHumanIdx = PR_MERGE_POST_APPROVAL_INSTRUCTIONS.indexOf('do NOT escalate to a');
    const escalateIdx = PR_MERGE_POST_APPROVAL_INSTRUCTIONS.indexOf('escalate to space-agent');
    expect(noHumanIdx).toBeGreaterThan(-1);
    expect(escalateIdx).toBeGreaterThan(noHumanIdx);
  });

  test('cycle-cap and own-PR fallback handling is robust', () => {
    // The cycle-cap is based on the ACTUAL upstream channel (Post-Approval →
    // Coding or Post-Approval → Research), where the merger routes conflicts.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/Post-Approval → Research/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('list_channels` reports');
    // Re-approval has an own-PR fallback (GitHub blocks self-approval).
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/COMMENT review \/ PR comment/);
    // Cleanup warnings must be a NON-result artifact (no mark_complete poisoning).
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('cleanup_warning');
  });

  test('each conflict attempt is recorded as a workflow artifact (not Forge evidence)', () => {
    // The post-approval reviewer session has node-agent tools only — no
    // add_forge_manual_note — so it cannot create real Forge evidence. The
    // prompt must record a workflow artifact and must not claim Forge evidence.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('merge_conflict_loop');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(
      /save_artifact\(\{ type: "merge_conflict_loop"/
    );
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('workflow artifact');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('Forge evidence');
    // The artifact records the approved head OID (the PR head at conflict time)
    // so the reviewer has a reliable diff base after the coder pushes a fix,
    // and the trial merge uses the PR head, not local HEAD.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('approved_head_oid');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('headRefOid');
  });

  test('pre-merge checks are re-run before retrying; cycle budget and cap handled', () => {
    // A conflict-fix push changes the PR head; the reviewer must re-verify CI
    // and review threads (steps 1 and 2) before retrying the merge.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/Rerun the pre-merge checks/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/do NOT retry the merge immediately/);
    // Conflict handoffs reuse the Review → Coding cycle budget; the prompt must
    // not over-promise 2 attempts when the cycle cap may already be exhausted,
    // and must fall back to space-agent when the cap blocks the handoff.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/cycle cap/);
    // No QA/browser re-run orchestration — there is no QA → Review channel, and
    // that is a workflow-structure concern outside this merge template.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('QA node');
  });

  test('conflict routing ordering: detect -> artifact -> message coder -> wait -> reverify -> retry/escalate', () => {
    const text = PR_MERGE_POST_APPROVAL_INSTRUCTIONS;
    const detectIdx = text.indexOf('mergeStateStatus: DIRTY');
    const artifactIdx = text.indexOf('merge_conflict_loop');
    const coderIdx = text.indexOf('list_reachable_agents');
    const reverifyIdx = text.indexOf('Rerun the pre-merge checks');
    const retryIdx = text.indexOf('re-attempt');
    const escalateIdx = text.indexOf('escalate to space-agent');
    expect(detectIdx).toBeGreaterThan(-1);
    expect(artifactIdx).toBeGreaterThan(detectIdx);
    expect(coderIdx).toBeGreaterThan(artifactIdx);
    expect(reverifyIdx).toBeGreaterThan(coderIdx);
    expect(retryIdx).toBeGreaterThan(reverifyIdx);
    expect(escalateIdx).toBeGreaterThan(retryIdx);
  });
});

// ---------------------------------------------------------------------------
// Non-conflict merge-blocker diagnostic checklist (step 3g → 3h)
// ---------------------------------------------------------------------------

describe('Post-approval merge non-conflict blocker diagnostic checklist', () => {
  test('a non-conflict failure is diagnosed before escalating; never assumed to be a GitHub bug', () => {
    // Task #856: when `gh pr merge` fails for a non-conflict reason the merger
    // must NOT jump straight to space-agent and must NOT assume a "GitHub bug".
    // It runs an exhaustive diagnostic checklist first; escalation (step h) is
    // the last resort.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/genuine NON-CONFLICT blocker/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('Diagnose it by running this checklist');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('NEVER assume a "GitHub bug"');
    const diagnoseIdx = PR_MERGE_POST_APPROVAL_INSTRUCTIONS.indexOf(
      'Diagnose it by running this checklist'
    );
    const escalateIdx = PR_MERGE_POST_APPROVAL_INSTRUCTIONS.indexOf('escalate to space-agent');
    expect(diagnoseIdx).toBeGreaterThan(-1);
    expect(escalateIdx).toBeGreaterThan(diagnoseIdx);
  });

  test('checklist covers all six categories A through F, checked in that order', () => {
    // Category A (branch-protection / ruleset) first, then B, C, D, E, F — as
    // the task's hard rules require ("Run Category A checks first").
    const text = PR_MERGE_POST_APPROVAL_INSTRUCTIONS;
    const aIdx = text.indexOf('Category A — branch-protection / ruleset rules');
    const bIdx = text.indexOf('Category B — PR state:');
    const cIdx = text.indexOf('Category C — review state:');
    const dIdx = text.indexOf('Category D — CI / checks:');
    const eIdx = text.indexOf('Category E — permission/access');
    const fIdx = text.indexOf('Category F — GitHub mechanics');
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(cIdx).toBeGreaterThan(bIdx);
    expect(dIdx).toBeGreaterThan(cIdx);
    expect(eIdx).toBeGreaterThan(dIdx);
    expect(fIdx).toBeGreaterThan(eIdx);
  });

  test('step 1 mergeStateStatus narrows the category before the per-item checks', () => {
    // The diagnostic reuses the mergeStateStatus already fetched in step 1 to
    // jump straight to the right category instead of re-running every check.
    const text = PR_MERGE_POST_APPROVAL_INSTRUCTIONS;
    expect(text).toContain('Re-fetch fresh state FIRST');
    expect(text).toContain('BLOCKED  -> a branch-protection / ruleset rule');
    expect(text).toContain('BEHIND   -> head is behind $BASE');
    expect(text).toContain('UNSTABLE -> a required check is pending or failing');
    // CLEAN means mergeable (rules out A-D) — it is NOT "transient, just retry".
    expect(text).toContain('CLEAN    -> mergeable (rules out Categories A-D)');
    expect(text).toContain('NOT automatically transient');
    // A catch-all row covers the remaining mergeStateStatus values; UNKNOWN is
    // transient (GitHub recomputing) and is retried, not escalated.
    expect(text).toContain('OUT_OF_DATE / HAS_HOOKS');
    expect(text).toContain('recomputing mergeability');
    // DIRTY still routes to the conflict loop (steps a-f), not this checklist.
    const mappingIdx = text.indexOf('DIRTY    -> merge conflict');
    const aIdx = text.indexOf('Category A — branch-protection / ruleset rules');
    expect(mappingIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeGreaterThan(mappingIdx);
  });

  test('checklist includes the concrete diagnostic gh commands', () => {
    // Each category names the exact API/gh command to confirm the blocker —
    // the merger must discover the real cause, not guess.
    const text = PR_MERGE_POST_APPROVAL_INSTRUCTIONS;
    expect(text).toContain('gh pr checks {{pr_url}} --required');
    expect(text).toContain('`gh run rerun <RUN_ID> --failed`');
    expect(text).toContain('--json reviewDecision');
    expect(text).toContain('--json mergeable');
    expect(text).toContain('--json isDraft');
    expect(text).toContain('git log --format=%G?');
    expect(text).toContain('commits/<SHA>/status');
    // B3/B4 use the valid gh JSON fields (headRefName / baseRefName), never the
    // invalid headRef / baseRef (which error with "Unknown JSON field").
    expect(text).toContain('--json headRefName');
    expect(text).toContain('--json baseRefName');
    expect(text).not.toContain('--json headRef`');
    expect(text).not.toContain('--json baseRef`');
    // F1 merge queue: plain --squash enqueues (there is no --queue flag).
    expect(text).toContain('there is NO `--queue` flag');
    expect(text).not.toContain('gh pr merge {{pr_url}} --queue');
  });

  test('diagnostic commands use correct gh semantics (review round 3)', () => {
    // Locks in the bot review fixes — every command the checklist hands the
    // merger must actually work at the shell and route correctly.
    const text = PR_MERGE_POST_APPROVAL_INSTRUCTIONS;
    // B1: `mergeable` is the enum MERGEABLE/CONFLICTING/UNKNOWN (the repo's own
    // pr-ready-validator.ts compares it as strings), never a boolean `false`.
    expect(text).toContain('CONFLICTING — the field is the enum');
    expect(text).not.toContain('--json mergeable` false');
    // A1: only REQUIRED checks (--required); pending -> wait, never rerun and
    // never --auto (which only ENABLES auto-merge and returns pre-merge).
    expect(text).toContain('gh pr checks {{pr_url}} --required');
    expect(text).toContain('IN_PROGRESS / pending, do NOT rerun');
    expect(text).toContain('do NOT enable');
    expect(text).toContain('Only proceed to steps 4-6 once');
    // A9: GitHub verification is authoritative; local %G? depends on this
    // machine's GPG/SSH allowed-signers config and can disagree with GitHub.
    expect(text).toContain('commit.verification.verified');
    expect(text).toContain('disagree with GitHub');
    // C1: aggregate reviewDecision is CHANGES_REQUESTED (NOT REVIEW_REQUIRED —
    // mutually exclusive enum values), superseded only by a later APPROVED.
    expect(text).toContain('CHANGES_REQUESTED (NOT REVIEW_REQUIRED');
    expect(text).toContain('superseded by a later APPROVED');
    // A2: only REVIEW_REQUIRED routes here; CHANGES_REQUESTED defers to C1 so
    // active change requests reach the coder route, not step h.
    expect(text).toContain('skip to C1');
    // F1: merge queue does not recommend --auto (consistent with A1).
    expect(text).toContain('Do NOT add `--auto`');
    // B3: tests the head REF (404 on deletion), not the headRefName string.
    expect(text).toContain('git/refs/heads/<headRefName>');
    // Changed-head: the merger does NOT review/re-approve; it messages the coder
    // and never merges on the stale approval (decision: merger never reviews).
    expect(text).toContain('does NOT review or re-approve');
    expect(text).toContain('does NOT merge on');
    expect(text).toContain('message the coder that their push changed');
    // The guard fires for ANY coder push (category-agnostic), not a few.
    expect(text).toContain('not exhaustive');
    // EXCEPTION covers pending CHECKS and REVIEWS (wait, don't escalate); C2
    // no longer escalates an extra pending review when approvals are met.
    expect(text).toContain('a check or review that is');
    expect(text).toContain('do NOT escalate an extra');
    // Hard rules: an in-flight pending check/review is exempt from "never sit and
    // poll" (waiting for it is correct, not a routeable blocker).
    expect(text).toContain('EXCEPTION');
    // A4: a CODEOWNERS path match alone does not require routing — confirm the
    // review is required AND unsatisfied first.
    expect(text).toContain('REQUIRES owner review (ruleset) AND an owner has');
    // A14: push restrictions CAN block a merge (merging writes to the base
    // branch); only A12/A13 are non-blocking.
    expect(text).toContain('A14 Push restrictions');
    expect(text).toContain('treat as Category E and go to step h');
    // D2: pass the PR hostname so GitHub Enterprise queries the right host.
    expect(text).toContain('gh api --hostname <host> repos/<owner>/<repo>/commits/<SHA>/status');
    // Undeterminable failures (no category match, or a diagnostic API error)
    // fall through to step h instead of looping.
    expect(text).toContain('NO Category A-F item matches');
    expect(text).toContain('go straight to step h');
  });

  test('hard rules are reinforced inside the diagnostic', () => {
    // The merger has no review authority and no admin power; it must not
    // fabricate a resolution while diagnosing.
    const text = PR_MERGE_POST_APPROVAL_INSTRUCTIONS;
    expect(text).toContain('NEVER resolve or dismiss review threads');
    expect(text).toContain('NEVER push commits to the PR branch');
    expect(text).toContain('NEVER approve a PR yourself');
    expect(text).toContain('use `--admin` or ask a human to admin-bypass');
    // It must not sit and poll — route the blocker to an actor.
    expect(text).toContain('never sit and poll');
  });

  test('diagnosed blockers route to the coder or step h; escalation stays the final fallback', () => {
    // Code-work blockers (failing CI after reruns, unsigned commits, stale base,
    // draft, changes-requested) are routed to the coder over the post-approval
    // channel; human/review/operator blockers funnel to step h.
    const text = PR_MERGE_POST_APPROVAL_INSTRUCTIONS;
    expect(text).toContain('message the coder with the failing job');
    expect(text).toContain('go to step h');
    // Step h is gated on step g routing there, a cycle cap, or undeterminable —
    // it must come after the diagnostic and still carry the merge_blocked artifact.
    const gIdx = text.indexOf('g. When the merge fails with a genuine NON-CONFLICT blocker');
    const hIdx = text.indexOf('h. Escalate ONLY when step g routes');
    expect(gIdx).toBeGreaterThan(-1);
    expect(hIdx).toBeGreaterThan(gIdx);
    expect(text).toContain('type: "merge_blocked"');
    expect(text).toContain('send_message(target="space-agent"');
  });
});
