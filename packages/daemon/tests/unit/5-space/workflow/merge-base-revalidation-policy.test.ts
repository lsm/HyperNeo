import { describe, expect, test } from 'bun:test';
import {
  CODER_EXTERNAL_GATE_BLOCK,
  CODER_ONLY_MERGE_INSTRUCTIONS,
  EXTERNAL_REVIEW_BOTS_GUIDANCE,
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import { CODER_OWNED_MERGE_INSTRUCTIONS } from '../../../../src/lib/space/workflows/post-approval-merge-template.ts';
import { REVIEWER_SYSTEM_CONTRACT } from '../../../../src/lib/space/agents/system-contracts.ts';

const AUDIT_ACCEPTANCE_LINE = 'merged anyway per policy decided 2026-08-24';

describe('merge-time base revalidation policy (issue #2906)', () => {
  test('same base name + tip advanced + live CLEAN or HAS_HOOKS proceeds bound to the approved head', () => {
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'A base TIP advance under the same name never does'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'proceed iff the live `mergeStateStatus` is CLEAN or HAS_HOOKS'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('reports CLEAN or HAS_HOOKS');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'human approval binds to the head only, and base freshness is enforced by GitHub alone'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('human approval binds to the head only');
  });

  test('head change still re-gates with fresh approval', () => {
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'the current `$HEAD_OID` must equal the `head_oid`'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('A head advanced outside this procedure');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'If the head changed after approval, OR the PR was retargeted to a different base ref name, BOTH the gate AND the human approval are stale'
    );
  });

  test('base ref NAME change (retarget) still re-gates in every surface', () => {
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'a base ref NAME change is a retarget that changes the reviewed diff WITHOUT changing `headRefOid`'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'either mismatch invalidates the gate and every approval given against the old head or base ref'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'retargeting the PR to a different base changes the reviewed diff without changing the head and still stales the gate and the human approval'
    );
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain(
      'When the acknowledged head differs, or the base NAME differs'
    );
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain(
      'if the head OR the base NAME is observed to change at ANY point mid-gate — even a change that later reverts — discard'
    );
  });

  test('BEHIND routes to update-branch (new head, normal re-gate)', () => {
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'BEHIND means the branch must be updated first — that push creates a new head, which takes the normal re-gate path'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'BEHIND takes the update-branch path (a new head, which re-runs the gate and needs fresh sign-off)'
    );
  });

  test('DIRTY and BLOCKED keep the existing conflict paths', () => {
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'DIRTY or BLOCKED take the existing conflict paths per step 4'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'DIRTY or BLOCKED take the step-4 conflict paths'
    );
  });

  test('verdict freshness predicates are unchanged (head binding from #2800 intact)', () => {
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'its commit_id equals $HEAD_OID, its submittedAt is AFTER any same-author CHANGES_REQUESTED'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('commit.oid equality');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'a base TIP advance under the same name does not'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'a same-name base-tip advance never stales either'
    );
  });

  test('audit acceptance line is emitted at every base-advance site with standardized wording', () => {
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      `base branch had advanced (<recorded base_oid>-><current baseRefOid>); ${AUDIT_ACCEPTANCE_LINE}`
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      `base branch had advanced (<recorded base_oid>-><first parent>); ${AUDIT_ACCEPTANCE_LINE}`
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'NON-result `note` artifact (kind "base-advance-accepted", key "base-advance")'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      `base branch had advanced (<recorded base_oid>-><current baseRefOid>); ${AUDIT_ACCEPTANCE_LINE}`
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      `base branch had advanced (<recorded base_oid>-><first parent>); ${AUDIT_ACCEPTANCE_LINE}`
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'NON-result `note` artifact (kind "base-advance-accepted", key "base-advance")'
    );
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain(
      `base branch had advanced (<dispatched base_oid>-><acknowledged base_oid>); ${AUDIT_ACCEPTANCE_LINE}`
    );
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain(
      `base branch had advanced (<start baseRefOid>-><finish baseRefOid>); ${AUDIT_ACCEPTANCE_LINE}`
    );
  });

  test('queue wait accepts a mergeable base-tip advance and escalates only on conflict or removal', () => {
    for (const instructions of [CODER_OWNED_MERGE_INSTRUCTIONS, CODER_ONLY_MERGE_INSTRUCTIONS]) {
      expect(instructions).toContain(
        'A base-tip advance while queued is acceptable when the entry stays mergeable: the merge queue rebases onto the new tip and the merge-group checks validate the result — escalate only on a conflict or when the queue entry is removed'
      );
      expect(instructions).toContain(
        'do NOT compare the live `baseRefOid` to the recorded `base_oid` as a blocker'
      );
      expect(instructions).toContain(
        'a post-merge first-parent mismatch is never a blocker and never an escalation trigger'
      );
    }
  });

  test('MERGED recovery records the acceptance line instead of escalating', () => {
    for (const instructions of [CODER_OWNED_MERGE_INSTRUCTIONS, CODER_ONLY_MERGE_INSTRUCTIONS]) {
      expect(instructions).toContain('a difference is a base-tip advance the policy accepts');
    }
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'it never fails this recovery and never escalates'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'it never fails this recovery and never an escalation trigger'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'a retarget, concurrent head push, stale gate, or policy change slipped in'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'a different, unverified head, a retargeted base, gate, or policy was merged by another actor'
    );
  });

  test('review-base note verifies on name match + head binding; OID drift carries the acceptance note', () => {
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain(
      'when the acknowledged head matches the dispatched head AND the acknowledged base NAME matches the dispatched base name, overwrite the note with `status: "verified"`'
    );
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain(
      'record the acknowledged base OID even when it differs from the dispatched one'
    );
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain(
      'while the artifact data keys stay exactly as dispatched'
    );
  });

  test('retired strict base-revalidation wording is gone from every surface', () => {
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).not.toContain(
      'a mismatch in ANY value invalidates the gate'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).not.toContain(
      'compare the current `baseRefName` AND `baseRefOid` AND `$HEAD_OID`'
    );
    for (const instructions of [CODER_OWNED_MERGE_INSTRUCTIONS, CODER_ONLY_MERGE_INSTRUCTIONS]) {
      expect(instructions).not.toContain(
        'Accept `MERGED` as verified ONLY when that first parent equals the `base_oid`'
      );
      expect(instructions).not.toContain('the merged result will contain a diff no gate reviewed');
    }
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).not.toContain(
      'a base-name OR base-commit change also stales the gate and the human approval'
    );
    expect(CODER_EXTERNAL_GATE_BLOCK).not.toContain(
      'only when the head AND BOTH base fields match the dispatched values'
    );
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).not.toContain(
      'if ANY of the three is observed to change at ANY point mid-gate'
    );
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).not.toContain(
      'the same branch name can advance underneath the gate'
    );
  });
});

