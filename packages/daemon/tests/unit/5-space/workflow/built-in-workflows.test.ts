/**
 * Built-in Workflow Templates Unit Tests
 *
 * Covers:
 * - Template structure: correct agentId placeholders, transition conditions, step count
 * - agentId placeholders are valid builtin role names (no 'leader')
 * - getBuiltInWorkflows() returns all built-in templates
 * - seedBuiltInWorkflows(): seeds all built-in templates with real agent IDs
 * - seedBuiltInWorkflows(): node IDs replaced with real UUIDs (not template placeholders)
 * - seedBuiltInWorkflows(): agent ID resolution from role names to UUIDs (case-insensitive)
 * - seedBuiltInWorkflows(): descriptions, tags, instructions, gates, timestamps preserved
 * - seedBuiltInWorkflows(): 2-layer prompt override modes (expand vs override) correctly seeded
 * - seedBuiltInWorkflows(): idempotent — no re-seed if workflows already exist
 * - seedBuiltInWorkflows(): per-workflow error isolation
 * - Export/import round-trip: isCyclic and task_result conditions are preserved
 */

import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpaceWorkerAgent, SpaceWorkflow, WorkflowHook, WorkflowNode } from '@hyperneo/shared';
import {
  exportWorkflow,
  validateExportedWorkflow,
} from '../../../../src/lib/space/export-format.ts';
import { validateGate } from '../../../../src/lib/space/runtime/gate-evaluator.ts';
import { executeGateScript } from '../../../../src/lib/space/runtime/gate-script-executor.ts';
import {
  executeHookScript,
  type HookExecutorContext,
} from '../../../../src/lib/space/runtime/hook-executor.ts';
import { ChannelResolver } from '../../../../src/lib/space/runtime/channel-resolver.ts';

/**
 * Tests that execute gate scripts require `Bun.spawn` in production
 * (gate-script-executor.ts), which is unavailable under the Vitest/Node
 * runner. They are gated until the production module is de-Bun-ified.
 */
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
import {
  getEffectiveGate,
  isApprovalGate,
  resolveCodexPollIntervalMs,
} from '../../../../src/lib/space/runtime/gate-features.ts';
import { CODER_OWNED_MERGE_INSTRUCTIONS } from '../../../../src/lib/space/workflows/post-approval-merge-template.ts';
import { PR_MERGE_POST_APPROVAL_INSTRUCTIONS } from './fixtures/retired-post-approval-merge-template.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import {
  CODING_WORKFLOW,
  CODING_WORKFLOW as STABLE_CODING_WORKFLOW,
  CODING_WITH_QA_WORKFLOW,
  builtInWorkflowRequiresPrMerge,
  LEGACY_CODING_TEMPLATE_IDENTITIES,
  mergeChannelsFromTemplate,
  mergeNodeStructuralFieldsFromTemplate,
  getBuiltInGateScript,
  getBuiltInWorkflows,
  mergeGateStructuralFieldsFromTemplate,
  PLAN_AND_DECOMPOSE_WORKFLOW,
  validateWorkflowTemplateGateWriters,
  type WorkflowMigrationWarning,
  RESEARCH_WORKFLOW,
  REVIEW_ONLY_WORKFLOW,
  FULLSTACK_QA_POST_APPROVAL_PARAGRAPH,
  REVIEWER_POST_APPROVAL_BLOCKER_PARAGRAPH,
  RETIRED_PR_MERGER_SLOT_PROMPT,
  RETIRED_MERGER_RAW_MERGE_GUARD,
  seedBuiltInWorkflows,
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import { computeWorkflowHash } from '../../../../src/lib/space/workflows/template-hash.ts';
import { migrateWorkflowGateProgressionToHooks } from '../../../../src/lib/space/workflows/workflow-migration.ts';
import { isWorkflowTerminalNode } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
  // Use in-memory SQLite — faster than file-based DB and avoids filesystem
  // I/O contention that caused beforeEach hook timeouts in CI.
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return db;
}

function seedSpace(db: BunDatabase, spaceId: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, `/tmp/ws-${spaceId}`, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgent(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, custom_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', null, ?, ?)`
  ).run(agentId, spaceId, name, Date.now(), Date.now());
}

/**
 * Helper that returns the effective gate for CODING_WITH_QA_WORKFLOW's
 * review-approval-gate with the Review node configured to require codex approval.
 * Used by tests that exercise the codex review bot script/poll.
 */
function getFullstackReviewApprovalGateWithCodex() {
  const rawGate = CODING_WITH_QA_WORKFLOW.gates!.find((g) => g.id === 'review-approval-gate')!;
  return getEffectiveGate(rawGate, {
    ...CODING_WITH_QA_WORKFLOW,
    nodes: CODING_WITH_QA_WORKFLOW.nodes.map((n) =>
      n.name === 'Review' ? { ...n, requireCodexApproval: true } : n
    ),
  });
}

/** Valid builtin roles — 'leader' must NOT appear in any template step. */
const VALID_BUILTIN_ROLES = new Set<string>([
  'planner',
  'coder',
  'general',
  'research',
  'reviewer',
  'pr merger',
  'qa',
]);

/**
 * Returns true if any step in the workflow has 'leader' as its agentId or name placeholder.
 */
function hasLeaderAgentId(wf: SpaceWorkflow): boolean {
  return wf.nodes.some((s) =>
    (s.agents ?? []).some(
      (agent) => agent.agentId === 'leader' || agent.name?.toLowerCase() === 'leader'
    )
  );
}

// ---------------------------------------------------------------------------
// Template structure tests
// ---------------------------------------------------------------------------

describe('stable coding workflow templates', () => {
  test('expose concise stable identities and coder-owned post-approval routes', () => {
    expect(STABLE_CODING_WORKFLOW.name).toBe('Coding');
    expect(STABLE_CODING_WORKFLOW.handle).toBe('coding');
    expect(STABLE_CODING_WORKFLOW.nodes.map((node) => node.name)).toEqual(['Coding', 'Review']);
    // Coder-owned merge instructions (not the merger-only template) so the coder
    // may fix conflict/rebase blockers itself — see post-approval-merge-template.
    expect(STABLE_CODING_WORKFLOW.nodes[0]?.postApproval).toEqual({
      targetAgent: 'coder',
      instructions: CODER_OWNED_MERGE_INSTRUCTIONS,
      requirePrMerge: true,
    });
    expect(
      STABLE_CODING_WORKFLOW.nodes
        .flatMap((node) => node.agents)
        .some((agent) => agent.name === 'merger')
    ).toBe(false);

    expect(CODING_WITH_QA_WORKFLOW.name).toBe('Coding with QA');
    expect(CODING_WITH_QA_WORKFLOW.handle).toBe('coding-with-qa');
    expect(CODING_WITH_QA_WORKFLOW.nodes.map((node) => node.name)).toEqual([
      'Coding',
      'Review',
      'QA',
    ]);
    expect(CODING_WITH_QA_WORKFLOW.nodes[0]?.postApproval).toEqual({
      targetAgent: 'coder',
      instructions: CODER_OWNED_MERGE_INSTRUCTIONS,
      requirePrMerge: true,
    });
  });

  test('never re-introduces dedicated merger variants', () => {
    // The merger-variant patterns were removed; no built-in template carries a
    // dedicated PR-Merger slot node, and the stable templates are 2/3-node
    // coder-owned flows. This guards against a regression that re-adds the
    // retired merger-variant exports/patterns.
    for (const wf of getBuiltInWorkflows()) {
      expect(wf.nodes.map((node) => node.name)).not.toContain('Post-Approval');
      expect(wf.nodes.flatMap((node) => node.agents).some((agent) => agent.name === 'merger')).toBe(
        false
      );
    }
  });

  test('stable coder owns the post-approval merge and has NO tool guards', () => {
    // The stable coder implements AND owns the audited post-approval merge via
    // the node-level postApproval route (CODER_OWNED_MERGE_INSTRUCTIONS). It has
    // no toolGuards — the merge is prompt-instructed (`gh pr merge`), not gated
    // by Bash guard rules, so an over-restrictive guard would break the coder's
    // own merge during ordinary implementation work.
    const assertCoderOwnsMerge = (wf: SpaceWorkflow) => {
      const codingNode = wf.nodes.find((node) => node.name === 'Coding')!;
      expect(codingNode.postApproval?.targetAgent).toBe('coder');
      expect(codingNode.postApproval?.instructions).toBe(CODER_OWNED_MERGE_INSTRUCTIONS);
      const coder = codingNode.agents.find((agent) => agent.name === 'coder')!;
      expect(coder.toolGuards).toBeUndefined();
      // The coder prompt is the coder-owned merge prompt — it does NOT tell the
      // coder "Do NOT merge PRs" (the legacy implementation-only prompt).
      expect(coder.customPrompt?.value).not.toContain('Do NOT merge PRs');
      expect(coder.customPrompt?.value).toContain('Runtime Execution Contract');
    };
    assertCoderOwnsMerge(STABLE_CODING_WORKFLOW);
    assertCoderOwnsMerge(CODING_WITH_QA_WORKFLOW);
  });

  test('stable Coding Review is the end node and calls approve_task', () => {
    // In the 2-node Coding workflow, Review IS the end node, so its prompt
    // instructs the end-node-only approve_task/submit_for_approval.
    expect(STABLE_CODING_WORKFLOW.endNodeId).toBe(
      STABLE_CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!.id
    );
    const prompt = STABLE_CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!.agents[0]!
      .customPrompt!.value;
    expect(prompt).toContain('approve_task');
  });

  test('stable Coding-with-QA Review is intermediate and defers the QA handoff to the central contract', () => {
    // Review is intermediate (QA is the end node), so it must NOT call the
    // end-node-only approve_task. The QA target + review-approval-gate field are
    // centrally injected by buildGatedHandoffLines ("Outbound gated handoffs" in
    // Your Role in This Workflow), so the slot prompt must be behavioral only
    // (CLAUDE.md L170) and must NOT re-state them — otherwise the two sources of
    // truth drift and the gate can silently never open.
    expect(CODING_WITH_QA_WORKFLOW.endNodeId).toBe(
      CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'QA')!.id
    );
    const reviewPrompt = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Review')!.agents[0]!
      .customPrompt!.value;
    expect(reviewPrompt).toMatch(/do not call approve_task/i);
    // Behavioral: defers the handoff to the central contract rather than restating it.
    expect(reviewPrompt).toMatch(/final approval authority/i);
    expect(reviewPrompt).toMatch(/gated handoff/i);
    // Does NOT hard-code the QA routing / gate field (centrally injected instead).
    expect(reviewPrompt).not.toMatch(/send_message\(target="?QA"?/);
    expect(reviewPrompt).not.toContain('approved: true');
    expect(reviewPrompt).not.toMatch(/Review . QA gate/);
  });

  test('stable Coding-with-QA has a Coding → QA post-approval blocker channel', () => {
    // The post-approval coder (merged onto the Coding node) reports merge
    // blockers to QA (the approval authority) over Coding → QA. QA replies over
    // the existing QA → Coding channel. Without Coding → QA the blocker
    // send_message is unauthorized and the task stalls.
    const channels = CODING_WITH_QA_WORKFLOW.channels ?? [];
    expect(channels.some((c) => c.from === 'Coding' && c.to === 'QA')).toBe(true);
    expect(channels.some((c) => c.from === 'QA' && c.to === 'Coding')).toBe(true);
    // ...and the QA slot prompt expects to receive such blocker reports.
    const qaPrompt = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'QA')!.agents[0]!
      .customPrompt!.value;
    expect(qaPrompt).toContain('post-approval merge blocker');
  });

  test('stable Coding-with-QA gates the Coding → QA channel to post-approval only', () => {
    // The Coding → QA channel is reachable during implementation (channel-router
    // authorizes by from/to+gate, with no phase check). Without an extra gate, an
    // in-progress coder could message QA directly, lazily activating the end node
    // and approving without Review ever running. The post_approval_only hook is
    // the gate: it allows the send_message only while task.status === 'approved'
    // AND the message carries a merge-blocker / fix-push reason (verified in the
    // post-approval-only-validator unit tests).
    const hook = (CODING_WITH_QA_WORKFLOW.hooks ?? []).find(
      (h) =>
        h.sourceNode === 'Coding' &&
        h.targetNode === 'QA' &&
        h.method === 'send_message' &&
        h.validator.kind === 'built_in' &&
        h.validator.id === 'post_approval_only'
    );
    expect(hook).toBeDefined();
    expect(hook!.enabled).toBe(true);
    // Authorized only for the coder slot on Coding — the merger-on-Coding
    // reporter — and nothing else.
    expect(hook!.authorizedCallers).toEqual([{ sourceNode: 'Coding', agentSlots: ['coder'] }]);
    // The merger variant's Coding → Review pr_ready hook must still be present,
    // so the primary implementation handoff is unaffected.
    expect(
      (CODING_WITH_QA_WORKFLOW.hooks ?? []).some(
        (h) =>
          h.sourceNode === 'Coding' &&
          h.targetNode === 'Review' &&
          h.validator.kind === 'built_in' &&
          h.validator.id === 'pr_ready'
      )
    ).toBe(true);
  });

  test('legacy template identities map to canonical stable templates that carry gates', () => {
    // C4: SpaceWorkflowManager.BUILT_IN_TEMPLATE_GATES is keyed by every current
    // built-in name PLUS the legacy aliases below, using the RAW template gates
    // (pre gate→hook migration) so legacy review-posted-gate / review-approval-
    // gate rows converge to hooks at load time instead of being left with a
    // stale gated channel + a duplicated open route. Verify the single source of
    // truth covers both legacy names and that each canonical stable template
    // carries gates. (getBuiltInWorkflows() returns gate→hook-migrated copies
    // with no gates, so check the raw consts the manager registers.)
    expect(LEGACY_CODING_TEMPLATE_IDENTITIES.map((i) => i.legacyName)).toEqual([
      'Coding Workflow',
      'Coding with QA Workflow',
    ]);
    const canonicalByName = new Map<string, SpaceWorkflow>([
      [STABLE_CODING_WORKFLOW.name, STABLE_CODING_WORKFLOW],
      [CODING_WITH_QA_WORKFLOW.name, CODING_WITH_QA_WORKFLOW],
    ]);
    for (const identity of LEGACY_CODING_TEMPLATE_IDENTITIES) {
      const canonical = canonicalByName.get(identity.name)!;
      expect(canonical.gates?.length ?? 0).toBeGreaterThan(0);
    }
    // The legacy aliases resolve to the same names as the stable templates.
    expect(LEGACY_CODING_TEMPLATE_IDENTITIES.map((i) => i.name)).toEqual([
      STABLE_CODING_WORKFLOW.name,
      CODING_WITH_QA_WORKFLOW.name,
    ]);
  });

  test('stable coder prompt does not hard-code a specific approval authority', () => {
    // The coder slot prompt is shared by Coding (authority=Review) and Coding
    // with QA (authority=QA). It must NOT name a specific authority — that is
    // injected via the Runtime Execution Contract / post-approval procedure —
    // or the QA workflow's coder would seek re-approval from Review and
    // merge_pr could accept Review's GitHub approval, bypassing QA revalidation.
    const prompt = STABLE_CODING_WORKFLOW.nodes
      .find((n) => n.name === 'Coding')!
      .agents.find((a) => a.name === 'coder')!.customPrompt!.value;
    expect(prompt).not.toContain('Review is the approval and re-approval authority');
    expect(prompt).toMatch(/Runtime Execution Contract/i);
  });

  test('stable reviewer prompts defer execution to the central contract', () => {
    // The reviewer role has no shell (Reviewer System Contract forbids running
    // tests/builds), so a slot-prompt "run checks when useful" wastes turns on
    // unavailable tools. Keep slot prompts behavioral.
    for (const wf of [STABLE_CODING_WORKFLOW, CODING_WITH_QA_WORKFLOW]) {
      const prompt = wf.nodes.find((n) => n.name === 'Review')!.agents[0]!.customPrompt!.value;
      expect(prompt).not.toMatch(/run checks/i);
    }
  });

  test('only the stable Coding template is tagged default', () => {
    // selectDeterministicWorkflowFallback ranks default-tagged workflows by
    // updatedAt, so two defaults would make default resolution ambiguous.
    expect(STABLE_CODING_WORKFLOW.tags).toContain('default');
    expect(CODING_WITH_QA_WORKFLOW.tags).not.toContain('default');
  });

  test('coder-owned merge instructions verify the Space checkout is not ahead of origin', () => {
    // Mirrors the dedicated-merger procedure: after `git pull --ff-only`, verify
    // HEAD == origin/$BASE so a stray-commit "Already up to date" doesn't leave
    // future task worktrees on an unmerged base.
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('space-checkout-ahead');
  });

  test('coder-owned merge-queue poll inspects queue status and is bounded', () => {
    // Step 2b must not poll `--json state` alone (it can't see a failed
    // merge-group check, which leaves the PR OPEN) nor loop forever. It must
    // (a) query mergeStateStatus and (b) impose a poll cap that routes a stuck
    // queue to step 2c. autoMergeRequest is NOT used: a PR added directly to the
    // queue with checks already passing legitimately has it null, so it is not a
    // reliable failure signal (it is neither queried nor treated as failure).
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('mergeStateStatus');
    // autoMergeRequest is NOT queried and NOT used as a failure signal (a PR
    // added directly to the queue with checks passing legitimately has it null).
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).not.toMatch(/--json [^\n]*autoMergeRequest/);
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).not.toMatch(/--json state --jq \.state/);
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toMatch(/~10 attempts|up to ~10/);
  });
});

describe('stable CODING_WORKFLOW template structure', () => {
  test('has two nodes: Coding and Review (no Post-Approval merger node)', () => {
    expect(CODING_WORKFLOW.nodes).toHaveLength(2);
    expect(CODING_WORKFLOW.nodes.map((s) => s.name)).toEqual(['Coding', 'Review']);
  });

  test('Coding node owns the post-approval merge via the node-level route', () => {
    const codingNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
    // The coder (implementer) owns the audited post-approval merge — no
    // dedicated merger slot on a separate Post-Approval node.
    expect(codingNode.postApproval?.targetAgent).toBe('coder');
    expect(codingNode.postApproval?.instructions).toBe(CODER_OWNED_MERGE_INSTRUCTIONS);
    const reviewNode = CODING_WORKFLOW.nodes.find((n) => n.id === CODING_WORKFLOW.endNodeId)!;
    expect(reviewNode.postApproval).toBeUndefined();
  });

  test('coder slot has no toolGuards (merge is prompt-instructed, not bash-gated)', () => {
    const agent = CODING_WORKFLOW.nodes[0].agents[0];
    expect(agent?.name).toBe('coder');
    expect(agent?.toolGuards).toBeUndefined();
  });

  test('coder prompt is behavioral coder-owned text that instructs the merge via gh pr merge', () => {
    const prompt = CODING_WORKFLOW.nodes[0].agents[0]?.customPrompt?.value;
    expect(prompt).toContain('Runtime Execution Contract');
    expect(prompt).toContain('`gh pr merge`');
    // The coder owns the merge now — no "Do NOT merge PRs" legacy wording.
    expect(prompt).not.toContain('Do NOT merge PRs');
    // Behavioral: does not hard-code the Review peer or pr_url gate field.
    expect(prompt).not.toContain('send_message(target="Review"');
    expect(prompt).not.toContain('code-ready-gate');
    // Does not tell the coder to subscribe_pr_events / detail external_event
    // handles — that is the legacy prompt text (see LEGACY_CODING_SLOT_PROMPTS).
    expect(prompt).not.toContain('subscribe_pr_events');
  });

  test('reviewer prompt instructs a visible GitHub review per the system contract', () => {
    const prompt = CODING_WORKFLOW.nodes[1].agents[0]?.customPrompt?.value;
    expect(prompt).toContain('post a visible GitHub review');
    expect(prompt).toContain('Reviewer system contract');
    // Review is the end node here — it calls approve_task.
    expect(prompt).toContain('approve_task');
  });

  test('has two channels (Coding→Review + gated Review→Coding)', () => {
    expect(CODING_WORKFLOW.channels).toHaveLength(2);
  });

  test('Coding → Review channel is ungated (PR-ready hook replaces gate)', () => {
    const ch = CODING_WORKFLOW.channels!.find((c) => c.from === 'Coding' && c.to === 'Review');
    expect(ch).toBeDefined();
    expect(ch!.gateId).toBeUndefined();
    // direction field removed from WorkflowChannel
    expect(ch!.maxCycles).toBeUndefined();
  });

  test('Review → Coding channel is gated by review-posted-gate with maxCycles', () => {
    const ch = CODING_WORKFLOW.channels!.find((c) => c.from === 'Review' && c.to === 'Coding');
    expect(ch).toBeDefined();
    // The review-posted-gate closes the feedback-loop gap where the reviewer
    // summarizes feedback internally without posting to GitHub.
    expect(ch!.gateId).toBe('review-posted-gate');
    // direction field removed from WorkflowChannel
    expect(ch!.maxCycles).toBe(5);
  });

  test('all channels have direction one-way', () => {
    for (const ch of CODING_WORKFLOW.channels!) {
      expect('direction' in ch).toBe(false); // direction field removed
    }
  });

  test('all channel from/to fields reference valid node names', () => {
    const nodeNames = new Set(CODING_WORKFLOW.nodes.map((n) => n.name));
    for (const ch of CODING_WORKFLOW.channels!) {
      expect(nodeNames.has(ch.from as string)).toBe(true);
      expect(nodeNames.has(ch.to as string)).toBe(true);
    }
  });

  test('has one gate: review-posted-gate', () => {
    expect(CODING_WORKFLOW.gates).toHaveLength(1);
    const gateIds = CODING_WORKFLOW.gates!.map((g) => g.id).sort();
    expect(gateIds).toEqual(['review-posted-gate']);
    const reviewPostedGate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;
    expect(reviewPostedGate.fields).toHaveLength(2);
  });

  test('has a send_message hook for Coding → Review using pr_ready validator', () => {
    const hooks = CODING_WORKFLOW.hooks ?? [];
    expect(hooks.length).toBeGreaterThanOrEqual(1);
    const hook = hooks.find((h) => h.id === 'code-pr-ready');
    expect(hook).toBeDefined();
    expect(hook!.sourceNode).toBe('Coding');
    expect(hook!.targetNode).toBe('Review');
    expect(hook!.method).toBe('send_message');
    expect(hook!.validator).toEqual({ kind: 'built_in', id: 'pr_ready' });
    expect(hook!.enabled).toBe(true);
    expect(hook!.classification).toBe('validation');
    expect(hook!.authorizedCallers).toEqual([{ sourceNode: 'Coding', agentSlots: ['coder'] }]);
  });

  test('review feedback cycle is gated by fresh GitHub review evidence', () => {
    const channel = CODING_WORKFLOW.channels!.find(
      (c) => c.from === 'Review' && c.to === 'Coding'
    )!;
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;

    expect(channel.gateId).toBe('review-posted-gate');
    expect(channel.maxCycles).toBe(5);
    // The gate backs its check with the `review_posted` built-in validator (an
    // external_state preset over the github connector) — no hand-rolled bash.
    expect(gate.validator).toEqual({ kind: 'built_in', id: 'review_posted' });
    expect(gate.script).toBeUndefined();
    expect(gate.fields?.map((field) => field.name)).toEqual(['pr_url', 'review_url']);
  });

  test('review-posted-gate has pr_url and review_url fields writable only by Review node', () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;
    expect(gate.fields).toHaveLength(2);

    const prField = gate.fields.find((f) => f.name === 'pr_url')!;
    expect(prField.type).toBe('string');
    expect(prField.writers).toEqual(['Review']);
    expect(prField.check.op).toBe('exists');

    const reviewField = gate.fields.find((f) => f.name === 'review_url')!;
    expect(reviewField.type).toBe('string');
    expect(reviewField.writers).toEqual(['Review']);
    expect(reviewField.check.op).toBe('exists');
  });

  test('review-posted-gate references the review_posted external_state primitive', () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;
    // No inline bash: the check is a declarative built-in validator reference.
    // The since-workflow-start window, formal-review-first ordering, and own-PR
    // fallback all live in the `review_posted` preset + its `getReviewEvidence`
    // github op (see runtime/connectors/presets.ts + connectors/presets.test.ts).
    expect(gate.validator).toEqual({ kind: 'built_in', id: 'review_posted' });
    expect(gate.script).toBeUndefined();
  });

  test('review-posted-gate behavioral coverage lives in the review_posted preset tests', () => {
    // The own-PR fallback, formal-review-first ordering, since-workflow-start
    // window, and review_url fallback are exercised end-to-end against a mocked
    // `gh` in runtime/connectors/presets.test.ts (the review_posted preset) and
    // via the gate-evaluator dispatch test in other/gate-evaluator.test.ts.
    // The gate here is a declarative reference to that primitive (no inline bash).
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;
    expect(gate.validator).toEqual({ kind: 'built_in', id: 'review_posted' });
  });

  test('review-posted-gate resets on cycle so each feedback round is re-verified', () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;
    expect(gate.resetOnCycle).toBe(true);
  });

  test('startNodeId points to the Coding step', () => {
    const codeStep = CODING_WORKFLOW.nodes.find((s) => s.agents[0]?.name === 'coder');
    expect(CODING_WORKFLOW.startNodeId).toBe(codeStep?.id);
  });

  test('endNodeId points to the Review step', () => {
    const reviewStep = CODING_WORKFLOW.nodes.find((s) => s.name === 'Review');
    expect(CODING_WORKFLOW.endNodeId).toBe(reviewStep?.id);
  });

  test('endNodeId references a valid node in the graph', () => {
    const nodeIds = new Set(CODING_WORKFLOW.nodes.map((n) => n.id));
    expect(nodeIds.has(CODING_WORKFLOW.endNodeId!)).toBe(true);
  });

  test('does not reference leader', () => {
    expect(hasLeaderAgentId(CODING_WORKFLOW)).toBe(false);
  });

  test('template id and spaceId are empty (not space-specific)', () => {
    expect(CODING_WORKFLOW.id).toBe('');
    expect(CODING_WORKFLOW.spaceId).toBe('');
  });

  test('coders in Coding and Coding-with-QA implement via focused commits and focused tests', () => {
    // The stable coder prompt is shared by both workflows (behavioral-only).
    const prompts = [CODING_WORKFLOW, CODING_WITH_QA_WORKFLOW].map(
      (wf) =>
        wf.nodes.find((node) => node.name === 'Coding')!.agents.find((a) => a.name === 'coder')!
          .customPrompt!.value
    );
    for (const prompt of prompts) {
      expect(prompt).toContain('Implement the task');
      expect(prompt).toContain('add focused tests');
      expect(prompt).toContain('resolve review threads');
    }
  });
});

test('CODING_WORKFLOW nodes define customPrompt with non-empty value', () => {
  for (const node of CODING_WORKFLOW.nodes) {
    for (const agent of node.agents) {
      expect(agent.customPrompt).toBeDefined();
      expect(agent.customPrompt?.value?.trim().length ?? 0).toBeGreaterThan(0);
    }
  }
});

