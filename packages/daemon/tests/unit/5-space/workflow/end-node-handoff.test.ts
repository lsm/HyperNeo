import { describe, test, expect } from 'bun:test';
import type { SpaceWorkflow } from '@hyperneo/shared';
import {
  CODING_WORKFLOW,
  CODING_WITH_QA_WORKFLOW,
  RESEARCH_WORKFLOW,
  REVIEW_ONLY_WORKFLOW,
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import { CODER_OWNED_MERGE_INSTRUCTIONS } from '../../../../src/lib/space/workflows/post-approval-merge-template.ts';
import { interpolatePostApprovalTemplate } from '../../../../src/lib/space/workflows/post-approval-template.ts';
import { ChannelResolver } from '../../../../src/lib/space/runtime/channel-resolver.ts';

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
  return wf.nodes.find((node) => node.postApproval)?.postApproval;
}

const IMPLEMENTER_ROUTED_WORKFLOWS: Array<[string, SpaceWorkflow, string]> = [
  ['CODING_WORKFLOW', CODING_WORKFLOW, 'coder'],
  ['CODING_WITH_QA_WORKFLOW', CODING_WITH_QA_WORKFLOW, 'coder'],
  ['RESEARCH_WORKFLOW', RESEARCH_WORKFLOW, 'research'],
];

const NO_POST_APPROVAL_WORKFLOWS: Array<[string, SpaceWorkflow]> = [
  ['REVIEW_ONLY_WORKFLOW', REVIEW_ONLY_WORKFLOW],
];

describe('Post-approval route declarations', () => {
  test('stable Coding routes post-approval to its coder slot', () => {
    expect(postApprovalRoute(CODING_WORKFLOW)).toEqual({
      targetAgent: 'coder',
      instructions: CODER_OWNED_MERGE_INSTRUCTIONS,
      requirePrMerge: true,
    });
  });

  test('stable Coding-with-QA routes post-approval to its coder slot', () => {
    expect(postApprovalRoute(CODING_WITH_QA_WORKFLOW)).toEqual({
      targetAgent: 'coder',
      instructions: CODER_OWNED_MERGE_INSTRUCTIONS,
      requirePrMerge: true,
    });
  });

  for (const [label, wf] of IMPLEMENTER_ROUTED_WORKFLOWS) {
    test(`${label} routes post-approval to a real implementer slot (no merger node)`, () => {
      const route = postApprovalRoute(wf);
      expect(route).toBeDefined();
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

describe('End-node prompts save runtime post-approval data before approve_task', () => {
  for (const [label, wf] of IMPLEMENTER_ROUTED_WORKFLOWS) {
    test(`${label} end-node prompt instructs the agent to record the PR and not relay to the task-agent`, () => {
      const prompt = endNodePrompt(wf);
      expect(prompt).toMatch(/save_artifact|save the PR link/);
      expect(prompt).toContain('approve_task');
      expect(prompt).not.toContain('target: "task-agent"');
    });

    test(`${label} end-node prompt places the record-PR step BEFORE the final approve_task call`, () => {
      const prompt = endNodePrompt(wf);
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
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'the changed PR must go through Review BEFORE any re-approval'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'Review re-reviews the changed head first, then {{approval_authority}} re-approves'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      "never substitutes for the review source's gate on a changed head"
    );
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
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('SPACE_WS={{workspace_path_sh}}');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toMatch(/git -C "\$SPACE_WS" pull --ff-only/);
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('--jq .baseRefName');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('$BASE');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('space-checkout-ahead');
  });
});

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
