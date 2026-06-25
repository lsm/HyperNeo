/**
 * End-node handoff prompt tests (PR 3/5, updated in PR 5/5)
 *
 * Verifies that every built-in workflow's end-node `customPrompt` agrees with
 * the post-approval routing contract:
 *
 *   - Coding / Research / QA end nodes each save a result artifact carrying
 *     `data.pr_url` BEFORE calling `approve_task`. These three terminal nodes
 *     MUST also declare a node-level
 *     `postApproval: { targetAgent: 'reviewer', instructions: <merge template> }`
 *     route so the runtime dispatches the merge. PR 5/5 removed the legacy
 *     `post_approval_action: "merge_pr"` discriminator from the data payload —
 *     post-approval routing is now fully declarative on the terminal node's
 *     `postApproval` field and nothing consumed the runtime discriminator.
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
import type { SpaceWorkflow } from '@neokai/shared';
import {
  CODING_WORKFLOW,
  FULLSTACK_QA_LOOP_WORKFLOW,
  PLAN_AND_DECOMPOSE_WORKFLOW,
  RESEARCH_WORKFLOW,
  REVIEW_ONLY_WORKFLOW,
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import { PR_MERGE_POST_APPROVAL_INSTRUCTIONS } from '../../../../src/lib/space/workflows/post-approval-merge-template.ts';

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

function endNodePostApproval(wf: SpaceWorkflow) {
  const endNode = wf.nodes.find((node) => node.id === wf.endNodeId);
  return endNode?.postApproval;
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

describe('End-node post-approval declarations', () => {
  for (const [label, wf] of MERGE_ROUTED_WORKFLOWS) {
    test(`${label} declares node-level postApproval targeting the reviewer role`, () => {
      const route = endNodePostApproval(wf);
      expect(route).toBeDefined();
      expect(route!.targetAgent).toBe('reviewer');
      // Uses the merge prompt. The runtime appends the
      // shared mark_complete instruction separately.
      expect(route!.instructions).toBe(PR_MERGE_POST_APPROVAL_INSTRUCTIONS);
      expect(wf.postApproval).toBeUndefined();
    });

    test(`${label} postApproval targetAgent matches an actual agent name in the workflow`, () => {
      const route = endNodePostApproval(wf);
      const reviewerAgent = wf.nodes
        .flatMap((n) => n.agents)
        .find((a) => a.name === route!.targetAgent);
      expect(reviewerAgent).toBeDefined();
    });
  }

  for (const [label, wf] of NO_POST_APPROVAL_WORKFLOWS) {
    test(`${label} has NO postApproval route (end node closes directly)`, () => {
      expect(wf.postApproval).toBeUndefined();
      expect(endNodePostApproval(wf)).toBeUndefined();
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

  test('conflict-resolution diff is inspected before retrying the merge', () => {
    // The approval covered the pre-conflict head; a bad conflict resolution can
    // pass CI, so the reviewer must inspect the conflict-fix diff and only
    // merge when the resolution is sound.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/approval no longer covers/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/inspect the conflict-resolution diff/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/request changes from the coder/);
  });

  test('exhausted retries escalate to space-agent with real count/exit reason (no false completion)', () => {
    // The post-approval node-agent surface has no block/request-human tool, so
    // escalation is a result artifact + space-agent message; the task must NOT
    // be marked complete (the PR is not merged).
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('request_human_input');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('do NOT mark the task complete');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('exit_reason');
    // The escalation must report the real attempt count, not a hard-coded 2 —
    // the loop can end early via a cycle-cap rejection before 2 attempts.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('unresolved after 2 coder attempts');
  });

  test('conflict detection keys on DIRTY mergeStateStatus and conflict markers', () => {
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('mergeStateStatus: DIRTY');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/conflict markers/);
  });

  test('coder handoff includes review_url so review-posted-gate opens', () => {
    // Review → Coding is gated by review-posted-gate, which requires BOTH
    // pr_url and review_url (writers: Review) and resets each cycle. A conflict
    // handoff carrying only pr_url would be blocked, so the coder would never
    // receive the rebase request. The payload must carry review_url too.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('review-posted-gate');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('requires both `pr_url`');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('review_url: "<approval review url>"');
  });

  test('coder handoff carries PR URL, base branch, and conflicting files', () => {
    // The send_message payload to the coder must include everything the coder
    // needs to rebase and resolve.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('base_branch: "dev"');
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
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('origin/dev');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/resolve the listed conflicts/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/run the tests/);
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/report back to Review/);
  });

  test('retry is capped at 2 coder attempts before space-agent escalation', () => {
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toMatch(/maximum 2 coder attempts/);
    // Escalation target after the cap is space-agent, not a human.
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('send_message(target="space-agent"');
    // The "do NOT escalate to a human" directive precedes the space-agent
    // escalation — i.e. the first reaction to a conflict is coder routing,
    // and space-agent escalation only appears later (after the retry cap).
    const noHumanIdx = PR_MERGE_POST_APPROVAL_INSTRUCTIONS.indexOf('do NOT escalate to a');
    const escalateIdx = PR_MERGE_POST_APPROVAL_INSTRUCTIONS.indexOf('escalate to space-agent');
    expect(noHumanIdx).toBeGreaterThan(-1);
    expect(escalateIdx).toBeGreaterThan(noHumanIdx);
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
