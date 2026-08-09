/**
 * End-node handoff prompt tests
 *
 * Verifies that every built-in workflow's end-node `customPrompt` agrees with
 * the post-approval routing contract:
 *
 *   - The stable Coding / Coding-with-QA / Research workflows route the
 *     post-approval merge back to the implementer (coder / research) slot via
 *     a node-level `postApproval: { targetAgent: 'coder'|'research',
 *     instructions: <merge template> }`. There is no dedicated merger agent.
 *
 *   - The merge template is `CODER_OWNED_MERGE_INSTRUCTIONS` (the implementer
 *     merges via `gh pr merge` after verifying current-head approval).
 *
 *   - Review-Only intentionally does NOT declare `postApproval` (no PR to
 *     merge).
 *
 *   - Plan & Decompose is unchanged: it closes on its own end-node directive
 *     (verify-tasks-created) and has no `postApproval` route.
 *
 * These tests protect against silent regressions where someone edits an end-
 * node prompt and accidentally removes the runtime-owned post-approval handoff,
 * adds a `gh pr merge` back into QA, or drops one of the `postApproval` routes.
 */

import { describe, test, expect } from 'bun:test';
import type { SpaceWorkflow } from '@hyperneo/shared';
import {
  CODING_WORKFLOW,
  CODING_WITH_QA_WORKFLOW,
  PLAN_AND_DECOMPOSE_WORKFLOW,
  RESEARCH_WORKFLOW,
  REVIEW_ONLY_WORKFLOW,
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import { CODER_OWNED_MERGE_INSTRUCTIONS } from '../../../../src/lib/space/workflows/post-approval-merge-template.ts';
import { interpolatePostApprovalTemplate } from '../../../../src/lib/space/workflows/post-approval-template.ts';
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
  // it (the implementer / Coding or Research node for the coder-owned
  // workflows), and the router fans out to it regardless of which node
  // submitted.
  return wf.nodes.find((node) => node.postApproval)?.postApproval;
}