describe('reviewer contract post-regen base-advance pins (m216)', () => {
  test('contract keeps capture/poll, discards only head or base-NAME excursions', () => {
    expect(REVIEWER_SYSTEM_CONTRACT).toContain(
      'Capture the baseRefName, baseRefOid, AND headRefOid'
    );
    expect(REVIEWER_SYSTEM_CONTRACT).toContain(
      'immediately before you write the gate artifact, perform a single terminal read of all three and confirm they are still unchanged'
    );
    expect(REVIEWER_SYSTEM_CONTRACT).toContain(
      'if the head OR the base NAME is observed to change at ANY point mid-gate'
    );
    expect(REVIEWER_SYSTEM_CONTRACT).toContain(
      'discard the cycle' +
        "'" +
        's verdicts and re-run the whole gate under the current base and head'
    );
  });

  test('contract records a base-OID excursion instead of discarding it', () => {
    expect(REVIEWER_SYSTEM_CONTRACT).toContain('A base-OID excursion alone');
    expect(REVIEWER_SYSTEM_CONTRACT).toContain('recorded, not discarded');
    expect(REVIEWER_SYSTEM_CONTRACT).toContain(
      'when the head never moved and the final pre-artifact `mergeStateStatus` is CLEAN or HAS_HOOKS'
    );
    expect(REVIEWER_SYSTEM_CONTRACT).toContain(
      `base branch had advanced (<start baseRefOid>-><finish baseRefOid>); ${AUDIT_ACCEPTANCE_LINE}`
    );
    expect(REVIEWER_SYSTEM_CONTRACT).toContain(
      'stamp the artifact' + "'" + 's `base_oid` with the base observed at finish'
    );
  });

  test('contract no longer discards on base-OID movement alone', () => {
    expect(REVIEWER_SYSTEM_CONTRACT).not.toContain(
      'if ANY of the three is observed to change at ANY point mid-gate'
    );
    expect(REVIEWER_SYSTEM_CONTRACT).not.toContain(
      'the same branch name can advance underneath the gate'
    );
  });
});