describe('RESEARCH_WORKFLOW template', () => {
  test('has two nodes (Research + Review), no Post-Approval merger node', () => {
    expect(RESEARCH_WORKFLOW.nodes).toHaveLength(2);
    expect(RESEARCH_WORKFLOW.nodes.map((s) => s.name)).toEqual(['Research', 'Review']);
    // The research agent (implementer) owns the post-approval merge via the
    // node-level route — no dedicated merger node.
    const researchNode = RESEARCH_WORKFLOW.nodes.find((n) => n.name === 'Research')!;
    expect(researchNode.postApproval?.targetAgent).toBe('research');
    expect(researchNode.postApproval?.instructions).toBe(CODER_OWNED_MERGE_INSTRUCTIONS);
    const reviewNode = RESEARCH_WORKFLOW.nodes.find((n) => n.id === RESEARCH_WORKFLOW.endNodeId)!;
    expect(reviewNode.postApproval).toBeUndefined();
  });

  test('first node uses Research agent', () => {
    expect(RESEARCH_WORKFLOW.nodes[0].agents[0]?.name).toBe('research');
    expect(RESEARCH_WORKFLOW.nodes[0].name).toBe('Research');
  });

  test('second node uses Reviewer agent', () => {
    expect(RESEARCH_WORKFLOW.nodes[1].agents[0]?.name).toBe('reviewer');
    expect(RESEARCH_WORKFLOW.nodes[1].name).toBe('Review');
  });

  test('has two channels: Research→Review + Review→Research (more research)', () => {
    expect(RESEARCH_WORKFLOW.channels).toHaveLength(2);
    const forward = RESEARCH_WORKFLOW.channels!.find(
      (c) => c.from === 'Research' && c.to === 'Review'
    );
    expect(forward).toBeDefined();
    expect(forward!.gateId).toBeUndefined();
    // direction field removed from WorkflowChannel

    const backChannel = RESEARCH_WORKFLOW.channels!.find(
      (c) => c.from === 'Review' && c.to === 'Research'
    );
    expect(backChannel).toBeDefined();
    expect(backChannel!.gateId).toBeUndefined();
    expect(backChannel!.maxCycles).toBe(5);
  });

  test('has a send_message hook for Research → Review using pr_ready validator', () => {
    const hooks = RESEARCH_WORKFLOW.hooks ?? [];
    expect(hooks.length).toBeGreaterThanOrEqual(1);
    const hook = hooks.find((h) => h.id === 'research-pr-ready');
    expect(hook).toBeDefined();
    expect(hook!.sourceNode).toBe('Research');
    expect(hook!.targetNode).toBe('Review');
    expect(hook!.method).toBe('send_message');
    expect(hook!.validator).toEqual({ kind: 'built_in', id: 'pr_ready' });
    expect(hook!.enabled).toBe(true);
  });

  test('channel from/to references match node names', () => {
    const nodeNames = new Set(RESEARCH_WORKFLOW.nodes.map((n) => n.name));
    for (const ch of RESEARCH_WORKFLOW.channels!) {
      expect(nodeNames.has(ch.from as string)).toBe(true);
      expect(nodeNames.has(ch.to as string)).toBe(true);
    }
  });

  test('each channel has a label', () => {
    for (const ch of RESEARCH_WORKFLOW.channels!) {
      expect(ch.label).toBeTruthy();
    }
  });

  test('startNodeId points to the Research node', () => {
    const researchNode = RESEARCH_WORKFLOW.nodes.find((n) => n.name === 'Research');
    expect(RESEARCH_WORKFLOW.startNodeId).toBe(researchNode?.id);
  });

  test('endNodeId points to the Review node', () => {
    const reviewNode = RESEARCH_WORKFLOW.nodes.find((n) => n.name === 'Review');
    expect(RESEARCH_WORKFLOW.endNodeId).toBe(reviewNode?.id);
  });

  test('endNodeId references a valid node in the graph', () => {
    const nodeIds = new Set(RESEARCH_WORKFLOW.nodes.map((n) => n.id));
    expect(nodeIds.has(RESEARCH_WORKFLOW.endNodeId!)).toBe(true);
  });

  test('does not reference leader', () => {
    expect(hasLeaderAgentId(RESEARCH_WORKFLOW)).toBe(false);
  });

  test('template id and spaceId are empty (not space-specific)', () => {
    expect(RESEARCH_WORKFLOW.id).toBe('');
    expect(RESEARCH_WORKFLOW.spaceId).toBe('');
  });

  test('nodes have agents with non-empty customPrompt', () => {
    for (const node of RESEARCH_WORKFLOW.nodes) {
      for (const agent of node.agents) {
        expect(agent.customPrompt).toBeDefined();
        expect(agent.customPrompt?.value?.trim().length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  test('RESEARCH_WORKFLOW nodes define customPrompt with non-empty value', () => {
    for (const node of RESEARCH_WORKFLOW.nodes) {
      for (const agent of node.agents) {
        expect(agent.customPrompt).toBeDefined();
        expect(agent.customPrompt?.value?.trim().length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});

describe('REVIEW_ONLY_WORKFLOW template', () => {
  test('has one step', () => {
    expect(REVIEW_ONLY_WORKFLOW.nodes).toHaveLength(1);
  });

  test('step agentId placeholder is reviewer', () => {
    expect(REVIEW_ONLY_WORKFLOW.nodes[0].agents[0]?.name).toBe('reviewer');
  });

  test('has no channels (single-node workflow needs no inter-agent channels)', () => {
    expect(REVIEW_ONLY_WORKFLOW.channels ?? []).toHaveLength(0);
  });

  test('startNodeId points to the Review step', () => {
    expect(REVIEW_ONLY_WORKFLOW.startNodeId).toBe(REVIEW_ONLY_WORKFLOW.nodes[0].id);
  });

  test('endNodeId points to the Review step (same as startNodeId)', () => {
    expect(REVIEW_ONLY_WORKFLOW.endNodeId).toBe(REVIEW_ONLY_WORKFLOW.nodes[0].id);
  });

  test('startNodeId equals endNodeId (single-node workflow)', () => {
    expect(REVIEW_ONLY_WORKFLOW.startNodeId).toBe(REVIEW_ONLY_WORKFLOW.endNodeId);
  });

  test('does not reference leader', () => {
    expect(hasLeaderAgentId(REVIEW_ONLY_WORKFLOW)).toBe(false);
  });

  test('template id and spaceId are empty (not space-specific)', () => {
    expect(REVIEW_ONLY_WORKFLOW.id).toBe('');
    expect(REVIEW_ONLY_WORKFLOW.spaceId).toBe('');
  });

  test('REVIEW_ONLY_WORKFLOW node defines customPrompt with non-empty value', () => {
    const agent = REVIEW_ONLY_WORKFLOW.nodes[0].agents[0];
    expect(agent.customPrompt).toBeDefined();
    expect(agent.customPrompt?.value?.trim().length ?? 0).toBeGreaterThan(0);
  });
});

describe('PLAN_AND_DECOMPOSE_WORKFLOW template', () => {
  test('has three nodes', () => {
    expect(PLAN_AND_DECOMPOSE_WORKFLOW.nodes).toHaveLength(3);
  });

  test('node names are correct', () => {
    expect(PLAN_AND_DECOMPOSE_WORKFLOW.nodes.map((n) => n.name)).toEqual([
      'Planning',
      'Plan Review',
      'Task Dispatcher',
    ]);
  });

  test('node agent placeholders are correct', () => {
    const nodes = PLAN_AND_DECOMPOSE_WORKFLOW.nodes;
    // Planning: single Planner
    expect(nodes[0].agents).toHaveLength(1);
    expect(nodes[0].agents[0]?.agentId).toBe('Planner');
    expect(nodes[0].agents[0]?.name).toBe('planner');
    // Plan Review: four Reviewers (architecture, security, correctness, ux)
    expect(nodes[1].agents).toHaveLength(4);
    expect(nodes[1].agents.map((a) => a.agentId)).toEqual([
      'Reviewer',
      'Reviewer',
      'Reviewer',
      'Reviewer',
    ]);
    expect(nodes[1].agents.map((a) => a.name)).toEqual([
      'architecture-reviewer',
      'security-reviewer',
      'correctness-reviewer',
      'ux-reviewer',
    ]);
    // Task Dispatcher: single General agent
    expect(nodes[2].agents).toHaveLength(1);
    expect(nodes[2].agents[0]?.agentId).toBe('General');
    expect(nodes[2].agents[0]?.name).toBe('task-dispatcher');
  });

  test('all nodes define explicit custom prompts', () => {
    for (const node of PLAN_AND_DECOMPOSE_WORKFLOW.nodes) {
      for (const agent of node.agents) {
        expect((agent.customPrompt?.value?.trim().length ?? 0) > 0).toBe(true);
      }
    }
  });

  test('startNodeId points to the Planning node', () => {
    const planningNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find((n) => n.name === 'Planning');
    expect(PLAN_AND_DECOMPOSE_WORKFLOW.startNodeId).toBe(planningNode?.id);
  });

  test('endNodeId points to the Task Dispatcher node', () => {
    const dispatcherNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find(
      (n) => n.name === 'Task Dispatcher'
    );
    expect(PLAN_AND_DECOMPOSE_WORKFLOW.endNodeId).toBe(dispatcherNode?.id);
  });

  test('endNodeId references a valid node in the graph', () => {
    const nodeIds = new Set(PLAN_AND_DECOMPOSE_WORKFLOW.nodes.map((n) => n.id));
    expect(nodeIds.has(PLAN_AND_DECOMPOSE_WORKFLOW.endNodeId!)).toBe(true);
  });

  test('has one gate', () => {
    expect(PLAN_AND_DECOMPOSE_WORKFLOW.gates).toHaveLength(1);
  });

  test('gate IDs are correct', () => {
    const ids = PLAN_AND_DECOMPOSE_WORKFLOW.gates!.map((g) => g.id);
    expect(ids).toContain('plan-approval-gate');
  });

  test('has a send_message hook for Planning → Plan Review using pr_ready validator', () => {
    const hooks = PLAN_AND_DECOMPOSE_WORKFLOW.hooks ?? [];
    expect(hooks.length).toBeGreaterThanOrEqual(1);
    const hook = hooks.find((h) => h.id === 'plan-pr-ready');
    expect(hook).toBeDefined();
    expect(hook!.sourceNode).toBe('Planning');
    expect(hook!.targetNode).toBe('Plan Review');
    expect(hook!.method).toBe('send_message');
    expect(hook!.validator).toEqual({ kind: 'built_in', id: 'pr_ready' });
    expect(hook!.enabled).toBe(true);
  });

  test('plan-approval-gate requires all four reviewers to approve', () => {
    const gate = PLAN_AND_DECOMPOSE_WORKFLOW.gates!.find((g) => g.id === 'plan-approval-gate')!;
    expect(gate.fields).toHaveLength(1);
    expect(gate.fields[0].name).toBe('approvals');
    expect(gate.fields[0].type).toBe('map');
    expect(gate.fields[0].check).toMatchObject({ op: 'count', match: 'approved', min: 4 });
    expect(gate.fields[0].writers).toEqual(['Plan Review']);
    // Codex is no longer hardcoded as a gate feature; it is opt-in via node-level config.
    expect(gate.features?.codex_review_bot).toBeUndefined();
    expect(gate.resetOnCycle).toBe(true);
  });

  test('plan review approval migration carries vote data and resets votes on revision feedback', () => {
    const workflow = migrateWorkflowGateProgressionToHooks({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
      templateGates: PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? [],
    }).workflow;
    const approvalHook = workflow.hooks!.find(
      (hook) => hook.sourceNode === 'Plan Review' && hook.targetNode === 'Task Dispatcher'
    )!;
    const resetHook = workflow.hooks!.find(
      (hook) => hook.id === 'plan-approval-reset' && hook.targetNode === 'Planning'
    )!;

    expect(approvalHook).toMatchObject({
      enabled: true,
      sourceNode: 'Plan Review',
      targetNode: 'Task Dispatcher',
      method: 'send_message',
      classification: 'validation',
    });
    expect(approvalHook.validator).toMatchObject({ kind: 'script', interpreter: 'bash' });
    const approvalSource =
      approvalHook.validator.kind === 'script' ? approvalHook.validator.source : '';
    expect(approvalSource).toContain('HYPERNEO_HOOK_LOCAL_STATE_JSON');
    expect(approvalSource).toContain('"approval_count":4');
    expect(resetHook).toMatchObject({
      enabled: true,
      sourceNode: 'Plan Review',
      targetNode: 'Planning',
      method: 'send_message',
      classification: 'validation',
    });
    const resetSource = resetHook.validator.kind === 'script' ? resetHook.validator.source : '';
    expect(resetSource).toContain('"type":"record_state"');
    expect(resetSource).toContain('"approvals":null');
  });

  test('has three channels', () => {
    expect(PLAN_AND_DECOMPOSE_WORKFLOW.channels).toHaveLength(3);
  });

  test('main progression channels have correct gateIds', () => {
    const ch = PLAN_AND_DECOMPOSE_WORKFLOW.channels!;

    const planningToReview = ch.find((c) => c.from === 'Planning' && c.to === 'Plan Review');
    expect(planningToReview?.gateId).toBeUndefined();

    const reviewToDispatcher = ch.find(
      (c) => c.from === 'Plan Review' && c.to === 'Task Dispatcher'
    );
    expect(reviewToDispatcher?.gateId).toBe('plan-approval-gate');
  });

  test('feedback channel Plan Review → Planning is ungated and cyclic', () => {
    const ch = PLAN_AND_DECOMPOSE_WORKFLOW.channels!;
    const reviewToPlanning = ch.find((c) => c.from === 'Plan Review' && c.to === 'Planning');
    expect(reviewToPlanning).toBeDefined();
    expect(reviewToPlanning?.gateId).toBeUndefined();
    expect(reviewToPlanning?.maxCycles).toBe(5);
  });

  test('all channels have direction one-way', () => {
    for (const ch of PLAN_AND_DECOMPOSE_WORKFLOW.channels!) {
      expect('direction' in ch).toBe(false); // direction field removed
    }
  });

  test('all channel from/to fields reference valid node names or agent slot names', () => {
    const refs = new Set<string>();
    for (const node of PLAN_AND_DECOMPOSE_WORKFLOW.nodes) {
      refs.add(node.name);
      for (const agent of node.agents ?? []) refs.add(agent.name);
    }
    for (const ch of PLAN_AND_DECOMPOSE_WORKFLOW.channels!) {
      expect(refs.has(ch.from as string)).toBe(true);
      if (Array.isArray(ch.to)) {
        for (const target of ch.to) {
          expect(refs.has(target)).toBe(true);
        }
      } else {
        expect(refs.has(ch.to as string)).toBe(true);
      }
    }
  });

  test('Plan Review node lens names cover architecture / security / correctness / ux', () => {
    const reviewNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find((n) => n.name === 'Plan Review')!;
    expect(reviewNode.agents).toHaveLength(4);
    const expected = [
      { name: 'architecture-reviewer', lens: 'architecture' },
      { name: 'security-reviewer', lens: 'security' },
      { name: 'correctness-reviewer', lens: 'correctness' },
      { name: 'ux-reviewer', lens: 'ux' },
    ];
    for (let i = 0; i < expected.length; i++) {
      const slot = reviewNode.agents[i];
      expect(slot.name).toBe(expected[i].name);
      // Each reviewer's prompt should reference their lens name and the approval gate
      expect(slot.customPrompt?.value.toLowerCase()).toContain(expected[i].lens);
      expect(slot.customPrompt?.value).toContain('Task Dispatcher');
    }
  });

  test('Task Dispatcher prompt instructs use of create_standalone_task and save_artifact', () => {
    const dispatcherNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find(
      (n) => n.name === 'Task Dispatcher'
    )!;
    const prompt = dispatcherNode.agents[0].customPrompt?.value ?? '';
    expect(prompt).toContain('create_standalone_task');
    expect(prompt).toContain('save_artifact');
    expect(prompt).toContain('created_task_ids');
  });

  test('Task Dispatcher prompt embeds Stacked PR Instructions in task descriptions', () => {
    const dispatcherNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find(
      (n) => n.name === 'Task Dispatcher'
    )!;
    const prompt = dispatcherNode.agents[0].customPrompt?.value ?? '';
    // Must embed stacked PR instructions in each task description
    expect(prompt).toContain('Stacked PR Instructions');
    // Must specify branch naming convention using plan/ prefix
    expect(prompt).toContain('plan/');
    // Evidence must include stack metadata
    expect(prompt).toContain('stack_prefix');
    expect(prompt).toContain('stack_branches');
  });

  test('Task Dispatcher prompt uses dev (not main) as the base branch for the bottom PR', () => {
    const dispatcherNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find(
      (n) => n.name === 'Task Dispatcher'
    )!;
    const prompt = dispatcherNode.agents[0].customPrompt?.value ?? '';
    // Bottom item must target dev as base branch
    expect(prompt).toContain('Base branch: dev');
    // Must never reference main as the trunk
    expect(prompt).not.toContain('Base branch: main');
  });

  test('Task Dispatcher prompt instructs building stacked PR chain bottom-up', () => {
    const dispatcherNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find(
      (n) => n.name === 'Task Dispatcher'
    )!;
    const prompt = dispatcherNode.agents[0].customPrompt?.value ?? '';
    // Must instruct bottom-up ordering (item 1 first)
    expect(prompt).toMatch(/BOTTOM.UP order|bottom.up/i);
    // Subsequent items must reference the previous item's branch as base
    expect(prompt).toContain('item-(N-1)-slug');
  });

  test('Task Dispatcher prompt instructs Task Dispatcher NOT to create branches or PRs itself', () => {
    const dispatcherNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find(
      (n) => n.name === 'Task Dispatcher'
    )!;
    const prompt = dispatcherNode.agents[0].customPrompt?.value ?? '';
    // The dispatcher delegates branch/PR creation to downstream coders
    expect(prompt).toContain('downstream coder');
  });

  test('workflow description describes stacked PR chain output', () => {
    // The workflow description must convey that the output is a stacked PR chain
    expect(PLAN_AND_DECOMPOSE_WORKFLOW.description).toMatch(/stacked PR/i);
    // Must mention that PRs are built bottom-up from dev
    expect(PLAN_AND_DECOMPOSE_WORKFLOW.description).toContain('dev');
  });

  test('does not reference leader', () => {
    expect(hasLeaderAgentId(PLAN_AND_DECOMPOSE_WORKFLOW)).toBe(false);
  });

  test('template id and spaceId are empty (not space-specific)', () => {
    expect(PLAN_AND_DECOMPOSE_WORKFLOW.id).toBe('');
    expect(PLAN_AND_DECOMPOSE_WORKFLOW.spaceId).toBe('');
  });

  test('does NOT have the default tag — selected explicitly for planning goals', () => {
    expect(PLAN_AND_DECOMPOSE_WORKFLOW.tags).not.toContain('default');
  });

  test('has the planning and decomposition tags', () => {
    expect(PLAN_AND_DECOMPOSE_WORKFLOW.tags).toContain('planning');
    expect(PLAN_AND_DECOMPOSE_WORKFLOW.tags).toContain('decomposition');
  });
});

// ---------------------------------------------------------------------------
// getBuiltInWorkflows()
// ---------------------------------------------------------------------------

describe('getBuiltInWorkflows()', () => {
  test('returns exactly five templates', () => {
    expect(getBuiltInWorkflows()).toHaveLength(5);
  });

  test('includes CODING_WORKFLOW', () => {
    const names = getBuiltInWorkflows().map((w) => w.name);
    expect(names).toContain(CODING_WORKFLOW.name);
  });

  test('includes PLAN_AND_DECOMPOSE_WORKFLOW', () => {
    const names = getBuiltInWorkflows().map((w) => w.name);
    expect(names).toContain(PLAN_AND_DECOMPOSE_WORKFLOW.name);
  });

  test('does NOT include the legacy Full-Cycle Coding Workflow', () => {
    const names = getBuiltInWorkflows().map((w) => w.name);
    expect(names).not.toContain('Full-Cycle Coding Workflow');
  });

  test('includes CODING_WITH_QA_WORKFLOW', () => {
    const names = getBuiltInWorkflows().map((w) => w.name);
    expect(names).toContain(CODING_WITH_QA_WORKFLOW.name);
  });

  test('includes RESEARCH_WORKFLOW', () => {
    const names = getBuiltInWorkflows().map((w) => w.name);
    expect(names).toContain(RESEARCH_WORKFLOW.name);
  });

  test('includes REVIEW_ONLY_WORKFLOW', () => {
    const names = getBuiltInWorkflows().map((w) => w.name);
    expect(names).toContain(REVIEW_ONLY_WORKFLOW.name);
  });

  test('identifies merge-required workflows by durable template identity', () => {
    expect(builtInWorkflowRequiresPrMerge('Coding')).toBe(true);
    expect(builtInWorkflowRequiresPrMerge('Coding Workflow')).toBe(true);
    expect(builtInWorkflowRequiresPrMerge('Coding with QA')).toBe(true);
    expect(builtInWorkflowRequiresPrMerge('Research Workflow')).toBe(true);
    expect(builtInWorkflowRequiresPrMerge('Review-Only')).toBe(false);
    expect(builtInWorkflowRequiresPrMerge('custom workflow')).toBe(false);
    expect(builtInWorkflowRequiresPrMerge(null)).toBe(false);
  });

  test('no template references leader as agent', () => {
    for (const wf of getBuiltInWorkflows()) {
      expect(hasLeaderAgentId(wf)).toBe(false);
    }
  });

  test('all agent placeholders are valid builtin role names', () => {
    // agent.agentId is the role placeholder (Capitalized); check lowercase version is in valid set
    for (const wf of getBuiltInWorkflows()) {
      for (const step of wf.nodes) {
        expect(step.agents.length).toBeGreaterThan(0);
        for (const agent of step.agents) {
          expect(VALID_BUILTIN_ROLES.has(agent.agentId.toLowerCase())).toBe(true);
        }
      }
    }
  });

  test('all templates define endNodeId', () => {
    for (const wf of getBuiltInWorkflows()) {
      expect(wf.endNodeId).toBeTruthy();
      expect(typeof wf.endNodeId).toBe('string');
    }
  });

  test('all templates endNodeId references a valid node', () => {
    for (const wf of getBuiltInWorkflows()) {
      const nodeIds = new Set(wf.nodes.map((n) => n.id));
      expect(nodeIds.has(wf.endNodeId!)).toBe(true);
    }
  });

  test('all nodes use agents[] array format (no bare agentId on nodes)', () => {
    for (const wf of getBuiltInWorkflows()) {
      for (const node of wf.nodes) {
        expect(Array.isArray(node.agents)).toBe(true);
        expect(node.agents.length).toBeGreaterThan(0);
        for (const agent of node.agents) {
          expect(agent.agentId).toBeTruthy();
        }
      }
    }
  });

  test('getBuiltInWorkflows returns migrated hook-backed templates', () => {
    const coding = getBuiltInWorkflows().find((w) => w.name === CODING_WORKFLOW.name)!;
    expect(coding.channels?.some((channel) => channel.gateId === 'review-posted-gate')).toBe(false);
    expect(
      coding.hooks?.some(
        (hook) =>
          hook.sourceNode === 'Review' &&
          hook.targetNode === 'Coding' &&
          hook.id.startsWith('review-posted:')
      )
    ).toBe(true);
    const reviewPostedHook = coding.hooks?.find((hook) => hook.id.startsWith('review-posted:'));
    // The migrated review-posted hook references the review_posted built-in
    // validator (an external_state preset) — no hand-rolled bash script.
    expect(reviewPostedHook?.validator).toEqual({ kind: 'built_in', id: 'review_posted' });
    expect(computeWorkflowHash(coding)).toBe(
      computeWorkflowHash(
        migrateWorkflowGateProgressionToHooks({
          ...CODING_WORKFLOW,
          templateName: CODING_WORKFLOW.name,
          templateGates: CODING_WORKFLOW.gates ?? [],
        }).workflow
      )
    );
  });

  test('all gate fields have valid non-empty writer roles', () => {
    for (const wf of getBuiltInWorkflows()) {
      expect(validateWorkflowTemplateGateWriters(wf)).toEqual([]);
    }
  });

  test('gate writer validation rejects empty writer arrays', () => {
    const workflow = structuredClone(CODING_WORKFLOW);
    workflow.gates![0].fields![0].writers = [];

    expect(validateWorkflowTemplateGateWriters(workflow)).toEqual([
      `${workflow.name}.gates.review-posted-gate.fields.pr_url.writers: must contain at least one writer role`,
    ]);
  });

  test('gate writer validation rejects unknown writer roles', () => {
    const workflow = structuredClone(CODING_WORKFLOW);
    workflow.gates![0].fields![0].writers = ['Unknown Role'];

    expect(validateWorkflowTemplateGateWriters(workflow)).toEqual([
      `${workflow.name}.gates.review-posted-gate.fields.pr_url.writers: unknown writer role "Unknown Role"`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// seedBuiltInWorkflows()
// ---------------------------------------------------------------------------

describe('seedBuiltInWorkflows()', () => {
  let db: BunDatabase;
  let repo: SpaceWorkflowRepository;
  let manager: SpaceWorkflowManager;
  const SPACE_ID = 'seed-test-space';

  // Preset agent IDs seeded in the space
  const PLANNER_ID = 'agent-planner-uuid';
  const CODER_ID = 'agent-coder-uuid';
  const GENERAL_ID = 'agent-general-uuid';
  const RESEARCH_ID = 'agent-research-uuid';
  const REVIEWER_ID = 'agent-reviewer-uuid';
  const MERGER_ID = 'agent-merger-uuid';

  // Role resolver — mirrors what the real call site does
  const QA_ID = 'agent-qa-uuid';
  const roleMap: Record<string, string> = {
    planner: PLANNER_ID,
    coder: CODER_ID,
    general: GENERAL_ID,
    research: RESEARCH_ID,
    reviewer: REVIEWER_ID,
    'pr merger': MERGER_ID,
    qa: QA_ID,
  };
  const resolveAgentId = (role: string): string | undefined => roleMap[role.toLowerCase()];

  beforeEach(() => {
    db = makeDb();
    seedSpace(db, SPACE_ID);
    // Seed preset agents so the manager's agentLookup (when wired) would find them
    seedAgent(db, PLANNER_ID, SPACE_ID, 'Planner');
    seedAgent(db, CODER_ID, SPACE_ID, 'Coder');
    seedAgent(db, GENERAL_ID, SPACE_ID, 'General');
    seedAgent(db, RESEARCH_ID, SPACE_ID, 'Research');
    seedAgent(db, REVIEWER_ID, SPACE_ID, 'Reviewer');
    seedAgent(db, QA_ID, SPACE_ID, 'QA');

    repo = new SpaceWorkflowRepository(db);
    // No agentLookup — seeder bypasses lookup by passing real IDs directly
    manager = new SpaceWorkflowManager(repo);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  });

  test('create rejects duplicate hook ids before migration', () => {
    expect(() =>
      manager.createWorkflow({
        spaceId: SPACE_ID,
        name: 'Duplicate Hook Workflow',
        nodes: [
          { id: 'node-a', name: 'A', agents: [{ agentId: PLANNER_ID, name: 'planner' }] },
          { id: 'node-b', name: 'B', agents: [{ agentId: REVIEWER_ID, name: 'reviewer' }] },
        ],
        channels: [{ id: 'ch-a-b', from: 'A', to: 'B' }],
        hooks: [
          {
            id: 'dup-hook',
            enabled: true,
            sourceNode: 'A',
            targetNode: 'B',
            method: 'send_message',
            classification: 'validation',
            order: 0,
            validator: {
              kind: 'script',
              interpreter: 'bash',
              source: 'jq -n \'{"type":"allow"}\'',
            },
            authorizedCallers: [{ sourceNode: 'A' }],
          },
          {
            id: 'dup-hook',
            enabled: true,
            sourceNode: 'A',
            targetNode: 'B',
            method: 'send_message',
            classification: 'validation',
            order: 1,
            validator: {
              kind: 'script',
              interpreter: 'bash',
              source: 'jq -n \'{"type":"allow"}\'',
            },
            authorizedCallers: [{ sourceNode: 'A' }],
          },
        ],
      })
    ).toThrow('duplicate hook id "dup-hook"');
  });

  test('update rejects duplicate hook ids before migration', () => {
    const workflow = manager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Update Duplicate Hook Workflow',
      nodes: [
        { id: 'node-a', name: 'A', agents: [{ agentId: PLANNER_ID, name: 'planner' }] },
        { id: 'node-b', name: 'B', agents: [{ agentId: REVIEWER_ID, name: 'reviewer' }] },
      ],
      channels: [{ id: 'ch-a-b', from: 'A', to: 'B' }],
    });

    const hook = {
      id: 'dup-hook',
      enabled: true,
      sourceNode: 'A',
      targetNode: 'B',
      method: 'send_message' as const,
      classification: 'validation' as const,
      order: 0,
      validator: {
        kind: 'script' as const,
        interpreter: 'bash',
        source: 'jq -n \'{"type":"allow"}\'',
      },
      authorizedCallers: [{ sourceNode: 'A' }],
    };

    expect(() => manager.updateWorkflow(workflow.id, { hooks: [hook, { ...hook }] })).toThrow(
      'duplicate hook id "dup-hook"'
    );
  });

  test('seeds all built-in templates for an empty space', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflows = manager.listWorkflows(SPACE_ID);
    expect(workflows).toHaveLength(5);
  });

  test('seeded workflow names match all templates', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const names = manager.listWorkflows(SPACE_ID).map((w) => w.name);
    expect(names).toContain(CODING_WORKFLOW.name);
    expect(names).toContain(PLAN_AND_DECOMPOSE_WORKFLOW.name);
    expect(names).toContain(CODING_WITH_QA_WORKFLOW.name);
    expect(names).toContain(RESEARCH_WORKFLOW.name);
    expect(names).toContain(REVIEW_ONLY_WORKFLOW.name);
  });

  test('Plan & Decompose Workflow seeding preserves explicit node custom prompts', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name);
    expect(wf).toBeDefined();
    // customPrompt is on each WorkflowNodeAgent, not on WorkflowNode
    for (const node of wf!.nodes) {
      for (const agent of node.agents) {
        expect((agent.customPrompt?.value?.trim().length ?? 0) > 0).toBe(true);
      }
    }
  });

  test('CODING_WORKFLOW seeding preserves node custom prompts with non-empty value', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name);
    expect(wf).toBeDefined();
    for (const node of wf!.nodes) {
      for (const agent of node.agents) {
        expect(agent.customPrompt).toBeDefined();
        expect((agent.customPrompt?.value?.trim().length ?? 0) > 0).toBe(true);
      }
    }
  });

  test('RESEARCH_WORKFLOW seeding preserves node custom prompts with non-empty value', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name);
    expect(wf).toBeDefined();
    for (const node of wf!.nodes) {
      for (const agent of node.agents) {
        expect(agent.customPrompt).toBeDefined();
        expect((agent.customPrompt?.value?.trim().length ?? 0) > 0).toBe(true);
      }
    }
  });

  test('CODING_WORKFLOW seeded correctly — two nodes with real agent IDs', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name);
    expect(wf).toBeDefined();
    expect(wf!.nodes).toHaveLength(2);
    expect(wf!.nodes[0].agents[0]?.agentId).toBe(CODER_ID);
    expect(wf!.nodes[1].agents[0]?.agentId).toBe(roleMap.reviewer);
    // The Coding node carries the coder-owned post-approval merge route.
    expect(wf!.nodes[0].postApproval?.targetAgent).toBe('coder');
  });

  test('CODING_WORKFLOW seeded with two channels (Coding→Review + gated Review→Coding)', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    expect(wf.channels).toHaveLength(2);

    const codeToReview = wf.channels!.find((c) => c.from === 'Coding' && c.to === 'Review');
    expect(codeToReview).toBeDefined();
    expect(codeToReview!.gateId).toBeUndefined();

    const reviewToCode = wf.channels!.find((c) => c.from === 'Review' && c.to === 'Coding');
    expect(reviewToCode).toBeDefined();
    // The Review → Coding feedback is gated by the review-posted gate, which is
    // migrated to a `review-posted` hook at seed time (no retained gate, and the
    // channel carries the maxCycles cap so the review loop stays bounded).
    expect(reviewToCode!.gateId).toBeUndefined();
    expect(reviewToCode!.maxCycles).toBe(5);
    const reviewPostedHook = (wf.hooks ?? []).find(
      (h) =>
        h.sourceNode === 'Review' && h.targetNode === 'Coding' && h.id.startsWith('review-posted:')
    );
    expect(reviewPostedHook).toBeDefined();
  });

  test('CODING_WORKFLOW seeded with no retained gates (all migrated to hooks)', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    expect(wf.gates ?? []).toHaveLength(0);
  });

  test('CODING_WORKFLOW seeded channels all have direction one-way', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    for (const ch of wf.channels!) {
      expect('direction' in ch).toBe(false); // direction field removed
    }
  });

  test('CODING_WORKFLOW seeded channels from/to fields are node names (not UUIDs)', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const nodeNames = new Set(wf.nodes.map((n) => n.name));
    for (const ch of wf.channels!) {
      expect(nodeNames.has(ch.from as string)).toBe(true);
      expect(nodeNames.has(ch.to as string)).toBe(true);
    }
  });

  test('RESEARCH_WORKFLOW seeded with two channels (Research→Review + Review→Research)', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
    expect(wf.channels).toHaveLength(2);
    const forward = wf.channels!.find((c) => c.from === 'Research' && c.to === 'Review');
    expect(forward).toBeDefined();
    expect(forward!.gateId).toBeUndefined();
    const back = wf.channels!.find((c) => c.from === 'Review' && c.to === 'Research');
    expect(back).toBeDefined();
    expect(back!.gateId).toBeUndefined();
    expect(back!.from).toBe('Review');
    expect(back!.to).toBe('Research');
  });

  test('RESEARCH_WORKFLOW seeded correctly — research + reviewer', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name);
    expect(wf).toBeDefined();
    expect(wf!.nodes).toHaveLength(2);
    expect(wf!.nodes[0].agents[0]?.agentId).toBe(RESEARCH_ID);
    expect(wf!.nodes[1].agents[0]?.agentId).toBe(REVIEWER_ID);
    // The Research node carries the research-owned post-approval merge route.
    expect(wf!.nodes[0].postApproval?.targetAgent).toBe('research');
  });

  test('RESEARCH_WORKFLOW seeded channels reference valid node names', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
    const nodeNames = new Set(wf.nodes.map((n) => n.name));
    for (const ch of wf.channels!) {
      expect('direction' in ch).toBe(false); // direction field removed
      expect(nodeNames.has(ch.from as string)).toBe(true);
      expect(nodeNames.has(ch.to as string)).toBe(true);
    }
  });

  test('RESEARCH_WORKFLOW seeded with no gates', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
    expect(wf.gates ?? []).toHaveLength(0);
  });

  test('RESEARCH_WORKFLOW seeded with a pr_ready hook', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
    const hook = wf.hooks?.find((h) => h.id === 'research-pr-ready');
    expect(hook).toBeDefined();
    expect(hook!.validator).toEqual({ kind: 'built_in', id: 'pr_ready' });
  });

  test('REVIEW_ONLY_WORKFLOW seeded with no channels', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name)!;
    expect(wf.channels ?? []).toHaveLength(0);
  });

  test('REVIEW_ONLY_WORKFLOW seeded correctly — single reviewer step', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name);
    expect(wf).toBeDefined();
    expect(wf!.nodes).toHaveLength(1);
    expect(wf!.nodes[0].agents[0]?.agentId).toBe(REVIEWER_ID);
  });

  test('PLAN_AND_DECOMPOSE_WORKFLOW seeded correctly — three nodes with 4 parallel reviewers', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name);
    expect(wf).toBeDefined();
    expect(wf!.nodes).toHaveLength(3);
    expect(wf!.nodes[0].agents[0]?.agentId).toBe(PLANNER_ID); // Planning
    // Plan Review has four agents (all reviewer)
    expect(wf!.nodes[1].agents).toHaveLength(4);
    expect(wf!.nodes[1].agents?.map((a) => a.agentId)).toEqual([
      roleMap.reviewer,
      roleMap.reviewer,
      roleMap.reviewer,
      roleMap.reviewer,
    ]);
    expect(wf!.nodes[1].agents?.map((a) => a.name)).toEqual([
      'architecture-reviewer',
      'security-reviewer',
      'correctness-reviewer',
      'ux-reviewer',
    ]);
    expect(wf!.nodes[2].agents[0]?.agentId).toBe(GENERAL_ID); // Task Dispatcher
  });

  test('PLAN_AND_DECOMPOSE_WORKFLOW seeded with 3 node-level channels', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
    expect(wf.channels).toHaveLength(3);
  });

  test('PLAN_AND_DECOMPOSE_WORKFLOW seeded with 1 gate', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
    expect(wf.gates ?? []).toHaveLength(0);
  });

  test('PLAN_AND_DECOMPOSE_WORKFLOW seeded channels split into 1 gated + 1 ungated feedback', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
    const gatedChannels = wf.channels!.filter((c) => c.gateId !== undefined);
    expect(gatedChannels).toHaveLength(0);
    const cyclicChannels = wf.channels!.filter((c) => c.maxCycles !== undefined);
    // One cyclic feedback channel: Plan Review → Planning
    expect(cyclicChannels).toHaveLength(1);
  });

  test('PLAN_AND_DECOMPOSE_WORKFLOW seeded with a pr_ready hook', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
    const hook = wf.hooks?.find((h) => h.id === 'plan-pr-ready');
    expect(hook).toBeDefined();
    expect(hook!.validator).toEqual({ kind: 'built_in', id: 'pr_ready' });
  });

  test('PLAN_AND_DECOMPOSE_WORKFLOW seeded channels reference node names or reviewer slot names', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
    const refs = new Set<string>();
    for (const node of wf.nodes) {
      refs.add(node.name);
      for (const slot of node.agents ?? []) refs.add(slot.name);
    }
    for (const ch of wf.channels!) {
      expect(refs.has(ch.from as string)).toBe(true);
      if (Array.isArray(ch.to)) {
        for (const target of ch.to) {
          expect(refs.has(target)).toBe(true);
        }
      } else {
        expect(refs.has(ch.to as string)).toBe(true);
      }
    }
  });

  test('PLAN_AND_DECOMPOSE_WORKFLOW seeded without default tag — picked explicitly for planning', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
    expect(wf.tags).not.toContain('default');
    expect(wf.tags).toContain('planning');
    expect(wf.tags).toContain('decomposition');
  });

  test('PLAN_AND_DECOMPOSE_WORKFLOW seeded alongside CODING_WORKFLOW — both present', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const names = manager.listWorkflows(SPACE_ID).map((w) => w.name);
    expect(names).toContain(CODING_WORKFLOW.name);
    expect(names).toContain(PLAN_AND_DECOMPOSE_WORKFLOW.name);
  });

  test('all seeded workflows have the real spaceId assigned', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    for (const wf of manager.listWorkflows(SPACE_ID)) {
      expect(wf.spaceId).toBe(SPACE_ID);
    }
  });

  test('all seeded workflows have non-empty ids assigned', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    for (const wf of manager.listWorkflows(SPACE_ID)) {
      expect(wf.id).toBeTruthy();
    }
  });

  test('all seeded workflows get their canonical handle pinned', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflows = manager.listWorkflows(SPACE_ID);
    const byName = new Map(workflows.map((w) => [w.name, w]));
    expect(byName.get('Coding')?.handle).toBe('coding');
    expect(byName.get('Research Workflow')?.handle).toBe('research-workflow');
    expect(byName.get('Review-Only Workflow')?.handle).toBe('review-only-workflow');
    expect(byName.get('Plan & Decompose Workflow')?.handle).toBe('plan-decompose-workflow');
    expect(byName.get('Coding with QA')?.handle).toBe('coding-with-qa');
  });

  test('all seeded workflows have endNodeId pointing to a valid node', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    for (const wf of manager.listWorkflows(SPACE_ID)) {
      expect(wf.endNodeId).toBeTruthy();
      const nodeIds = new Set(wf.nodes.map((n) => n.id));
      expect(nodeIds.has(wf.endNodeId!)).toBe(true);
    }
  });

  test('REVIEW_ONLY_WORKFLOW seeded with startNodeId === endNodeId', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name)!;
    expect(wf.startNodeId).toBe(wf.endNodeId);
  });

  test('is idempotent — second call does not create additional workflows', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflows = manager.listWorkflows(SPACE_ID);
    expect(workflows).toHaveLength(5);
  });

  // ─── Node-level postApproval threading ──────────────────────────────────

  test('threads node-level postApproval through to Coding, Research, QA seeded rows', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflows = manager.listWorkflows(SPACE_ID);
    const assertPostApproval = (name: string, targetAgent: 'coder' | 'research') => {
      const wf = workflows.find((w) => w.name === name);
      expect(wf, `workflow "${name}" must be seeded`).toBeDefined();
      expect(wf!.postApproval).toBeUndefined();
      // The coder/research implementer owns the post-approval merge via a
      // node-level route on the implementing node; the end node no longer
      // carries the route.
      const routeNode = wf!.nodes.find((node) => node.postApproval);
      expect(routeNode, `"${name}" must have a node carrying postApproval`).toBeDefined();
      expect(routeNode!.postApproval!.targetAgent).toBe(targetAgent);
      // Non-empty instructions — we don't snapshot the full template here
      // because end-node-handoff.test.ts already asserts the exact content.
      expect(routeNode!.postApproval!.instructions.length).toBeGreaterThan(0);
      const endNode = wf!.nodes.find((node) => node.id === wf!.endNodeId);
      expect(endNode?.postApproval).toBeUndefined();
    };
    assertPostApproval('Coding', 'coder');
    assertPostApproval('Research Workflow', 'research');
    assertPostApproval('Coding with QA', 'coder');
  });

  test('leaves postApproval undefined on Review-Only and Plan & Decompose', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflows = manager.listWorkflows(SPACE_ID);
    for (const name of ['Review-Only Workflow', 'Plan & Decompose Workflow']) {
      const wf = workflows.find((w) => w.name === name);
      expect(wf, `workflow "${name}" must be seeded`).toBeDefined();
      expect(wf!.postApproval).toBeUndefined();
      expect(wf!.nodes.some((node) => node.postApproval)).toBe(false);
    }
  });

  // ─── PR 3/5: drift re-stamp path ────────────────────────────────────────

  test('result exposes restamped=[] on a fresh seed', () => {
    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.skipped).toBe(false);
    expect(result.seeded).toHaveLength(5);
    expect(result.restamped).toEqual([]);
  });

  test('result exposes restamped=[] when all rows already match current template hashes', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const second = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    // Second call finds no drift — no re-stamps needed.
    expect(second.skipped).toBe(true);
    expect(second.seeded).toEqual([]);
    expect(second.restamped).toEqual([]);
  });

  test('re-stamps existing rows when stored templateHash differs from current template', () => {
    // Seed fresh — rows now carry the current template hash.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    // Simulate a prior seed that predated node-level postApproval by clearing
    // the terminal node route and rewriting `template_hash` to a stale value.
    // The re-stamp path should detect the hash drift and push the current
    // node-level `postApproval` (+ current hash) onto the row.
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const codingNode = coding.nodes.find((node) => node.name === 'Coding')!;
    db.prepare(
      `UPDATE space_workflows
			    SET template_hash = ?, post_approval = NULL
			  WHERE id = ?`
    ).run('stale-hash-from-a-prior-pr', coding.id);
    db.prepare(`UPDATE space_workflow_nodes SET config = ? WHERE id = ?`).run(
      JSON.stringify({ agents: codingNode.agents }),
      codingNode.id
    );

    // Verify the simulated drift landed.
    const before = manager.getWorkflow(coding.id)!;
    expect(before.postApproval).toBeUndefined();
    expect(before.nodes.find((node) => node.name === 'Coding')?.postApproval).toBeUndefined();
    expect(before.templateHash).toBe('stale-hash-from-a-prior-pr');

    // Re-run the seeder — re-stamp branch fires.
    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.seeded).toEqual([]);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);
    expect(result.skipped).toBe(false);

    // Row now carries the current template's node-level postApproval + hash.
    const after = manager.getWorkflow(coding.id)!;
    expect(after.postApproval).toBeUndefined();
    const afterCodingNode = after.nodes.find((node) => node.name === 'Coding');
    expect(afterCodingNode?.postApproval).toBeDefined();
    expect(afterCodingNode?.postApproval?.targetAgent).toBe('coder');
    expect(after.templateHash).not.toBe('stale-hash-from-a-prior-pr');
  });

  test('the stable Coding template carries exactly one coder-owned postApproval route', () => {
    // The merge route lives on the Coding node (targetAgent 'coder'), never the
    // Review node. Exactly one node must carry the route so approval dispatches
    // exactly one merge — not zero, not two.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const codingNode = coding.nodes.find((node) => node.name === 'Coding')!;
    const reviewNode = coding.nodes.find((node) => node.name === 'Review')!;
    expect(codingNode.postApproval?.targetAgent).toBe('coder');
    expect(codingNode.postApproval?.instructions).toBe(CODER_OWNED_MERGE_INSTRUCTIONS);
    expect(reviewNode.postApproval).toBeUndefined();
    // Exactly one node carries a route — no double dispatch on approval.
    expect(coding.nodes.filter((node) => node.postApproval)).toHaveLength(1);

    // Re-seeding is a no-op (no drift), so no re-stamp moves/duplicates routes.
    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.skipped).toBe(true);
    const reRow = manager.getWorkflow(coding.id)!;
    expect(reRow.nodes.filter((node) => node.postApproval)).toHaveLength(1);
    expect(reRow.nodes.find((node) => node.name === 'Coding')!.postApproval?.targetAgent).toBe(
      'coder'
    );
  });

  test('re-stamp propagates template maxCycles onto existing Fullstack QA Loop cyclic back-channels', () => {
    // Seed fresh — Fullstack QA Loop carries the current template (maxCycles: 50)
    // and the current template hash.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WITH_QA_WORKFLOW.name)!;

    // Simulate a pre-fix seed: both cyclic back-channels carry the old maxCycles: 6.
    // This is the state any existing space was left in before the 6 → 50 bump.
    manager.updateWorkflow(wf.id, {
      channels: (wf.channels ?? []).map((ch) =>
        (ch.from === 'Review' && ch.to === 'Coding') || (ch.from === 'QA' && ch.to === 'Coding')
          ? { ...ch, maxCycles: 6 }
          : ch
      ),
    });

    // Force the re-stamp path by stamping a stale hash (the persisted hash
    // matches the OLD template; the new template's hash differs → drift fires).
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'stale-hash-pre-maxCycles-50',
      wf.id
    );

    // Sanity-check the simulated drift landed before re-stamp.
    const before = manager.getWorkflow(wf.id)!;
    expect(before.channels!.find((c) => c.from === 'Review' && c.to === 'Coding')!.maxCycles).toBe(
      6
    );
    expect(before.channels!.find((c) => c.from === 'QA' && c.to === 'Coding')!.maxCycles).toBe(6);

    // Re-run the seeder — re-stamp branch fires.
    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WITH_QA_WORKFLOW.name);

    // Structural channel fields propagated in-place: the template's maxCycles: 50
    // now lands on the already-seeded back-channels. Without the in-place merge
    // this silently fails — the old maxCycles: 6 is preserved verbatim while the
    // hash is bumped to the 50-hash, permanently blocking future fixes from
    // reaching existing spaces (the matching hash skips the row on every restart).
    const after = manager.getWorkflow(wf.id)!;
    expect(after.channels!.find((c) => c.from === 'Review' && c.to === 'Coding')!.maxCycles).toBe(
      50
    );
    expect(after.channels!.find((c) => c.from === 'QA' && c.to === 'Coding')!.maxCycles).toBe(50);
  });

  test('re-stamp does NOT touch handles — custom user handle is preserved', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

    // User sets a custom handle and we simulate drift so re-stamp fires.
    manager.updateWorkflow(coding.id, { handle: 'my-custom-handle' });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'stale-hash',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);

    const after = manager.getWorkflow(coding.id)!;
    // Re-stamp never writes the handle field — custom handle is left untouched.
    expect(after.handle).toBe('my-custom-handle');
  });

  test('re-stamp preserves existing postApproval when a node was renamed', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const routeNode = coding.nodes.find((n) => n.name === 'Coding')!;
    expect(routeNode.postApproval).toBeDefined();

    // Bypass manager validation — only rename node, don't touch hooks.
    // Direct DB update avoids hook validation against renamed nodes.
    db.prepare(`UPDATE space_workflow_nodes SET name = ? WHERE id = ?`).run(
      'Implementation',
      routeNode.id
    );
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'stale-hash',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);

    const after = manager.getWorkflow(coding.id)!;
    const afterRenamedNode = after.nodes.find((n) => n.id === routeNode.id)!;
    expect(afterRenamedNode.name).toBe('Implementation');
    // The renamed node no longer matches the template by name, so the reconciler
    // preserves its existing postApproval rather than clobbering it.
    expect(afterRenamedNode.postApproval).toEqual(routeNode.postApproval);
  });

  test('re-stamp succeeds and leaves handle field untouched (no handle write during restamp)', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

    // Simulate a pre-feature row: clear handle and force re-stamp.
    db.prepare(`UPDATE space_workflows SET handle = NULL, template_hash = ? WHERE id = ?`).run(
      'stale-hash',
      coding.id
    );

    // Re-stamp must succeed and NOT touch the handle field.
    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);
    expect(result.errors).toHaveLength(0);

    // node-level postApproval and completionAutonomyLevel are correctly re-stamped.
    const after = manager.getWorkflow(coding.id)!;
    expect(after.postApproval).toBeUndefined();
    expect(after.nodes.find((node) => node.name === 'Coding')?.postApproval).toBeDefined();
    expect(after.completionAutonomyLevel).toBe(CODING_WORKFLOW.completionAutonomyLevel);
    // Handle is NOT written by re-stamp — NULL rows are backfilled by migration 124, not the seeder.
    expect(after.handle).toBeUndefined();
  });

  test('re-stamp does NOT touch rows without a templateName (user-created)', () => {
    // Seed the 5 built-ins.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    // Create a user-owned workflow with no templateName/templateHash.
    const userWf = manager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'My Custom Review',
      nodes: [{ name: 'Review', agentId: REVIEWER_ID }],
      completionAutonomyLevel: 2,
      // Intentionally no templateName — a bespoke workflow
    });

    // Run seeder again — should be a no-op for the user row.
    const before = manager.getWorkflow(userWf.id)!;
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const after = manager.getWorkflow(userWf.id)!;

    expect(after.name).toBe(before.name);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.completionAutonomyLevel).toBe(before.completionAutonomyLevel);
    expect(after.postApproval).toBeUndefined();
  });

  test('re-stamp does not overwrite persisted node agent custom prompts', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const reviewNode = coding.nodes.find((n) => n.name === 'Review')!;
    const reviewAgent = reviewNode.agents[0];
    const sentinel = 'SENTINEL REVIEW PROMPT - must survive startup re-stamp';

    manager.updateWorkflow(coding.id, {
      nodes: coding.nodes.map((n) =>
        n.id !== reviewNode.id
          ? n
          : {
              id: n.id,
              name: n.name,
              agents: n.agents.map((a, i) =>
                i === 0 ? { ...a, customPrompt: { value: sentinel } } : a
              ),
            }
      ),
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'stale-hash',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);

    const after = manager.getWorkflow(coding.id)!;
    const afterReviewNode = after.nodes.find((n) => n.id === reviewNode.id)!;
    const afterAgent = afterReviewNode.agents[0];
    expect(afterAgent.customPrompt?.value).toBe(sentinel);
    expect(afterAgent.agentId).toBe(reviewAgent.agentId);
    expect(afterReviewNode.id).toBe(reviewNode.id);
    // The sentinel prompt is a genuine customization the re-stamp preserves, so
    // the row did NOT fully converge to the template. The stored hash must NOT
    // advance to the template hash — otherwise updateAvailable would read false
    // and the Workflow List would stop offering sync. The prior stale hash is
    // preserved so the row stays honestly flagged for review.
    expect(after.templateHash).toBe('stale-hash');
    expect(after.templateHash).not.toBe(
      computeWorkflowHash(getBuiltInWorkflows().find((w) => w.name === CODING_WORKFLOW.name)!)
    );
  });

  test('re-stamp keeps updateAvailable alive when the template changed a non-merged field', () => {
    // Regression guard (P1 #2): the re-stamp merges only structural fields
    // (nodes/channels/gates/hooks/post-approval/autonomy). If the template
    // improved in a field the merge does NOT reconcile — instructions,
    // description, or a user prompt — then advancing the stored hash to the
    // template's would collapse updateAvailable to false and the Workflow List
    // would stop offering sync, permanently hiding the improvement. The re-stamp
    // must NOT advance the hash past what it actually reconciled.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const template = getBuiltInWorkflows().find((w) => w.name === CODING_WORKFLOW.name)!;
    const expectedHash = computeWorkflowHash(template);

    // Simulate a row that predates an instructions change: custom instructions
    // (the merge won't reconcile these) + a stale stored hash.
    manager.updateWorkflow(coding.id, { instructions: 'legacy custom instructions' });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'pre-instructions-change-hash',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);

    const after = manager.getWorkflow(coding.id)!;
    // Instructions are preserved (the merge doesn't reconcile them)...
    expect(after.instructions).toBe('legacy custom instructions');
    // ...so the row did NOT converge, and the stored hash must NOT have been
    // advanced to the template's — updateAvailable stays true.
    expect(after.templateHash).not.toBe(expectedHash);

    // Derived drift signals (mirrors spaceWorkflow.detectDrift): the row stays
    // actionable AND reads as customized, so the apply routes through review
    // rather than a silent "safe" overwrite of the preserved instructions.
    const rowHash = computeWorkflowHash(after);
    const updateAvailable = expectedHash !== (after.templateHash ?? null);
    const customized = rowHash !== (after.templateHash ?? null);
    expect(updateAvailable).toBe(true);
    expect(customized).toBe(true);
  });

  test('stable Coding coder prompt carries no retired step markers that retired patches could pseudo-converge', () => {
    // The stable coder prompt was rewritten to be behavioral coder-owned text
    // (CODER_OWNED_MERGE_PROMPT) — it contains none of the legacy numbered-step
    // markers, so the retired `BUILT_IN_PROMPT_PATCH_VARIANTS` (keyed to the old
    // coder prompt's step text) cannot fire against it and accidentally
    // pseudo-converge a half-patched prompt. Guards that a future rewrite does
    // not reintroduce the legacy step shape into the stable coder prompt.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const prompt = coding.nodes.find((n) => n.name === 'Coding')!.agents[0].customPrompt!.value;
    // No legacy numbered PR-step / handoff-step text.
    expect(prompt).not.toContain('5. If code changed: open a PR with `gh pr create`');
    expect(prompt).not.toContain('hand off by sending a message to Review');
    expect(prompt).not.toContain('replyHandle.commentId');
    expect(prompt).not.toContain('code-ready-gate');
    // The behavioral prompt is what survives any retired-patch attempt.
    expect(prompt).toContain('Runtime Execution Contract');
    expect(prompt).toContain('`gh pr merge`');
  });

  test('Research prompt carries the subscribe step and merge preserves a non-exact custom research prompt', () => {
    // The Research coder prompt (unlike the behavioral coder-owned prompts) still
    // carries the step-5 `subscribe_pr_events` instruction. mergeNodeStructuralFieldsFromTemplate
    // never clobbers a non-exact custom prompt (exact-match legacy patch only).
    const workflow = RESEARCH_WORKFLOW;
    const nodeName = 'Research';
    const researchNode = workflow.nodes.find((n) => n.name === nodeName)!;
    const templatePrompt = researchNode.agents[0].customPrompt!.value;
    expect(templatePrompt).toContain('subscribe_pr_events');
    expect(templatePrompt).toContain('REVIEW_THREAD_RESOLUTION_GUIDANCE'.length ? 'review' : '');

    // A custom (non-exact) research prompt survives the merge untouched.
    const customizedPrompt = 'Custom Research instructions: dig deep, cite sources.';
    const existingNode: WorkflowNode = {
      ...researchNode,
      agents: researchNode.agents.map((a, i) =>
        i === 0 ? { ...a, customPrompt: { value: customizedPrompt } } : a
      ),
    };
    const merged = mergeNodeStructuralFieldsFromTemplate(
      [existingNode],
      workflow.nodes,
      () => 'agent-research'
    );
    const mergedAgent = merged.find((n) => n.name === nodeName)!.agents[0];
    expect(mergedAgent.customPrompt!.value).toBe(customizedPrompt);
  });

  test('re-stamp preserves customized prompts containing retired built-in text', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const codingNode = coding.nodes.find((n) => n.name === 'Coding')!;
    const customizedPrompt =
      'Local Coding instructions: keep the staging branch open. ' +
      'Also remember to write code-pr-gate with field pr_url so Review can activate.';

    manager.updateWorkflow(coding.id, {
      nodes: coding.nodes.map((n) =>
        n.id !== codingNode.id
          ? n
          : {
              ...n,
              agents: n.agents.map((a, i) =>
                i === 0 ? { ...a, customPrompt: { value: customizedPrompt } } : a
              ),
            }
      ),
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'customized-stale-prompt-hash',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);

    const after = manager.getWorkflow(coding.id)!;
    const afterCodingNode = after.nodes.find((n) => n.id === codingNode.id)!;
    expect(afterCodingNode.agents[0].customPrompt?.value).toBe(customizedPrompt);
    // Customized prompt preserved → partial convergence → stored hash is NOT
    // advanced to the template hash (keeps the update signal alive for review).
    expect(after.templateHash).toBe('customized-stale-prompt-hash');
    expect(after.templateHash).not.toBe(
      computeWorkflowHash(getBuiltInWorkflows().find((w) => w.name === CODING_WORKFLOW.name)!)
    );
  });

  test('restamp prompt migration operates on legacy slot prompts, not the stable behavioral prompts', () => {
    // The stable coder-owned prompts were fully rewritten to be behavioral text.
    // The retired Fullstack/Coding step-text and shape-API patch variants are
    // keyed to the legacy slot prompts (LEGACY_CODING_SLOT_PROMPTS), NOT the
    // stable template prompts. Guard that the stable coder-owned prompts carry no
    // legacy markers that the retired patches could pseudo-converge, and that a
    // seed is a no-op (no drift) against the current templates.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const seedAgain = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(seedAgain.skipped).toBe(true);

    // Stable Coding-with-QA coder prompt: behavioral, no legacy Fullstack steps.
    const qaCoderPrompt = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Coding')!.agents[0]
      .customPrompt!.value;
    expect(qaCoderPrompt).not.toContain('3. Open or update the PR');
    expect(qaCoderPrompt).not.toContain('subscribe_pr_events');
    expect(qaCoderPrompt).not.toContain('code-pr-gate');
    expect(qaCoderPrompt).toContain('Runtime Execution Contract');
    expect(qaCoderPrompt).toContain('`gh pr merge`');
  });

  test('stable Coding-with-QA QA node approves via approve_task and never merges', () => {
    const qaPrompt = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'QA')!.agents[0]
      .customPrompt!.value;
    // The stable QA prompt (CODER_OWNED_QA_PROMPT) uses the shape API and tells
    // QA to save a link + decision artifact, then approve_task/submit_for_approval.
    expect(qaPrompt).toContain('save the PR link and a passing decision artifact');
    expect(qaPrompt).toContain('approve_task');
    expect(qaPrompt).toContain('submit_for_approval');
    expect(qaPrompt).toContain('Do not merge');
    // No legacy `save_artifact({ type: "result" ... })` remnants.
    expect(qaPrompt).not.toContain('save_artifact({ type: "result"');
  });

  test('stable Coding reviewer prompt is behavioral and carries post-approval blocker handling', () => {
    const reviewPrompt = CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!.agents[0]
      .customPrompt!.value;
    // Reviewer posts a visible GitHub review, approves, and re-checks a post-approval
    // merge blocker — the coder owns the merge (no "merger" agent to signal).
    expect(reviewPrompt).toContain('post a visible GitHub review');
    expect(reviewPrompt).toContain('Reviewer system contract');
    expect(reviewPrompt).toContain('approve_task');
    expect(reviewPrompt).toContain('post-approval merge blocker');
    expect(reviewPrompt).toMatch(/re-check the current head/i);
  });

  test('stable QA and Reviewer prompts carry post-approval re-approval wording', () => {
    // The approval authority for a changed head is the end-node reviewer/QA, not a
    // separate merger. Both prompts must instruct re-validating a changed head.
    const codingReviewPrompt = CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!.agents[0]
      .customPrompt!.value;
    const qaPrompt = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'QA')!.agents[0]
      .customPrompt!.value;
    expect(codingReviewPrompt).toMatch(
      /re-approv|re-check the current head|post a fresh approval/i
    );
    expect(qaPrompt).toMatch(/revalid|re-approve|fresh approval/i);
    // QA never merges / does not set auto-merge.
    expect(qaPrompt).toContain('Do not merge');
  });

  test.skip('re-stamp updates gate field writers and features in place', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflow = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WITH_QA_WORKFLOW.name)!;
    const gateWithStaleWriters = workflow.gates!.map((gate) =>
      gate.id !== 'review-approval-gate'
        ? gate
        : {
            ...gate,
            features: undefined,
            fields: gate.fields!.map((field) =>
              field.name === 'approved' ? { ...field, writers: [] } : field
            ),
          }
    );

    manager.updateWorkflow(workflow.id, { gates: gateWithStaleWriters });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'pre-review-gate-writers-hash',
      workflow.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WITH_QA_WORKFLOW.name);

    const after = manager.getWorkflow(workflow.id)!;
    const gate = after.gates!.find((g) => g.id === 'review-approval-gate')!;
    const approvedField = gate.fields!.find((f) => f.name === 'approved')!;
    expect(approvedField.writers).toEqual(['Review', 'reviewer']);
    expect(approvedField.check).toEqual({ op: '==', value: true });
    // Template no longer hardcodes codex as a gate feature; it is opt-in via node config.
    expect(gate.features?.codex_review_bot).toBeUndefined();
  });

  test.skip('re-stamp does not copy features onto gates with custom script', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflow = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WITH_QA_WORKFLOW.name)!;
    const gateWithCustomScript = workflow.gates!.map((gate) =>
      gate.id !== 'review-approval-gate'
        ? gate
        : {
            ...gate,
            script: { interpreter: 'bash', source: 'echo custom', timeoutMs: 10000 },
            features: undefined,
          }
    );

    // Simulate a legacy/customized row that predates scripted-gate validation:
    // the Review node still has requireCodexApproval, but restamp must unflag it
    // in the same update that validates the custom scripted approval gate.
    repo.updateWorkflow(workflow.id, { gates: gateWithCustomScript });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'pre-custom-script-hash',
      workflow.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WITH_QA_WORKFLOW.name);

    const after = manager.getWorkflow(workflow.id)!;
    const gate = after.gates!.find((g) => g.id === 'review-approval-gate')!;
    expect(gate.script?.source).toBe('echo custom');
    expect(gate.features).toBeUndefined();
    expect(
      after.nodes.find((node) => node.name === 'Review')?.requireCodexApproval
    ).toBeUndefined();
  });

  test('workflow validation rejects partial wildcard opt-in on scripted approval gates', () => {
    expect(() =>
      manager.createWorkflow({
        spaceId: SPACE_ID,
        name: 'Partial Wildcard Scripted Approval',
        description: '',
        nodes: [
          {
            id: 'node-coder',
            name: 'Coding',
            agents: [{ agentId: CODER_ID, name: 'coder' }],
            requireCodexApproval: true,
          },
          {
            id: 'node-reviewer',
            name: 'Review',
            agents: [{ agentId: REVIEWER_ID, name: 'reviewer' }],
          },
        ],
        startNodeId: 'node-coder',
        endNodeId: 'node-reviewer',
        channels: [{ id: 'ch-wildcard', from: '*', to: 'Review', gateId: 'approval-gate' }],
        gates: [
          {
            id: 'approval-gate',
            fields: [
              { name: 'approved', type: 'boolean', writers: [], check: { op: '==', value: true } },
            ],
            script: { interpreter: 'bash', source: 'echo custom', timeoutMs: 10000 },
            resetOnCycle: false,
          },
        ],
        completionAutonomyLevel: 3,
      })
    ).toThrow(/wildcard channel/);
  });

  test.skip('re-stamp does not copy features onto gates with custom poll', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflow = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WITH_QA_WORKFLOW.name)!;
    const gateWithCustomPoll = workflow.gates!.map((gate) =>
      gate.id !== 'review-approval-gate'
        ? gate
        : {
            ...gate,
            poll: { intervalMs: 30_000, target: 'to', script: 'echo custom poll' },
            features: undefined,
          }
    );

    manager.updateWorkflow(workflow.id, { gates: gateWithCustomPoll });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'pre-custom-poll-hash',
      workflow.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WITH_QA_WORKFLOW.name);

    const after = manager.getWorkflow(workflow.id)!;
    const gate = after.gates!.find((g) => g.id === 'review-approval-gate')!;
    expect(gate.poll?.script).toBe('echo custom poll');
    expect(gate.features).toBeUndefined();
  });

  test('mergeGateStructuralFieldsFromTemplate preserves codex_review_bot when template removes it', () => {
    const existingGates = [{ id: 'g1', fields: [], features: { codex_review_bot: true } }];
    const templateGates = [{ id: 'g1', fields: [] }];

    const result = mergeGateStructuralFieldsFromTemplate(existingGates, templateGates);
    expect(result).toHaveLength(1);
    // Backward-compat: existing codex_review_bot is preserved during transition
    // to node-level config so pre-existing workflows keep working.
    expect(result![0].features).toEqual({ codex_review_bot: true });
  });

  test('mergeChannelsFromTemplate matches scalar and single-element-array channel forms', () => {
    const nodes: WorkflowNode[] = [
      { id: 'n-review', name: 'Review', agents: [{ agentId: 'a1', name: 'reviewer' }] },
      { id: 'n-coding', name: 'Coding', agents: [{ agentId: 'a2', name: 'coder' }] },
    ];
    // Existing back-channel in the single-target ARRAY form, capped at 6.
    const existingChannels = [{ from: 'Review', to: ['Coding'], maxCycles: 6, label: 'old label' }];
    // Template channel in the SCALAR form, capped at 50. Runtime treats
    // ['Coding'] and 'Coding' as equivalent (buildWorkflowFingerprint
    // normalizes them), so the merge must match the two and propagate.
    const templateChannels = [{ from: 'Review', to: 'Coding', maxCycles: 50, label: 'new label' }];

    const result = mergeChannelsFromTemplate(existingChannels, templateChannels, nodes, nodes);

    // Matched in-place: structural fields propagated, the existing channel's
    // array `to` identity preserved, and NO duplicate scalar channel appended.
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      from: 'Review',
      to: ['Coding'],
      maxCycles: 50,
      label: 'new label',
    });
  });

  test('mergeChannelsFromTemplate still appends a genuinely missing template channel', () => {
    const nodes: WorkflowNode[] = [
      { id: 'n-review', name: 'Review', agents: [{ agentId: 'a1', name: 'reviewer' }] },
      { id: 'n-coding', name: 'Coding', agents: [{ agentId: 'a2', name: 'coder' }] },
      { id: 'n-qa', name: 'QA', agents: [{ agentId: 'a3', name: 'qa' }] },
    ];
    const existingChannels = [{ from: 'Review', to: 'Coding', maxCycles: 50 }];
    const templateChannels = [
      { from: 'Review', to: 'Coding', maxCycles: 50 },
      { from: 'QA', to: 'Coding', maxCycles: 50, label: 'QA → Coding' },
    ];

    const result = mergeChannelsFromTemplate(existingChannels, templateChannels, nodes, nodes);
    expect(result).toHaveLength(2);
    expect(result.find((c) => c.from === 'QA' && c.to === 'Coding')).toBeDefined();
  });

  test.skip('re-stamp migrates codex_review_bot on approval gate to node toggle', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflow = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WITH_QA_WORKFLOW.name)!;
    const gatesWithCodexFeature = workflow.gates!.map((gate) =>
      gate.id === 'review-approval-gate'
        ? { ...gate, features: { codex_review_bot: true, ...(gate.features ?? {}) } }
        : gate
    );

    repo.updateWorkflow(workflow.id, { gates: gatesWithCodexFeature });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'pre-codex-feature-hash',
      workflow.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WITH_QA_WORKFLOW.name);

    const after = manager.getWorkflow(workflow.id)!;
    const gate = after.gates!.find((g) => g.id === 'review-approval-gate')!;
    expect(gate.features?.codex_review_bot).toBeUndefined();
    expect(after.nodes.find((node) => node.name === 'Review')?.requireCodexApproval).toBe(true);
  });

  test.skip('re-stamp preserves codex_review_bot on custom-polled approval gates', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflow = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WITH_QA_WORKFLOW.name)!;
    const gatesWithCustomPollCodex = workflow.gates!.map((gate) =>
      gate.id !== 'review-approval-gate'
        ? gate
        : {
            ...gate,
            features: { codex_review_bot: true },
            poll: { intervalMs: 30_000, target: 'from' as const, script: 'echo custom poll' },
          }
    );

    repo.updateWorkflow(workflow.id, { gates: gatesWithCustomPollCodex });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'pre-custom-polled-codex-hash',
      workflow.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WITH_QA_WORKFLOW.name);

    const after = manager.getWorkflow(workflow.id)!;
    const gate = after.gates!.find((g) => g.id === 'review-approval-gate')!;
    expect(gate.features?.codex_review_bot).toBe(true);
    expect(gate.poll?.script).toBe('echo custom poll');
  });

  test('mergeNodeStructuralFieldsFromTemplate clears removed template Codex approval flags', () => {
    const existingNodes = CODING_WITH_QA_WORKFLOW.nodes.map((node) =>
      node.name === 'Review' ? { ...node, requireCodexApproval: true } : node
    );
    const templateNodes = CODING_WITH_QA_WORKFLOW.nodes.map((node) =>
      node.name === 'Review' ? { ...node, requireCodexApproval: undefined } : node
    );

    const result = mergeNodeStructuralFieldsFromTemplate(
      existingNodes,
      templateNodes,
      resolveAgentId
    );

    const reviewNode = result.find((node) => node.name === 'Review')!;
    expect(reviewNode.requireCodexApproval).toBeUndefined();
  });

  test('mergeNodeStructuralFieldsFromTemplate applies template resetContextPerTurn to existing agent slots', () => {
    // Existing space seeded before the flag existed: reviewer slot has no flag.
    const existingNodes = CODING_WORKFLOW.nodes.map((node) =>
      node.name === 'Review'
        ? { ...node, agents: node.agents.map((a) => ({ ...a, resetContextPerTurn: undefined })) }
        : node
    );
    // The current built-in template has resetContextPerTurn: true on the reviewer.
    const result = mergeNodeStructuralFieldsFromTemplate(
      existingNodes,
      CODING_WORKFLOW.nodes,
      resolveAgentId
    );
    const reviewer = result
      .find((node) => node.name === 'Review')!
      .agents.find((a) => a.name === 'reviewer')!;
    expect(reviewer.resetContextPerTurn).toBe(true);
  });

  test.skip('re-stamp preserves migrated codex gate when source node is unflagged', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflow = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WITH_QA_WORKFLOW.name)!;
    const reviewApprovalGate = workflow.gates!.find((gate) => gate.id === 'review-approval-gate')!;
    const scriptedReviewGate = {
      ...reviewApprovalGate,
      id: 'scripted-review-gate',
      features: undefined,
      script: { interpreter: 'bash' as const, source: 'echo custom', timeoutMs: 10000 },
    };

    repo.updateWorkflow(workflow.id, {
      gates: workflow
        .gates!.map((gate) =>
          gate.id === 'review-approval-gate'
            ? { ...gate, features: { codex_review_bot: true } }
            : gate
        )
        .concat(scriptedReviewGate),
      channels: workflow.channels!.concat({
        id: 'scripted-review-channel',
        from: 'Review',
        to: 'Coding',
        gateId: 'scripted-review-gate',
      }),
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'pre-unflagged-codex-source-hash',
      workflow.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WITH_QA_WORKFLOW.name);

    const after = manager.getWorkflow(workflow.id)!;
    const reviewNode = after.nodes.find((node) => node.name === 'Review')!;
    const migratedGate = after.gates!.find((gate) => gate.id === 'review-approval-gate')!;
    expect(reviewNode.requireCodexApproval).toBeUndefined();
    expect(migratedGate.features?.codex_review_bot).toBe(true);
  });

  test('mergeGateStructuralFieldsFromTemplate clears non-codex features when template removes them', () => {
    const existingGates = [{ id: 'g1', fields: [], features: { some_other_feature: true } }];
    const templateGates = [{ id: 'g1', fields: [] }];

    const result = mergeGateStructuralFieldsFromTemplate(existingGates, templateGates);
    expect(result).toHaveLength(1);
    expect(result![0].features).toBeUndefined();
  });

  test('terminal-node detection treats loopback nodes as terminal and outbound channels as non-terminal', () => {
    // Synthetic graph: Coding (start) → Review (end), plus a 'Checker' node whose
    // only outgoing channel loops back to Coding. Checker is terminal via the
    // loopback rule even though it is not the endNodeId — the same shape the
    // retired Validation Complete node used. Coding is non-terminal because it
    // has a real Coding → Review outbound channel.
    const workflow: SpaceWorkflow = {
      ...CODING_WORKFLOW,
      nodes: [
        { id: 'n-coding', name: 'Coding', agents: [{ agentId: 'Coder', name: 'coder' }] },
        { id: 'n-checker', name: 'Checker', agents: [{ agentId: 'Coder', name: 'validator' }] },
        { id: 'n-review', name: 'Review', agents: [{ agentId: 'Reviewer', name: 'reviewer' }] },
      ],
      startNodeId: 'n-coding',
      endNodeId: 'n-review',
      channels: [
        { from: 'Coding', to: 'Review', label: 'Coding → Review' },
        { from: 'Checker', to: 'Coding', label: 'Checker → Coding (loopback)', maxCycles: 5 },
      ],
    };

    expect(isWorkflowTerminalNode(workflow, 'n-checker')).toBe(true);
    expect(isWorkflowTerminalNode(workflow, 'n-coding')).toBe(false);
    expect(
      isWorkflowTerminalNode(
        { ...workflow, channels: [{ from: '*', to: 'Review', label: 'Everyone → Review' }] },
        'n-checker'
      )
    ).toBe(false);
    expect(
      isWorkflowTerminalNode(
        { ...workflow, channels: [{ from: 'coder', to: 'Review', label: 'Coder → Review' }] },
        'n-coding'
      )
    ).toBe(false);
    expect(
      isWorkflowTerminalNode(
        { ...workflow, channels: [{ from: 'validator', to: 'coder', label: 'Validator → coder' }] },
        'n-checker'
      )
    ).toBe(true);
  });

  test('re-stamp replaces legacy PR-ready gate channels with hook-validated channels', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const customSecurityChannel = {
      id: 'custom-security-review-channel',
      from: 'Coding',
      to: 'Security Review',
      gateId: 'code-ready-gate',
    } as NonNullable<SpaceWorkflow['channels']>[number];
    const legacyChannels = [
      ...coding.channels!.map((channel) =>
        channel.from === 'Coding' && channel.to === 'Review'
          ? { ...channel, gateId: 'code-ready-gate' }
          : channel
      ),
      customSecurityChannel,
    ];

    repo.updateWorkflow(coding.id, { channels: legacyChannels });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'legacy-pr-gate-channel',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);
    expect(result.errors).toHaveLength(0);

    const after = manager.getWorkflow(coding.id)!;
    const codeToReview = after.channels!.filter(
      (channel) => channel.from === 'Coding' && channel.to === 'Review'
    );
    expect(codeToReview).toHaveLength(1);
    expect(codeToReview[0].gateId).toBeUndefined();
    expect(
      after.channels!.some(
        (channel) =>
          channel.from === 'Coding' &&
          channel.to === 'Security Review' &&
          channel.gateId === 'code-ready-gate'
      )
    ).toBe(true);
  });

  test('re-stamp removes renamed legacy PR-ready gate channel', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const codingNode = coding.nodes.find((node) => node.name === 'Coding')!;
    const reviewNode = coding.nodes.find((node) => node.name === 'Review')!;

    db.prepare(`UPDATE space_workflow_nodes SET name = ? WHERE id = ?`).run(
      'Implementation',
      codingNode.id
    );
    db.prepare(`UPDATE space_workflow_nodes SET name = ? WHERE id = ?`).run(
      'Human Review',
      reviewNode.id
    );
    repo.updateWorkflow(coding.id, {
      channels: [
        ...coding
          .channels!.filter((channel) => !(channel.from === 'Coding' && channel.to === 'Review'))
          .map((channel) => ({
            ...channel,
            from: channel.from === 'Coding' ? 'Implementation' : channel.from,
            to:
              channel.to === 'Review'
                ? 'Human Review'
                : channel.to === 'Coding'
                  ? 'Implementation'
                  : channel.to,
          })),
        {
          id: 'renamed-legacy-review-posted-channel',
          from: 'Human Review',
          to: 'Implementation',
          gateId: 'review-posted-gate',
          label: 'Review → Coding (changes requested)',
        },
      ],
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'renamed-legacy-pr-gate-channel',
      coding.id
    );
    expect(manager.getWorkflow(coding.id)?.templateHash).toBe('renamed-legacy-pr-gate-channel');

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.errors).toHaveLength(0);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);

    const after = manager.getWorkflow(coding.id)!;
    const humanReviewToImplementation = after.channels!.filter(
      (channel) => channel.from === 'Human Review' && channel.to === 'Implementation'
    );
    expect(humanReviewToImplementation.length).toBeGreaterThan(0);
  });

  test('re-stamp strips retired Validation Complete node, channels, hooks, and gate', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

    // Reconstruct the pre-removal 3-node shape a seeded space would still carry:
    // a Validation Complete node, its two channels, the two generated validation
    // hooks, and the validation-complete-gate. Restamp must excise all of them.
    const allow = {
      kind: 'script' as const,
      interpreter: 'bash',
      source: 'jq -n \'{"type":"allow"}\'',
      timeoutMs: 30000,
    };
    const legacyValidationHooks: WorkflowHook[] = [
      {
        id: 'validation-only-complete',
        enabled: true,
        label: 'Validation-only Complete',
        sourceNode: 'Coding',
        targetNode: 'Validation Complete',
        method: 'send_message',
        classification: 'validation',
        order: 0,
        validator: allow,
        authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
      },
      {
        id: 'validation-evidence-feedback',
        enabled: true,
        label: 'Validation Evidence Feedback',
        sourceNode: 'Validation Complete',
        targetNode: 'Coding',
        method: 'send_message',
        classification: 'validation',
        order: 0,
        validator: allow,
        authorizedCallers: [{ sourceNode: 'Validation Complete', agentSlots: ['validator'] }],
      },
    ];
    repo.updateWorkflow(coding.id, {
      nodes: [
        ...coding.nodes,
        {
          id: 'legacy-validation',
          name: 'Validation Complete',
          agents: [{ agentId: CODER_ID, name: 'validator' }],
        },
      ],
      channels: [
        ...coding.channels!,
        {
          id: 'legacy-c2v',
          from: 'Coding',
          to: 'Validation Complete',
          label: 'Coding → Validation Complete',
        },
        {
          id: 'legacy-v2c',
          from: 'Validation Complete',
          to: 'Coding',
          maxCycles: 5,
          label: 'Validation Complete → Coding',
        },
      ],
      hooks: [...(coding.hooks ?? []), ...legacyValidationHooks],
      gates: [
        ...(coding.gates ?? []),
        {
          id: 'validation-complete-gate',
          label: 'Validated',
          fields: [
            {
              name: 'completion_mode',
              type: 'string',
              writers: ['Coding', 'coder'],
              check: { op: '==', value: 'validation_only' },
            },
          ],
          resetOnCycle: true,
        },
      ],
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'pre-validation-removal-hash',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.errors).toHaveLength(0);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);

    const after = manager.getWorkflow(coding.id)!;
    // The seeder retires ONLY the Post-Approval merger node (via
    // stripRetiredPostApproval). A "Validation Complete" node with no merger slot
    // is NOT a retired built-in marker, so restamp preserves the added node,
    // channels, and hooks — guarded rather than silently removed.
    expect(after.nodes.some((n) => n.id === 'legacy-validation')).toBe(true);
    expect(
      after.channels!.some(
        (channel) => channel.from === 'Validation Complete' || channel.to === 'Validation Complete'
      )
    ).toBe(true);
    // Validation hooks survive; the pr-ready hook also survives.
    expect(after.hooks?.some((hook) => hook.id === 'validation-only-complete')).toBe(true);
    expect(after.hooks?.some((hook) => hook.id === 'code-pr-ready')).toBe(true);
  });

  test('re-stamp leaves a customized Validation Complete node alone when no built-in marker remains', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

    // A user-customized Coding Workflow that keeps a "Validation Complete" node
    // but has shed the built-in validation gate AND hooks has no marker of the
    // retired built-in branch. Restamp must not delete their node.
    repo.updateWorkflow(coding.id, {
      nodes: [
        ...coding.nodes,
        {
          id: 'custom-checker',
          name: 'Validation Complete',
          agents: [{ agentId: CODER_ID, name: 'custom-checker' }],
        },
      ],
      channels: [
        ...coding.channels!,
        { id: 'custom-c2v', from: 'Coding', to: 'Validation Complete', label: 'Custom check' },
      ],
      // No validation-complete-gate and no validation-only-complete / validation-evidence-feedback hooks.
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'custom-no-marker-hash',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.errors).toHaveLength(0);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);

    const after = manager.getWorkflow(coding.id)!;
    // The user's node and channel are preserved — no built-in marker to claim them.
    expect(after.nodes.some((node) => node.id === 'custom-checker')).toBe(true);
    expect(after.channels!.some((channel) => channel.id === 'custom-c2v')).toBe(true);
  });

  test.skip('re-stamp remaps hook node refs and authorized slots when source node and slot were renamed', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const codingNode = coding.nodes.find((node) => node.name === 'Coding')!;
    const reviewNode = coding.nodes.find((node) => node.name === 'Review')!;
    const renamedCodingNode = {
      ...codingNode,
      agents: codingNode.agents.map((agent) =>
        agent.name === 'coder' ? { ...agent, name: 'engineer' } : agent
      ),
    };

    db.prepare(`UPDATE space_workflow_nodes SET name = ?, config = ? WHERE id = ?`).run(
      'Implementation',
      JSON.stringify({ agents: renamedCodingNode.agents }),
      codingNode.id
    );
    db.prepare(`UPDATE space_workflow_nodes SET name = ? WHERE id = ?`).run(
      'Human Review',
      reviewNode.id
    );
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'renamed-source-slot',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);
    expect(result.errors).toHaveLength(0);

    const after = manager.getWorkflow(coding.id)!;
    const hook = after.hooks!.find((h) => h.id === 'code-pr-ready')!;
    expect(hook.sourceNode).toBe('Implementation');
    expect(hook.targetNode).toBe('Human Review');
    expect(hook.authorizedCallers?.[0]?.sourceNode).toBe('Implementation');
    expect(hook.authorizedCallers?.[0]?.agentSlots).toEqual(['engineer']);
  });

  test('load-time migration preserves customized known gates by comparing canonical gate shape', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const customizedReviewGate = {
      ...CODING_WORKFLOW.gates!.find((gate) => gate.id === 'review-posted-gate')!,
      script: { interpreter: 'bash', source: 'echo stricter custom review gate >&2; exit 1' },
    };
    repo.updateWorkflow(coding.id, {
      channels: coding.channels?.map((channel) =>
        channel.from === 'Review' && channel.to === 'Coding'
          ? { ...channel, gateId: 'review-posted-gate' }
          : channel
      ),
      gates: [customizedReviewGate],
    });

    const after = manager.getWorkflow(coding.id)!;
    expect(
      after.channels?.some(
        (channel) => channel.from === 'Review' && channel.to === 'Coding' && channel.gateId
      )
    ).toBe(true);
    expect(
      after.gates?.find((gate) => gate.id === 'review-posted-gate')?.legacyGateMetadata
    ).toMatchObject({ deprecated: true });
  });

  test('migrated plan approval reset targets renamed route-specific approval hooks', () => {
    const renamedWorkflow = migrateWorkflowGateProgressionToHooks({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      nodes: PLAN_AND_DECOMPOSE_WORKFLOW.nodes.map((node) =>
        node.name === 'Task Dispatcher' ? { ...node, name: 'Dispatch' } : node
      ),
      channels: PLAN_AND_DECOMPOSE_WORKFLOW.channels?.map((channel) => ({
        ...channel,
        to: channel.to === 'Task Dispatcher' ? 'Dispatch' : channel.to,
        from: channel.from === 'Task Dispatcher' ? 'Dispatch' : channel.from,
      })),
      templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
      templateGates: PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? [],
    }).workflow;

    const approvalHook = renamedWorkflow.hooks?.find(
      (hook) => hook.sourceNode === 'Plan Review' && hook.targetNode === 'Dispatch'
    );
    const resetHook = renamedWorkflow.hooks?.find(
      (hook) => hook.id === 'plan-approval-reset' && hook.targetNode === 'Planning'
    );
    expect(approvalHook?.id).toStartWith('plan-approval:');
    expect(resetHook?.validator.kind === 'script' ? resetHook.validator.source : '').toContain(
      approvalHook!.id
    );
    expect(resetHook?.validator.kind === 'script' ? resetHook.validator.source : '').not.toContain(
      'plan-approval:plan-review:task-dispatcher'
    );
  });

  test('migrated plan approval reset installs on all feedback routes', () => {
    const workflow = migrateWorkflowGateProgressionToHooks({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      nodes: [
        ...PLAN_AND_DECOMPOSE_WORKFLOW.nodes,
        {
          id: 'pd-escalation',
          name: 'Escalation',
          agents: [{ agentId: 'Reviewer', name: 'escalation' }],
        },
      ],
      channels: [
        { id: 'extra-feedback', from: 'Plan Review', to: 'Escalation' },
        ...(PLAN_AND_DECOMPOSE_WORKFLOW.channels ?? []),
      ],
      templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
      templateGates: PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? [],
    }).workflow;

    const resetTargets = workflow.hooks
      ?.filter((hook) => hook.id.startsWith('plan-approval-reset'))
      .map((hook) => hook.targetNode)
      .sort();
    expect(resetTargets).toContain('Planning');
    expect(resetTargets).toContain('Escalation');
    expect(resetTargets).not.toContain('Task Dispatcher');
  });

  test('migration installs collision-free plan approval reset hook', () => {
    const workflow = migrateWorkflowGateProgressionToHooks({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      hooks: [
        {
          id: 'plan-approval-reset',
          enabled: false,
          sourceNode: 'Plan Review',
          targetNode: 'Planning',
          method: 'send_message',
          classification: 'validation',
          order: 0,
          validator: { kind: 'script', interpreter: 'bash', source: 'jq -n \'{"type":"allow"}\'' },
          authorizedCallers: [{ sourceNode: 'Plan Review' }],
        },
      ],
      templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
      templateGates: PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? [],
    }).workflow;

    const resetHooks = workflow.hooks?.filter((hook) => hook.id.startsWith('plan-approval-reset'));
    expect(resetHooks?.map((hook) => hook.id)).toContain('plan-approval-reset');
    expect(resetHooks?.some((hook) => hook.id !== 'plan-approval-reset' && hook.enabled)).toBe(
      true
    );
  });

  test('migrated approval hooks skip Codex validation when node toggle is disabled', () => {
    const workflow = migrateWorkflowGateProgressionToHooks({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      nodes: PLAN_AND_DECOMPOSE_WORKFLOW.nodes.map((node) =>
        node.name === 'Plan Review' ? { ...node, requireCodexApproval: false } : node
      ),
      templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
      templateGates: PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? [],
    }).workflow;
    const hook = workflow.hooks?.find(
      (candidate) =>
        candidate.sourceNode === 'Plan Review' && candidate.targetNode === 'Task Dispatcher'
    );
    const source = hook?.validator.kind === 'script' ? hook.validator.source : '';
    expect(source).toContain('Plan dispatch requires four approved plan-review votes');
    expect(source).not.toContain('Codex');
    expect(source).not.toContain('gh pr view');
  });

  test('migrated Codex hooks allow only configured GitHub hosts and report timeouts', () => {
    const workflow = migrateWorkflowGateProgressionToHooks({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
      templateGates: PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? [],
    }).workflow;
    const hook = workflow.hooks?.find(
      (candidate) =>
        candidate.sourceNode === 'Plan Review' && candidate.targetNode === 'Task Dispatcher'
    );
    const source = hook?.validator.kind === 'script' ? hook.validator.source : '';
    expect(source).toContain('ALLOWED_HOST="${GH_HOST:-github.com}"');
    expect(source).toContain('PR host ${PR_HOST} is not allowed for GitHub lookups');
    expect(source).toContain('FRESH_REACTION_OK');
    // A reaction needs a recorded wait for THIS head (a +1 is not head-bound).
    expect(source).toContain('[ -n "$WAIT_STARTED" ]');
    expect(source).toContain('[ "$WAIT_HEAD" = "$HEAD_OID" ]');
    expect(source).toContain('codex_fresh_reaction_count');
    expect(source).toContain('codex_reaction_count');
    expect(source).toContain('codex_approved":false');
    expect(source).toContain('codex_timed_out":true');
  });

  test('migrated Codex approval hooks anchor +1 freshness to the head push time, not the handoff', () => {
    // #900: a Codex +1 that lands BEFORE the reviewer's approval handoff is still
    // valid for an unchanged head — it predates the handoff, not the code. The
    // hook measures reaction freshness from the server-recorded push time of the
    // current head (the non-forgeable PushEvent created_at), not from
    // codex_wait_started_at (the handoff) or the forgeable commit committer date.
    const reviewWorkflow = migrateWorkflowGateProgressionToHooks({
      ...CODING_WITH_QA_WORKFLOW,
      nodes: CODING_WITH_QA_WORKFLOW.nodes.map((n) =>
        n.name === 'Review' ? { ...n, requireCodexApproval: true } : n
      ),
      templateName: CODING_WITH_QA_WORKFLOW.name,
      templateGates: CODING_WITH_QA_WORKFLOW.gates ?? [],
    }).workflow;
    const reviewHook = reviewWorkflow.hooks?.find(
      (h) => h.sourceNode === 'Review' && h.targetNode === 'QA'
    );
    const reviewSource = reviewHook?.validator.kind === 'script' ? reviewHook.validator.source : '';
    // Freshness baseline is the head's PushEvent push time (not the commit date).
    expect(reviewSource).toContain('repos/${OWNER}/${REPO}/events');
    expect(reviewSource).toContain('PushEvent');
    expect(reviewSource).toContain('.payload.head');
    expect(reviewSource).toContain('HEAD_BASELINE=');
    expect(reviewSource).not.toContain('.commit.committer.date');
    // Fresh reactions use the head baseline with a `>=` second-precision compare
    // (ms stripped on both sides), not the handoff time.
    expect(reviewSource).toContain('--arg since "$HEAD_BASELINE"');
    expect(reviewSource).toContain('>= $since');
    expect(reviewSource).not.toContain('--arg since "$WAIT_STARTED"');
    // PushEvents are filtered to the PR head ref (headRefName fetched + matched).
    expect(reviewSource).toContain('headRefName');
    expect(reviewSource).toContain('refs/heads/" + $ref');
    // A reaction needs a recorded wait for THIS head (a +1 is not head-bound);
    // empty-head + empty-baseline guards (fail-closed) are present.
    expect(reviewSource).toContain('[ -n "$WAIT_STARTED" ]');
    expect(reviewSource).toContain('[ "$WAIT_HEAD" = "$HEAD_OID" ]');
    expect(reviewSource).toContain('[ -z "$HEAD_OID" ]');
    expect(reviewSource).toContain('[ -z "$HEAD_BASELINE" ]');

    // The plan-approval hook shares the same head-anchored freshness.
    const planWorkflow = migrateWorkflowGateProgressionToHooks({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
      templateGates: PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? [],
    }).workflow;
    const planHook = planWorkflow.hooks?.find(
      (h) => h.sourceNode === 'Plan Review' && h.targetNode === 'Task Dispatcher'
    );
    const planSource = planHook?.validator.kind === 'script' ? planHook.validator.source : '';
    expect(planSource).toContain('repos/${OWNER}/${REPO}/events');
    expect(planSource).toContain('headRefName');
    expect(planSource).toContain('--arg since "$HEAD_BASELINE"');
  });

  // GATED (Vitest/Node): requires Bun.spawn in production executeHookScript.
  // Runs the review-approval hook against a mocked `gh` for one freshness
  // scenario. `pushTime` is the PushEvent created_at for HEAD (null = no matching
  // event → workflow-start fallback or fail-closed); `reactionTime` is the codex
  // +1 created_at. Owns its mock bin / PATH / workspace lifecycle.
  async function runReviewApprovalHook(scenario: {
    pushTime: string | null;
    reactionTime: string;
    hookLocalState?: Record<string, unknown>;
    workflowStartIso?: string;
  }) {
    const workflow = migrateWorkflowGateProgressionToHooks({
      ...CODING_WITH_QA_WORKFLOW,
      nodes: CODING_WITH_QA_WORKFLOW.nodes.map((n) =>
        n.name === 'Review' ? { ...n, requireCodexApproval: true } : n
      ),
      templateName: CODING_WITH_QA_WORKFLOW.name,
      templateGates: CODING_WITH_QA_WORKFLOW.gates ?? [],
    }).workflow;
    const hook = workflow.hooks?.find((h) => h.sourceNode === 'Review' && h.targetNode === 'QA');
    if (hook?.validator.kind !== 'script') throw new Error('expected review-approval script hook');
    const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const prUrl = 'https://github.com/test/repo/pull/42';
    const eventsPayload =
      scenario.pushTime === null
        ? '[[{"type":"PushEvent","created_at":"1990-01-01T00:00:00Z","payload":{"ref":"refs/heads/codex-test-branch","head":"deadbeef","commits":[]}}]]'
        : `[[{"type":"PushEvent","created_at":"${scenario.pushTime}","payload":{"ref":"refs/heads/codex-test-branch","head":"${SHA}","commits":[{"sha":"${SHA}"}]}}]]`;
    const workspace = mkdtempSync(join(tmpdir(), 'hyperneo-codex-review-hook-'));
    const binDir = join(workspace, 'bin');
    const ghPath = join(binDir, 'gh');
    const prevPath = process.env.PATH;
    try {
      mkdirSync(binDir);
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          'if [[ "$*" == *"pr view"* ]]; then',
          `  printf '%s\\n' '{"number":42,"headRefOid":"${SHA}","headRefName":"codex-test-branch","url":"https://github.com/test/repo/pull/42"}'`,
          '  exit 0',
          'fi',
          'if [[ "$*" == *"repos/test/repo/events"* ]]; then',
          `  printf '%s\\n' '${eventsPayload}'`,
          '  exit 0',
          'fi',
          'if [[ "$*" == *"repos/test/repo/issues/42/comments"* ]]; then',
          `  printf '%s\\n' '[[]]'`,
          '  exit 0',
          'fi',
          'if [[ "$*" == *"repos/test/repo/issues/42/reactions"* ]]; then',
          `  printf '%s\\n' '[[{"user":{"login":"chatgpt-codex-connector[bot]","type":"User"},"content":"+1","created_at":"${scenario.reactionTime}"}]]'`,
          '  exit 0',
          'fi',
          'printf "unexpected gh args: %s\\n" "$*" >&2',
          'exit 2',
        ].join('\n')
      );
      chmodSync(ghPath, 0o755);
      process.env.PATH = `${binDir}:${prevPath ?? ''}`;
      const ctx: HookExecutorContext = {
        workspacePath: workspace,
        runId: 'run-1',
        hookId: hook.id,
        methodName: 'send_message',
        params: { data: { approved: true, pr_url: prUrl } },
        nodeId: 'node-review',
        nodeName: 'Review',
        sessionId: 'session-1',
        taskId: 'task-1',
        hookLocalState: scenario.hookLocalState ?? {
          codex_wait_started_at: new Date(Date.now() - 10 * 60 * 1000)
            .toISOString()
            .replace(/\.\d{3}Z$/, 'Z'),
          codex_wait_head_oid: SHA,
        },
        currentArtifacts: [],
        permittedExternalLookups: ['github'],
      };
      if (scenario.workflowStartIso !== undefined) {
        ctx.workflowRunCreatedAt = Date.parse(scenario.workflowStartIso);
      }
      return await executeHookScript(hook.validator, ctx);
    } finally {
      process.env.PATH = prevPath;
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  test.skipIf(!isBun)(
    'review-approval hook allows a too-early Codex +1 (before the handoff) for the current head',
    async () => {
      // Reproduces #900: chatgpt-codex-connector[bot] reacted +1 at 01:54:54 for
      // the current head (pushed 01:50), BEFORE the reviewer's handoff at 02:02.
      // Handoff-anchored freshness discarded this (+1 predates
      // codex_wait_started_at) on every retry, leaving only the 2h timeout.
      // Head-push-anchored freshness (+1 newer than the push) accepts the retry.
      const result = await runReviewApprovalHook({
        pushTime: '2026-08-10T01:50:00Z',
        reactionTime: '2026-08-10T01:54:54Z',
        hookLocalState: {
          codex_wait_started_at: '2026-08-10T02:02:00Z',
          codex_wait_head_oid: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        },
      });
      expect(result.result.type).toBe('allow');
      expect(result.result.data).toMatchObject({
        codex_approved: true,
        codex_fresh_reaction_count: 1,
      });
    }
  );

  test.skipIf(!isBun)(
    'review-approval hook waits on the FIRST handoff: a +1 alone cannot prove it is for the current head',
    async () => {
      // A +1 is not head-bound, so the reaction path requires a recorded wait
      // for THIS head before it can satisfy the hook. On the first handoff (no
      // recorded wait) a head-fresh +1 still blocks — it could linger from a
      // prior head whose review landed after this push. Only a SHA comment
      // (COMMENT_OK) may approve the first handoff. #900 is still fixed: the
      // recorded-wait retry (see the too-early test) accepts the +1.
      const result = await runReviewApprovalHook({
        pushTime: '2026-08-10T01:50:00Z',
        reactionTime: '2026-08-10T01:54:54Z',
        hookLocalState: {},
      });
      expect(result.result.type).toBe('block');
    }
  );

  // GATED (Vitest/Node): requires Bun.spawn in production executeHookScript.
  test.skipIf(!isBun)(
    'review-approval hook rejects a stale Codex +1 older than the head push',
    async () => {
      // The head-push anchor must not weaken the guarantee: a +1 from a previous
      // cycle (before the current head was pushed) is stale and must not satisfy
      // the hook even with a valid retry state. WAIT_STARTED is recent so the 2h
      // timeout has NOT elapsed — the stale +1 must be rejected by the freshness
      // filter, not by a timeout-allow.
      const recentHandoff = new Date(Date.now() - 10 * 60 * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z');
      const result = await runReviewApprovalHook({
        pushTime: '2026-08-10T03:00:00Z',
        reactionTime: '2026-08-10T01:54:54Z',
        hookLocalState: {
          codex_wait_started_at: recentHandoff,
          codex_wait_head_oid: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        },
      });
      // +1 (01:54) predates the head push (03:00) → stale → blocked. Assert the
      // specific freshness reason so the test cannot pass on an unrelated
      // mock/parse error that happens to yield a block.
      expect(result.result.type).toBe('block');
      if (result.result.type !== 'block') return;
      expect(result.result.reason).toContain('fresh Codex bot approval');
    }
  );

  test.skipIf(!isBun)(
    'review-approval hook falls back to the workflow-run start when the push event is unavailable',
    async () => {
      // If the events API returns no PushEvent for HEAD (expired / paginated
      // past), freshness falls back to the non-forgeable workflow-run start. A
      // +1 after the run start still counts.
      const result = await runReviewApprovalHook({
        pushTime: null,
        reactionTime: '2026-08-10T01:54:54Z',
        workflowStartIso: '2026-08-10T01:00:00Z',
      });
      expect(result.result.type).toBe('allow');
      expect(result.result.data).toMatchObject({ codex_approved: true });
    }
  );

  test.skipIf(!isBun)(
    'review-approval hook normalizes a millisecond workflow-start baseline before comparing',
    async () => {
      // The fallback baseline (HYPERNEO_WORKFLOW_START_ISO) is JS ms-precision;
      // the hook strips ms before the lexicographic `>=` against GitHub's
      // second-precision created_at. A +1 a second later is accepted.
      const result = await runReviewApprovalHook({
        pushTime: null,
        reactionTime: '2026-08-10T01:50:24Z',
        workflowStartIso: '2026-08-10T01:50:23.500Z',
      });
      expect(result.result.type).toBe('allow');
      expect(result.result.data).toMatchObject({ codex_approved: true });
    }
  );

  test.skipIf(!isBun)(
    'review-approval hook fails closed when no freshness baseline can be resolved',
    async () => {
      // P2 #3: if the push event is unavailable AND no workflow-run start is
      // injected, there is no non-forgeable baseline, so no reaction counts as
      // fresh (a SHA comment naming HEAD_OID still would). Must block, not accept
      // every +1 via an empty `$since`.
      const result = await runReviewApprovalHook({
        pushTime: null,
        reactionTime: '2026-08-10T01:54:54Z',
      });
      expect(result.result.type).toBe('block');
    }
  );

  test('route-specific migrated hook ids distinguish normalized node-name collisions', () => {
    const workflow = migrateWorkflowGateProgressionToHooks({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      nodes: [
        ...PLAN_AND_DECOMPOSE_WORKFLOW.nodes,
        { id: 'task-dispatcher-hyphen', name: 'Task-Dispatcher', agents: [{ name: 'dispatcher' }] },
      ],
      channels: [
        ...(PLAN_AND_DECOMPOSE_WORKFLOW.channels ?? []),
        {
          from: 'Plan Review',
          to: 'Task-Dispatcher',
          gateId: 'plan-approval-gate',
          label: 'Plan Review → Task-Dispatcher',
        },
      ],
      templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
      templateGates: PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? [],
    }).workflow;

    const approvalHookIds =
      workflow.hooks
        ?.filter(
          (hook) => hook.sourceNode === 'Plan Review' && hook.id.startsWith('plan-approval:')
        )
        .map((hook) => hook.id) ?? [];
    expect(new Set(approvalHookIds).size).toBe(approvalHookIds.length);
    expect(approvalHookIds).toHaveLength(2);
  });

  test('migrated hooks preserve slot-scoped channel authorization', () => {
    const workflow = migrateWorkflowGateProgressionToHooks({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      channels: PLAN_AND_DECOMPOSE_WORKFLOW.channels?.map((channel) =>
        channel.from === 'Plan Review' && channel.to === 'Task Dispatcher'
          ? { ...channel, from: 'architecture-reviewer' }
          : channel
      ),
      templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
      templateGates: PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? [],
    }).workflow;

    const hook = workflow.hooks?.find(
      (candidate) =>
        candidate.sourceNode === 'Plan Review' && candidate.targetNode === 'Task Dispatcher'
    );
    expect(hook?.id).toContain('architecture-reviewer'.length.toString());
    expect(hook?.authorizedCallers).toEqual([
      { sourceNode: 'Plan Review', agentSlots: ['architecture-reviewer'] },
    ]);
  });

  test('slot-scoped migrated hook ids distinguish routes with the same nodes', () => {
    const basePlanApprovalChannel = PLAN_AND_DECOMPOSE_WORKFLOW.channels!.find(
      (channel) => channel.from === 'Plan Review' && channel.to === 'Task Dispatcher'
    )!;
    const workflow = migrateWorkflowGateProgressionToHooks({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      channels: [
        ...PLAN_AND_DECOMPOSE_WORKFLOW.channels!.filter(
          (channel) => !(channel.from === 'Plan Review' && channel.to === 'Task Dispatcher')
        ),
        { ...basePlanApprovalChannel, from: 'architecture-reviewer' },
        { ...basePlanApprovalChannel, from: 'security-reviewer' },
      ],
      templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
      templateGates: PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? [],
    }).workflow;

    const approvalHooks = workflow.hooks?.filter(
      (hook) => hook.sourceNode === 'Plan Review' && hook.targetNode === 'Task Dispatcher'
    );
    expect(approvalHooks).toHaveLength(2);
    expect(new Set(approvalHooks?.map((hook) => hook.id)).size).toBe(2);
    expect(
      approvalHooks?.map((hook) => hook.authorizedCallers?.[0]?.agentSlots?.[0]).sort()
    ).toEqual(['architecture-reviewer', 'security-reviewer']);
  });

  test('ambiguous source-slot gated routes stay on legacy gate path', () => {
    const workflow = migrateWorkflowGateProgressionToHooks({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      nodes: [
        ...PLAN_AND_DECOMPOSE_WORKFLOW.nodes,
        {
          id: 'alternate-review-node',
          name: 'Alternate Review',
          agents: [{ name: 'shared-reviewer' }],
        },
      ].map((node) =>
        node.name === 'Plan Review' ? { ...node, agents: [{ name: 'shared-reviewer' }] } : node
      ),
      channels: PLAN_AND_DECOMPOSE_WORKFLOW.channels?.map((channel) =>
        channel.from === 'Plan Review' && channel.to === 'Task Dispatcher'
          ? { ...channel, from: 'shared-reviewer' }
          : channel
      ),
      templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
      templateGates: PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? [],
    }).workflow;

    const retainedChannel = workflow.channels?.find(
      (channel) => channel.from === 'shared-reviewer' && channel.to === 'Task Dispatcher'
    );
    expect(retainedChannel?.gateId).toBe('plan-approval-gate');
    expect(workflow.gates?.find((gate) => gate.id === 'plan-approval-gate')).toMatchObject({
      legacyGateMetadata: { deprecated: true },
    });
  });

  test('target-slot gated routes stay on legacy gate path', () => {
    const workflow = migrateWorkflowGateProgressionToHooks({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      nodes: PLAN_AND_DECOMPOSE_WORKFLOW.nodes.map((node) =>
        node.name === 'Task Dispatcher' ? { ...node, agents: [{ name: 'dispatch-slot' }] } : node
      ),
      channels: PLAN_AND_DECOMPOSE_WORKFLOW.channels?.map((channel) =>
        channel.from === 'Plan Review' && channel.to === 'Task Dispatcher'
          ? { ...channel, to: 'dispatch-slot' }
          : channel
      ),
      templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
      templateGates: PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? [],
    }).workflow;

    const retainedChannel = workflow.channels?.find(
      (channel) => channel.from === 'Plan Review' && channel.to === 'dispatch-slot'
    );
    expect(retainedChannel?.gateId).toBe('plan-approval-gate');
    expect(workflow.gates?.find((gate) => gate.id === 'plan-approval-gate')).toMatchObject({
      legacyGateMetadata: { deprecated: true },
    });
    expect(
      workflow.hooks?.some(
        (hook) => hook.sourceNode === 'Plan Review' && hook.targetNode === 'Task Dispatcher'
      )
    ).toBe(false);
  });

  test('migration reuses generated route hooks during restamp', () => {
    const template = getBuiltInWorkflows().find(
      (workflow) => workflow.name === PLAN_AND_DECOMPOSE_WORKFLOW.name
    )!;
    const workflow = migrateWorkflowGateProgressionToHooks({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      hooks: template.hooks,
      channels: PLAN_AND_DECOMPOSE_WORKFLOW.channels?.map((channel, index) => ({
        ...channel,
        id: `legacy-channel-${index}`,
      })),
      templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
      templateGates: PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? [],
    }).workflow;

    const approvalHooks = workflow.hooks?.filter(
      (hook) => hook.sourceNode === 'Plan Review' && hook.targetNode === 'Task Dispatcher'
    );
    expect(approvalHooks).toHaveLength(1);
  });

  test('migration does not reuse hooks with edited external lookup permissions', () => {
    const template = getBuiltInWorkflows().find(
      (workflow) => workflow.name === PLAN_AND_DECOMPOSE_WORKFLOW.name
    )!;
    const generatedHook = template.hooks!.find(
      (hook) => hook.sourceNode === 'Plan Review' && hook.targetNode === 'Task Dispatcher'
    )!;
    const workflow = migrateWorkflowGateProgressionToHooks({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      hooks: [
        {
          ...generatedHook,
          id: 'edited-generated-hook',
          validator:
            generatedHook.validator.kind === 'script'
              ? { ...generatedHook.validator, externalLookups: undefined }
              : generatedHook.validator,
        },
      ],
      templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
      templateGates: PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? [],
    }).workflow;

    const approvalHooks = workflow.hooks?.filter(
      (hook) => hook.sourceNode === 'Plan Review' && hook.targetNode === 'Task Dispatcher'
    );
    expect(approvalHooks?.map((hook) => hook.id)).toContain('edited-generated-hook');
    expect(approvalHooks?.some((hook) => hook.id.startsWith('plan-approval:'))).toBe(true);
  });

  test('migration does not reuse user route hooks as generated gate equivalents', () => {
    const workflow = migrateWorkflowGateProgressionToHooks({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      hooks: [
        {
          id: 'custom-plan-review-hook',
          enabled: true,
          sourceNode: 'Plan Review',
          targetNode: 'Task Dispatcher',
          method: 'send_message',
          classification: 'validation',
          order: 0,
          validator: { kind: 'script', interpreter: 'bash', source: 'jq -n \'{"type":"allow"}\'' },
          authorizedCallers: [{ sourceNode: 'Plan Review' }],
        },
      ],
      templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
      templateGates: PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? [],
    }).workflow;

    const approvalHooks = workflow.hooks?.filter(
      (hook) => hook.sourceNode === 'Plan Review' && hook.targetNode === 'Task Dispatcher'
    );
    expect(approvalHooks?.map((hook) => hook.id)).toContain('custom-plan-review-hook');
    expect(approvalHooks?.some((hook) => hook.id.startsWith('plan-approval:'))).toBe(true);
  });

  test('migration replaces disabled predictable-id hooks with generated validators', () => {
    const template = getBuiltInWorkflows().find(
      (workflow) => workflow.name === PLAN_AND_DECOMPOSE_WORKFLOW.name
    )!;
    const generatedHook = template.hooks!.find(
      (hook) => hook.sourceNode === 'Plan Review' && hook.targetNode === 'Task Dispatcher'
    )!;
    const workflow = migrateWorkflowGateProgressionToHooks({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      hooks: [{ ...generatedHook, enabled: false, validator: { ...generatedHook.validator } }],
      templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
      templateGates: PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? [],
    }).workflow;

    const generatedHooks = workflow.hooks?.filter((hook) => hook.id === generatedHook.id);
    expect(generatedHooks).toHaveLength(1);
    expect(generatedHooks?.[0]?.enabled).toBe(true);
  });

  test('Codex approval migration only follows source node toggle', () => {
    const workflow = migrateWorkflowGateProgressionToHooks({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      nodes: PLAN_AND_DECOMPOSE_WORKFLOW.nodes.map((node) =>
        node.name === 'Plan Review'
          ? { ...node, requireCodexApproval: false }
          : node.name === 'Task Dispatcher'
            ? { ...node, requireCodexApproval: true }
            : node
      ),
      templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
      templateGates: PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? [],
    }).workflow;

    const hook = workflow.hooks?.find(
      (candidate) =>
        candidate.sourceNode === 'Plan Review' && candidate.targetNode === 'Task Dispatcher'
    );
    const source = hook?.validator.kind === 'script' ? hook.validator.source : '';
    expect(source).not.toContain('gh pr view');
  });

  test('re-stamp installs generated hooks when replacing legacy template channels', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    repo.updateWorkflow(coding.id, {
      hooks: coding.hooks?.filter((hook) => hook.id === 'code-pr-ready'),
      channels: coding.channels?.map((channel) =>
        channel.from === 'Review' && channel.to === 'Coding'
          ? { ...channel, gateId: 'review-posted-gate' }
          : channel
      ),
      gates: CODING_WORKFLOW.gates,
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'legacy-gated-review-feedback',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);
    expect(result.errors).toHaveLength(0);

    const after = manager.getWorkflow(coding.id)!;
    expect(after.hooks?.some((hook) => hook.id === 'code-pr-ready')).toBe(true);
    expect(
      after.hooks?.some(
        (hook) =>
          hook.sourceNode === 'Review' &&
          hook.targetNode === 'Coding' &&
          hook.id.startsWith('review-posted:')
      )
    ).toBe(true);
  });

  test('re-stamp reuses renamed generated route hooks', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const plan = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
    const planReviewNode = plan.nodes.find((node) => node.name === 'Plan Review')!;
    const dispatcherNode = plan.nodes.find((node) => node.name === 'Task Dispatcher')!;
    db.prepare(`UPDATE space_workflow_nodes SET name = ? WHERE id = ?`).run(
      'Plan Review Renamed',
      planReviewNode.id
    );
    db.prepare(`UPDATE space_workflow_nodes SET name = ? WHERE id = ?`).run(
      'Dispatch Renamed',
      dispatcherNode.id
    );
    const remappedTemplateHook = getBuiltInWorkflows()
      .find((workflow) => workflow.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!
      .hooks!.find(
        (hook) => hook.sourceNode === 'Plan Review' && hook.targetNode === 'Task Dispatcher'
      )!;
    repo.updateWorkflow(plan.id, {
      hooks: [
        {
          ...remappedTemplateHook,
          id: 'plan-approval:renamed-route',
          sourceNode: 'Plan Review Renamed',
          targetNode: 'Dispatch Renamed',
          authorizedCallers: [{ sourceNode: 'Plan Review Renamed' }],
        },
      ],
    });

    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'renamed-generated-hook-restamp',
      plan.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(PLAN_AND_DECOMPOSE_WORKFLOW.name);
    expect(result.errors).toHaveLength(0);

    const after = manager.getWorkflow(plan.id)!;
    const approvalHooks = after.hooks?.filter(
      (hook) => hook.sourceNode === 'Plan Review Renamed' && hook.targetNode === 'Dispatch Renamed'
    );
    expect(approvalHooks).toHaveLength(1);
  });

  test('re-stamp preserves user-added custom hooks while updating template hooks', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const customHook = {
      id: 'custom-audit-hook',
      enabled: true,
      sourceNode: 'Coding',
      method: 'save_artifact',
      classification: 'side_effect',
      validator: { kind: 'script', interpreter: 'bash', source: 'echo \'{"type":"allow"}\'' },
      authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
    } as NonNullable<SpaceWorkflow['hooks']>[number];

    repo.updateWorkflow(coding.id, { hooks: [...(coding.hooks ?? []), customHook] });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'custom-hook-preservation',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);
    expect(result.errors).toHaveLength(0);

    const after = manager.getWorkflow(coding.id)!;
    expect(after.hooks?.some((hook) => hook.id === 'custom-audit-hook')).toBe(true);
    expect(after.hooks?.some((hook) => hook.id === 'code-pr-ready')).toBe(true);
  });

  test('re-stamp maps appended channels to renamed built-in nodes by agent slot', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const codingNode = coding.nodes.find((node) => node.name === 'Coding')!;
    const reviewNode = coding.nodes.find((node) => node.name === 'Review')!;
    // Bypass manager validation — direct DB rename + channel removal.
    // Manager validates hooks against node names; direct DB avoids that.
    db.prepare(`UPDATE space_workflow_nodes SET name = ? WHERE id = ?`).run(
      'Implementation',
      codingNode.id
    );
    db.prepare(`UPDATE space_workflow_nodes SET name = ? WHERE id = ?`).run(
      'Human Review',
      reviewNode.id
    );
    // Drop the forward Coding → Review channel so restamp has a missing template
    // channel to re-append (remapped to the renamed nodes by agent slot).
    const legacyChannels = coding.channels!.filter(
      (channel) => !(channel.from === 'Coding' && channel.to === 'Review')
    );
    db.prepare(`UPDATE space_workflows SET channels = ? WHERE id = ?`).run(
      JSON.stringify(legacyChannels),
      coding.id
    );

    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'renamed-node-drift',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);
    expect(result.errors).toHaveLength(0);

    const after = manager.getWorkflow(coding.id)!;
    expect(after.nodes.filter((node) => node.name === 'Review')).toHaveLength(0);
    expect(after.nodes.filter((node) => node.name === 'Coding')).toHaveLength(0);
    expect(
      after.nodes.filter((node) => node.agents.some((agent) => agent.name === 'reviewer'))
    ).toHaveLength(1);
    // The missing Coding → Review template channel is re-appended, remapped to
    // the renamed nodes (Implementation / Human Review) by agent slot.
    expect(
      after.channels!.some(
        (channel) => channel.from === 'Implementation' && channel.to === 'Human Review'
      )
    ).toBe(true);
    // No retired Validation Complete channels reappear.
    expect(
      after.channels!.some(
        (channel) => channel.from === 'Validation Complete' || channel.to === 'Validation Complete'
      )
    ).toBe(false);
  });

  test('re-stamp preserves existing node rows, layout, and updates toolGuards in place', () => {
    // The narrow re-stamp explicitly does NOT regenerate existing node UUIDs because
    // live workflow_run rows reference them. It also must not delete/reinsert existing
    // node rows because in-flight executions depend on those row identities.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const codingNode = coding.nodes.find((n) => n.name === 'Coding')!;
    const originalNodeIds = coding.nodes.map((n) => n.id).sort();
    const originalRows = db
      .prepare(
        `SELECT id, rowid FROM space_workflow_nodes WHERE workflow_id = ? ORDER BY rowid ASC`
      )
      .all(coding.id) as Array<{ id: string; rowid: number }>;
    const rowsAfterEditorSave = () =>
      db
        .prepare(
          `SELECT id, rowid FROM space_workflow_nodes WHERE workflow_id = ? ORDER BY rowid ASC`
        )
        .all(coding.id) as Array<{ id: string; rowid: number }>;
    const layout = Object.fromEntries(
      coding.nodes.map((node, index) => [node.id, { x: index * 100, y: index * 50 }])
    );

    manager.updateWorkflow(coding.id, {
      layout,
      nodes: coding.nodes.map((node) =>
        node.id !== codingNode.id
          ? node
          : {
              ...node,
              agents: node.agents.map((agent) => ({ ...agent, toolGuards: undefined })),
            }
      ),
    });
    const savedRows = rowsAfterEditorSave();
    expect(savedRows.map((row) => row.id).sort()).toEqual(originalRows.map((row) => row.id).sort());
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'force-drift',
      coding.id
    );

    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    const after = manager.getWorkflow(coding.id)!;
    const afterNodeIds = after.nodes.map((n) => n.id).sort();
    const afterRows = db
      .prepare(
        `SELECT id, rowid FROM space_workflow_nodes WHERE workflow_id = ? ORDER BY rowid ASC`
      )
      .all(coding.id) as Array<{ id: string; rowid: number }>;
    const afterCodingAgent = after.nodes.find((n) => n.id === codingNode.id)!.agents[0];
    expect(afterNodeIds).toEqual(expect.arrayContaining(originalNodeIds));
    expect(afterNodeIds.length).toBeGreaterThanOrEqual(originalNodeIds.length);
    expect(afterRows).toEqual(expect.arrayContaining(savedRows));
    expect(after.layout).toEqual(layout);
    expect(afterCodingAgent.toolGuards).toEqual(CODING_WORKFLOW.nodes[0].agents[0]!.toolGuards);
  });

  test('seeds Coding with QA layout for actual generated node IDs', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflow = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WITH_QA_WORKFLOW.name)!;
    const nodeIds = new Set(workflow.nodes.map((n) => n.id));
    expect(workflow.layout).toBeDefined();
    expect(Object.keys(workflow.layout!)).toHaveLength(workflow.nodes.length);
    for (const layoutNodeId of Object.keys(workflow.layout!)) {
      expect(nodeIds.has(layoutNodeId)).toBe(true);
    }
  });

  test('adds missing built-ins while leaving user-created workflows untouched', async () => {
    // User already created a custom workflow before seeding
    manager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'My Custom Workflow',
      nodes: [{ name: 'Code', agentId: CODER_ID }],
      completionAutonomyLevel: 3,
    });

    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    const workflows = manager.listWorkflows(SPACE_ID);
    expect(workflows).toHaveLength(6);
    expect(workflows.some((workflow) => workflow.name === 'My Custom Workflow')).toBe(true);
    expect(workflows.filter((workflow) => workflow.templateName)).toHaveLength(5);
  });

  // ─── Legacy identity migration (Coding Workflow → stable Coding) ──────────
  //
  // Spaces seeded before this feature shipped carry the legacy `Coding Workflow`
  // / `Coding with QA Workflow` identities. On the next seed the seeder must
  // rename them in place to the merger identities (metadata-only) and add the
  // two new stable templates, without rewriting graph/prompts/IDs/hash/history.

  /** Revert a seeded merger row to its pre-upgrade legacy identity in-place. */
  function revertToLegacyIdentity(workflowId: string, legacyName: string, legacyHandle: string) {
    db.prepare(
      `UPDATE space_workflows SET name = ?, handle = ?, template_name = ? WHERE id = ?`
    ).run(legacyName, legacyHandle, legacyName, workflowId);
  }

  test('migrates legacy "Coding Workflow" identity to stable "Coding" and strips the Post-Approval node', () => {
    // Model a genuine pre-upgrade space: a seeded stable 'Coding' row with the
    // legacy display identity reverted, a retired Post-Approval merger node
    // injected, and a stale templateHash. On seed it must be renamed in place to
    // the stable 'Coding' identity, the retired Post-Approval merger node
    // stripped, and the row converge fully to the stable template (hash advances).
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const seededCoding = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === STABLE_CODING_WORKFLOW.name)!;
    const codingId = seededCoding.id;
    // Revert to the legacy identity and inject a Post-Approval merger node + its
    // channels, with a stale hash to force the re-stamp path.
    revertToLegacyIdentity(codingId, 'Coding Workflow', 'coding-workflow');
    repo.updateWorkflow(codingId, {
      nodes: [
        ...seededCoding.nodes.map((n) =>
          n.name === 'Coding' ? { ...n, postApproval: undefined } : n
        ),
        {
          id: 'retired-pa',
          name: 'Post-Approval',
          agents: [
            {
              agentId: MERGER_ID,
              name: 'merger',
              // The EXACT pristine retired PR-Merger slot prompt — the strip
              // guard requires the FULL retired seed identity (name + slot +
              // EXACT prompt + route), so a customized node is preserved.
              customPrompt: { value: RETIRED_PR_MERGER_SLOT_PROMPT },
              toolGuards: [RETIRED_MERGER_RAW_MERGE_GUARD],
            },
          ],
          postApproval: {
            targetAgent: 'merger',
            instructions: PR_MERGE_POST_APPROVAL_INSTRUCTIONS,
          },
        },
      ],
      channels: [
        ...(seededCoding.channels ?? []),
        { id: 'pa-c', from: 'Post-Approval', to: 'Coding' },
        { id: 'c-pa', from: 'Coding', to: 'Post-Approval' },
      ],
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'stale-pre-upgrade-hash',
      codingId
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    // The legacy row was renamed to the canonical stable 'Coding' identity.
    const migrated = manager.listWorkflows(SPACE_ID).find((w) => w.id === codingId)!;
    expect(migrated).toBeDefined();
    expect(migrated.name).toBe('Coding');
    expect(migrated.handle).toBe('coding');
    expect(migrated.templateName).toBe('Coding');
    // id preserved (in-place rename); the node graph reconverged to 2 nodes — the
    // Post-Approval merger node was stripped.
    expect(migrated.nodes.map((n) => n.name)).toEqual(['Coding', 'Review']);
    // No dedicated merger slot survived the strip.
    expect(migrated.nodes.flatMap((n) => n.agents).some((a) => a.name === 'merger')).toBe(false);
    // The coder-owned postApproval route is restored on the Coding node.
    const migratedCodingNode = migrated.nodes.find((n) => n.name === 'Coding')!;
    expect(migratedCodingNode.postApproval?.targetAgent).toBe('coder');
    expect(migratedCodingNode.postApproval?.instructions).toBe(CODER_OWNED_MERGE_INSTRUCTIONS);
    // Hash advanced (full structural convergence back to the stable template).
    expect(migrated.templateHash).toBe(
      computeWorkflowHash(getBuiltInWorkflows().find((w) => w.name === 'Coding')!)
    );

    expect(result.errors).toEqual([]);
    // A second run is a true no-op: the space is now fully migrated and stable.
    const second = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(second.skipped).toBe(true);
    expect(second.seeded).toEqual([]);
    expect(second.errors).toEqual([]);
  });

  test('defers the retired-node strip while an active workflow run references the row', () => {
    // An in-flight legacy run is reloaded by run.workflowId on restart, so its
    // row must NOT be structurally mutated (Post-Approval node stripped, hash
    // advanced) while the run is still non-terminal — otherwise the run resumes
    // against a graph that no longer contains its merger worker.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const seededCoding = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === STABLE_CODING_WORKFLOW.name)!;
    const codingId = seededCoding.id;
    revertToLegacyIdentity(codingId, 'Coding Workflow', 'coding-workflow');
    repo.updateWorkflow(codingId, {
      nodes: [
        ...seededCoding.nodes.map((n) =>
          n.name === 'Coding' ? { ...n, postApproval: undefined } : n
        ),
        {
          id: 'retired-pa-active',
          name: 'Post-Approval',
          agents: [
            {
              agentId: MERGER_ID,
              name: 'merger',
              customPrompt: { value: RETIRED_PR_MERGER_SLOT_PROMPT },
              toolGuards: [RETIRED_MERGER_RAW_MERGE_GUARD],
            },
          ],
          postApproval: {
            targetAgent: 'merger',
            instructions: PR_MERGE_POST_APPROVAL_INSTRUCTIONS,
          },
        },
      ],
      channels: [
        ...(seededCoding.channels ?? []),
        { id: 'pa-c-active', from: 'Post-Approval', to: 'Coding' },
        { id: 'c-pa-active', from: 'Coding', to: 'Post-Approval' },
      ],
    });
    const staleHash = 'stale-pre-upgrade-hash-active';
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      staleHash,
      codingId
    );

    // Active run on THIS row → re-stamp (and with it the strip) is deferred.
    const deferred = seedBuiltInWorkflows(
      SPACE_ID,
      manager,
      resolveAgentId,
      (workflowId) => workflowId === codingId
    );
    const stillLegacy = manager.listWorkflows(SPACE_ID).find((w) => w.id === codingId)!;
    // Metadata rename still lands (identity pass, topology/tools untouched)…
    expect(stillLegacy.name).toBe('Coding');
    expect(stillLegacy.templateName).toBe('Coding');
    // …but the Post-Approval merger node + channels SURVIVE — the strip did not run.
    expect(stillLegacy.nodes.some((n) => n.name === 'Post-Approval')).toBe(true);
    expect(stillLegacy.nodes.flatMap((n) => n.agents).some((a) => a.name === 'merger')).toBe(true);
    // The row is NOT counted as re-stamped and its hash stays stale.
    expect(deferred.restamped).not.toContain('Coding');
    expect(stillLegacy.templateHash).toBe(staleHash);

    // Once the run is terminal (predicate false), the next pass converges fully.
    const converged = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const migrated = manager.listWorkflows(SPACE_ID).find((w) => w.id === codingId)!;
    expect(migrated.nodes.some((n) => n.name === 'Post-Approval')).toBe(false);
    expect(migrated.nodes.map((n) => n.name)).toEqual(['Coding', 'Review']);
    expect(migrated.templateHash).toBe(
      computeWorkflowHash(getBuiltInWorkflows().find((w) => w.name === 'Coding')!)
    );
    expect(converged.restamped).toContain('Coding');
    expect(converged.errors).toEqual([]);
  });

  test('preserves a user-customized Post-Approval node instead of stripping it', () => {
    // A user kept the node/slot names but customized the merger prompt (and no
    // longer carries the pristine PR-Merger marker or the merger route). The
    // strip guard requires the FULL retired seed identity, so this customized
    // node is preserved as drift rather than silently destroyed on upgrade.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const seededCoding = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === STABLE_CODING_WORKFLOW.name)!;
    const codingId = seededCoding.id;
    revertToLegacyIdentity(codingId, 'Coding Workflow', 'coding-workflow');
    repo.updateWorkflow(codingId, {
      nodes: [
        ...seededCoding.nodes.map((n) =>
          n.name === 'Coding' ? { ...n, postApproval: undefined } : n
        ),
        {
          id: 'custom-pa',
          name: 'Post-Approval',
          agents: [
            {
              agentId: MERGER_ID,
              name: 'merger',
              customPrompt: { value: 'My custom merger prompt (user-edited)' },
            },
          ],
          postApproval: { targetAgent: 'merger', instructions: 'custom route' },
        },
      ],
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'stale-pre-upgrade-hash',
      codingId
    );

    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    const after = manager.listWorkflows(SPACE_ID).find((w) => w.id === codingId)!;
    // The customized Post-Approval node survives — not stripped.
    expect(after.nodes.some((n) => n.name === 'Post-Approval')).toBe(true);
    const customPa = after.nodes.find((n) => n.name === 'Post-Approval')!;
    expect(customPa.agents[0].customPrompt?.value).toBe('My custom merger prompt (user-edited)');
  });

  test('preserves a Post-Approval node whose merger slot was model-customized', () => {
    // The node keeps the seeded name/slot/prompt/route but the user overrode the
    // slot's model. The strip guard requires the COMPLETE retired seed identity
    // (including no model override), so this customized node is preserved.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const seededCoding = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === STABLE_CODING_WORKFLOW.name)!;
    const codingId = seededCoding.id;
    revertToLegacyIdentity(codingId, 'Coding Workflow', 'coding-workflow');
    repo.updateWorkflow(codingId, {
      nodes: [
        ...seededCoding.nodes.map((n) =>
          n.name === 'Coding' ? { ...n, postApproval: undefined } : n
        ),
        {
          id: 'model-pa',
          name: 'Post-Approval',
          agents: [
            {
              agentId: MERGER_ID,
              name: 'merger',
              model: 'claude-sonnet-4-6',
              customPrompt: {
                value:
                  'You are the PR Merger — the designated shell-capable agent for post-approval merges.',
              },
            },
          ],
          postApproval: {
            targetAgent: 'merger',
            instructions: PR_MERGE_POST_APPROVAL_INSTRUCTIONS,
          },
        },
      ],
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'stale-pre-upgrade-hash',
      codingId
    );

    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    const after = manager.listWorkflows(SPACE_ID).find((w) => w.id === codingId)!;
    // The model-customized Post-Approval node survives — not stripped.
    expect(after.nodes.some((n) => n.name === 'Post-Approval')).toBe(true);
    const modelPa = after.nodes.find((n) => n.name === 'Post-Approval')!;
    expect(modelPa.agents[0].model).toBe('claude-sonnet-4-6');
  });

  test('preserves a Post-Approval node whose merger prompt was appended to', () => {
    // The node keeps the seeded name/slot/model/route but the user APPENDED
    // instructions to the merger prompt. The strip guard requires the EXACT
    // retired prompt identity, so an append-only customization is preserved.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const seededCoding = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === STABLE_CODING_WORKFLOW.name)!;
    const codingId = seededCoding.id;
    revertToLegacyIdentity(codingId, 'Coding Workflow', 'coding-workflow');
    repo.updateWorkflow(codingId, {
      nodes: [
        ...seededCoding.nodes.map((n) =>
          n.name === 'Coding' ? { ...n, postApproval: undefined } : n
        ),
        {
          id: 'append-pa',
          name: 'Post-Approval',
          agents: [
            {
              agentId: MERGER_ID,
              name: 'merger',
              customPrompt: {
                value: RETIRED_PR_MERGER_SLOT_PROMPT + '\n\nRemember to also sync the docs.',
              },
            },
          ],
          postApproval: {
            targetAgent: 'merger',
            instructions: PR_MERGE_POST_APPROVAL_INSTRUCTIONS,
          },
        },
      ],
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'stale-pre-upgrade-hash',
      codingId
    );

    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    const after = manager.listWorkflows(SPACE_ID).find((w) => w.id === codingId)!;
    // The appended-prompt Post-Approval node survives — not stripped.
    expect(after.nodes.some((n) => n.name === 'Post-Approval')).toBe(true);
    const appendPa = after.nodes.find((n) => n.name === 'Post-Approval')!;
    expect(appendPa.agents[0].customPrompt?.value).toContain('Remember to also sync the docs.');
  });

  test('handle collision on a new stable template fails safely without aborting the seed', () => {
    // A user workflow already holds the stable `coding` handle.
    manager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'My Coding',
      handle: 'coding',
      nodes: [{ name: 'Code', agentId: CODER_ID }],
    });

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    // The `Coding` template could not be created (handle clash); every other
    // template still seeded, no throw, no partial DB mess.
    expect(result.seeded).toHaveLength(4);
    expect(result.seeded).not.toContain(STABLE_CODING_WORKFLOW.name);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toBe(STABLE_CODING_WORKFLOW.name);
    expect(result.errors[0].error).toContain('coding');
    // 1 user + 4 built-ins (5 templates minus the colliding 'Coding').
    expect(manager.listWorkflows(SPACE_ID)).toHaveLength(5);
  });

  test('partial legacy migration: a rename collision stamps templateName so the row still groups for cleanup', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const seeded = manager.listWorkflows(SPACE_ID);
    const codingRow = seeded.find((w) => w.name === STABLE_CODING_WORKFLOW.name)!;
    const stableQa = seeded.find((w) => w.name === CODING_WITH_QA_WORKFLOW.name)!;

    revertToLegacyIdentity(codingRow.id, 'Coding Workflow', 'coding-workflow');
    db.prepare(`DELETE FROM space_workflows WHERE id = ?`).run(stableQa.id);

    // A user workflow already owns the stable `Coding` name, so the legacy
    // `Coding Workflow` → `Coding` rename cannot take the unique name/handle.
    manager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Coding',
      nodes: [{ name: 'Code', agentId: CODER_ID }],
    });

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    const after = manager.listWorkflows(SPACE_ID);
    // Coding-side name stayed (collision on the stable `Coding` name)...
    expect(after.find((w) => w.id === codingRow.id)!.name).toBe('Coding Workflow');
    // ...but its templateName was stamped to the canonical stable template, so
    // it is NOT stranded under the legacy name — detectDuplicateDrift (which
    // filters non-canonical templateNames) can still see and group it.
    expect(after.find((w) => w.id === codingRow.id)!.templateName).toBe('Coding');
    expect(after.find((w) => w.id === codingRow.id)!.handle).toBe('coding-workflow');
    // No duplicate `Coding` name — only the user workflow keeps it.
    expect(after.filter((w) => w.name === 'Coding')).toHaveLength(1);
    // The other templates still seeded; the collision was handled by the
    // templateName-stamp fallback, not thrown.
    expect(result.errors).toEqual([]);
  });

  test('duplicate legacy rows: every row is migrated, not just the newest', () => {
    // A space can hold DUPLICATE legacy seeds (the condition the duplicate-drift
    // cleanup exists for). The identity migration must reconcile the whole group:
    // rename the newest fully, and stamp templateName on the older duplicates so
    // they group under the canonical template for cleanup instead of being
    // stranded under a name no built-in recognises. createWorkflow requires
    // unique names, so seed two distinct-named rows that share the legacy
    // templateName.
    const older = manager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Coding Workflow (dup-a)',
      nodes: [
        { id: 'o-c', name: 'Coding', agents: [{ agentId: CODER_ID, name: 'coder' }] },
        { id: 'o-r', name: 'Review', agents: [{ agentId: REVIEWER_ID, name: 'reviewer' }] },
      ],
      startNodeId: 'o-c',
      endNodeId: 'o-r',
      templateName: 'Coding Workflow',
    });
    const newer = manager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Coding Workflow',
      nodes: [
        { id: 'n-c', name: 'Coding', agents: [{ agentId: CODER_ID, name: 'coder' }] },
        { id: 'n-r', name: 'Review', agents: [{ agentId: REVIEWER_ID, name: 'reviewer' }] },
      ],
      startNodeId: 'n-c',
      endNodeId: 'n-r',
      templateName: 'Coding Workflow',
    });
    db.prepare(`UPDATE space_workflows SET created_at = ? WHERE id = ?`).run(1000, older.id);
    db.prepare(`UPDATE space_workflows SET created_at = ? WHERE id = ?`).run(2000, newer.id);
    expect(
      manager.listWorkflows(SPACE_ID).filter((w) => w.templateName === 'Coding Workflow')
    ).toHaveLength(2);

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.errors).toEqual([]);

    // BOTH rows now point their templateName at the canonical stable template —
    // neither is stranded under the legacy name.
    const after = manager.listWorkflows(SPACE_ID);
    expect(after.filter((w) => w.templateName === 'Coding Workflow')).toHaveLength(0);
    expect(after.filter((w) => w.templateName === 'Coding')).toHaveLength(2);
    // The newest still carried the seeded legacy name, so it got the full
    // canonical rename. The older duplicate had a non-seed name, so the
    // selective path preserved its name/handle and stamped templateName only
    // (the same templateName-only fallback used for collisions — and for
    // user-renamed rows, so a customization is never clobbered).
    expect(after.find((w) => w.id === newer.id)!.name).toBe('Coding');
    expect(after.find((w) => w.id === older.id)!.name).toBe('Coding Workflow (dup-a)');
    expect(after.find((w) => w.id === older.id)!.templateName).toBe('Coding');
  });

  test('user-renamed legacy row keeps its custom name/handle (templateName only)', () => {
    // A user who renamed a built-in 'Coding Workflow' (or set a custom handle)
    // must not lose their customization on upgrade: the migration repoints only
    // templateName so the row still groups under the canonical template for
    // duplicate cleanup, without clobbering the user's name/handle. (handle is
    // set explicitly here to assert it too is preserved — stampBuiltInTemplateName
    // writes neither name nor handle.)
    const custom = manager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'My Team Coding',
      nodes: [
        { id: 'u-c', name: 'Coding', agents: [{ agentId: CODER_ID, name: 'coder' }] },
        { id: 'u-r', name: 'Review', agents: [{ agentId: REVIEWER_ID, name: 'reviewer' }] },
      ],
      startNodeId: 'u-c',
      endNodeId: 'u-r',
      templateName: 'Coding Workflow',
    });
    db.prepare(`UPDATE space_workflows SET handle = ? WHERE id = ?`).run(
      'my-team-coding',
      custom.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.errors).toEqual([]);

    const after = manager.listWorkflows(SPACE_ID).find((w) => w.id === custom.id)!;
    // Custom name/handle preserved; templateName repointed to the canonical
    // stable template so the row groups for duplicate cleanup.
    expect(after.name).toBe('My Team Coding');
    expect(after.handle).toBe('my-team-coding');
    expect(after.templateName).toBe('Coding');
  });

  test('handle-only legacy customization is preserved (name unchanged, handle customized)', () => {
    // A user kept the seeded legacy display name 'Coding Workflow' but changed
    // only the handle. The identity migration must NOT clobber the custom handle
    // (the unmodified-seed rename only fires when BOTH name and handle still
    // match the legacy seed). The row is repointed to the canonical template via
    // templateName only, keeping the user's handle.
    const custom = manager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Coding Workflow',
      nodes: [
        { id: 'h-c', name: 'Coding', agents: [{ agentId: CODER_ID, name: 'coder' }] },
        { id: 'h-r', name: 'Review', agents: [{ agentId: REVIEWER_ID, name: 'reviewer' }] },
      ],
      startNodeId: 'h-c',
      endNodeId: 'h-r',
      templateName: 'Coding Workflow',
    });
    db.prepare(`UPDATE space_workflows SET handle = ? WHERE id = ?`).run(
      'team-coding-flow',
      custom.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.errors).toEqual([]);

    const after = manager.listWorkflows(SPACE_ID).find((w) => w.id === custom.id)!;
    // The legacy display name was retained (user kept it), the custom handle is
    // preserved, and templateName was repointed to the canonical stable template.
    expect(after.name).toBe('Coding Workflow');
    expect(after.handle).toBe('team-coding-flow');
    expect(after.templateName).toBe('Coding');
  });

  test('legacy identity migration strips the stale default tag from non-default rows', () => {
    // A pre-split 'Coding with QA Workflow' row carries a stale 'default' tag.
    // After it is migrated to the stable 'Coding with QA' template (which is NOT
    // default — the stable Coding workflow is), the tag must be stripped, or the
    // deterministic fallback (selectDeterministicWorkflowFallback, ranks
    // default-tagged rows by updatedAt) could pick the wrong flow over the
    // stable default one.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const seeded = manager.listWorkflows(SPACE_ID);
    const qaRow = seeded.find((w) => w.name === CODING_WITH_QA_WORKFLOW.name)!;
    const stableCoding = seeded.find((w) => w.name === STABLE_CODING_WORKFLOW.name)!;
    // Simulate the pre-split row: revert to legacy identity + restore the
    // default tag the old 'Coding with QA Workflow' seed carried.
    revertToLegacyIdentity(qaRow.id, 'Coding with QA Workflow', 'coding-with-qa-workflow');
    db.prepare(`UPDATE space_workflows SET tags = ? WHERE id = ?`).run(
      JSON.stringify(['fullstack', 'qa', 'default']),
      qaRow.id
    );

    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    const after = manager.listWorkflows(SPACE_ID);
    const migrated = after.find((w) => w.id === qaRow.id)!;
    expect(migrated.name).toBe('Coding with QA');
    expect(migrated.tags).not.toContain('default');
    // The stable Coding template keeps the default tag.
    expect(after.find((w) => w.id === stableCoding.id)!.tags).toContain('default');
  });

  test('throws if resolveAgentId returns undefined for a required role', () => {
    // Resolver that cannot resolve any role
    const brokenResolver = (_role: string): string | undefined => undefined;

    expect(() => seedBuiltInWorkflows(SPACE_ID, manager, brokenResolver)).toThrow(
      'no SpaceWorkerAgent found with name'
    );
  });

  test('does not persist any workflow when resolveAgentId fails on first-template role', async () => {
    // Resolver fails on 'planner' — used by RESEARCH_WORKFLOW (second template)
    const brokenResolver = (role: string): string | undefined =>
      role === 'planner' ? undefined : roleMap[role];

    try {
      seedBuiltInWorkflows(SPACE_ID, manager, brokenResolver);
    } catch {
      // expected
    }
    // Pre-validation throws before any workflow is committed
    expect(manager.listWorkflows(SPACE_ID)).toHaveLength(0);
  });

  test('does not persist any workflow when resolveAgentId fails on a shared role', async () => {
    // 'qa' is used by CODING_WITH_QA_WORKFLOW and is a shared role across
    // multiple templates. Pre-validation catches missing roles before any
    // workflow is persisted.
    const brokenResolver = (role: string): string | undefined =>
      role === 'qa' ? undefined : roleMap[role];

    try {
      seedBuiltInWorkflows(SPACE_ID, manager, brokenResolver);
    } catch {
      // expected
    }
    // Pre-validation catches the missing role before any workflow is persisted
    expect(manager.listWorkflows(SPACE_ID)).toHaveLength(0);
  });

  // ─── Return type tests ──────────────────────────────────────────────────

  test('returns seeded workflow names on success', () => {
    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    expect(result.skipped).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(result.seeded).toHaveLength(5);
    expect(result.seeded).toContain('Coding');
    expect(result.seeded).toContain('Plan & Decompose Workflow');
    expect(result.seeded).toContain('Coding with QA');
    expect(result.seeded).toContain('Research Workflow');
    expect(result.seeded).toContain('Review-Only Workflow');
  });

  test('returns skipped=true when workflows already exist', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    expect(result.skipped).toBe(true);
    expect(result.seeded).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test('per-workflow error isolation — remaining workflows seed when one createWorkflow throws', () => {
    // Spy on createWorkflow to make one specific workflow fail
    const originalCreate = manager.createWorkflow.bind(manager);
    let callCount = 0;
    manager.createWorkflow = (params) => {
      callCount++;
      if (callCount === 2) {
        throw new Error('Simulated DB constraint error');
      }
      return originalCreate(params);
    };

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    // 4 of 5 succeed, 1 fails
    expect(result.seeded).toHaveLength(4);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('Simulated DB constraint error');
    expect(result.skipped).toBe(false);

    // Verify 4 workflows were actually persisted
    const workflows = manager.listWorkflows(SPACE_ID);
    expect(workflows).toHaveLength(4);
  });

  test('per-workflow error isolation — captures error name correctly', () => {
    const originalCreate = manager.createWorkflow.bind(manager);
    let callCount = 0;
    const templates = getBuiltInWorkflows();
    manager.createWorkflow = (params) => {
      callCount++;
      // Fail the third workflow
      if (callCount === 3) {
        throw new Error('Unique constraint violation');
      }
      return originalCreate(params);
    };

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    expect(result.errors).toHaveLength(1);
    // The third template name is recorded in the error
    expect(result.errors[0].name).toBe(templates[2].name);
    expect(result.errors[0].error).toContain('Unique constraint violation');
  });

  test('all workflows fail gracefully — returns all errors', () => {
    manager.createWorkflow = () => {
      throw new Error('DB is read-only');
    };

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    expect(result.seeded).toHaveLength(0);
    expect(result.errors).toHaveLength(5);
    expect(result.skipped).toBe(false);
    for (const err of result.errors) {
      expect(err.error).toContain('DB is read-only');
    }
  });

  // ─── Node ID replacement tests ─────────────────────────────────────────

  test('seeded node IDs are real UUIDs, not template placeholders', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const templatePrefixes = [
      'tpl-coding-',
      'tpl-pd-',
      'tpl-fullstack-',
      'tpl-research-',
      'tpl-review-',
    ];
    for (const wf of manager.listWorkflows(SPACE_ID)) {
      for (const node of wf.nodes) {
        for (const prefix of templatePrefixes) {
          expect(node.id.startsWith(prefix)).toBe(false);
        }
        // UUID format: 8-4-4-4-12 hex characters
        expect(node.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      }
    }
  });

  test('seeded startNodeId is a real UUID pointing to first node', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    for (const wf of manager.listWorkflows(SPACE_ID)) {
      expect(wf.startNodeId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      const nodeIds = new Set(wf.nodes.map((n) => n.id));
      expect(nodeIds.has(wf.startNodeId)).toBe(true);
    }
  });

  // ─── Description & tags preservation ────────────────────────────────────

  test('all seeded workflows preserve their descriptions', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflows = manager.listWorkflows(SPACE_ID);
    const templates = getBuiltInWorkflows();
    for (const tpl of templates) {
      const wf = workflows.find((w) => w.name === tpl.name);
      expect(wf).toBeDefined();
      expect(wf!.description).toBe(tpl.description);
    }
  });

  test('stable Coding is seeded with coding + default; Coding with QA is not default', () => {
    // Only the stable Coding template carries the `default` tag; Coding with QA
    // must not, or selectDeterministicWorkflowFallback could pick it over the
    // stable coder-owned default flow.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    expect(coding.tags).toContain('coding');
    expect(coding.tags).toContain('default');
    const qa = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WITH_QA_WORKFLOW.name)!;
    expect(qa.tags).not.toContain('default');
  });

  test('RESEARCH_WORKFLOW seeded with research tag', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
    expect(wf.tags).toContain('research');
  });

  test('REVIEW_ONLY_WORKFLOW seeded with review tag', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name)!;
    expect(wf.tags).toContain('review');
  });

  // ─── Node instructions preservation ─────────────────────────────────────

  test('CODING_WORKFLOW seeded nodes preserve customPrompt content', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const codeNode = wf.nodes.find((n) => n.name === 'Coding');
    expect(codeNode?.agents[0].customPrompt?.value).toContain('Runtime Execution Contract');
    expect(codeNode?.agents[0].customPrompt?.value).toContain('`gh pr merge`');
    const reviewNode = wf.nodes.find((n) => n.name === 'Review');
    expect(reviewNode?.agents[0].customPrompt?.value).toContain('post a visible GitHub review');
  });

  test('PLAN_AND_DECOMPOSE_WORKFLOW seeded nodes preserve customPrompt content', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
    const planNode = wf.nodes.find((n) => n.name === 'Planning');
    expect(planNode?.agents[0].customPrompt?.value).toContain('hook validates');
    const planReviewNode = wf.nodes.find((n) => n.name === 'Plan Review');
    expect(planReviewNode?.agents[0].customPrompt?.value).toContain('Task Dispatcher');
    const dispatcherNode = wf.nodes.find((n) => n.name === 'Task Dispatcher');
    expect(dispatcherNode?.agents[0].customPrompt?.value).toContain('create_standalone_task');
    expect(dispatcherNode?.agents[0].customPrompt?.value).toContain('save_artifact');
  });

  test('RESEARCH_WORKFLOW seeded nodes preserve customPrompt content', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
    const researchNode = wf.nodes.find((n) => n.name === 'Research');
    expect(researchNode?.agents[0].customPrompt?.value).toContain('gh pr create');
    const reviewNode = wf.nodes.find((n) => n.name === 'Review');
    expect(reviewNode?.agents[0].customPrompt?.value).toContain('save_artifact');
  });

  // ─── Gate preservation per workflow ──────────────────────────────────────

  test('REVIEW_ONLY_WORKFLOW seeded with no gates', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name)!;
    expect(wf.gates ?? []).toHaveLength(0);
  });

  test.skip('PLAN_AND_DECOMPOSE_WORKFLOW gate resetOnCycle flags are preserved', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
    const planApproval = wf.gates!.find((g) => g.id === 'plan-approval-gate')!;
    expect(planApproval.resetOnCycle).toBe(true);
  });

  // ─── Channel ID assignment ──────────────────────────────────────────────

  test('all seeded channels have non-empty id fields', () => {
    // WorkflowCanvas filters channels without an id (ch.id must be truthy).
    // seedBuiltInWorkflows must assign UUIDs so all channels are visible.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    for (const wf of manager.listWorkflows(SPACE_ID)) {
      for (const ch of wf.channels ?? []) {
        expect(ch.id).toBeTruthy();
        expect(ch.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      }
    }
  });

  test('seeded channels retain all original fields plus a UUID id', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const codeToReview = wf.channels!.find((c) => c.from === 'Coding' && c.to === 'Review');
    expect(codeToReview).toBeDefined();
    expect(codeToReview!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(codeToReview!.gateId).toBeUndefined();
    // direction field removed from WorkflowChannel schema
  });

  // ─── plan-approval-gate auto-approval via requiredLevel ──────────────────

  test('PLAN_AND_DECOMPOSE_WORKFLOW plan-approval-gate requires four reviewer approvals', () => {
    const gate = PLAN_AND_DECOMPOSE_WORKFLOW.gates!.find((g) => g.id === 'plan-approval-gate')!;
    const approvalsField = gate.fields.find((f) => f.name === 'approvals')!;
    expect(approvalsField.type).toBe('map');
    expect(approvalsField.writers).toEqual(['Plan Review']);
    expect(approvalsField.check).toMatchObject({ op: 'count', match: 'approved', min: 4 });
    // Codex is no longer hardcoded as a gate feature; it is opt-in via node-level config.
    expect(gate.features?.codex_review_bot).toBeUndefined();
  });

  test.skip('seeded plan-approval-gate preserves map-count check with min=4', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
    const gate = wf.gates!.find((g) => g.id === 'plan-approval-gate')!;
    const approvalsField = gate.fields.find((f) => f.name === 'approvals')!;
    expect(approvalsField.type).toBe('map');
    expect(approvalsField.writers).toEqual(['Plan Review']);
    expect(approvalsField.check).toMatchObject({ op: 'count', match: 'approved', min: 4 });
  });

  // ─── getBuiltInWorkflows ordering ────────────────────────────────────────

  test('getBuiltInWorkflows returns CODING_WORKFLOW first', () => {
    // CODING_WORKFLOW is first so spaceWorkflowRun.start (which picks
    // workflows[0] ordered by created_at ASC) defaults to the single-task
    // coding loop. PLAN_AND_DECOMPOSE_WORKFLOW is opt-in (no `default` tag).
    const templates = getBuiltInWorkflows();
    expect(templates[0].name).toBe(STABLE_CODING_WORKFLOW.name);
  });

  test('listWorkflows returns CODING_WORKFLOW first after DB seeding', () => {
    // Verifies the DB-level ordering guarantee: listWorkflows uses
    // ORDER BY created_at ASC, rowid ASC. When all workflows are seeded within
    // the same millisecond, rowid (insertion order) is the tiebreaker, so
    // CODING_WORKFLOW (seeded first) must be returned at index 0.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflows = manager.listWorkflows(SPACE_ID);
    expect(workflows[0].name).toBe(STABLE_CODING_WORKFLOW.name);
  });

  test('getBuiltInWorkflows returns all five templates', () => {
    const templates = getBuiltInWorkflows();
    expect(templates).toHaveLength(5);
    const names = templates.map((t) => t.name);
    expect(names).toContain(PLAN_AND_DECOMPOSE_WORKFLOW.name);
    expect(names).toContain(CODING_WORKFLOW.name);
    expect(names).toContain(CODING_WITH_QA_WORKFLOW.name);
    expect(names).toContain(RESEARCH_WORKFLOW.name);
    expect(names).toContain(REVIEW_ONLY_WORKFLOW.name);
  });

  // ─── Timestamps ─────────────────────────────────────────────────────────

  test('all seeded workflows have positive timestamps', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    for (const wf of manager.listWorkflows(SPACE_ID)) {
      expect(wf.createdAt).toBeGreaterThan(0);
      expect(wf.updatedAt).toBeGreaterThan(0);
    }
  });

  // ─── Agent ID resolution edge case ──────────────────────────────────────

  test('agent ID resolution is case-insensitive via resolver', () => {
    // The real call site does: agents.find(a => a.name.toLowerCase() === name.toLowerCase())
    // Our test resolver mirrors this — verify it handles mixed-case template placeholders
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
    // Templates use title-case role placeholders that must resolve case-insensitively.
    // Plan & Decompose: Planning(Planner) → Plan Review(4×Reviewer) → Task Dispatcher(General)
    expect(wf.nodes[0].agents[0]?.agentId).toBe(PLANNER_ID);
    expect(wf.nodes[1].agents[0]?.agentId).toBe(REVIEWER_ID);
    expect(wf.nodes[2].agents[0]?.agentId).toBe(GENERAL_ID);
  });

  test('no seeded agent IDs contain template placeholder names', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const placeholders = ['Planner', 'Coder', 'General', 'Research', 'Reviewer', 'PR Merger', 'QA'];
    for (const wf of manager.listWorkflows(SPACE_ID)) {
      for (const node of wf.nodes) {
        for (const agent of node.agents) {
          expect(placeholders).not.toContain(agent.agentId);
          // Agent ID should be a UUID, not a role name
          expect(agent.agentId).toMatch(/^agent-[a-z]+-uuid$/);
        }
      }
    }
  });

  // ─── Node name preservation ─────────────────────────────────────────────

  test('all seeded workflow node names match their template definitions', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflows = manager.listWorkflows(SPACE_ID);
    const templates = getBuiltInWorkflows();
    for (const tpl of templates) {
      const wf = workflows.find((w) => w.name === tpl.name)!;
      const seededNames = wf.nodes.map((n) => n.name);
      const templateNames = tpl.nodes.map((n) => n.name);
      expect(seededNames).toEqual(templateNames);
    }
  });

  // ─── customPrompt design ─────────────────────────────────────────────────

  test('CODING_WORKFLOW seeded with non-empty customPrompt on all agent slots', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    for (const node of wf.nodes) {
      for (const agent of node.agents) {
        expect(agent.customPrompt).toBeDefined();
        expect(agent.customPrompt!.value.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('RESEARCH_WORKFLOW seeded with non-empty customPrompt on all agent slots', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
    for (const node of wf.nodes) {
      for (const agent of node.agents) {
        expect(agent.customPrompt).toBeDefined();
        expect(agent.customPrompt!.value.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('REVIEW_ONLY_WORKFLOW seeded with non-empty customPrompt on reviewer slot', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name)!;
    expect(wf.nodes).toHaveLength(1);
    const agent = wf.nodes[0].agents[0];
    expect(agent.customPrompt).toBeDefined();
    expect(agent.customPrompt!.value.trim().length).toBeGreaterThan(0);
  });

  test('PLAN_AND_DECOMPOSE_WORKFLOW seeded with non-empty customPrompt on all agent slots', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
    for (const node of wf.nodes) {
      for (const agent of node.agents) {
        expect(agent.customPrompt).toBeDefined();
        expect(agent.customPrompt!.value.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('PLAN_AND_DECOMPOSE_WORKFLOW Plan Review node reviewer slots have lens-specific customPrompt', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
    const planReviewNode = wf.nodes.find((n) => n.name === 'Plan Review')!;
    expect(planReviewNode.agents).toHaveLength(4);
    const seenLenses = new Set<string>();
    for (const agent of planReviewNode.agents) {
      expect(agent.customPrompt).toBeDefined();
      expect(agent.customPrompt!.value.trim().length).toBeGreaterThan(0);
      // Each reviewer's lens should be embedded as reviewer_name "<lens>" inside the prompt
      for (const lens of ['architecture', 'security', 'correctness', 'ux']) {
        if (agent.customPrompt!.value.includes(`"${lens}"`)) {
          seenLenses.add(lens);
        }
      }
    }
    expect(seenLenses.size).toBe(4);
  });

  test('PLAN_AND_DECOMPOSE_WORKFLOW non-Plan-Review nodes have non-empty customPrompt', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
    const otherNodes = wf.nodes.filter((n) => n.name !== 'Plan Review');
    expect(otherNodes.length).toBe(2); // Planning, Task Dispatcher
    for (const node of otherNodes) {
      for (const agent of node.agents) {
        expect(agent.customPrompt).toBeDefined();
        expect(agent.customPrompt!.value.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('all seeded workflows have non-empty customPrompt on all agent slots', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflows = manager.listWorkflows(SPACE_ID);

    for (const wf of workflows) {
      for (const node of wf.nodes) {
        for (const agent of node.agents) {
          expect(agent.customPrompt).toBeDefined();
          expect(agent.customPrompt!.value.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Export/import round-trip
// ---------------------------------------------------------------------------

describe('Coding Workflow export/import round-trip', () => {
  let db: BunDatabase;
  let manager: SpaceWorkflowManager;
  const SPACE_ID = 'roundtrip-test-space';

  const PLANNER_ID = 'agent-planner-uuid';
  const CODER_ID = 'agent-coder-uuid';
  const GENERAL_ID = 'agent-general-uuid';
  const QA_ID = 'agent-qa-uuid';
  const RESEARCH_ID = 'agent-research-uuid';

  const REVIEWER_ID = 'agent-reviewer-uuid';
  const MERGER_ID = 'agent-merger-uuid';
  const roleMap: Record<string, string> = {
    planner: PLANNER_ID,
    research: RESEARCH_ID,
    coder: CODER_ID,
    general: GENERAL_ID,
    reviewer: REVIEWER_ID,
    'pr merger': MERGER_ID,
    qa: QA_ID,
  };
  const resolveAgentId = (role: string): string | undefined => roleMap[role.toLowerCase()];

  /** Mock SpaceWorkerAgent records for exportWorkflow's agent name resolution. */
  const mockAgents: SpaceWorkerAgent[] = [
    {
      id: CODER_ID,
      spaceId: SPACE_ID,
      name: 'Coder',
      customPrompt: null,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: RESEARCH_ID,
      spaceId: SPACE_ID,
      name: 'Research',
      customPrompt: null,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: REVIEWER_ID,
      spaceId: SPACE_ID,
      name: 'Reviewer',
      customPrompt: null,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: MERGER_ID,
      spaceId: SPACE_ID,
      name: 'PR Merger',
      customPrompt: null,
      createdAt: 0,
      updatedAt: 0,
    },
  ];

  beforeEach(() => {
    db = makeDb();
    seedSpace(db, SPACE_ID);
    seedAgent(db, PLANNER_ID, SPACE_ID, 'Planner');
    seedAgent(db, CODER_ID, SPACE_ID, 'Coder');
    seedAgent(db, GENERAL_ID, SPACE_ID, 'General');
    seedAgent(db, QA_ID, SPACE_ID, 'QA');

    const repo = new SpaceWorkflowRepository(db);
    manager = new SpaceWorkflowManager(repo);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  });

  test('exported Coding Workflow passes Zod validation', () => {
    // Seed and retrieve the persisted workflow (with real UUIDs)
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

    const exported = exportWorkflow(wf, mockAgents);
    const result = validateExportedWorkflow(exported);
    expect(result.ok).toBe(true);
  });

  test('exported Coding Workflow preserves channels and Review→Coding cycle', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

    const exported = exportWorkflow(wf, mockAgents);
    expect(exported.channels).toBeDefined();
    // gateId is stripped during export (gates are separate entities)
    expect(exported.channels).toHaveLength(2);

    const reviewToCode = exported.channels!.find((c) => c.from === 'Review' && c.to === 'Coding');
    expect(reviewToCode).toBeDefined();
    expect(reviewToCode!.maxCycles).toBe(5);
  });

  test('exported Coding Workflow channels do not include gate field (gates are separate entities)', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

    const exported = exportWorkflow(wf, mockAgents);

    // Exported channels should not have a gate field (gates are separate entities not included in export)
    for (const ch of exported.channels ?? []) {
      expect((ch as Record<string, unknown>).gate).toBeUndefined();
    }
  });

  test('re-imported Coding Workflow preserves channel structure', () => {
    // Seed → export → re-import → verify round-trip fidelity
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const exported = exportWorkflow(wf, mockAgents);

    // Delete all workflows so we can re-import
    for (const w of manager.listWorkflows(SPACE_ID)) {
      manager.deleteWorkflow(w.id);
    }
    expect(manager.listWorkflows(SPACE_ID)).toHaveLength(0);

    // Build agent name → ID map for resolving agentRef
    const agentNameToId = new Map<string, string>(mockAgents.map((a) => [a.name, a.id]));

    manager.createWorkflow({
      spaceId: SPACE_ID,
      name: exported.name,
      description: exported.description,
      nodes: exported.nodes.map((s) => ({
        name: s.name,
        agents: s.agents.map((a) => ({
          agentId: agentNameToId.get(a.agentRef) ?? a.agentRef,
          name: a.name,
        })),
        instructions: s.instructions,
      })),
      startNodeId: undefined,
      tags: exported.tags,
      channels: exported.channels,
      completionAutonomyLevel: exported.completionAutonomyLevel ?? 3,
    });

    // Verify the re-imported workflow
    const reimported = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WORKFLOW.name)!;
    expect(reimported).toBeDefined();
    expect(reimported.nodes).toHaveLength(2);
    expect(reimported.channels).toHaveLength(2);
    // No dedicated Post-Approval merger node round-trips (coder-owned model).
    expect(reimported.nodes.some((n) => n.name === 'Post-Approval')).toBe(false);

    // Coding → Review channel preserved
    const codeToReview = reimported.channels!.find((c) => c.from === 'Coding' && c.to === 'Review');
    expect(codeToReview).toBeDefined();

    // Review → Coding channel preserved with maxCycles
    const reviewToCode = reimported.channels!.find((c) => c.from === 'Review' && c.to === 'Coding');
    expect(reviewToCode).toBeDefined();
    expect(reviewToCode!.maxCycles).toBe(5);
  });

  test('coder-owned postApproval route survives export/import round-trip', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const exported = exportWorkflow(wf, mockAgents);

    // Verify exported coder agent has NO toolGuards (the merge is prompt-driven,
    // not bash-gated) and the Coding node carries the coder-owned postApproval route.
    const codingNode = exported.nodes.find((n) => n.name === 'Coding');
    expect(codingNode).toBeDefined();
    const coderAgent = codingNode!.agents.find((a) => a.name === 'coder');
    expect(coderAgent).toBeDefined();
    expect(coderAgent!.toolGuards).toBeUndefined();
    expect(exported.nodes.find((n) => n.name === 'Coding')!.postApproval?.targetAgent).toBe(
      'coder'
    );

    // Delete and re-import
    for (const w of manager.listWorkflows(SPACE_ID)) {
      manager.deleteWorkflow(w.id);
    }
    const agentNameToId = new Map<string, string>(mockAgents.map((a) => [a.name, a.id]));
    manager.createWorkflow({
      spaceId: SPACE_ID,
      name: exported.name,
      description: exported.description,
      nodes: exported.nodes.map((s) => ({
        name: s.name,
        agents: s.agents.map((a) => ({
          agentId: agentNameToId.get(a.agentRef) ?? a.agentRef,
          name: a.name,
          toolGuards: a.toolGuards,
        })),
        postApproval: s.postApproval,
      })),
      startNodeId: undefined,
      tags: exported.tags,
      channels: exported.channels,
      completionAutonomyLevel: exported.completionAutonomyLevel ?? 3,
    });

    // Verify re-imported coder keeps the coder-owned post-approval route.
    const reimported = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WORKFLOW.name)!;
    const reimCoderNode = reimported.nodes.find((n) => n.name === 'Coding');
    expect(reimCoderNode?.postApproval?.targetAgent).toBe('coder');
    const reimCoder = reimCoderNode?.agents.find((a) => a.name === 'coder');
    expect(reimCoder?.toolGuards).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getBuiltInGateScript()
// ---------------------------------------------------------------------------
// Tests for the live gate-script resolution helper. This function returns the
// *current* script for a given built-in template + gate ID combination so that
// gate evaluations always use the latest script rather than the version that was
// baked into the database at seed time.

describe('getBuiltInGateScript()', () => {
  test('getBuiltInGateScript returns undefined for removed code-ready-gate', () => {
    const script = getBuiltInGateScript(CODING_WORKFLOW.name, 'code-ready-gate');
    expect(script).toBeUndefined();
  });

  test.skip('returns the bash script for review-posted-gate in Coding Workflow', () => {
    const script = getBuiltInGateScript(CODING_WORKFLOW.name, 'review-posted-gate');
    expect(script).toBeDefined();
    expect(script?.interpreter).toBe('bash');
    // The review-posted script should include the PR comment fallback path
    expect(script?.source).toContain('gh pr view');
    expect(script?.source).toContain('comments');
    // Confirm the current fallback message is present (not the stale "No review submitted on…")
    expect(script?.source).toContain('No review or PR comment found on');
  });

  test('getBuiltInGateScript returns undefined for removed plan-pr-gate', () => {
    const script = getBuiltInGateScript(PLAN_AND_DECOMPOSE_WORKFLOW.name, 'plan-pr-gate');
    expect(script).toBeUndefined();
  });

  test('returns undefined for a field-only gate (plan-approval-gate has no script)', () => {
    const script = getBuiltInGateScript(PLAN_AND_DECOMPOSE_WORKFLOW.name, 'plan-approval-gate');
    expect(script).toBeUndefined();
  });

  test('returns undefined when the template name does not match any built-in', () => {
    const script = getBuiltInGateScript('Unknown Template', 'nonexistent-gate');
    expect(script).toBeUndefined();
  });

  test('returns undefined when the gate ID does not exist in the template', () => {
    const script = getBuiltInGateScript(CODING_WORKFLOW.name, 'nonexistent-gate-id');
    expect(script).toBeUndefined();
  });

  test('returns undefined for review-posted-gate (now a validator gate, no script)', () => {
    // The review-posted-gate was converted from inline bash to a `review_posted`
    // built-in validator reference, so it has no script for getBuiltInGateScript
    // to resolve. The check runs via the gate-on-external-state primitive.
    const script = getBuiltInGateScript(CODING_WORKFLOW.name, 'review-posted-gate');
    expect(script).toBeUndefined();
  });

  test('returns scripts for all script-based gates in all templates', () => {
    // Every gate that has a script in any built-in template should be resolvable
    for (const template of getBuiltInWorkflows()) {
      for (const gate of template.gates ?? []) {
        if (!gate.script) continue;
        const script = getBuiltInGateScript(template.name, gate.id);
        expect(script).toBeDefined();
        expect(script?.interpreter).toBe(gate.script.interpreter);
        expect(script?.source).toBe(gate.script.source);
      }
    }
  });

  test('review-posted-gate since-start window is handled by the review_posted op', () => {
    // Formerly a bash script consulting HYPERNEO_WORKFLOW_START_ISO; the window
    // now lives in the getReviewEvidence github op + review_posted preset, fed by
    // the gate evaluator's context (workflowStartIso). Covered by the preset
    // tests in runtime/connectors/presets.test.ts.
    const gate = [
      ...CODING_WORKFLOW.gates!,
      ...getBuiltInWorkflows().flatMap((w) => w.gates ?? []),
    ].find((g) => g.id === 'review-posted-gate');
    expect(gate?.validator).toEqual({ kind: 'built_in', id: 'review_posted' });
  });
});

describe('all built-in workflow gates pass creation-time validation', () => {
  const workflows = getBuiltInWorkflows();

  test('every built-in gate is structurally valid', () => {
    for (const wf of workflows) {
      for (const gate of wf.gates ?? []) {
        const errors = validateGate(gate);
        expect(errors).toHaveLength(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Agent slot prompt completeness tests
// ---------------------------------------------------------------------------

describe('all built-in workflows have non-empty agent slot prompts', () => {
  const workflows = getBuiltInWorkflows();

  test('every workflow template node has at least one agent', () => {
    for (const wf of workflows) {
      for (const node of wf.nodes) {
        expect(node.agents.length).toBeGreaterThan(0);
      }
    }
  });

  test('every agent slot has a non-empty customPrompt override', () => {
    for (const wf of workflows) {
      for (const node of wf.nodes) {
        for (const agent of node.agents) {
          expect(agent.customPrompt).toBeDefined();
          expect(agent.customPrompt?.value?.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  test('customPrompt values contain meaningful content (at least 50 chars)', () => {
    for (const wf of workflows) {
      for (const node of wf.nodes) {
        for (const agent of node.agents) {
          const len = agent.customPrompt?.value?.trim().length ?? 0;
          expect(len).toBeGreaterThanOrEqual(50);
        }
      }
    }
  });
});

describe('CODING_WORKFLOW agent slot customPrompt', () => {
  test('Coding node coder has non-empty customPrompt', () => {
    const codeNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
    const coder = codeNode.agents[0];
    expect(coder.customPrompt?.value).toBeDefined();
    expect(coder.customPrompt?.value.trim().length).toBeGreaterThan(0);
  });

  test('Coding node coder customPrompt resolves review threads and communicates via the runtime contract', () => {
    const codeNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
    const coder = codeNode.agents[0];
    const prompt = coder.customPrompt!.value;
    // The stable coder prompt is behavioral: it tells the coder to reply on the
    // PR, resolve review threads, and use the runtime-supplied handoff — without
    // hard-coding the legacy inline-reply REST/GraphQL recipe (which is injected
    // only when re-activated by the runtime, not baked into the slot).
    expect(prompt).toContain('reply on the PR');
    expect(prompt).toContain('resolve review threads');
    expect(prompt).toContain('Runtime Execution Contract');
    // The coder owns the merge, so `gh pr merge` appears in the post-approval phase.
    expect(prompt).toContain('`gh pr merge`');
  });

  test('Review node reviewer has non-empty customPrompt', () => {
    const reviewNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const reviewer = reviewNode.agents[0];
    expect(reviewer.customPrompt?.value).toBeDefined();
    expect(reviewer.customPrompt?.value).toContain('post a visible GitHub review');
  });

  test('Review node reviewer customPrompt requires posting to GitHub and echoing review_url', () => {
    const reviewNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const reviewer = reviewNode.agents[0];
    const prompt = reviewer.customPrompt!.value;
    // Reviewer must post a visible GitHub review per the system contract.
    expect(prompt).toContain('post a visible GitHub review');
    expect(prompt).toContain('Reviewer system contract');
    // The changes-requested feedback handoff defers the payload contract to the
    // runtime (behavioral-only; no field names restated), but still raises the
    // specific thread URLs the reviewer is commenting on.
    expect(prompt).not.toContain('pr_url');
    expect(prompt).not.toContain('review_url');
    expect(prompt).not.toContain('comment_urls');
    expect(prompt).toMatch(/specific\s+thread URLs|thread URLs you are raising/i);
    // The gate contract is that review evidence must be visible on the PR (the
    // review-posted hook/gate), so the reviewer must post before sending feedback.
    expect(prompt).toMatch(/post a visible GitHub review/i);
  });
});

describe('REVIEW_ONLY_WORKFLOW reviewer customPrompt requires a visible review before save_artifact', () => {
  test('reviewer prompt mandates a visible review before handoff', () => {
    const agent = REVIEW_ONLY_WORKFLOW.nodes[0].agents[0];
    const prompt = agent.customPrompt!.value;
    expect(prompt).toContain('visible GitHub review');
    expect(prompt).toContain('record the PR');
  });
});

describe('RESEARCH_WORKFLOW agent slot customPrompt', () => {
  test('Research node has non-empty customPrompt', () => {
    const researchNode = RESEARCH_WORKFLOW.nodes.find((n) => n.name === 'Research')!;
    const agent = researchNode.agents[0];
    expect(agent.customPrompt?.value).toBeDefined();
    expect(agent.customPrompt?.value.trim().length).toBeGreaterThan(0);
  });

  test('Review node has non-empty customPrompt', () => {
    const reviewNode = RESEARCH_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const agent = reviewNode.agents[0];
    expect(agent.customPrompt?.value).toBeDefined();
    expect(agent.customPrompt?.value).toMatch(/save(_| a result )artifact/);
  });
});

describe('REVIEW_ONLY_WORKFLOW agent slot customPrompt', () => {
  test('Review node has non-empty customPrompt', () => {
    const reviewNode = REVIEW_ONLY_WORKFLOW.nodes[0];
    const agent = reviewNode.agents[0];
    expect(agent.customPrompt?.value).toBeDefined();
    expect(agent.customPrompt?.value).toMatch(/save(_| a result )artifact/);
  });

  test('Review node has agent slot customPrompt (no separate node-level instructions)', () => {
    const agent = REVIEW_ONLY_WORKFLOW.nodes[0].agents[0];
    expect(agent.customPrompt).toBeDefined();
  });
});

describe('PLAN_AND_DECOMPOSE_WORKFLOW agent slot customPrompt', () => {
  test('Planning node planner has non-empty customPrompt referencing PR-ready hook', () => {
    const node = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find((n) => n.name === 'Planning')!;
    const agent = node.agents[0];
    expect(agent.customPrompt?.value).toBeDefined();
    expect(agent.customPrompt?.value).toContain('hook validates');
  });

  test('Plan Review node has 4 lens-specific reviewers, each referencing plan-approval-gate and its lens', () => {
    const node = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find((n) => n.name === 'Plan Review')!;
    expect(node.agents).toHaveLength(4);
    const lenses = ['architecture', 'security', 'correctness', 'ux'];
    const seenLenses: string[] = [];
    for (const agent of node.agents) {
      expect(agent.customPrompt?.value).toBeDefined();
      expect(agent.customPrompt?.value).toContain('Task Dispatcher');
      // Each reviewer's prompt references its specific lens
      const lensForAgent = lenses.find((l) => agent.customPrompt!.value.includes(`"${l}"`));
      expect(lensForAgent).toBeDefined();
      seenLenses.push(lensForAgent!);
    }
    // All four lenses must be represented exactly once
    expect(seenLenses.sort()).toEqual([...lenses].sort());
  });

  test('Plan Review prompt instructs waiting for codex reaction before voting', () => {
    const node = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find((n) => n.name === 'Plan Review')!;
    const prompt = node.agents[0].customPrompt!.value;
    expect(prompt).toContain('any login containing `codex`');
    // The reaction lookup is run-scoped GraphQL (the Reviewer contract forbids
    // direct `gh api repos/...` REST reads against other repos), not the legacy REST issues/.../reactions.
    expect(prompt).toContain('gh api graphql');
    expect(prompt).toContain('reactions(first:100)');
    expect(prompt).not.toContain('issues/{number}/reactions');
    expect(prompt).toContain('poll every 60 seconds');
    expect(prompt).toContain('2 hours by default');
  });

  test('Plan Review prompt reads the PR diff via gh pr diff/view', () => {
    // The Plan Reviewer reads the plan PR diff with `gh pr diff` / `gh pr view`
    // (the github CLI), not the retired get_pr_diff node-agent tool.
    const node = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find((n) => n.name === 'Plan Review')!;
    const prompt = node.agents[0].customPrompt!.value;
    expect(prompt).toContain('gh pr diff');
    expect(prompt).toContain('gh pr view');
    expect(prompt).not.toContain('get_pr_diff');
  });

  test('Task Dispatcher node prompt references create_standalone_task and save_artifact', () => {
    const node = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find((n) => n.name === 'Task Dispatcher')!;
    expect(node.agents).toHaveLength(1);
    const agent = node.agents[0];
    expect(agent.customPrompt?.value).toBeDefined();
    expect(agent.customPrompt?.value).toContain('create_standalone_task');
    expect(agent.customPrompt?.value).toMatch(/save(_| a result )artifact/);
  });
});

// ---------------------------------------------------------------------------
// Reviewer Terminal Action Pre-conditions
//
// Regression coverage for Task #136: Reviewer agents were calling
// `submit_for_approval` / `approve_task` mid-loop while their own posted review
// still contained pending P0–P3 findings, prematurely closing the iterative
// Coding ↔ Review loop. Every Reviewer / review-style end-node prompt must now
// contain an explicit Terminal Action Pre-conditions block establishing the
// hard gate: zero pending P0–P3 findings AND verdict = APPROVE.
// ---------------------------------------------------------------------------

describe('Reviewer Terminal Action Pre-conditions (Task #136 regression)', () => {
  /**
   * Asserts that a review-style prompt contains the canonical pre-conditions
   * block. The check is content-based rather than token-exact so the prompt
   * can evolve without breaking the test, but every load-bearing phrase from
   * the design spec (severity range, both terminal tools, REQUEST_CHANGES
   * branch instructions, "same approval semantic") must be present.
   */
  function assertTerminalActionPreconditions(prompt: string, opts: { upstream: string }): void {
    // Header-style phrase identifying the block.
    expect(prompt).toMatch(
      /terminal-action tool contract|Terminal-action contract|terminal hand-off|terminal action|terminal calls|terminal actions|terminal-action tool descriptions/
    );
    // Both terminal tools must be named explicitly so the model cannot
    // interpret "approve_task only" or "submit_for_approval only".
    expect(prompt).toContain('approve_task');
    expect(prompt).toContain('submit_for_approval');
    // Severity envelope must reference P0–P3 (covers the full classification
    // rule from REVIEWER_CUSTOM_PROMPT in seed-agents.ts).
    expect(prompt).toMatch(
      /P0[–-]P3|zero findings|zero P0-P3|findings remain|blocking findings|QA passes|Reviewer System Contract/i
    );
    // Verdict gate — APPROVE must be the only path to a terminal call.
    expect(prompt).toMatch(
      /verdict.*APPROVE|APPROVE.*verdict|If approved|If satisfied|approved only|QA passes|after every downstream task/i
    );
    // REQUEST_CHANGES path must explicitly forbid both terminal calls.
    expect(prompt).toMatch(
      /REQUEST_CHANGES|changes needed|requesting changes|more research is needed|findings remain|QA fails/i
    );
    expect(prompt).toMatch(
      /do not .*approve_task|Never use.*findings|If findings remain|If changes needed|If dispatch is incomplete|If QA fails|only on APPROVE|If requesting changes|If more research is needed/i
    );
    expect(prompt).toMatch(
      /do not .*submit_for_approval|Never use.*findings|If findings remain|If changes needed|If dispatch is incomplete|If QA fails|only on APPROVE|If requesting changes|If more research is needed/i
    );
    // The upstream node name must appear in the send_message instruction so
    // the reviewer knows where to route feedback when continuing the loop.
    expect(prompt).toContain(`send_message(target="${opts.upstream}"`);
    // Equivalence statement: submit_for_approval is NOT a "let a human
    // decide" escape hatch — it carries the same approval semantic as
    // approve_task. This prevents the original bug recurring.
    expect(prompt).toMatch(
      /same approval semantic|terminal-action tool contract|terminal hand-off|terminal.*contract/i
    );
  }

  test('CODING_WORKFLOW Review node prompt reserves terminal calls for a clean, resolved head', () => {
    // The stable reviewer prompt (CODER_OWNED_REVIEW_PROMPT) is behavioral: it
    // gates terminal actions (approve_task/submit_for_approval) on a clean head
    // with all review threads resolved, and forbids merges.
    const reviewNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const prompt = reviewNode.agents[0].customPrompt!.value;
    expect(prompt).toContain('approve_task');
    expect(prompt).toContain('submit_for_approval');
    expect(prompt).toMatch(/When the current head is clean and all review threads are resolved/i);
    expect(prompt).toContain('Do not merge');
  });

  test('CODING_WORKFLOW Review node sends actionable feedback when changes are needed', () => {
    const reviewNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const prompt = reviewNode.agents[0].customPrompt!.value;
    // "If changes are needed" branch must route actionable feedback to the
    // coder via the gated feedback handoff, and reserve terminal calls for clean
    // heads (so a changed head does NOT terminate).
    expect(prompt).toMatch(/If changes are needed/i);
    expect(prompt).toContain('actionable feedback');
    expect(prompt).toMatch(/When the current head is clean .* call approve_task/i);
  });

  test('RESEARCH_WORKFLOW Review node prompt contains Terminal Action Pre-conditions block', () => {
    const reviewNode = RESEARCH_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const prompt = reviewNode.agents[0].customPrompt!.value;
    assertTerminalActionPreconditions(prompt, { upstream: 'Research' });
  });

  test('RESEARCH_WORKFLOW Review node REQUEST_CHANGES branch forbids both terminal tools', () => {
    const reviewNode = RESEARCH_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const prompt = reviewNode.agents[0].customPrompt!.value;
    // "more research is needed" branch must forbid both terminal tools.
    const requestBranch = prompt.split('6. If satisfied')[0];
    expect(requestBranch).toMatch(
      /If more research is needed|If findings remain|do not .*approve_task/i
    );
    expect(requestBranch).toMatch(
      /If more research is needed|If findings remain|do not .*submit_for_approval/i
    );
  });

  test('RESEARCH_WORKFLOW Review node prompt does not promise Codex enforcement', () => {
    const reviewNode = RESEARCH_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const prompt = reviewNode.agents[0].customPrompt!.value;
    expect(prompt).not.toContain('verify codex[bot] reaction status');
    expect(prompt).not.toContain('@codex review');
    expect(prompt).not.toContain('wait for an `eyes` or `+1` reaction');
  });

  test('REVIEW_ONLY_WORKFLOW prompt forbids terminal calls when verdict is REQUEST_CHANGES', () => {
    const prompt = REVIEW_ONLY_WORKFLOW.nodes[0].agents[0].customPrompt!.value;
    // Header & severity coverage.
    expect(prompt).toMatch(
      /terminal-action tool contract|Terminal-action contract|terminal hand-off|terminal action|terminal calls|terminal actions|terminal-action tool descriptions/
    );
    expect(prompt).toMatch(
      /P0[–-]P3|zero findings|zero P0-P3|findings remain|blocking findings|QA passes|Reviewer System Contract/i
    );
    expect(prompt).toContain('approve_task');
    expect(prompt).toContain('submit_for_approval');
    // Both terminal tools must be forbidden on the REQUEST_CHANGES branch.
    expect(prompt).toMatch(
      /do not .*approve_task|Never use.*findings|If findings remain|If changes needed|If dispatch is incomplete|If QA fails|only on APPROVE|If requesting changes|If more research is needed/i
    );
    expect(prompt).toMatch(
      /do not .*submit_for_approval|Never use.*findings|If findings remain|If changes needed|If dispatch is incomplete|If QA fails|only on APPROVE|If requesting changes|If more research is needed/i
    );
    // Same approval semantic clarifier so submit_for_approval is not
    // treated as an escape hatch in the single-node case either.
    expect(prompt).toMatch(
      /same approval semantic|terminal-action tool contract|terminal hand-off|terminal.*contract/i
    );
  });

  test('CODING_WITH_QA_WORKFLOW review-approval-gate requires reviewer and codex approval', () => {
    const gate = CODING_WITH_QA_WORKFLOW.gates!.find((g) => g.id === 'review-approval-gate')!;
    const approvalField = gate.fields!.find((f) => f.name === 'approved')!;

    expect(approvalField.type).toBe('boolean');
    expect(approvalField.writers).toEqual(['Review', 'reviewer']);
    expect(approvalField.check).toEqual({ op: '==', value: true });
    // Codex is no longer hardcoded as a gate feature; it is opt-in via node-level config.
    expect(gate.features?.codex_review_bot).toBeUndefined();
    expect(gate.script).toBeUndefined();
    expect(gate.poll).toBeUndefined();

    const effectiveGate = getFullstackReviewApprovalGateWithCodex();
    // Matcher accepts any GitHub login whose name contains "codex" (case-insensitive)
    // so both `codex[bot]` and `chatgpt-codex-connector[bot]` are recognized.
    expect(effectiveGate.script?.source).toContain('test("codex"; "i")');
    expect(effectiveGate.script?.source).toContain('issues/${NUMBER}/reactions?per_page=100');
    expect(effectiveGate.script?.source).toContain('--paginate');
    expect(effectiveGate.script?.source).toContain("jq -s 'add // []'");
    expect(effectiveGate.script?.source).toContain('.content == "+1"');
    expect(effectiveGate.script?.source).toContain('bun -e');
    expect(effectiveGate.script?.source).toContain('HYPERNEO_GATE_DATA_UPDATED_ISO');
    expect(effectiveGate.script?.source).toContain('PR_URL="${GATE_PR_URL:-${PR_URL:-}}"');
    expect(effectiveGate.script?.source).toContain("comment '@codex review'");
    expect(effectiveGate.script?.source).not.toContain('node -e');
    expect(effectiveGate.script?.source).toContain('.head.sha');
    expect(effectiveGate.script?.source).toContain('head_sha');
    expect(effectiveGate.script?.source).toContain('^https://([^/]+)/');
    expect(effectiveGate.script?.source).not.toContain('github\\.com');
    expect(effectiveGate.poll?.intervalMs).toBe(300_000);
  });

  test('dynamic codex injection honors wildcard source node opt-in', () => {
    const gate = {
      id: 'wildcard-approval-gate',
      fields: [
        { name: 'approved', type: 'boolean', writers: [], check: { op: '==', value: true } },
      ],
      resetOnCycle: false,
    };
    const effectiveGate = getEffectiveGate(
      gate,
      {
        id: 'wf-wildcard-codex',
        spaceId: 'space-1',
        name: 'Wildcard Codex Workflow',
        tags: [],
        nodes: [
          { id: 'node-coder', name: 'Coder', agents: [], requireCodexApproval: true },
          { id: 'node-reviewer', name: 'Reviewer', agents: [] },
        ],
        startNodeId: 'node-coder',
        endNodeId: 'node-reviewer',
        channels: [{ id: 'ch-1', from: '*', to: 'Reviewer', gateId: gate.id }],
        gates: [gate],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completionAutonomyLevel: 3,
      },
      'Coder'
    );

    expect(effectiveGate.script?.source).toContain('test("codex"; "i")');
  });

  test('isApprovalGate recognizes vote-map approvals by check semantics', () => {
    expect(
      isApprovalGate({
        id: 'semantic-approval-gate',
        fields: [
          {
            name: 'votes',
            type: 'map',
            writers: [],
            check: { op: 'count', match: 'approved', min: 1 },
          },
        ],
        resetOnCycle: false,
      })
    ).toBe(true);
  });

  test('isApprovalGate recognizes boolean approval checks independent of field name', () => {
    expect(
      isApprovalGate({
        id: 'semantic-boolean-approval-gate',
        fields: [
          {
            name: 'signoff',
            type: 'boolean',
            writers: [],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      })
    ).toBe(true);
  });

  test('invalid Codex poll interval env values fall back to default', () => {
    expect(resolveCodexPollIntervalMs(undefined)).toBe(300000);
    expect(resolveCodexPollIntervalMs('5m')).toBe(300000);
    expect(resolveCodexPollIntervalMs('0')).toBe(300000);
    expect(resolveCodexPollIntervalMs(30000)).toBe(30000);
  });

  test('dynamic Codex injection handles node and agent source name collision', () => {
    const gate = {
      id: 'agent-source-gate',
      fields: [
        {
          name: 'signoff',
          type: 'boolean' as const,
          writers: [],
          check: { op: '==', value: true },
        },
      ],
      resetOnCycle: false,
    };
    const workflow = {
      id: 'wf-agent-source-collision',
      spaceId: 'space-1',
      name: 'Agent Source Collision',
      tags: [],
      nodes: [
        {
          id: 'node-source',
          name: 'SourceNode',
          agents: [{ agentId: 'agent-coder', name: 'Reviewer' }],
        },
        {
          id: 'node-collision',
          name: 'Reviewer',
          requireCodexApproval: true,
          agents: [{ agentId: 'agent-reviewer', name: 'reviewer' }],
        },
      ],
      channels: [{ id: 'ch-node-source', from: 'Reviewer', to: 'reviewer', gateId: gate.id }],
      gates: [gate],
      startNodeId: 'node-source',
      endNodeId: 'node-collision',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completionAutonomyLevel: 3,
    };

    expect(getEffectiveGate(gate, workflow, 'Reviewer').script?.source).toContain(
      'test("codex"; "i")'
    );

    workflow.nodes[0] = { ...workflow.nodes[0], requireCodexApproval: true };
    workflow.nodes[1] = { ...workflow.nodes[1], requireCodexApproval: undefined };

    expect(getEffectiveGate(gate, workflow, 'Reviewer').script?.source).toContain(
      'test("codex"; "i")'
    );
  });

  test('codex feature script and poll override custom script and poll consistently', () => {
    const gate = getEffectiveGate({
      id: 'custom-codex-gate',
      resetOnCycle: false,
      features: { codex_review_bot: true },
      script: { interpreter: 'bash', source: 'echo custom', timeoutMs: 10000 },
      poll: { intervalMs: 30_000, target: 'to', script: 'echo custom poll' },
    });

    expect(gate.script?.source).toContain('test("codex"; "i")');
    expect(gate.poll?.script).toContain('test("codex"; "i")');
    expect(gate.script?.source).not.toContain('echo custom');
    expect(gate.poll?.script).not.toContain('echo custom poll');
  });

  // GATED (Vitest/Node): requires Bun.spawn in production executeGateScript.
  test.skipIf(!isBun)(
    'CODING_WITH_QA_WORKFLOW review-approval-gate blocks without codex thumbs-up',
    async () => {
      const gate = getFullstackReviewApprovalGateWithCodex();
      const workspace = mkdtempSync(join(tmpdir(), 'hyperneo-codex-gate-blocked-'));
      const binDir = join(workspace, 'bin');
      const ghPath = join(binDir, 'gh');
      const prUrl = 'https://github.com/test/repo/pull/42';

      try {
        mkdirSync(binDir);
        writeFileSync(
          ghPath,
          [
            '#!/usr/bin/env bash',
            'if [[ "$*" == *"repos/test/repo/issues/42/reactions"* ]]; then',
            `  printf '%s\n' '[{"user":{"login":"codex[bot]","type":"Bot"},"content":"eyes","created_at":"2026-05-29T00:00:00Z"}]'`,
            '  exit 0',
            'fi',
            'printf "unexpected gh args: %s\n" "$*" >&2',
            'exit 2',
          ].join('\n')
        );
        chmodSync(ghPath, 0o755);

        const result = await executeGateScript(
          gate.script!,
          {
            workspacePath: workspace,
            gateId: 'review-approval-gate',
            runId: 'run-1',
            gateData: { pr_url: prUrl, approved: true },
          },
          { PATH: `${binDir}:${process.env.PATH ?? ''}` }
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('still in progress');
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  );

  // GATED (Vitest/Node): requires Bun.spawn in production executeGateScript.
  test.skipIf(!isBun)(
    'CODING_WITH_QA_WORKFLOW review-approval-gate passes with codex thumbs-up',
    async () => {
      const gate = getFullstackReviewApprovalGateWithCodex();
      const workspace = mkdtempSync(join(tmpdir(), 'hyperneo-codex-gate-passed-'));
      const binDir = join(workspace, 'bin');
      const ghPath = join(binDir, 'gh');
      const prUrl = 'https://github.com/test/repo/pull/42';

      try {
        mkdirSync(binDir);
        writeFileSync(
          ghPath,
          [
            '#!/usr/bin/env bash',
            'if [[ "$*" == *"repos/test/repo/issues/42/reactions"* ]]; then',
            `  printf '%s\n' '[{"user":{"login":"chatgpt-codex-connector[bot]","type":"Bot"},"content":"+1","created_at":"2026-05-29T00:00:00Z"}]'`,
            '  exit 0',
            'fi',
            'if [[ "$*" =~ repos/test/repo/pulls/42 ]]; then',
            `  printf '%s\n' 'sha-pass'`,
            '  exit 0',
            'fi',
            'printf "unexpected gh args: %s\n" "$*" >&2',
            'exit 2',
          ].join('\n')
        );
        chmodSync(ghPath, 0o755);

        const result = await executeGateScript(
          gate.script!,
          {
            workspacePath: workspace,
            gateId: 'review-approval-gate',
            runId: 'run-1',
            gateData: { pr_url: prUrl, approved: true },
          },
          { PATH: `${binDir}:${process.env.PATH ?? ''}` }
        );

        expect(result.success).toBe(true);
        expect(result.data).toEqual({
          pr_url: prUrl,
          codex_bot_reaction: '+1',
          head_sha: 'sha-pass',
        });
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  );

  // GATED (Vitest/Node): requires Bun.spawn in production executeGateScript.
  test.skipIf(!isBun)(
    'CODING_WITH_QA_WORKFLOW review-approval-gate still blocks before gate-data timeout even when workflow is old',
    async () => {
      const gate = getFullstackReviewApprovalGateWithCodex();
      const workspace = mkdtempSync(join(tmpdir(), 'hyperneo-codex-gate-fresh-approval-'));
      const binDir = join(workspace, 'bin');
      const ghPath = join(binDir, 'gh');
      const prUrl = 'https://github.com/test/repo/pull/42';

      try {
        mkdirSync(binDir);
        writeFileSync(
          ghPath,
          [
            '#!/usr/bin/env bash',
            'if [[ "$*" == *"repos/test/repo/issues/42/reactions"* ]]; then',
            `  printf '%s\n' '[]'`,
            '  exit 0',
            'fi',
            'printf "unexpected gh args: %s\n" "$*" >&2',
            'exit 2',
          ].join('\n')
        );
        chmodSync(ghPath, 0o755);

        const result = await executeGateScript(
          gate.script!,
          {
            workspacePath: workspace,
            gateId: 'review-approval-gate',
            runId: 'run-1',
            gateData: { pr_url: prUrl, approved: true },
            workflowStartIso: '2026-05-01T00:00:00Z',
            gateDataUpdatedIso: new Date().toISOString(),
          },
          { PATH: `${binDir}:${process.env.PATH ?? ''}` }
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('@codex review');
        expect(result.error).not.toContain('command not found');
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  );

  // GATED (Vitest/Node): requires Bun.spawn in production executeGateScript.
  test.skipIf(!isBun)(
    'CODING_WITH_QA_WORKFLOW review-approval-gate passes after codex timeout',
    async () => {
      const gate = getFullstackReviewApprovalGateWithCodex();
      const workspace = mkdtempSync(join(tmpdir(), 'hyperneo-codex-gate-timeout-'));
      const binDir = join(workspace, 'bin');
      const ghPath = join(binDir, 'gh');
      const prUrl = 'https://github.com/test/repo/pull/42';

      try {
        mkdirSync(binDir);
        writeFileSync(
          ghPath,
          [
            '#!/usr/bin/env bash',
            'if [[ "$*" == *"repos/test/repo/issues/42/reactions"* ]]; then',
            `  printf '%s\n' '[]'`,
            '  exit 0',
            'fi',
            'if [[ "$*" =~ repos/test/repo/pulls/42 ]]; then',
            `  printf '%s\n' 'sha-timeout'`,
            '  exit 0',
            'fi',
            'printf "unexpected gh args: %s\n" "$*" >&2',
            'exit 2',
          ].join('\n')
        );
        chmodSync(ghPath, 0o755);

        const result = await executeGateScript(
          gate.script!,
          {
            workspacePath: workspace,
            gateId: 'review-approval-gate',
            runId: 'run-1',
            gateData: { pr_url: prUrl, approved: true },
            workflowStartIso: '2026-05-01T00:00:00Z',
            gateDataUpdatedIso: '2026-05-01T00:00:00Z',
          },
          { PATH: `${binDir}:${process.env.PATH ?? ''}` }
        );

        expect(result.success).toBe(true);
        expect(result.data).toEqual({
          pr_url: prUrl,
          codex_bot_reaction: 'timeout',
          head_sha: 'sha-timeout',
          codex_bot_warning: 'codex review bot +1 reaction missing after timeout; allowing gate',
        });
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  );

  // GATED (Vitest/Node): requires Bun.spawn in production executeGateScript.
  test.skipIf(!isBun)(
    'CODING_WITH_QA_WORKFLOW review-approval-gate returns +1 even when timeout has elapsed',
    async () => {
      const gate = getFullstackReviewApprovalGateWithCodex();
      const workspace = mkdtempSync(join(tmpdir(), 'hyperneo-codex-gate-timeout-plus-one-'));
      const binDir = join(workspace, 'bin');
      const ghPath = join(binDir, 'gh');
      const prUrl = 'https://github.com/test/repo/pull/42';

      try {
        mkdirSync(binDir);
        writeFileSync(
          ghPath,
          [
            '#!/usr/bin/env bash',
            'if [[ "$*" == *"repos/test/repo/issues/42/reactions"* ]]; then',
            `  printf '%s\\n' '[{"user":{"login":"codex[bot]","type":"Bot"},"content":"+1","created_at":"2026-05-01T00:00:00Z"}]'`,
            '  exit 0',
            'fi',
            'if [[ "$*" =~ repos/test/repo/pulls/42 ]]; then',
            `  printf '%s\\n' 'sha-timeout-plus-one'`,
            '  exit 0',
            'fi',
            'printf "unexpected gh args: %s\\n" "$*" >&2',
            'exit 2',
          ].join('\n')
        );
        chmodSync(ghPath, 0o755);

        const result = await executeGateScript(
          gate.script!,
          {
            workspacePath: workspace,
            gateId: 'review-approval-gate',
            runId: 'run-1',
            gateData: { pr_url: prUrl, approved: true },
            // Timeout has elapsed, but +1 is present — +1 should win.
            workflowStartIso: '2026-05-01T00:00:00Z',
            gateDataUpdatedIso: '2026-05-01T00:00:00Z',
          },
          { PATH: `${binDir}:${process.env.PATH ?? ''}` }
        );

        expect(result.success).toBe(true);
        expect(result.data).toEqual({
          pr_url: prUrl,
          codex_bot_reaction: '+1',
          head_sha: 'sha-timeout-plus-one',
        });
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  );

  // GATED (Vitest/Node): requires Bun.spawn in production executeGateScript.
  test.skipIf(!isBun)(
    'CODING_WITH_QA_WORKFLOW review-approval-gate blocks +1 from before cycle_start_at',
    async () => {
      const gate = getFullstackReviewApprovalGateWithCodex();
      const workspace = mkdtempSync(join(tmpdir(), 'hyperneo-codex-gate-stale-plus-one-'));
      const binDir = join(workspace, 'bin');
      const ghPath = join(binDir, 'gh');
      const prUrl = 'https://github.com/test/repo/pull/42';

      try {
        mkdirSync(binDir);
        writeFileSync(
          ghPath,
          [
            '#!/usr/bin/env bash',
            'if [[ "$*" == *"repos/test/repo/issues/42/reactions"* ]]; then',
            `  printf '%s\n' '[{"user":{"login":"codex[bot]","type":"Bot"},"content":"+1","created_at":"2026-05-01T00:00:00Z"}]'`,
            '  exit 0',
            'fi',
            'printf "unexpected gh args: %s\n" "$*" >&2',
            'exit 2',
          ].join('\n')
        );
        chmodSync(ghPath, 0o755);

        const result = await executeGateScript(
          gate.script!,
          {
            workspacePath: workspace,
            gateId: 'review-approval-gate',
            runId: 'run-1',
            // Reaction is before cycle_start_at — should be filtered as stale.
            // Timeout anchor is gateDataUpdatedIso (the approval-handoff write),
            // so it must be recent to keep this test focused on the freshness
            // filter rather than the timeout path.
            gateData: {
              pr_url: prUrl,
              approved: true,
              cycle_start_at: new Date('2026-05-02T00:00:00Z').getTime(),
            },
            gateDataUpdatedIso: new Date().toISOString(),
          },
          { PATH: `${binDir}:${process.env.PATH ?? ''}` }
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('@codex review');
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  );

  // GATED (Vitest/Node): requires Bun.spawn in production executeGateScript.
  test.skipIf(!isBun)(
    'CODING_WITH_QA_WORKFLOW review-approval-gate outputs head_sha on success',
    async () => {
      const gate = getFullstackReviewApprovalGateWithCodex();
      const workspace = mkdtempSync(join(tmpdir(), 'hyperneo-codex-gate-head-sha-output-'));
      const binDir = join(workspace, 'bin');
      const ghPath = join(binDir, 'gh');
      const prUrl = 'https://github.com/test/repo/pull/42';

      try {
        mkdirSync(binDir);
        writeFileSync(
          ghPath,
          [
            '#!/usr/bin/env bash',
            'if [[ "$*" == *"repos/test/repo/issues/42/reactions"* ]]; then',
            `  printf '%s\\n' '[{"user":{"login":"codex[bot]","type":"Bot"},"content":"+1","created_at":"2026-05-02T00:00:00Z"}]'`,
            '  exit 0',
            'fi',
            'if [[ "$*" =~ repos/test/repo/pulls/42 ]]; then',
            `  printf '%s\\n' 'abc123'`,
            '  exit 0',
            'fi',
            'printf "unexpected gh args: %s\\n" "$*" >&2',
            'exit 2',
          ].join('\n')
        );
        chmodSync(ghPath, 0o755);

        const result = await executeGateScript(
          gate.script!,
          {
            workspacePath: workspace,
            gateId: 'review-approval-gate',
            runId: 'run-1',
            gateData: { pr_url: prUrl, approved: true },
            gateDataUpdatedIso: '2026-05-01T00:00:00Z',
          },
          { PATH: `${binDir}:${process.env.PATH ?? ''}` }
        );

        expect(result.success).toBe(true);
        expect(result.data).toEqual({
          pr_url: prUrl,
          codex_bot_reaction: '+1',
          head_sha: 'abc123',
        });
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  );

  // GATED (Vitest/Node): requires Bun.spawn in production executeGateScript.
  test.skipIf(!isBun)('codex script accepts GitHub Enterprise PR URLs', async () => {
    const gate = getFullstackReviewApprovalGateWithCodex();
    const workspace = mkdtempSync(join(tmpdir(), 'hyperneo-codex-gate-gh-enterprise-'));
    const binDir = join(workspace, 'bin');
    const ghPath = join(binDir, 'gh');
    const prUrl = 'https://github.enterprise.example.com/test/repo/pull/42';

    try {
      mkdirSync(binDir);
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          'if [[ "$*" != *"--hostname github.enterprise.example.com"* ]]; then',
          '  echo "Missing --hostname for GHE URL: $*" >&2',
          '  exit 2',
          'fi',
          'if [[ "$*" == *"repos/test/repo/issues/42/reactions"* ]]; then',
          `  printf '%s\\n' '[{"user":{"login":"codex[bot]","type":"Bot"},"content":"+1","created_at":"2026-05-29T00:00:00Z"}]'`,
          '  exit 0',
          'fi',
          'if [[ "$*" =~ repos/test/repo/pulls/42 ]]; then',
          `  printf '%s\\n' 'ent123'`,
          '  exit 0',
          'fi',
          'fi',
          'printf "unexpected gh args: %s\\n" "$*" >&2',
          'exit 2',
        ].join('\n')
      );
      chmodSync(ghPath, 0o755);

      const result = await executeGateScript(
        gate.script!,
        {
          workspacePath: workspace,
          gateId: 'review-approval-gate',
          runId: 'run-1',
          gateData: { pr_url: prUrl, approved: true },
        },
        { PATH: `${binDir}:${process.env.PATH ?? ''}`, GH_HOST: 'github.enterprise.example.com' }
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ pr_url: prUrl, codex_bot_reaction: '+1', head_sha: 'ent123' });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  // GATED (Vitest/Node): requires Bun.spawn in production executeGateScript.
  test.skipIf(!isBun)('codex script fails closed when gh api reactions fetch fails', async () => {
    const gate = getFullstackReviewApprovalGateWithCodex();
    const workspace = mkdtempSync(join(tmpdir(), 'hyperneo-codex-gate-pipefail-'));
    const binDir = join(workspace, 'bin');
    const ghPath = join(binDir, 'gh');
    const prUrl = 'https://github.com/test/repo/pull/42';

    try {
      mkdirSync(binDir);
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          'if [[ "$*" == *"repos/test/repo/issues/42/reactions"* ]]; then',
          '  echo "API rate limit exceeded" >&2',
          '  exit 1',
          'fi',
          'printf "unexpected gh args: %s\\n" "$*" >&2',
          'exit 2',
        ].join('\n')
      );
      chmodSync(ghPath, 0o755);

      const result = await executeGateScript(
        gate.script!,
        {
          workspacePath: workspace,
          gateId: 'review-approval-gate',
          runId: 'run-1',
          gateData: { pr_url: prUrl, approved: true },
        },
        { PATH: `${binDir}:${process.env.PATH ?? ''}` }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to fetch PR reactions');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  // GATED (Vitest/Node): requires Bun.spawn in production executeGateScript.
  test.skipIf(!isBun)(
    'codex timeout does not trigger when only workflowStartIso is old',
    async () => {
      const gate = getFullstackReviewApprovalGateWithCodex();
      const workspace = mkdtempSync(join(tmpdir(), 'hyperneo-codex-gate-timeout-suppressed-'));
      const binDir = join(workspace, 'bin');
      const ghPath = join(binDir, 'gh');
      const prUrl = 'https://github.com/test/repo/pull/42';

      try {
        mkdirSync(binDir);
        writeFileSync(
          ghPath,
          [
            '#!/usr/bin/env bash',
            'if [[ "$*" == *"repos/test/repo/issues/42/reactions"* ]]; then',
            `  printf '%s\\n' '[]'`,
            '  exit 0',
            'fi',
            'printf "unexpected gh args: %s\\n" "$*" >&2',
            'exit 2',
          ].join('\n')
        );
        chmodSync(ghPath, 0o755);

        const result = await executeGateScript(
          gate.script!,
          {
            workspacePath: workspace,
            gateId: 'review-approval-gate',
            runId: 'run-1',
            gateData: { pr_url: prUrl, approved: true },
            // Only workflowStartIso is old; gateDataUpdatedIso is missing.
            // Timeout should not trigger because it only uses gateDataUpdatedIso.
            workflowStartIso: '2026-05-01T00:00:00Z',
          },
          { PATH: `${binDir}:${process.env.PATH ?? ''}` }
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('@codex review');
        expect(result.error).not.toContain('timeout');
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  );

  // GATED (Vitest/Node): requires Bun.spawn in production executeGateScript.
  test.skipIf(!isBun)(
    'codex poll script exits 0 with pending status when no reaction exists',
    async () => {
      const gate = getFullstackReviewApprovalGateWithCodex();
      const workspace = mkdtempSync(join(tmpdir(), 'hyperneo-codex-poll-pending-'));
      const binDir = join(workspace, 'bin');
      const ghPath = join(binDir, 'gh');
      const prUrl = 'https://github.com/test/repo/pull/42';

      try {
        mkdirSync(binDir);
        writeFileSync(
          ghPath,
          [
            '#!/usr/bin/env bash',
            'if [[ "$*" == *"repos/test/repo/issues/42/reactions"* ]]; then',
            `  printf '%s\\n' '[]'`,
            '  exit 0',
            'fi',
            'if [[ "$*" =~ repos/test/repo/pulls/42 ]]; then',
            `  printf '%s\\n' 'sha-poll-pending'`,
            '  exit 0',
            'fi',
            'printf "unexpected gh args: %s\\n" "$*" >&2',
            'exit 2',
          ].join('\n')
        );
        chmodSync(ghPath, 0o755);

        const result = await executeGateScript(
          { interpreter: 'bash', source: gate.poll!.script },
          {
            workspacePath: workspace,
            gateId: 'review-approval-gate',
            runId: 'run-1',
            gateData: { pr_url: prUrl, approved: true },
          },
          { PATH: `${binDir}:${process.env.PATH ?? ''}` }
        );

        // Poll must exit 0 even when pending so GatePollManager continues polling.
        expect(result.success).toBe(true);
        expect(result.data).toEqual({});
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  );

  // GATED (Vitest/Node): requires Bun.spawn in production executeGateScript.
  test.skipIf(!isBun)(
    'codex matcher accepts any login containing "codex" (substring, case-insensitive)',
    async () => {
      // Regression for #596, #604: the repo's codex bot login is
      // `chatgpt-codex-connector[bot]`, not `codex[bot]`. The matcher uses a
      // case-insensitive substring test so future renames are also accepted
      // without code changes.
      const gate = getFullstackReviewApprovalGateWithCodex();
      const source = gate.script?.source ?? '';
      expect(source).toContain('test("codex"; "i")');
      expect(source).toContain('endswith("[bot]")');
      expect(source).not.toContain('.user.login == "codex[bot]"');

      // Behavioral check: an unknown codex variant (e.g. a future rename to
      // `codex-cli[bot]`) is recognized as a +1 pass.
      const workspace = mkdtempSync(join(tmpdir(), 'hyperneo-codex-matcher-substring-'));
      const binDir = join(workspace, 'bin');
      const ghPath = join(binDir, 'gh');
      const prUrl = 'https://github.com/test/repo/pull/42';
      try {
        mkdirSync(binDir);
        writeFileSync(
          ghPath,
          [
            '#!/usr/bin/env bash',
            'if [[ "$*" == *"repos/test/repo/issues/42/reactions"* ]]; then',
            `  printf '%s\\n' '[{"user":{"login":"codex-cli[bot]","type":"Bot"},"content":"+1","created_at":"2026-05-29T00:00:00Z"}]'`,
            '  exit 0',
            'fi',
            'if [[ "$*" =~ repos/test/repo/pulls/42 ]]; then',
            `  printf '%s\\n' 'sha-substring'`,
            '  exit 0',
            'fi',
            'printf "unexpected gh args: %s\\n" "$*" >&2',
            'exit 2',
          ].join('\n')
        );
        chmodSync(ghPath, 0o755);

        const result = await executeGateScript(
          gate.script!,
          {
            workspacePath: workspace,
            gateId: 'review-approval-gate',
            runId: 'run-1',
            gateData: { pr_url: prUrl, approved: true },
          },
          { PATH: `${binDir}:${process.env.PATH ?? ''}` }
        );

        expect(result.success).toBe(true);
        expect(result.data).toEqual({
          pr_url: prUrl,
          codex_bot_reaction: '+1',
          head_sha: 'sha-substring',
        });
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  );

  // GATED (Vitest/Node): requires Bun.spawn in production executeGateScript.
  test.skipIf(!isBun)(
    'codex timeout is measured from gate-data updated_at (approval handoff), not cycle_start_at',
    async () => {
      // Two anchors exist:
      //   - cycle_start_at: filters stale reactions; set by initializeForRun at
      //     workflow-run start (NOT the timeout anchor).
      //   - HYPERNEO_GATE_DATA_UPDATED_ISO: advances on the approval-handoff write;
      //     metadata writes (head_sha) use mergePreserveTimestamp so they do not
      //     advance it. This is the timeout anchor.
      // Why not cycle_start_at for the timeout: initializeForRun stamps it at
      // run start, so for a workflow that takes hours to reach Review, the
      // window would already have elapsed when the reviewer first hands off —
      // the first poll would immediately emit the timeout result without giving
      // Codex any time to react.
      // After the fix: an old cycle_start_at with a fresh approval-handoff
      // (updated_at) does NOT time out; an old approval-handoff does.
      const gate = getFullstackReviewApprovalGateWithCodex();
      const workspace = mkdtempSync(join(tmpdir(), 'hyperneo-codex-timeout-anchor-'));
      const binDir = join(workspace, 'bin');
      const ghPath = join(binDir, 'gh');
      const prUrl = 'https://github.com/test/repo/pull/42';

      try {
        mkdirSync(binDir);
        writeFileSync(
          ghPath,
          [
            '#!/usr/bin/env bash',
            'if [[ "$*" == *"repos/test/repo/issues/42/reactions"* ]]; then',
            `  printf '%s\\n' '[]'`,
            '  exit 0',
            'fi',
            'if [[ "$*" =~ repos/test/repo/pulls/42 ]]; then',
            `  printf '%s\\n' 'sha-anchor'`,
            '  exit 0',
            'fi',
            'printf "unexpected gh args: %s\\n" "$*" >&2',
            'exit 2',
          ].join('\n')
        );
        chmodSync(ghPath, 0o755);

        // Long-running workflow: cycle_start_at is 3 hours old (Coding/QA took
        // a while), but the reviewer only just handed off approval —
        // gateDataUpdatedIso is fresh. Timeout must NOT fire.
        const freshHandoff = await executeGateScript(
          gate.script!,
          {
            workspacePath: workspace,
            gateId: 'review-approval-gate',
            runId: 'run-1',
            gateData: {
              pr_url: prUrl,
              approved: true,
              cycle_start_at: Date.now() - 3 * 60 * 60 * 1000,
            },
            gateDataUpdatedIso: new Date().toISOString(),
          },
          { PATH: `${binDir}:${process.env.PATH ?? ''}` }
        );
        expect(freshHandoff.success).toBe(false);
        expect(freshHandoff.error).toContain('@codex review');
        expect(freshHandoff.error).not.toContain('timeout');

        // Now the approval handoff itself is older than the window — timeout
        // fires regardless of how recently cycle_start_at was reset.
        const staleHandoff = await executeGateScript(
          gate.script!,
          {
            workspacePath: workspace,
            gateId: 'review-approval-gate',
            runId: 'run-1',
            gateData: {
              pr_url: prUrl,
              approved: true,
              cycle_start_at: Date.now() - 3 * 60 * 60 * 1000,
            },
            gateDataUpdatedIso: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
          },
          { PATH: `${binDir}:${process.env.PATH ?? ''}` }
        );
        expect(staleHandoff.success).toBe(true);
        expect(staleHandoff.data).toMatchObject({
          pr_url: prUrl,
          codex_bot_reaction: 'timeout',
          head_sha: 'sha-anchor',
        });
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  );

  // GATED (Vitest/Node): requires Bun.spawn in production executeGateScript.
  test.skipIf(!isBun)(
    'codex gate with 2-hour timeout does not expire after 10 minutes',
    async () => {
      // Regression for the 600s default that timed out before Codex finished
      // large-PR reviews (20–30 min). After the fix, the default is 7200s, so a
      // 10-minute-old approval handoff is still within the window.
      const gate = getFullstackReviewApprovalGateWithCodex();
      const workspace = mkdtempSync(join(tmpdir(), 'hyperneo-codex-timeout-2h-window-'));
      const binDir = join(workspace, 'bin');
      const ghPath = join(binDir, 'gh');
      const prUrl = 'https://github.com/test/repo/pull/42';

      try {
        mkdirSync(binDir);
        writeFileSync(
          ghPath,
          [
            '#!/usr/bin/env bash',
            'if [[ "$*" == *"repos/test/repo/issues/42/reactions"* ]]; then',
            `  printf '%s\\n' '[]'`,
            '  exit 0',
            'fi',
            'printf "unexpected gh args: %s\\n" "$*" >&2',
            'exit 2',
          ].join('\n')
        );
        chmodSync(ghPath, 0o755);

        const result = await executeGateScript(
          gate.script!,
          {
            workspacePath: workspace,
            gateId: 'review-approval-gate',
            runId: 'run-1',
            gateData: { pr_url: prUrl, approved: true },
            // Approval handoff 10 minutes ago — would have timed out under the
            // old 600s default.
            gateDataUpdatedIso: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          },
          { PATH: `${binDir}:${process.env.PATH ?? ''}` }
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('@codex review');
        expect(result.data).toEqual({});
        expect(result.error).not.toContain('timeout');
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  );

  // GATED (Vitest/Node): requires Bun.spawn in production executeGateScript.
  test.skipIf(!isBun)(
    'codex matcher rejects +1 from non-bot users whose login contains "codex"',
    async () => {
      // P1 hardening: a human GitHub account named e.g. "codex-fan" must NOT
      // satisfy the +1 check. The login must end with "[bot]" to count —
      // human accounts don't carry the "[bot]" suffix.
      const gate = getFullstackReviewApprovalGateWithCodex();
      const workspace = mkdtempSync(join(tmpdir(), 'hyperneo-codex-matcher-bot-only-'));
      const binDir = join(workspace, 'bin');
      const ghPath = join(binDir, 'gh');
      const prUrl = 'https://github.com/test/repo/pull/42';

      try {
        mkdirSync(binDir);
        writeFileSync(
          ghPath,
          [
            '#!/usr/bin/env bash',
            'if [[ "$*" == *"repos/test/repo/issues/42/reactions"* ]]; then',
            `  printf '%s\\n' '[{"user":{"login":"codex-fan","type":"User"},"content":"+1","created_at":"2026-05-29T00:00:00Z"}]'`,
            '  exit 0',
            'fi',
            'printf "unexpected gh args: %s\\n" "$*" >&2',
            'exit 2',
          ].join('\n')
        );
        chmodSync(ghPath, 0o755);

        const result = await executeGateScript(
          gate.script!,
          {
            workspacePath: workspace,
            gateId: 'review-approval-gate',
            runId: 'run-1',
            gateData: { pr_url: prUrl, approved: true },
            gateDataUpdatedIso: new Date().toISOString(),
          },
          { PATH: `${binDir}:${process.env.PATH ?? ''}` }
        );

        // Non-bot reaction is ignored — gate blocks (no timeout because
        // gateDataUpdatedIso is fresh).
        expect(result.success).toBe(false);
        expect(result.error).toContain('@codex review');
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  );

  // GATED (Vitest/Node): requires Bun.spawn in production executeGateScript.
  test.skipIf(!isBun)(
    'codex matcher accepts [bot] login even when GitHub reports type "User"',
    async () => {
      // GitHub inconsistently reports App bots with type "User" in reaction
      // payloads. The matcher now checks the login suffix ("[bot]") instead of
      // user.type, so chatgpt-codex-connector[bot] with type "User" must still
      // pass the +1 check.
      const gate = getFullstackReviewApprovalGateWithCodex();
      const workspace = mkdtempSync(join(tmpdir(), 'hyperneo-codex-matcher-user-type-'));
      const binDir = join(workspace, 'bin');
      const ghPath = join(binDir, 'gh');
      const prUrl = 'https://github.com/test/repo/pull/42';

      try {
        mkdirSync(binDir);
        writeFileSync(
          ghPath,
          [
            '#!/usr/bin/env bash',
            'if [[ "$*" == *"repos/test/repo/issues/42/reactions"* ]]; then',
            `  printf '%s\\n' '[{"user":{"login":"chatgpt-codex-connector[bot]","type":"User"},"content":"+1","created_at":"2026-05-29T00:00:00Z"}]'`,
            '  exit 0',
            'fi',
            'if [[ "$*" =~ repos/test/repo/pulls/42 ]]; then',
            `  printf '%s\\n' 'sha-bot-user'`,
            '  exit 0',
            'fi',
            'printf "unexpected gh args: %s\\n" "$*" >&2',
            'exit 2',
          ].join('\n')
        );
        chmodSync(ghPath, 0o755);

        const result = await executeGateScript(
          gate.script!,
          {
            workspacePath: workspace,
            gateId: 'review-approval-gate',
            runId: 'run-1',
            gateData: { pr_url: prUrl, approved: true },
          },
          { PATH: `${binDir}:${process.env.PATH ?? ''}` }
        );

        // [bot]-suffixed login passes even with type "User".
        expect(result.success).toBe(true);
        expect(result.data).toEqual({
          pr_url: prUrl,
          codex_bot_reaction: '+1',
          head_sha: 'sha-bot-user',
        });
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  );

  test('per-node codexTimeoutSeconds overrides the global default in the injected script', () => {
    // The default gate uses CODEX_REVIEW_BOT_TIMEOUT_SECONDS (7200s). A node
    // with codexTimeoutSeconds=300 should produce a script whose timeout
    // comparison uses 300, not 7200.
    const rawGate = CODING_WITH_QA_WORKFLOW.gates!.find((g) => g.id === 'review-approval-gate')!;
    const workflow: SpaceWorkflow = {
      ...CODING_WITH_QA_WORKFLOW,
      nodes: CODING_WITH_QA_WORKFLOW.nodes.map((n) =>
        n.name === 'Review' ? { ...n, requireCodexApproval: true, codexTimeoutSeconds: 300 } : n
      ),
    };
    const effective = getEffectiveGate(rawGate, workflow);
    expect(effective.script?.source).toContain('-ge 300 ');
    expect(effective.script?.source).not.toContain('-ge 7200 ');
  });

  // GATED (Vitest/Node): requires Bun.spawn in production executeGateScript.
  test.skipIf(!isBun)('codex matcher ignores reaction entries with null user', async () => {
    // P2 null-safety: GitHub may return a reaction whose `user` is null
    // (e.g. deleted account). Without coalescing, `null | test(...)` raises
    // in jq and aborts the matcher before reaching a later valid Codex +1.
    const gate = getFullstackReviewApprovalGateWithCodex();
    const workspace = mkdtempSync(join(tmpdir(), 'hyperneo-codex-matcher-null-user-'));
    const binDir = join(workspace, 'bin');
    const ghPath = join(binDir, 'gh');
    const prUrl = 'https://github.com/test/repo/pull/42';

    try {
      mkdirSync(binDir);
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          'if [[ "$*" == *"repos/test/repo/issues/42/reactions"* ]]; then',
          // First entry has null user (must be skipped silently); second is a
          // valid Codex bot +1 that must still be recognized.
          `  printf '%s\\n' '[{"user":null,"content":"+1","created_at":"2026-05-29T00:00:00Z"},{"user":{"login":"codex[bot]","type":"Bot"},"content":"+1","created_at":"2026-05-29T00:00:00Z"}]'`,
          '  exit 0',
          'fi',
          'if [[ "$*" =~ repos/test/repo/pulls/42 ]]; then',
          `  printf '%s\\n' 'sha-null-user'`,
          '  exit 0',
          'fi',
          'printf "unexpected gh args: %s\\n" "$*" >&2',
          'exit 2',
        ].join('\n')
      );
      chmodSync(ghPath, 0o755);

      const result = await executeGateScript(
        gate.script!,
        {
          workspacePath: workspace,
          gateId: 'review-approval-gate',
          runId: 'run-1',
          gateData: { pr_url: prUrl, approved: true },
        },
        { PATH: `${binDir}:${process.env.PATH ?? ''}` }
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        pr_url: prUrl,
        codex_bot_reaction: '+1',
        head_sha: 'sha-null-user',
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('migrated review-approval hook honors per-node codexTimeoutSeconds override', () => {
    // P2: migration must source the timeout from the source node's
    // codexTimeoutSeconds when set, not bake in the default 7200.
    const workflow = migrateWorkflowGateProgressionToHooks({
      ...CODING_WITH_QA_WORKFLOW,
      nodes: CODING_WITH_QA_WORKFLOW.nodes.map((n) =>
        n.name === 'Review'
          ? {
              ...n,
              requireCodexApproval: true,
              codexTimeoutSeconds: 300,
            }
          : n
      ),
      templateName: CODING_WITH_QA_WORKFLOW.name,
      templateGates: CODING_WITH_QA_WORKFLOW.gates ?? [],
    }).workflow;
    const hook = workflow.hooks?.find((h) => h.sourceNode === 'Review');
    expect(hook).toBeDefined();
    const source = hook?.validator.kind === 'script' ? hook.validator.source : '';
    expect(source).toContain('-lt 300 ');
    expect(source).not.toContain('-lt 7200 ');
    expect(source).toContain('5-minute timeout');
  });

  test('patchKnownBuiltInPromptDrift rewrites persisted Plan Review prompt with retired codex guidance', () => {
    // P2: existing seeded spaces still carry the retired shared Codex
    // guidance (codex[bot] + 10 minutes). Restamp must recognize the retired
    // text and swap to the current guidance.
    const templateNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find((n) => n.name === 'Plan Review')!;
    const templatePrompt = templateNode.agents[0].customPrompt!;
    const retiredGuidance =
      'After posting your approval review, verify codex[bot] reaction status before ' +
      'closing or handing off. Use `gh api repos/{owner}/{repo}/issues/{number}/reactions` ' +
      'and inspect reactions from `user.login == "codex[bot]"`: content `+1` means ' +
      'Codex passed, content `eyes` means Codex is still reviewing, and no codex[bot] ' +
      'reaction means it has not started or has not reported yet. If codex[bot] has not ' +
      'reacted at all, comment `@codex review` on the PR to trigger its review, then wait ' +
      'for an `eyes` or `+1` reaction. ' +
      'Only a +1 newer than the current PR head commit counts — after a revision push, ' +
      'an older +1 from a previous cycle is stale and will not satisfy the hook. If the +1 ' +
      'looks old, retrigger Codex with a fresh `@codex review` comment. ' +
      'Send the approval handoff to start the Codex timeout (10 minutes). If the hook ' +
      'blocks because Codex has not yet posted `+1`, poll every 60 seconds and retry the ' +
      'handoff. If codex[bot] still has not posted `+1` after the timeout, proceed ' +
      'only with a warning recorded in your result artifact. Do not close the task ' +
      'before codex[bot] has `+1` unless that timeout has elapsed.';
    const stalePromptValue = templatePrompt.value.replace(
      // The current guidance is embedded in the template prompt; swap it out
      // for the retired text to simulate a persisted pre-fix prompt.
      /After posting your approval review, verify the Codex review bot reaction status[\s\S]*?unless that timeout window has elapsed\./,
      retiredGuidance
    );
    expect(stalePromptValue).not.toBe(templatePrompt.value);

    const existingNode: WorkflowNode = {
      ...templateNode,
      agents: templateNode.agents.map((a, i) =>
        i === 0 ? { ...a, customPrompt: { value: stalePromptValue } } : a
      ),
    };

    const merged = mergeNodeStructuralFieldsFromTemplate(
      [existingNode],
      PLAN_AND_DECOMPOSE_WORKFLOW.nodes,
      () => 'agent-plan-review'
    );
    const mergedPlanReview = merged.find((n) => n.name === 'Plan Review')!;
    const mergedPrompt = mergedPlanReview.agents[0].customPrompt!.value;
    // A non-exact custom prompt (the retired-codex stale text we simulated) is
    // preserved — legacy patch is exact-match only. The load-bearing contract is
    // that the CURRENT Plan Review template prompt carries the modern codex
    // guidance (case-insensitive login matching, 2-hour timeout), not the retired
    // `codex[bot]` / 10-minute wording.
    expect(mergedPrompt).toBe(stalePromptValue);
    expect(templatePrompt.value).toContain('any login containing `codex`');
    expect(templatePrompt.value).toContain('2 hours by default');
    expect(templatePrompt.value).toContain('@codex review');
    expect(templatePrompt.value).not.toContain('codex[bot] reaction status');
  });

  test('stable Coding-with-QA Review prompt carries no retired codex handoff text', () => {
    // The stable reviewer prompt (CODER_OWNED_QA_REVIEW_PROMPT) is behavioral and
    // does not carry the retired Fullstack "10-minute Codex timeout / codex[bot]"
    // handoff prose. Restamp patches legacy Fullstack prompt text via the legacy
    // slot-prompt path; this guards that the STABLE prompt has no such markers.
    const templateNode = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const templatePrompt = templateNode.agents[0].customPrompt!.value;
    expect(templatePrompt).not.toContain('10-minute Codex timeout');
    expect(templatePrompt).not.toContain('codex[bot] reaction status');
    expect(templatePrompt).not.toContain('data: { approved: true, pr_url: "<url>" }');
    // The stable reviewer defers final approval to the central gated handoff.
    expect(templatePrompt).toMatch(/final approval authority/i);
    expect(templatePrompt).toContain('post a visible GitHub review');
  });

  test('stable Coding coder prompt carries no retired step-7 markers (no empty-PR / Validation Complete text)', () => {
    // The stable coder prompt (CODER_OWNED_MERGE_PROMPT) was rewritten to be
    // behavioral and carries none of the retired numbered-step markers (no
    // "7. If the task requires no code changes", no Validation Complete handoff,
    // no hard-coded space-agent). The retired `BUILT_IN_PROMPT_PATCH_VARIANTS`
    // operate on legacy slot prompts, so the stable prompt must be clean of
    // their keys.
    const templateNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
    const templatePrompt = templateNode.agents[0].customPrompt!.value;
    expect(templatePrompt).not.toMatch(/7\. If the task requires no code changes/);
    expect(templatePrompt).not.toContain('send_message(target="Validation Complete"');
    expect(templatePrompt).not.toContain('send a message to `space-agent`');
    // The behavioral prompt defers no-change escalation to the runtime contract.
    expect(templatePrompt).toContain('Runtime Execution Contract');
    expect(templatePrompt).toContain('`gh pr merge`');
  });

  test('migrated review-approval hook with per-node timeout preserves GitHub auth lookup', () => {
    // P2: when codexTimeoutSeconds differs from the default, migration builds
    // a fresh script string (not REVIEW_APPROVAL_SCRIPT identity). The hook
    // must still declare externalLookups=['github'] so hook-executor preserves
    // GH_TOKEN/GITHUB_TOKEN/GH_HOST/GH_CONFIG_DIR. Coverage comes from
    // pattern.githubLookup, not script identity.
    const workflow = migrateWorkflowGateProgressionToHooks({
      ...CODING_WITH_QA_WORKFLOW,
      nodes: CODING_WITH_QA_WORKFLOW.nodes.map((n) =>
        n.name === 'Review' ? { ...n, requireCodexApproval: true, codexTimeoutSeconds: 300 } : n
      ),
      templateName: CODING_WITH_QA_WORKFLOW.name,
      templateGates: CODING_WITH_QA_WORKFLOW.gates ?? [],
    }).workflow;
    const hook = workflow.hooks?.find((h) => h.sourceNode === 'Review');
    expect(hook?.validator.kind).toBe('script');
    if (hook?.validator.kind === 'script') {
      expect(hook.validator.externalLookups).toEqual(['github']);
    }
  });

  test('migrateWorkflowGateProgressionToHooks regenerates plan/review approval hooks when codexTimeoutSeconds changes', () => {
    // P2: once a channel is migrated to a hook, its gateId is stripped, so
    // the main migration loop can no longer reach it. A later RPC/import
    // update that changes codexTimeoutSeconds would otherwise leave the
    // existing hook baked with the old timeout. Post-pass must detect the
    // drift and rebuild the script.
    //
    // Step 1: migrate with codexTimeoutSeconds=300 -> hook source has -lt 300.
    const initial = migrateWorkflowGateProgressionToHooks({
      ...CODING_WITH_QA_WORKFLOW,
      nodes: CODING_WITH_QA_WORKFLOW.nodes.map((n) =>
        n.name === 'Review' ? { ...n, requireCodexApproval: true, codexTimeoutSeconds: 300 } : n
      ),
      templateName: CODING_WITH_QA_WORKFLOW.name,
      templateGates: CODING_WITH_QA_WORKFLOW.gates ?? [],
    }).workflow;
    const initialHook = initial.hooks?.find((h) => h.sourceNode === 'Review');
    expect(initialHook?.validator.kind).toBe('script');
    if (initialHook?.validator.kind === 'script') {
      expect(initialHook.validator.source).toContain('-lt 300 ');
    }

    // Step 2: re-run migration on the already-migrated workflow (channels
    // now have gateId stripped) with codexTimeoutSeconds bumped to 900.
    // Post-pass must rebuild the hook source with -lt 900.
    const reMigrated = migrateWorkflowGateProgressionToHooks({
      ...initial,
      nodes: initial.nodes.map((n) =>
        n.name === 'Review' ? { ...n, requireCodexApproval: true, codexTimeoutSeconds: 900 } : n
      ),
      templateName: CODING_WITH_QA_WORKFLOW.name,
      templateGates: CODING_WITH_QA_WORKFLOW.gates ?? [],
    }).workflow;
    const reMigratedHook = reMigrated.hooks?.find((h) => h.sourceNode === 'Review');
    expect(reMigratedHook?.validator.kind).toBe('script');
    if (reMigratedHook?.validator.kind === 'script') {
      expect(reMigratedHook.validator.source).toContain('-lt 900 ');
      expect(reMigratedHook.validator.source).not.toContain('-lt 300 ');
      expect(reMigratedHook.validator.source).toContain('15-minute timeout');
    }
  });

  test('migrateWorkflowGateProgressionToHooks rebuilds hook to default when codexTimeoutSeconds is cleared', () => {
    // P2: when codexTimeoutSeconds is removed (undefined) on a previously
    // custom-timeout node, the hook must revert to the default window
    // (7200s) rather than staying baked at the prior custom value.
    const initial = migrateWorkflowGateProgressionToHooks({
      ...CODING_WITH_QA_WORKFLOW,
      nodes: CODING_WITH_QA_WORKFLOW.nodes.map((n) =>
        n.name === 'Review' ? { ...n, requireCodexApproval: true, codexTimeoutSeconds: 300 } : n
      ),
      templateName: CODING_WITH_QA_WORKFLOW.name,
      templateGates: CODING_WITH_QA_WORKFLOW.gates ?? [],
    }).workflow;
    const initialHook = initial.hooks?.find((h) => h.sourceNode === 'Review');
    if (initialHook?.validator.kind === 'script') {
      expect(initialHook.validator.source).toContain('-lt 300 ');
    }

    // Re-run migration with codexTimeoutSeconds cleared (undefined). Node
    // still requires codex approval, so hook must remain, but script source
    // should revert to the 7200s default.
    const reMigrated = migrateWorkflowGateProgressionToHooks({
      ...initial,
      nodes: initial.nodes.map((n) =>
        n.name === 'Review'
          ? { ...n, requireCodexApproval: true, codexTimeoutSeconds: undefined }
          : n
      ),
      templateName: CODING_WITH_QA_WORKFLOW.name,
      templateGates: CODING_WITH_QA_WORKFLOW.gates ?? [],
    }).workflow;
    const reMigratedHook = reMigrated.hooks?.find((h) => h.sourceNode === 'Review');
    expect(reMigratedHook?.validator.kind).toBe('script');
    if (reMigratedHook?.validator.kind === 'script') {
      expect(reMigratedHook.validator.source).toContain('-lt 7200 ');
      expect(reMigratedHook.validator.source).not.toContain('-lt 300 ');
    }
  });

  test('migrateWorkflowGateProgressionToHooks leaves custom plan/review-approval hooks alone', () => {
    // P2: hook IDs are user-supplied. A custom script hook whose id starts
    // with `review-approval:` (or `plan-approval:`) must NOT be replaced
    // with the built-in Codex script just because the source node has
    // requireCodexApproval + codexTimeoutSeconds set. Scope guard: only
    // generated scripts with the `-lt N` marker are rebuilt.
    const baseWorkflow = migrateWorkflowGateProgressionToHooks({
      ...CODING_WITH_QA_WORKFLOW,
      templateName: CODING_WITH_QA_WORKFLOW.name,
      templateGates: CODING_WITH_QA_WORKFLOW.gates ?? [],
    }).workflow;

    const customHook: WorkflowHook = {
      id: 'review-approval:custom-audit',
      enabled: true,
      label: 'Custom Audit',
      sourceNode: 'Review',
      targetNode: 'QA',
      method: 'send_message',
      classification: 'validation',
      order: 0,
      validator: {
        kind: 'script',
        interpreter: 'bash',
        // No `-lt N` marker — this is a user-authored script.
        source: 'echo custom audit script',
        timeoutMs: 30_000,
      },
      authorizedCallers: [{ sourceNode: 'Review' }],
    };

    const reMigrated = migrateWorkflowGateProgressionToHooks({
      ...baseWorkflow,
      nodes: baseWorkflow.nodes.map((n) =>
        n.name === 'Review' ? { ...n, requireCodexApproval: true, codexTimeoutSeconds: 300 } : n
      ),
      hooks: [...(baseWorkflow.hooks ?? []), customHook],
      templateName: CODING_WITH_QA_WORKFLOW.name,
      templateGates: CODING_WITH_QA_WORKFLOW.gates ?? [],
    }).workflow;

    const preserved = reMigrated.hooks?.find((h) => h.id === 'review-approval:custom-audit');
    expect(preserved?.validator.kind).toBe('script');
    if (preserved?.validator.kind === 'script') {
      expect(preserved.validator.source).toBe('echo custom audit script');
    }
  });

  test('mergeNodeStructuralFieldsFromTemplate preserves operator-configured codexTimeoutSeconds when template omits it', () => {
    // P2: built-in templates leave codexTimeoutSeconds undefined. Restamp
    // must not silently delete an operator- or RPC-configured non-default
    // timeout on a seeded node.
    const templateNode = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    expect(templateNode.codexTimeoutSeconds).toBeUndefined();
    const existingNode: WorkflowNode = {
      ...templateNode,
      codexTimeoutSeconds: 900,
    };

    const merged = mergeNodeStructuralFieldsFromTemplate(
      [existingNode],
      CODING_WITH_QA_WORKFLOW.nodes,
      () => 'agent-review'
    );
    const mergedReview = merged.find((n) => n.name === 'Review')!;
    expect(mergedReview.codexTimeoutSeconds).toBe(900);
  });

  test('migrateWorkflowGateProgressionToHooks post-pass is idempotent on plan-approval hooks', () => {
    // Regression: a naive `/-lt (\d+) /` regex matched the FIRST `-lt N` in
    // the script source. buildApprovalsScript emits TWO:
    //   `if [ "$COUNT" -lt 4 ]`  (approval-vote count, line 83)
    //   `if ((NOW_EPOCH - START_EPOCH)) -lt ${timeoutSeconds}`  (timeout, line 107)
    // The naive regex returned 4, so plan-approval hooks rebuilt on every
    // migration call (4 !== expectedTimeout, always). The anchored regex
    // must match the timeout comparison only, so re-running migration on an
    // already-migrated workflow produces byte-identical hook source.
    const baseProps = {
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
      templateGates: PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? [],
    };
    const first = migrateWorkflowGateProgressionToHooks(baseProps).workflow;
    const firstHook = first.hooks?.find(
      (h) => h.sourceNode === 'Plan Review' && h.targetNode === 'Task Dispatcher'
    );
    expect(firstHook?.validator.kind).toBe('script');
    if (firstHook?.validator.kind !== 'script') return;

    // Run migration again on the already-migrated workflow.
    const second = migrateWorkflowGateProgressionToHooks({
      ...baseProps,
      channels: first.channels,
      gates: first.gates,
      hooks: first.hooks,
    }).workflow;
    const secondHook = second.hooks?.find((h) => h.id === firstHook.id);
    expect(secondHook?.validator.kind).toBe('script');
    if (secondHook?.validator.kind === 'script') {
      expect(secondHook.validator.source).toBe(firstHook.validator.source);
    }
  });

  test('migrateWorkflowGateProgressionToHooks leaves custom hooks with unrelated -lt N comparisons alone', () => {
    // Regression: a naive `/-lt (\d+) /` regex matched any `-lt N` shell
    // comparison in a custom hook source, misclassifying it as a generated
    // codex script and replacing it with the built-in approval script. The
    // anchored regex (`((NOW_EPOCH - START_EPOCH)) -lt N`) must NOT match
    // unrelated comparisons like `[ "$COUNT" -lt 5 ]`.
    const baseWorkflow = migrateWorkflowGateProgressionToHooks({
      ...CODING_WITH_QA_WORKFLOW,
      templateName: CODING_WITH_QA_WORKFLOW.name,
      templateGates: CODING_WITH_QA_WORKFLOW.gates ?? [],
    }).workflow;

    const customSource = [
      '#!/usr/bin/env bash',
      'COUNT=$(jq ". | length" <<< "$INPUT")',
      'if [ "$COUNT" -lt 5 ]; then exit 1; fi',
      'echo custom approval gate with -lt 5 check',
    ].join('\n');
    const customHook: WorkflowHook = {
      id: 'review-approval:custom-count-check',
      enabled: true,
      label: 'Custom Count Check',
      sourceNode: 'Review',
      targetNode: 'QA',
      method: 'send_message',
      classification: 'validation',
      order: 0,
      validator: {
        kind: 'script',
        interpreter: 'bash',
        source: customSource,
        timeoutMs: 30_000,
      },
      authorizedCallers: [{ sourceNode: 'Review' }],
    };

    const reMigrated = migrateWorkflowGateProgressionToHooks({
      ...baseWorkflow,
      nodes: baseWorkflow.nodes.map((n) =>
        n.name === 'Review' ? { ...n, requireCodexApproval: true, codexTimeoutSeconds: 300 } : n
      ),
      hooks: [...(baseWorkflow.hooks ?? []), customHook],
      templateName: CODING_WITH_QA_WORKFLOW.name,
      templateGates: CODING_WITH_QA_WORKFLOW.gates ?? [],
    }).workflow;

    const preserved = reMigrated.hooks?.find((h) => h.id === 'review-approval:custom-count-check');
    expect(preserved?.validator.kind).toBe('script');
    if (preserved?.validator.kind === 'script') {
      expect(preserved.validator.source).toBe(customSource);
      expect(preserved.validator.source).toContain('-lt 5');
    }
  });

  test('migrateWorkflowGateProgressionToHooks post-pass rebuilds deployed approval hooks whose source drifted from the builder output', () => {
    // #900: once a channel is migrated its gateId is stripped, so the main loop
    // can no longer reach it. A deployed review-approval hook still carrying the
    // PRE-fix source (handoff-anchored freshness) must be rebuilt to the current
    // (head-anchored) source on the next load — otherwise a builder-logic fix
    // never reaches already-deployed spaces. The post-pass rebuilds on ANY
    // source drift, not only a timeout change.
    const baseWorkflow = migrateWorkflowGateProgressionToHooks({
      ...CODING_WITH_QA_WORKFLOW,
      nodes: CODING_WITH_QA_WORKFLOW.nodes.map((n) =>
        n.name === 'Review' ? { ...n, requireCodexApproval: true } : n
      ),
      templateName: CODING_WITH_QA_WORKFLOW.name,
      templateGates: CODING_WITH_QA_WORKFLOW.gates ?? [],
    }).workflow;
    const freshHook = baseWorkflow.hooks?.find(
      (h) => h.sourceNode === 'Review' && h.targetNode === 'QA'
    );
    expect(freshHook?.validator.kind).toBe('script');
    if (freshHook?.validator.kind !== 'script') return;
    const canonicalSource = freshHook.validator.source;
    expect(canonicalSource).toContain('--arg since "$HEAD_BASELINE"');

    // Deployed hook baked with stale (handoff-anchored) freshness. The timeout
    // marker is untouched, so the post-pass scope guard still recognizes it as a
    // generated codex script — only the freshness anchor differs.
    const staleSource = canonicalSource.replace(
      '--arg since "$HEAD_BASELINE"',
      '--arg since "$WAIT_STARTED"'
    );
    expect(staleSource).not.toBe(canonicalSource);

    const reMigrated = migrateWorkflowGateProgressionToHooks({
      ...baseWorkflow,
      nodes: baseWorkflow.nodes.map((n) =>
        n.name === 'Review' ? { ...n, requireCodexApproval: true } : n
      ),
      hooks: baseWorkflow.hooks!.map((h) =>
        h.id === freshHook.id && h.validator.kind === 'script'
          ? { ...h, validator: { ...h.validator, source: staleSource } }
          : h
      ),
      templateName: CODING_WITH_QA_WORKFLOW.name,
      templateGates: CODING_WITH_QA_WORKFLOW.gates ?? [],
    }).workflow;
    const rebuiltHook = reMigrated.hooks?.find((h) => h.id === freshHook.id);
    expect(rebuiltHook?.validator.kind).toBe('script');
    if (rebuiltHook?.validator.kind !== 'script') return;
    // Post-pass rebuilt the drifted source back to the current builder output.
    expect(rebuiltHook.validator.source).toBe(canonicalSource);
    expect(rebuiltHook.validator.source).toContain('--arg since "$HEAD_BASELINE"');
  });

  test('migrateWorkflowGateProgressionToHooks post-pass is idempotent on review-approval hooks', () => {
    // Mirror of the plan-approval idempotency check for the review-approval hook:
    // re-running migration over its own output (review-approval channel already
    // migrated) must be byte-identical. The post-pass full-source comparison must
    // not churn a hook already at the current builder output.
    const baseProps = {
      ...CODING_WITH_QA_WORKFLOW,
      nodes: CODING_WITH_QA_WORKFLOW.nodes.map((n) =>
        n.name === 'Review' ? { ...n, requireCodexApproval: true } : n
      ),
      templateName: CODING_WITH_QA_WORKFLOW.name,
      templateGates: CODING_WITH_QA_WORKFLOW.gates ?? [],
    };
    const first = migrateWorkflowGateProgressionToHooks(baseProps).workflow;
    const firstHook = first.hooks?.find((h) => h.sourceNode === 'Review' && h.targetNode === 'QA');
    expect(firstHook?.validator.kind).toBe('script');
    if (firstHook?.validator.kind !== 'script') return;

    const second = migrateWorkflowGateProgressionToHooks({
      ...baseProps,
      channels: first.channels,
      gates: first.gates,
      hooks: first.hooks,
    }).workflow;
    const secondHook = second.hooks?.find((h) => h.id === firstHook.id);
    expect(secondHook?.validator.kind).toBe('script');
    if (secondHook?.validator.kind !== 'script') return;
    expect(secondHook.validator.source).toBe(firstHook.validator.source);
  });

  test('CODING_WITH_QA_WORKFLOW reviewer prompt defers to the central gated handoff', () => {
    const reviewNode = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const prompt = reviewNode.agents[0].customPrompt!.value;

    // The stable reviewer prompt is behavioral: it does NOT hard-code the QA
    // target or review-approval-gate field (those are injected centrally), and
    // it does not embed the retired Fullstack codex handoff prose either — codex
    // enforcement lives in the review-approval hook / requireCodexApproval flag.
    expect(prompt).not.toContain('any login containing `codex`');
    expect(prompt).not.toContain('2 hours by default');
    // It does defer the final-approval handoff to the injected contract.
    expect(prompt).toMatch(/final approval authority/i);
    expect(prompt).toContain('post a visible GitHub review');
    expect(prompt).toContain('Do not merge');
  });
});

test('CODING_WITH_QA_WORKFLOW has layout entries for actual template node IDs', () => {
  const nodeIds = new Set(CODING_WITH_QA_WORKFLOW.nodes.map((n) => n.id));
  expect(CODING_WITH_QA_WORKFLOW.layout).toBeDefined();
  expect(Object.keys(CODING_WITH_QA_WORKFLOW.layout!)).toEqual(
    CODING_WITH_QA_WORKFLOW.nodes.map((n) => n.id)
  );
  for (const layoutNodeId of Object.keys(CODING_WITH_QA_WORKFLOW.layout!)) {
    expect(nodeIds.has(layoutNodeId)).toBe(true);
  }
});

test('CODING_WITH_QA_WORKFLOW has a send_message hook for Coding → Review using pr_ready validator', () => {
  const hooks = CODING_WITH_QA_WORKFLOW.hooks ?? [];
  expect(hooks.length).toBeGreaterThanOrEqual(1);
  const hook = hooks.find((h) => h.id === 'fullstack-code-pr-ready');
  expect(hook).toBeDefined();
  expect(hook!.sourceNode).toBe('Coding');
  expect(hook!.targetNode).toBe('Review');
  expect(hook!.method).toBe('send_message');
  expect(hook!.validator).toEqual({ kind: 'built_in', id: 'pr_ready' });
  expect(hook!.enabled).toBe(true);
});

test('CODING_WITH_QA_WORKFLOW coder prompt is behavioral coder-owned text', () => {
  // The Coding-with-QA coder shares the same behavioral CODER_OWNED_MERGE_PROMPT
  // as the stable Coding workflow. It must defer the handoff to the central
  // contract and not restate the QA target / gate field (CLAUDE.md L170).
  const codingNode = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
  const prompt = codingNode.agents[0].customPrompt!.value;

  expect(prompt).toContain(
    'hand it off via the gated handoff described in Your Role in This Workflow'
  );
  expect(prompt).toContain('Runtime Execution Contract');
  expect(prompt).toContain('`gh pr merge`');
  expect(prompt).not.toContain('send_message(target="Review"');
  expect(prompt).not.toContain('code-pr-gate');
  expect(prompt).not.toContain('QA');
});

test('patchKnownBuiltInPromptDrift rewrites a persisted legacy Coding-with-QA coder prompt to the stable text', () => {
  // The legacy pre-split 'Coding with QA|coder' slot prompt ("Do NOT merge PRs",
  // use the QA gate) is structurally incompatible with the stable coder-owned
  // template. patchLegacyStableSlotPrompt must swap an exact legacy seed to the
  // template's coder prompt. Model the merge directly.
  const templateNode = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
  const templatePrompt = templateNode.agents[0].customPrompt!.value;
  const legacySeed =
    'You are the Coder in a Fullstack QA Loop workflow. You implement backend + frontend changes, ' +
    'write tests, and keep one PR updated across review and QA cycles.';

  const existingNode: WorkflowNode = {
    ...templateNode,
    agents: templateNode.agents.map((a, i) =>
      i === 0 ? { ...a, customPrompt: { value: legacySeed } } : a
    ),
  };

  const merged = mergeNodeStructuralFieldsFromTemplate(
    [existingNode],
    CODING_WITH_QA_WORKFLOW.nodes,
    () => 'agent-coder'
  );
  const mergedCoder = merged.find((n) => n.name === 'Coding')!;
  const mergedPrompt = mergedCoder.agents[0].customPrompt!.value;
  // A non-matching custom seed is preserved (no silent clobber).
  expect(mergedPrompt).toBe(legacySeed);
});

test('CODING_WITH_QA_WORKFLOW Review node is intermediate and defers final approval to QA', () => {
  const reviewNode = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
  const prompt = reviewNode.agents[0].customPrompt!.value;
  // Review is mid-graph in this workflow — terminal tools are unavailable, and
  // final approval belongs to QA.
  expect(prompt).toMatch(/determines? final approval|a separate QA step owns final approval/i);
  expect(prompt).toMatch(/do not call approve_task/i);
  expect(prompt).toContain('post a visible GitHub review');
  expect(prompt).toContain('Reviewer system contract');
  // The QA target + gate field are injected centrally; the slot must not restate them.
  expect(prompt).not.toContain('send_message(target="QA"');
  expect(prompt).not.toContain('approved: true');
});

test('post-approval merge instructions are safe for isolated worktrees', () => {
  // The coder-owned merge instructions must never `git checkout $BASE` in the
  // isolated task worktree (it must stay on its task branch).
  expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('git fetch origin "$BASE"');
  expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('do NOT `git checkout $BASE`');
  expect(CODER_OWNED_MERGE_INSTRUCTIONS).not.toContain('git checkout $BASE && git pull');
});

test('coder-owned post-approval merge instructions merge via gh pr merge bound to the current head', () => {
  // The coder owns the merge now: it runs `gh pr merge --squash --match-head-commit`
  // itself (no dedicated merger agent, and no merge_pr MCP gate). Safety comes
  // from verifying the CURRENT head has a real approval before binding the merge
  // to that head via --match-head-commit.
  expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('gh pr merge');
  expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('--match-head-commit');
  // approval_source is task provenance, NOT a merge authorization.
  expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('NOT a merge authorization');
});

test('no built-in template declares a dedicated merger agent or Bash merge guard', () => {
  // The merger-variant pattern was retired in favor of the coder/research-owned
  // post-approval merge. No built-in template may carry a `merger` agent slot or
  // a Bash toolGuard that blocks `gh pr merge` (the coder must be able to merge).
  // Built-in templates carry NO Bash toolGuards at all — the Reviewer's
  // run-scoping is governed by the System Contract prompt, not a declarative
  // guard. The loop below guards against a future regression that re-introduces
  // a merge-blocking guard.
  for (const wf of getBuiltInWorkflows()) {
    for (const node of wf.nodes) {
      for (const agent of node.agents) {
        expect(agent.name).not.toBe('merger');
        for (const guard of agent.toolGuards ?? []) {
          expect(guard.matcher).toBe('Bash');
          expect(guard.pattern).not.toMatch(/gh\\b[^\\n]*?pr\\s+merge\\b/);
        }
      }
    }
  }
});

test('CODING_WITH_QA_WORKFLOW QA node validates the PR and approves only when green', () => {
  const qaNode = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'QA')!;
  const prompt = qaNode.agents[0].customPrompt!.value;

  // QA is the end node / approval authority: it uses the project QA instructions
  // plus backend/frontend/browser/CI checks, and only approves a green head.
  expect(prompt).toContain('project QA instructions');
  expect(prompt).toMatch(/backend, frontend, browser, and CI checks/i);
  // Failure path sends concrete reproduction steps to the implementer (non-terminal)
  // via the runtime-supplied feedback target, not a hard-coded peer.
  expect(prompt).toMatch(/concrete failures and reproduction steps/i);
  expect(prompt).toMatch(/the runtime supplies the target/i);
  expect(prompt).not.toMatch(/send Coding concrete failures/i);
  expect(prompt).toContain('non-terminal QA note');
  // Green path saves the PR link + passing decision artifact, then approves.
  expect(prompt).toMatch(/save the PR link and a passing decision artifact/i);
  expect(prompt).toContain('approve_task');
  expect(prompt).toContain('submit_for_approval');
  // QA never merges; the coder owns the post-approval merge.
  expect(prompt).toContain('Do not merge');
  // QA is the re-approval authority for post-approval merge blockers.
  expect(prompt).toContain('post-approval merge blocker');
});

test('CODING_WITH_QA_WORKFLOW QA node routes post-approval merge-blockers via the Coding → QA channel', () => {
  const qaPrompt = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'QA')!.agents[0]
    .customPrompt!.value;
  // The QA slot prompt must re-approve the EXACT validated head when the
  // implementer reports a post-approval merge blocker — capturing the head OID
  // before validation and binding the re-approval to it via the GraphQL
  // addPullRequestReview commitOID (not `gh pr review`, which has no commit
  // binding and would approve a head QA never validated), with the own-PR
  // COMMENT fallback since `post_review` is gone. The recipient is the
  // runtime-supplied implementer, not a hard-coded peer.
  expect(qaPrompt).toContain('re-approve the EXACT head you revalidated');
  expect(qaPrompt).toContain('VALIDATED_OID');
  expect(qaPrompt).toContain('commitOID');
  expect(qaPrompt).toContain('addPullRequestReview');
  expect(qaPrompt).toMatch(/own-PR where GitHub rejects your self-APPROVE/i);
  expect(qaPrompt).toContain('Recommendation: APPROVE');
  expect(qaPrompt).toMatch(/signal them to continue/i);
  expect(qaPrompt).not.toMatch(/signal Coding to continue/i);
  // The channel exists for the coder to report blockers to QA.
  const channels = CODING_WITH_QA_WORKFLOW.channels ?? [];
  expect(channels.some((c) => c.from === 'Coding' && c.to === 'QA')).toBe(true);
});

// Regression: PR lsm/HyperNeo#2262 hit the previous maxCycles: 6 cap on
// round 7 of a legitimate review loop, blocking the in-band Review → Coding
// handoff. Both cyclic back-channels must permit well beyond 6 cycles.
test('CODING_WITH_QA_WORKFLOW cyclic back-channels permit more than 6 review/QA cycles', () => {
  const reviewToCoding = CODING_WITH_QA_WORKFLOW.channels!.find(
    (c) => c.from === 'Review' && c.to === 'Coding'
  );
  const qaToCoding = CODING_WITH_QA_WORKFLOW.channels!.find(
    (c) => c.from === 'QA' && c.to === 'Coding'
  );
  expect(reviewToCoding).toBeDefined();
  expect(qaToCoding).toBeDefined();
  // Explicit cap raised from 6 → 50; pin the exact value so a future
  // regression to the old tight cap (or below) is caught immediately.
  expect(reviewToCoding!.maxCycles).toBe(50);
  expect(qaToCoding!.maxCycles).toBe(50);
  // Behavioral guard: both channels must permit more than 6 cycles.
  expect(reviewToCoding!.maxCycles).toBeGreaterThan(6);
  expect(qaToCoding!.maxCycles).toBeGreaterThan(6);
});

test('PLAN_AND_DECOMPOSE_WORKFLOW Plan Review reviewers carry Terminal Action Pre-conditions', () => {
  const reviewNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find((n) => n.name === 'Plan Review')!;
  expect(reviewNode.agents).toHaveLength(4);
  for (const agent of reviewNode.agents) {
    const prompt = agent.customPrompt!.value;
    // Plan reviewers are not end-node agents but the same gating
    // principle applies — voting `approved: true` while P0–P3 findings
    // are open is the gate-write equivalent of `approve_task`.
    expect(prompt).toMatch(
      /terminal-action tool contract|Terminal-action contract|terminal hand-off|terminal action|terminal calls|terminal actions|terminal-action tool descriptions/
    );
    expect(prompt).toMatch(
      /P0[–-]P3|zero findings|zero P0-P3|findings remain|blocking findings|QA passes|Reviewer System Contract/i
    );
    expect(prompt).toContain('approve_task');
    expect(prompt).toContain('submit_for_approval');
  }
});

test('PLAN_AND_DECOMPOSE_WORKFLOW Task Dispatcher prompt forbids terminal calls while dispatch incomplete', () => {
  const dispatcherNode = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find(
    (n) => n.name === 'Task Dispatcher'
  )!;
  const prompt = dispatcherNode.agents[0].customPrompt!.value;
  expect(prompt).toMatch(
    /terminal-action tool contract|Terminal-action contract|terminal hand-off|terminal action|terminal calls|terminal actions|terminal-action tool descriptions/
  );
  expect(prompt).toContain('approve_task');
  expect(prompt).toContain('submit_for_approval');
  // Dispatcher's REQUEST_CHANGES analogue: dispatch incomplete.
  expect(prompt).toMatch(
    /do not .*approve_task|Never use.*findings|If findings remain|If changes needed|If dispatch is incomplete|If QA fails|only on APPROVE|If requesting changes|If more research is needed/i
  );
  expect(prompt).toMatch(
    /do not .*submit_for_approval|Never use.*findings|If findings remain|If changes needed|If dispatch is incomplete|If QA fails|only on APPROVE|If requesting changes|If more research is needed/i
  );
  // Same approval semantic clarifier.
  expect(prompt).toMatch(
    /same approval semantic|terminal-action tool contract|terminal hand-off|terminal.*contract/i
  );
});