/** Workflows whose implementer node declares a coder-owned merge route. */
const IMPLEMENTER_ROUTED_WORKFLOWS: Array<[string, SpaceWorkflow, string]> = [
  ['CODING_WORKFLOW', CODING_WORKFLOW, 'coder'],
  ['CODING_WITH_QA_WORKFLOW', CODING_WITH_QA_WORKFLOW, 'coder'],
  ['RESEARCH_WORKFLOW', RESEARCH_WORKFLOW, 'research'],
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
  test('stable Coding routes post-approval to its coder slot', () => {
    expect(postApprovalRoute(CODING_WORKFLOW)).toEqual({
      targetAgent: 'coder',
      instructions: CODER_OWNED_MERGE_INSTRUCTIONS,
    });
  });

  test('stable Coding-with-QA routes post-approval to its coder slot', () => {
    expect(postApprovalRoute(CODING_WITH_QA_WORKFLOW)).toEqual({
      targetAgent: 'coder',
      instructions: CODER_OWNED_MERGE_INSTRUCTIONS,
    });
  });

  // No workflow carries the dedicated Post-Approval merger node anymore.
  for (const [label, wf] of IMPLEMENTER_ROUTED_WORKFLOWS) {
    test(`${label} routes post-approval to a real implementer slot (no merger node)`, () => {
      const route = postApprovalRoute(wf);
      expect(route).toBeDefined();
      // Coder-owned merge instructions (the implementer merges via gh pr merge
      // after verifying current-head approval).
      expect(route!.instructions).toBe(CODER_OWNED_MERGE_INSTRUCTIONS);
      expect(wf.nodes.map((node) => node.name)).not.toContain('Post-Approval');
      expect(wf.nodes.flatMap((node) => node.agents).some((agent) => agent.name === 'merger')).toBe(
        false
      );
      const targetSlot = wf.nodes
        .flatMap((node) => node.agents)
        .find((agent) => agent.name === route!.targetAgent);
      expect(targetSlot).toBeDefined();
    });
  }

  for (const [label, wf] of NO_POST_APPROVAL_WORKFLOWS) {
    test(`${label} has NO postApproval route (end node closes directly)`, () => {
      expect(wf.postApproval).toBeUndefined();
      expect(postApprovalRoute(wf)).toBeUndefined();
    });
  }

  // The implementer's post-approval blocker reports must be deliverable to the
  // approval authority over the workflow's channel topology — otherwise
  // ChannelResolver.canSend rejects the send and the approved task stalls.
  test('Coding implementer can reach the Review approval authority', () => {
    const resolver = new ChannelResolver(CODING_WORKFLOW.channels ?? []);
    expect(resolver.canSend('Coding', 'Review')).toBe(true);
  });

  test('Coding-with-QA implementer can reach the QA approval authority', () => {
    const resolver = new ChannelResolver(CODING_WITH_QA_WORKFLOW.channels ?? []);
    expect(resolver.canSend('Coding', 'QA')).toBe(true);
  });

  test('Research implementer can reach the Review approval authority', () => {
    const resolver = new ChannelResolver(RESEARCH_WORKFLOW.channels ?? []);
    expect(resolver.canSend('Research', 'Review')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-node prompt — runtime-owned post-approval data handoff
// ---------------------------------------------------------------------------

describe('End-node prompts save runtime post-approval data before approve_task', () => {
  for (const [label, wf] of IMPLEMENTER_ROUTED_WORKFLOWS) {
    test(`${label} end-node prompt instructs the agent to record the PR and not relay to the task-agent`, () => {
      const prompt = endNodePrompt(wf);
      // Every PR-producing workflow must instruct its end-node agent to record
      // the PR (a link artifact) so post-approval dispatch can resolve it. The
      // stable behavioral prompts phrase this as prose ("save the PR link
      // artifact"), the merger-era prompts as `save_artifact({...})` — accept
      // either.
      expect(prompt).toMatch(/save_artifact|save the PR link/);
      expect(prompt).toContain('approve_task');
      expect(prompt).not.toContain('target: "task-agent"');
    });

    test(`${label} end-node prompt places the record-PR step BEFORE the final approve_task call`, () => {
      const prompt = endNodePrompt(wf);
      // The end node must record the PR before the final approve_task — the
      // approval fires PostApprovalRouter.route, which reads the PR URL the end
      // node just stashed. Anchor on the "save the PR link"/save_artifact
      // instruction and the (last) approve_task occurrence.
      const signalIdx = Math.max(
        prompt.lastIndexOf('save_artifact('),
        prompt.lastIndexOf('save the PR link')
      );
      const approveIdx = prompt.lastIndexOf('approve_task');
      expect(signalIdx).toBeGreaterThan(-1);
      expect(approveIdx).toBeGreaterThan(-1);
      expect(signalIdx).toBeLessThan(approveIdx);
    });

    test(`${label} end-node prompt instructs the agent NOT to merge itself`, () => {
      const prompt = endNodePrompt(wf);
      // The end-node agent (Reviewer / QA) is the approval authority, not the
      // merger — it must be told explicitly not to merge.
      const mentionsSelfMergeWarning =
        prompt.includes('Do NOT attempt to merge the PR yourself') ||
        prompt.includes('Do NOT run `gh pr merge`') ||
        prompt.includes('Do NOT merge the PR yourself') ||
        prompt.includes('Do not merge');
      expect(mentionsSelfMergeWarning).toBe(true);
    });
  }

  test('CODING_WORKFLOW end-node prompt gates approval on resolved review threads', () => {
    const prompt = endNodePrompt(CODING_WORKFLOW);
    expect(prompt).toContain('all review threads are resolved');
  });
});

// ---------------------------------------------------------------------------
// Merge template (implementer-owned, bash-based)
// ---------------------------------------------------------------------------

describe('Implementer merge template (verify current-head approval, then gh pr merge)', () => {
  test('verifies CI, threads, and current-head approval before merging', () => {
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('required CI / checks are passing');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('zero unresolved review conversations');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('covers the current head');
  });

  test('merges via gh pr merge bound to the verified head', () => {
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('--squash --match-head-commit');
  });

  test('verifies a real approval covers the current head via the review-threads GraphQL query', () => {
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('reviewThreads(first:100');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('isResolved=false');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('Recommendation: APPROVE');
  });

  test('does not instruct a raw unbounded merge poll', () => {
    // Step 2b must not poll `--json state` alone (it can't see a failed
    // merge-group check, which leaves the PR OPEN) nor loop forever.
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('mergeStateStatus');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).not.toMatch(/--json state --jq \.state/);
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toMatch(/~10 attempts|up to ~10/);
  });

  test('runtime tokens are present', () => {
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('{{pr_url}}');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('{{approval_source}}');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('{{workspace_path_sh}}');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('{{approval_authority}}');
  });

  test('on a blocker, either fixes it or reports to the approval authority and waits', () => {
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'send_message(target="{{approval_authority}}"'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('reason: "merge_blocked"');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('reason: "merge_fix_pushed"');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('headRefOid');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'until {{approval_authority}} tells you to continue'
    );
  });

  test('escalates to space-agent only on cycle-cap or unresolvable blocker', () => {
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('send_message(target="space-agent"');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('shape: "note", kind: "merge_blocked"');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('exit_reason');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('Do NOT mark the task complete');
  });

  test('preserved: branch deletion separate step; audit artifact', () => {
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('HEAD_REF=$(gh pr view');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('IS_FORK=');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('git push origin --delete');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toMatch(/BEST-EFFORT/);
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('shape: "link", kind: "merge"');
  });

  test('preserved: root-repo sync uses {{workspace_path_sh}}, branch-agnostic $BASE', () => {
    // `{{workspace_path_sh}}` renders as a single-quote-escaped shell literal
    // (the derived token), so the template line must NOT wrap it in quotes.
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('SPACE_WS={{workspace_path_sh}}');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toMatch(/git -C "\$SPACE_WS" pull --ff-only/);
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('--jq .baseRefName');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('$BASE');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('space-checkout-ahead');
  });
});

// ---------------------------------------------------------------------------
// Legacy merge instructions removed from QA end node
// ---------------------------------------------------------------------------

describe('Merge/worktree instructions removed from QA end node', () => {
  test('CODING_WITH_QA_WORKFLOW QA prompt does NOT embed gh pr merge', () => {
    const prompt = endNodePrompt(CODING_WITH_QA_WORKFLOW);
    const bareMergeMatches = prompt.match(/gh pr merge/g) ?? [];
    const prohibitions = prompt.match(/Do NOT run `gh pr merge`/g) ?? [];
    expect(bareMergeMatches.length).toBe(prohibitions.length);
  });

  test('CODING_WITH_QA_WORKFLOW QA prompt does NOT instruct worktree sync', () => {
    const prompt = endNodePrompt(CODING_WITH_QA_WORKFLOW);
    expect(prompt).not.toContain('git pull --ff-only');
    expect(prompt).not.toContain('git checkout dev');
  });

  test('CODING_WITH_QA_WORKFLOW completionAutonomyLevel is 3', () => {
    expect(CODING_WITH_QA_WORKFLOW.completionAutonomyLevel).toBe(3);
  });
});

describe('Review-Only end-node prompt loses verification boilerplate', () => {
  test('REVIEW_ONLY_WORKFLOW prompt does NOT claim "runtime verifies"', () => {
    const prompt = endNodePrompt(REVIEW_ONLY_WORKFLOW);
    expect(prompt).not.toContain('runtime verifies');
    expect(prompt).not.toContain('before accepting completion');
  });

  test('REVIEW_ONLY_WORKFLOW prompt still requires a visible review before approve_task', () => {
    const prompt = endNodePrompt(REVIEW_ONLY_WORKFLOW);
    expect(prompt).toContain('post a visible GitHub review');
    expect(prompt).toContain('save_artifact');
    expect(prompt).toContain('approve_task()');
  });
});

describe('Plan & Decompose end-node is unchanged', () => {
  test('PLAN_AND_DECOMPOSE_WORKFLOW Task Dispatcher prompt does NOT signal the task-agent', () => {
    const prompt = endNodePrompt(PLAN_AND_DECOMPOSE_WORKFLOW);
    expect(prompt).not.toContain('send_message');
  });

  test('PLAN_AND_DECOMPOSE_WORKFLOW Task Dispatcher still calls create_standalone_task + approve_task', () => {
    const prompt = endNodePrompt(PLAN_AND_DECOMPOSE_WORKFLOW);
    expect(prompt).toContain('create_standalone_task');
    expect(prompt).toContain('approve_task');
  });
});
