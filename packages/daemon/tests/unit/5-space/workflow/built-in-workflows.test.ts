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
 * - seedBuiltInWorkflows(): descriptions, tags, instructions, timestamps preserved
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
import type {
  HandoffTransition,
  SpaceWorkerAgent,
  SpaceWorkflow,
  WorkflowHook,
  WorkflowNode,
} from '@hyperneo/shared';
import {
  exportWorkflow,
  validateExportedWorkflow,
} from '../../../../src/lib/space/export-format.ts';
import { CODER_OWNED_MERGE_INSTRUCTIONS } from '../../../../src/lib/space/workflows/post-approval-merge-template.ts';
import { PR_MERGE_POST_APPROVAL_INSTRUCTIONS } from './fixtures/retired-post-approval-merge-template.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import {
  CODING_WORKFLOW,
  CODING_WORKFLOW as STABLE_CODING_WORKFLOW,
  CODING_WITH_QA_WORKFLOW,
  CODER_OWNED_PR_SUBSCRIBE_GUIDANCE,
  builtInWorkflowRequiresPrMerge,
  LEGACY_CODING_TEMPLATE_IDENTITIES,
  mergeChannelsFromTemplate,
  mergeNodeStructuralFieldsFromTemplate,
  getBuiltInWorkflows,
  RESEARCH_WORKFLOW,
  REVIEW_ONLY_WORKFLOW,
  RETIRED_PR_MERGER_SLOT_PROMPT,
  RETIRED_MERGER_RAW_MERGE_GUARD,
  seedBuiltInWorkflows,
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import { computeWorkflowHash } from '../../../../src/lib/space/workflows/template-hash.ts';
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

  test('coder slots declare the primaryLink PR-event interest (task #907)', () => {
    // The implementer slot subscribes to its own run's PR events (review
    // comments, CI failures, reactions) via a topicFrom interest resolved from
    // the run's primary link — pure pub/sub, no smart routing. Only the coder
    // (implementer) carries it; the reviewer/QA slots do not.
    const expected = {
      topicFrom: {
        source: 'primaryLink',
        pattern: 'github/{owner}/{repo}/pull_request/{number}.*',
      },
      label: 'My PR events',
    };
    for (const wf of [STABLE_CODING_WORKFLOW, CODING_WITH_QA_WORKFLOW]) {
      const coder = wf.nodes
        .find((n) => n.name === 'Coding')!
        .agents.find((a) => a.name === 'coder')!;
      expect(coder.eventInterests).toEqual([expected]);
      // Non-implementer slots in the same workflow carry no static interest.
      for (const node of wf.nodes) {
        for (const agent of node.agents) {
          if (agent.name === 'coder') continue;
          expect(agent.eventInterests).toBeUndefined();
        }
      }
    }
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

  test('legacy template identities map to canonical stable templates', () => {
    // The legacy `Coding Workflow` / `Coding with QA Workflow` names (which
    // carried the dedicated merger node) now resolve to the STABLE coder-owned
    // templates. Verify the single source of truth covers both legacy names.
    expect(LEGACY_CODING_TEMPLATE_IDENTITIES.map((i) => i.legacyName)).toEqual([
      'Coding Workflow',
      'Coding with QA Workflow',
    ]);
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
    // The imperative subscribe instruction lives in the stable coder prompt as a
    // backstop while the declarative eventInterests resolver is inert
    // (see CODER_OWNED_PR_SUBSCRIBE_GUIDANCE). It uses the explicit prUrl form.
    expect(prompt).toContain('subscribe_pr_events');
    expect(prompt).toContain('prUrl');
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

  test('Review → Coding channel is ungated (plain handoff) with maxCycles', () => {
    const ch = CODING_WORKFLOW.channels!.find((c) => c.from === 'Review' && c.to === 'Coding');
    expect(ch).toBeDefined();
    // Review → Coding is now a plain ungated handoff; the review-posted gate
    // was replaced by a route-scoped `review_posted` send_message hook.
    expect(ch!.gateId).toBeUndefined();
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

  test('Review → Coding has a review_posted send_message hook', () => {
    // The former review-posted-gate is now a route-scoped `review_posted`
    // send_message hook on the Review → Coding channel.
    const hook = (CODING_WORKFLOW.hooks ?? []).find(
      (h) =>
        h.sourceNode === 'Review' &&
        h.targetNode === 'Coding' &&
        h.method === 'send_message' &&
        h.validator.kind === 'built_in' &&
        h.validator.id === 'review_posted'
    );
    expect(hook).toBeDefined();
    expect(hook!.enabled).toBe(true);
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

  test('research slot declares the primaryLink PR-event interest (task #907)', () => {
    // The research implementer subscribes to its own run's PR events via a
    // topicFrom interest resolved from the run's primary link — same pub/sub
    // contract as the coder slots. Only the research slot carries it.
    const research = RESEARCH_WORKFLOW.nodes
      .find((n) => n.name === 'Research')!
      .agents.find((a) => a.name === 'research')!;
    expect(research.eventInterests).toEqual([
      {
        topicFrom: {
          source: 'primaryLink',
          pattern: 'github/{owner}/{repo}/pull_request/{number}.*',
        },
        label: 'My PR events',
      },
    ]);
    const reviewer = RESEARCH_WORKFLOW.nodes
      .find((n) => n.name === 'Review')!
      .agents.find((a) => a.name === 'reviewer')!;
    expect(reviewer.eventInterests).toBeUndefined();
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

// ---------------------------------------------------------------------------
// getBuiltInWorkflows()
// ---------------------------------------------------------------------------

describe('getBuiltInWorkflows()', () => {
  test('returns exactly four templates', () => {
    expect(getBuiltInWorkflows()).toHaveLength(4);
  });

  test('includes CODING_WORKFLOW', () => {
    const names = getBuiltInWorkflows().map((w) => w.name);
    expect(names).toContain(CODING_WORKFLOW.name);
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

  test('getBuiltInWorkflows returns hook-native templates', () => {
    const coding = getBuiltInWorkflows().find((w) => w.name === CODING_WORKFLOW.name)!;
    expect(coding.channels?.some((channel) => channel.gateId === 'review-posted-gate')).toBe(false);
    expect(
      coding.hooks?.some(
        (hook) =>
          hook.sourceNode === 'Review' &&
          hook.targetNode === 'Coding' &&
          hook.id === 'review-posted'
      )
    ).toBe(true);
    const reviewPostedHook = coding.hooks?.find((hook) => hook.id === 'review-posted');
    // The review-posted hook references the review_posted built-in
    // validator (an external_state preset) — no hand-rolled bash script.
    expect(reviewPostedHook?.validator).toEqual({ kind: 'built_in', id: 'review_posted' });
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
    expect(workflows).toHaveLength(4);
  });

  test('seeded workflow names match all templates', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const names = manager.listWorkflows(SPACE_ID).map((w) => w.name);
    expect(names).toContain(CODING_WORKFLOW.name);
    expect(names).toContain(CODING_WITH_QA_WORKFLOW.name);
    expect(names).toContain(RESEARCH_WORKFLOW.name);
    expect(names).toContain(REVIEW_ONLY_WORKFLOW.name);
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
    // The Review → Coding feedback is validated by the route-scoped `review-posted`
    // hook (the former review-posted gate), and the channel carries the maxCycles
    // cap so the review loop stays bounded.
    expect(reviewToCode!.gateId).toBeUndefined();
    expect(reviewToCode!.maxCycles).toBe(5);
    const reviewPostedHook = (wf.hooks ?? []).find(
      (h) => h.sourceNode === 'Review' && h.targetNode === 'Coding' && h.id === 'review-posted'
    );
    expect(reviewPostedHook).toBeDefined();
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
    expect(workflows).toHaveLength(4);
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

  test('leaves postApproval undefined on Review-Only', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflows = manager.listWorkflows(SPACE_ID);
    const wf = workflows.find((w) => w.name === 'Review-Only Workflow');
    expect(wf).toBeDefined();
    expect(wf!.postApproval).toBeUndefined();
    expect(wf!.nodes.some((node) => node.postApproval)).toBe(false);
  });

  // ─── PR 3/5: drift re-stamp path ────────────────────────────────────────

  test('result exposes restamped=[] on a fresh seed', () => {
    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.skipped).toBe(false);
    expect(result.seeded).toHaveLength(4);
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

  test('re-stamp restores the imperative subscribe instruction to the stable coder prompt', () => {
    // Existing live spaces store the pre-subscribe CODER_OWNED_MERGE_PROMPT. The
    // [CODER_OWNED_PR_SUBSCRIBE_GUIDANCE, ''] retired patch must converge that
    // stored prompt to the current template (with subscribe) on the next seed.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const codingNode = coding.nodes.find((n) => n.name === 'Coding')!;

    const templatePrompt = codingNode.agents[0].customPrompt!.value;
    expect(templatePrompt).toContain('subscribe_pr_events');
    // Reconstruct the pre-subscribe retired form by dropping the guidance.
    const retiredPrompt = templatePrompt.replace(CODER_OWNED_PR_SUBSCRIBE_GUIDANCE, '');
    expect(retiredPrompt).not.toContain('subscribe_pr_events');

    // Simulate a live space that stored the retired prompt with a stale hash.
    manager.updateWorkflow(coding.id, {
      nodes: coding.nodes.map((n) =>
        n.id !== codingNode.id
          ? n
          : {
              ...n,
              agents: n.agents.map((a, i) =>
                i === 0 ? { ...a, customPrompt: { value: retiredPrompt } } : a
              ),
            }
      ),
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'stale-pre-subscribe-hash',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);

    const after = manager.getWorkflow(coding.id)!;
    const afterCodingNode = after.nodes.find((n) => n.id === codingNode.id)!;
    // Exact convergence: stored prompt is restored to the template (with subscribe).
    expect(afterCodingNode.agents[0].customPrompt?.value).toBe(templatePrompt);
    expect(afterCodingNode.agents[0].customPrompt?.value).toContain('subscribe_pr_events');
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
    // subscribe_pr_events now lives in the stable coder prompt too
    // (CODER_OWNED_PR_SUBSCRIBE_GUIDANCE), so it no longer distinguishes legacy
    // from stable — the numbered-step and gate-field markers are the real legacy
    // discriminators asserted above/below.
    expect(qaCoderPrompt).toContain('subscribe_pr_events');
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

  test('mergeNodeStructuralFieldsFromTemplate propagates template eventInterests to seeded slots (task #907)', () => {
    // Existing space seeded before the interest existed: coder slot has none.
    const existingNodes = CODING_WORKFLOW.nodes.map((node) =>
      node.name === 'Coding'
        ? { ...node, agents: node.agents.map((a) => ({ ...a, eventInterests: undefined })) }
        : node
    );
    const result = mergeNodeStructuralFieldsFromTemplate(
      existingNodes,
      CODING_WORKFLOW.nodes,
      resolveAgentId
    );
    const coder = result
      .find((node) => node.name === 'Coding')!
      .agents.find((a) => a.name === 'coder')!;
    expect(coder.eventInterests).toEqual(CODING_WORKFLOW.nodes[0].agents[0]!.eventInterests);
    // The reviewer slot is not template-managed for interests, so it stays absent.
    const outReviewer = result
      .find((node) => node.name === 'Review')!
      .agents.find((a) => a.name === 'reviewer')!;
    expect(outReviewer.eventInterests).toBeUndefined();
  });

  test('mergeNodeStructuralFieldsFromTemplate overwrites a divergent slot eventInterests from the template', () => {
    // A slot that drifted (or carries a stale interest) is reset to the
    // template's interests — structural sync, not user config.
    const drifted = [{ topic: 'github/acme/widgets/pull_request/999.*', label: 'stale' }];
    const existingNodes = CODING_WORKFLOW.nodes.map((node) =>
      node.name === 'Coding'
        ? { ...node, agents: node.agents.map((a) => ({ ...a, eventInterests: drifted })) }
        : node
    );
    const result = mergeNodeStructuralFieldsFromTemplate(
      existingNodes,
      CODING_WORKFLOW.nodes,
      resolveAgentId
    );
    const coder = result
      .find((node) => node.name === 'Coding')!
      .agents.find((a) => a.name === 'coder')!;
    expect(coder.eventInterests).toEqual(CODING_WORKFLOW.nodes[0].agents[0]!.eventInterests);
    expect(coder.eventInterests).not.toEqual(drifted);
  });

  test('mergeNodeStructuralFieldsFromTemplate preserves slot eventInterests the template leaves undefined', () => {
    // Built-in templates manage only the implementer slots; an unmanaged slot
    // that carries its own interests must NOT be cleared by restamp. Use a
    // custom node whose template counterpart omits eventInterests entirely.
    const customInterest = [{ topic: 'github/acme/widgets/pull_request/*.*', label: 'custom' }];
    const existingNodes: WorkflowNode[] = [
      {
        id: 'n1',
        name: 'Coding',
        agents: [{ agentId: 'a1', name: 'coder', eventInterests: customInterest }],
      },
    ];
    // Template has no eventInterests on this slot (undefined).
    const templateNodes = [
      {
        id: 'n1',
        name: 'Coding',
        agents: [{ agentId: 'Coder', name: 'coder' }],
      },
    ];
    const result = mergeNodeStructuralFieldsFromTemplate(
      existingNodes,
      templateNodes,
      resolveAgentId
    );
    expect(result[0]!.agents[0]!.eventInterests).toEqual(customInterest);
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

  test('re-stamp propagates the primaryLink eventInterests to existing seeded spaces (task #907)', () => {
    // Simulate a space seeded before the interest existed: seed, then strip the
    // coder slot's eventInterests and force a stale hash so restamp re-runs.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    manager.updateWorkflow(coding.id, {
      nodes: coding.nodes.map((node) =>
        node.name === 'Coding'
          ? {
              ...node,
              agents: node.agents.map((agent) => ({ ...agent, eventInterests: undefined })),
            }
          : node
      ),
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'pre-event-interest-hash',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);

    const after = manager.getWorkflow(coding.id)!;
    const coder = after.nodes
      .find((n) => n.name === 'Coding')!
      .agents.find((a) => a.name === 'coder')!;
    // The interest landed on the previously-empty coder slot via the structural merge.
    expect(coder.eventInterests).toEqual(CODING_WORKFLOW.nodes[0].agents[0]!.eventInterests);
    // The row converged to the template, so its hash is stamped up to date —
    // no perpetual re-stamp loop on every restart. Compare against the migrated
    // template (getBuiltInWorkflows applies gate→hook migration), as the raw
    // CODING_WORKFLOW constant predates that migration.
    const migratedTemplate = getBuiltInWorkflows().find((w) => w.name === CODING_WORKFLOW.name)!;
    expect(after.templateHash).toBe(computeWorkflowHash(migratedTemplate));
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
    expect(workflows).toHaveLength(5);
    expect(workflows.some((workflow) => workflow.name === 'My Custom Workflow')).toBe(true);
    expect(workflows.filter((workflow) => workflow.templateName)).toHaveLength(4);
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
    expect(result.seeded).toHaveLength(3);
    expect(result.seeded).not.toContain(STABLE_CODING_WORKFLOW.name);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toBe(STABLE_CODING_WORKFLOW.name);
    expect(result.errors[0].error).toContain('coding');
    // 1 user + 3 built-ins (4 templates minus the colliding 'Coding').
    expect(manager.listWorkflows(SPACE_ID)).toHaveLength(4);
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
    expect(result.seeded).toHaveLength(4);
    expect(result.seeded).toContain('Coding');
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

    // 3 of 4 succeed, 1 fails
    expect(result.seeded).toHaveLength(3);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('Simulated DB constraint error');
    expect(result.skipped).toBe(false);

    // Verify 3 workflows were actually persisted
    const workflows = manager.listWorkflows(SPACE_ID);
    expect(workflows).toHaveLength(3);
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
    expect(result.errors).toHaveLength(4);
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

  test('RESEARCH_WORKFLOW seeded nodes preserve customPrompt content', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
    const researchNode = wf.nodes.find((n) => n.name === 'Research');
    expect(researchNode?.agents[0].customPrompt?.value).toContain('gh pr create');
    const reviewNode = wf.nodes.find((n) => n.name === 'Review');
    expect(reviewNode?.agents[0].customPrompt?.value).toContain('save_artifact');
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

  // ─── getBuiltInWorkflows ordering ────────────────────────────────────────

  test('getBuiltInWorkflows returns CODING_WORKFLOW first', () => {
    // CODING_WORKFLOW is first so spaceWorkflowRun.start (which picks
    // workflows[0] ordered by created_at ASC) defaults to the single-task
    // coding loop.
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

  test('getBuiltInWorkflows returns all templates', () => {
    const templates = getBuiltInWorkflows();
    const names = templates.map((t) => t.name);
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
      .find((w) => w.name === CODING_WITH_QA_WORKFLOW.name)!;
    // Templates use title-case role placeholders that must resolve case-insensitively.
    // Coding with QA: Coding(Coder) → Review(Reviewer) → QA(QA)
    expect(wf.nodes[0].agents[0]?.agentId).toBe(CODER_ID);
    expect(wf.nodes[1].agents[0]?.agentId).toBe(REVIEWER_ID);
    expect(wf.nodes[2].agents[0]?.agentId).toBe(QA_ID);
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

  test('mergeNodeStructuralFieldsFromTemplate preserves operator-configured handoff transitions when the template is silent', () => {
    // Built-in templates do not declare transitions today. Restamp must NOT wipe
    // operator-/RPC-installed transitions on a seeded node.
    const templateNode = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
    expect(templateNode.transitions).toBeUndefined();
    const installed: HandoffTransition[] = [{ id: 'to-review', target: 'Review' }];
    const existingNode: WorkflowNode = {
      ...templateNode,
      transitions: installed,
    };

    const merged = mergeNodeStructuralFieldsFromTemplate(
      [existingNode],
      CODING_WITH_QA_WORKFLOW.nodes,
      () => 'agent-coder'
    );
    const mergedCoding = merged.find((n) => n.name === 'Coding')!;
    expect(mergedCoding.transitions).toEqual(installed);
  });

  test('mergeNodeStructuralFieldsFromTemplate overwrites transitions when the template declares them', () => {
    const templateNode = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
    const declared: HandoffTransition[] = [{ id: 'to-review', target: 'Review', gateId: 'g1' }];
    const templateWithTransitions = CODING_WITH_QA_WORKFLOW.nodes.map((n) =>
      n.name === 'Coding' ? { ...n, transitions: declared } : n
    );
    const existingNode: WorkflowNode = {
      ...templateNode,
      transitions: [{ id: 'stale', target: 'Review' }],
    };

    const merged = mergeNodeStructuralFieldsFromTemplate(
      [existingNode],
      templateWithTransitions,
      () => 'agent-coder'
    );
    const mergedCoding = merged.find((n) => n.name === 'Coding')!;
    expect(mergedCoding.transitions).toEqual(declared);
  });

  test('mergeNodeStructuralFieldsFromTemplate preserves transitions for a node renamed away from the template', () => {
    // When the template no longer has a matching node, the existing node is
    // treated as user-owned; its transitions are preserved, not cleared.
    const installed: HandoffTransition[] = [{ id: 'to-review', target: 'Review' }];
    const orphan: WorkflowNode = {
      id: 'orphan-1',
      name: 'Custom Node',
      agents: [{ agentId: 'agent-1', name: 'coder' }],
      transitions: installed,
    };

    const merged = mergeNodeStructuralFieldsFromTemplate(
      [orphan],
      CODING_WITH_QA_WORKFLOW.nodes,
      () => 'agent-coder'
    );
    expect(merged[0].transitions).toEqual(installed);
  });

  test('mergeNodeStructuralFieldsFromTemplate remaps transition targets to the installed graph', () => {
    // When the template declares a transition and the user renamed the target
    // node in the installed space (same node id, different name), the template
    // target name must be remapped to the installed name — otherwise the
    // subsequent updateWorkflow validation sees the template name as unknown and
    // aborts the entire re-stamp on every startup. Mirrors the channel/hook remap.
    const codingTemplate = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
    const reviewTemplate = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const declared: HandoffTransition[] = [{ id: 'to-review', target: 'Review' }];
    const templateWithTransitions = CODING_WITH_QA_WORKFLOW.nodes.map((n) =>
      n.name === 'Coding' ? { ...n, transitions: declared } : n
    );
    // Installed space renamed 'Review' → 'Reviewer' (same node id).
    const installed: WorkflowNode[] = CODING_WITH_QA_WORKFLOW.nodes.map((n) =>
      n.id === reviewTemplate.id ? { ...n, name: 'Reviewer' } : { ...n }
    );

    const merged = mergeNodeStructuralFieldsFromTemplate(
      installed,
      templateWithTransitions,
      () => 'agent-coder'
    );
    const mergedCoding = merged.find((n) => n.id === codingTemplate.id)!;
    expect(mergedCoding.transitions?.[0].target).toBe('Reviewer');
  });

  test('mergeNodeStructuralFieldsFromTemplate preserves agent-slot targets verbatim', () => {
    // A slot-name target (e.g. a reviewer slot) must NOT be remapped to its
    // enclosing node name — that would change the destination for a multi-agent
    // node. Only node-name targets are remapped; slot targets and '*' are kept.
    const codingTemplate = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
    const reviewTemplate = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const reviewerSlotName = reviewTemplate.agents[0]?.name ?? 'Reviewer';
    const declared: HandoffTransition[] = [{ id: 'to-slot', target: reviewerSlotName }];
    const templateWithTransitions = CODING_WITH_QA_WORKFLOW.nodes.map((n) =>
      n.name === 'Coding' ? { ...n, transitions: declared } : n
    );

    const merged = mergeNodeStructuralFieldsFromTemplate(
      CODING_WITH_QA_WORKFLOW.nodes.map((n) => ({ ...n })),
      templateWithTransitions,
      () => 'agent-coder'
    );
    const mergedCoding = merged.find((n) => n.id === codingTemplate.id)!;
    expect(mergedCoding.transitions?.[0].target).toBe(reviewerSlotName);
  });

  test('mergeNodeStructuralFieldsFromTemplate remaps a renamed slot target by position', () => {
    // When the installed space renamed a slot targeted by a template transition
    // (same node id, slot at the same position renamed), the target is remapped
    // to the installed slot name so re-stamp validation does not abort.
    const codingTemplate = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
    const reviewTemplate = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const reviewerSlotName = reviewTemplate.agents[0]?.name ?? 'Reviewer';
    const declared: HandoffTransition[] = [{ id: 'to-slot', target: reviewerSlotName }];
    const templateWithTransitions = CODING_WITH_QA_WORKFLOW.nodes.map((n) =>
      n.name === 'Coding' ? { ...n, transitions: declared } : n
    );
    // Installed: rename the Review node's first slot to 'Senior Reviewer'.
    const installed = CODING_WITH_QA_WORKFLOW.nodes.map((n) => {
      if (n.id !== reviewTemplate.id) return { ...n };
      const agents = n.agents.map((a, i) => (i === 0 ? { ...a, name: 'Senior Reviewer' } : a));
      return { ...n, agents };
    });

    const merged = mergeNodeStructuralFieldsFromTemplate(
      installed,
      templateWithTransitions,
      () => 'agent-coder'
    );
    const mergedCoding = merged.find((n) => n.id === codingTemplate.id)!;
    expect(mergedCoding.transitions?.[0].target).toBe('Senior Reviewer');
  });

  test('CODING_WITH_QA_WORKFLOW reviewer prompt defers to the central gated handoff', () => {
    const reviewNode = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const prompt = reviewNode.agents[0].customPrompt!.value;

    // The stable reviewer prompt is behavioral: it does NOT hard-code the QA
    // target or review-approval-gate field (those are injected centrally), and
    // it does not embed the retired Fullstack codex handoff prose either.
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
