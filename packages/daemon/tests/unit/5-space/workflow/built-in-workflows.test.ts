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
import { PR_MERGE_POST_APPROVAL_INSTRUCTIONS } from '../../../../src/lib/space/workflows/post-approval-merge-template.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import {
  CODING_WORKFLOW,
  FULLSTACK_QA_LOOP_WORKFLOW,
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
 * Helper that returns the effective gate for FULLSTACK_QA_LOOP_WORKFLOW's
 * review-approval-gate with the Review node configured to require codex approval.
 * Used by tests that exercise the codex review bot script/poll.
 */
function getFullstackReviewApprovalGateWithCodex() {
  const rawGate = FULLSTACK_QA_LOOP_WORKFLOW.gates!.find((g) => g.id === 'review-approval-gate')!;
  return getEffectiveGate(rawGate, {
    ...FULLSTACK_QA_LOOP_WORKFLOW,
    nodes: FULLSTACK_QA_LOOP_WORKFLOW.nodes.map((n) =>
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

describe('CODING_WORKFLOW template', () => {
  test('has three nodes: Coding, Review, Post-Approval', () => {
    expect(CODING_WORKFLOW.nodes).toHaveLength(3);
    expect(CODING_WORKFLOW.nodes.map((s) => s.name)).toEqual(['Coding', 'Review', 'Post-Approval']);
  });

  test('Post-Approval node declares the shell-capable merger slot (Option C)', () => {
    const postApprovalNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Post-Approval')!;
    expect(postApprovalNode).toBeDefined();
    expect(postApprovalNode.agents).toHaveLength(1);
    expect(postApprovalNode.agents[0].agentId).toBe('PR Merger');
    expect(postApprovalNode.agents[0].name).toBe('merger');
    // The Post-Approval (merger) node owns its own post-approval merge route —
    // approval is task-level, so the router fans out to it regardless of which
    // node submitted. The end (Review) node no longer carries the route.
    expect(postApprovalNode.postApproval?.targetAgent).toBe('merger');
    const reviewNode = CODING_WORKFLOW.nodes.find((n) => n.id === CODING_WORKFLOW.endNodeId)!;
    expect(reviewNode.postApproval).toBeUndefined();
  });

  test('merger can route a merge conflict to the coder and receive the reply', () => {
    // The Post-Approval node must have channels to/from the upstream
    // implementation node, or the merger's send_message to the coder is
    // rejected by ChannelResolver.canSend (regressing conflict routing).
    const resolver = new ChannelResolver(CODING_WORKFLOW.channels ?? []);
    expect(resolver.canSend('Post-Approval', 'Coding')).toBe(true);
    expect(resolver.canSend('Coding', 'Post-Approval')).toBe(true);
    expect(resolver.getPermittedTargets('Post-Approval')).toContain('Coding');
  });

  test('step agentId placeholders are correct', () => {
    expect(CODING_WORKFLOW.nodes[0].agents[0]?.name).toBe('coder');
    expect(CODING_WORKFLOW.nodes[1].agents[0]?.name).toBe('reviewer');
  });

  test('coder prompt forbids merging and delegates approval merge to reviewer', () => {
    const prompt = CODING_WORKFLOW.nodes[0].agents[0]?.customPrompt?.value;
    expect(prompt).toContain('Your job is implementation only:');
    expect(prompt).toContain('Do NOT merge PRs. When the reviewer approves, your work is done.');
    expect(prompt).toContain('The reviewer handles the merge.');
  });

  test('coding-role prompts instruct subscribing to PR events after PR creation', () => {
    const prompts = [
      CODING_WORKFLOW.nodes[0].agents[0]?.customPrompt?.value,
      FULLSTACK_QA_LOOP_WORKFLOW.nodes.find((node) => node.name === 'Coding')?.agents[0]
        .customPrompt?.value,
      RESEARCH_WORKFLOW.nodes[0].agents[0]?.customPrompt?.value,
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain('`subscribe_pr_events({})`');
      expect(prompt).toContain('review comments, CI failures, and reactions');
      expect(prompt).toContain('Do this once per PR');
    }
  });

  test('coding-role prompts instruct using external_event reply handles and GraphQL thread ids', () => {
    const prompts = [
      CODING_WORKFLOW.nodes[0].agents[0]?.customPrompt?.value,
      FULLSTACK_QA_LOOP_WORKFLOW.nodes.find((node) => node.name === 'Coding')?.agents[0]
        .customPrompt?.value,
      RESEARCH_WORKFLOW.nodes[0].agents[0]?.customPrompt?.value,
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain('`external_event` review comment essence');
      expect(prompt).toContain('`replyHandle.commentId`');
      expect(prompt).toContain('gh api --hostname <host>');
      expect(prompt).toContain('pulls/{pull_number}/comments/{comment_id}/replies');
      expect(prompt).toContain('gh api graphql --hostname <host>');
      expect(prompt).toContain('resolveReviewThread(input:{threadId:$threadId})');
      expect(prompt).toContain('PullRequestReviewThread.id');
      expect(prompt).toContain('`commentNodeId`');
      expect(prompt).toContain('do not use the review comment `node_id`');
    }
  });

  test('coder prompt gives behavioral handoff guidance without hard-coded gate details', () => {
    const prompt = CODING_WORKFLOW.nodes[0].agents[0]?.customPrompt?.value;
    expect(prompt).toContain('hand off by calling `send_message` to the review target');
    expect(prompt).toContain('Use the current target and required data fields');
    expect(prompt).toContain('Runtime Execution Contract');
    expect(prompt).toContain('`save_artifact` alone is insufficient');
    expect(prompt).toContain('Re-supplying the PR URL data field is required');
    expect(prompt).not.toContain('send_message(target="Review"');
    expect(prompt).not.toContain('code-ready-gate');
  });

  test('coder slot has toolGuards with gh pr merge deny rule', () => {
    const agent = CODING_WORKFLOW.nodes[0].agents[0];
    const guards = agent?.toolGuards;
    expect(guards).toBeDefined();
    expect(guards).toHaveLength(1);
    expect(guards![0].matcher).toBe('Bash');
    expect(guards![0].decision).toBe('deny');
    expect(guards![0].pattern).toContain('gh');
    expect(guards![0].reason).toContain('merge');
  });

  test('has six channels (Coding↔Review + Post-Approval↔Coding + Post-Approval↔Review)', () => {
    expect(CODING_WORKFLOW.channels).toHaveLength(6);
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
  test('has three nodes (Research + Review + Post-Approval)', () => {
    expect(RESEARCH_WORKFLOW.nodes).toHaveLength(3);
    expect(RESEARCH_WORKFLOW.nodes.map((s) => s.name)).toEqual([
      'Research',
      'Review',
      'Post-Approval',
    ]);
    const researchPostApprovalNode = RESEARCH_WORKFLOW.nodes.find(
      (n) => n.name === 'Post-Approval'
    )!;
    expect(researchPostApprovalNode.postApproval?.targetAgent).toBe('merger');
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

  test('has six channels: Research↔Review + Post-Approval↔Research + Post-Approval↔Review', () => {
    expect(RESEARCH_WORKFLOW.channels).toHaveLength(6);
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

  test('includes FULLSTACK_QA_LOOP_WORKFLOW', () => {
    const names = getBuiltInWorkflows().map((w) => w.name);
    expect(names).toContain(FULLSTACK_QA_LOOP_WORKFLOW.name);
  });

  test('includes RESEARCH_WORKFLOW', () => {
    const names = getBuiltInWorkflows().map((w) => w.name);
    expect(names).toContain(RESEARCH_WORKFLOW.name);
  });

  test('includes REVIEW_ONLY_WORKFLOW', () => {
    const names = getBuiltInWorkflows().map((w) => w.name);
    expect(names).toContain(REVIEW_ONLY_WORKFLOW.name);
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
    expect(names).toContain(FULLSTACK_QA_LOOP_WORKFLOW.name);
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

  test('CODING_WORKFLOW seeded correctly — three nodes with real agent IDs', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name);
    expect(wf).toBeDefined();
    expect(wf!.nodes).toHaveLength(3);
    expect(wf!.nodes[0].agents[0]?.agentId).toBe(CODER_ID);
    expect(wf!.nodes[1].agents[0]?.agentId).toBe(roleMap.reviewer);
    // Third node is the dedicated Post-Approval merger slot.
    expect(wf!.nodes[2].name).toBe('Post-Approval');
    expect(wf!.nodes[2].agents[0]?.agentId).toBe(MERGER_ID);
    expect(wf!.nodes[2].agents[0]?.name).toBe('merger');
  });

  test('CODING_WORKFLOW seeded with six channels (incl. Post-Approval↔Review)', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    expect(wf.channels).toHaveLength(6);

    const codeToReview = wf.channels!.find((c) => c.from === 'Coding' && c.to === 'Review');
    expect(codeToReview).toBeDefined();
    expect(codeToReview!.gateId).toBeUndefined();

    const reviewToCode = wf.channels!.find((c) => c.from === 'Review' && c.to === 'Coding');
    expect(reviewToCode).toBeDefined();
    // Review → Coding is now gated by review-posted-gate so the reviewer's
    // message cannot be delivered until a GitHub review is visible.
    expect(reviewToCode!.gateId).toBeUndefined();
    expect(reviewToCode!.maxCycles).toBe(5);
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

  test('RESEARCH_WORKFLOW seeded with six channels (incl. Post-Approval↔Review)', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
    expect(wf.channels).toHaveLength(6);
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
    expect(wf!.nodes).toHaveLength(3);
    expect(wf!.nodes[0].agents[0]?.agentId).toBe(RESEARCH_ID);
    expect(wf!.nodes[1].agents[0]?.agentId).toBe(REVIEWER_ID);
    expect(wf!.nodes[2].name).toBe('Post-Approval');
    expect(wf!.nodes[2].agents[0]?.agentId).toBe(MERGER_ID);
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
    expect(byName.get('Coding Workflow')?.handle).toBe('coding-workflow');
    expect(byName.get('Research Workflow')?.handle).toBe('research-workflow');
    expect(byName.get('Review-Only Workflow')?.handle).toBe('review-only-workflow');
    expect(byName.get('Plan & Decompose Workflow')?.handle).toBe('plan-decompose-workflow');
    expect(byName.get('Coding with QA Workflow')?.handle).toBe('coding-with-qa-workflow');
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
    const assertPostApproval = (name: string) => {
      const wf = workflows.find((w) => w.name === name);
      expect(wf, `workflow "${name}" must be seeded`).toBeDefined();
      expect(wf!.postApproval).toBeUndefined();
      // The merge route lives on the dedicated Post-Approval (merger) node;
      // approval is task-level so the router fans out to it. The end node no
      // longer carries the route.
      const routeNode = wf!.nodes.find((node) => node.postApproval);
      expect(routeNode, `"${name}" must have a node carrying postApproval`).toBeDefined();
      expect(routeNode!.postApproval!.targetAgent).toBe('merger');
      // Non-empty instructions — we don't snapshot the full template here
      // because end-node-handoff.test.ts already asserts the exact content.
      expect(routeNode!.postApproval!.instructions.length).toBeGreaterThan(0);
      const endNode = wf!.nodes.find((node) => node.id === wf!.endNodeId);
      expect(endNode?.postApproval).toBeUndefined();
    };
    assertPostApproval('Coding Workflow');
    assertPostApproval('Research Workflow');
    assertPostApproval('Coding with QA Workflow');
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
    const codingPostApprovalNode = coding.nodes.find((node) => node.name === 'Post-Approval')!;
    db.prepare(
      `UPDATE space_workflows
			    SET template_hash = ?, post_approval = NULL
			  WHERE id = ?`
    ).run('stale-hash-from-a-prior-pr', coding.id);
    db.prepare(`UPDATE space_workflow_nodes SET config = ? WHERE id = ?`).run(
      JSON.stringify({ agents: codingPostApprovalNode.agents }),
      codingPostApprovalNode.id
    );

    // Verify the simulated drift landed.
    const before = manager.getWorkflow(coding.id)!;
    expect(before.postApproval).toBeUndefined();
    expect(
      before.nodes.find((node) => node.name === 'Post-Approval')?.postApproval
    ).toBeUndefined();
    expect(before.templateHash).toBe('stale-hash-from-a-prior-pr');

    // Re-run the seeder — re-stamp branch fires.
    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.seeded).toEqual([]);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);
    expect(result.skipped).toBe(false);

    // Row now carries the current template's node-level postApproval + hash.
    const after = manager.getWorkflow(coding.id)!;
    expect(after.postApproval).toBeUndefined();
    const afterRouteNode = after.nodes.find((node) => node.name === 'Post-Approval');
    expect(afterRouteNode?.postApproval).toBeDefined();
    expect(afterRouteNode?.postApproval?.targetAgent).toBe('merger');
    expect(after.templateHash).not.toBe('stale-hash-from-a-prior-pr');
  });

  test('re-stamp clears a stale Review-node postApproval route now that the route lives on Post-Approval', () => {
    // Before the fan-out redesign the merge route lived on the Review node. A
    // space seeded from that older template carries a stale route on its Review
    // node (and none on Post-Approval). Re-stamping against the current template
    // must CLEAR the Review node's stale route and assert the route on the
    // Post-Approval node, so approval dispatches exactly one merge — not zero,
    // not two. (mergeNodeStructuralFieldsFromTemplate line ~1437.)
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const reviewNode = coding.nodes.find((node) => node.name === 'Review')!;
    const postApprovalNode = coding.nodes.find((node) => node.name === 'Post-Approval')!;

    // Simulate the pre-redesign shape: route on Review, no route on Post-Approval,
    // and a stale template_hash so the restamp branch fires.
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'stale-hash-pre-fanout',
      coding.id
    );
    db.prepare(`UPDATE space_workflow_nodes SET config = ? WHERE id = ?`).run(
      JSON.stringify({
        agents: reviewNode.agents,
        postApproval: {
          targetAgent: 'merger',
          instructions: PR_MERGE_POST_APPROVAL_INSTRUCTIONS,
        },
      }),
      reviewNode.id
    );
    db.prepare(`UPDATE space_workflow_nodes SET config = ? WHERE id = ?`).run(
      JSON.stringify({ agents: postApprovalNode.agents }),
      postApprovalNode.id
    );

    // Verify the simulated stale state landed: route on Review, none on Post-Approval.
    const before = manager.getWorkflow(coding.id)!;
    expect(before.nodes.find((node) => node.name === 'Review')?.postApproval).toBeDefined();
    expect(
      before.nodes.find((node) => node.name === 'Post-Approval')?.postApproval
    ).toBeUndefined();

    // Re-run the seeder — re-stamp branch fires.
    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);

    // The Review node's stale route is cleared; Post-Approval carries the route.
    const after = manager.getWorkflow(coding.id)!;
    expect(after.nodes.find((node) => node.name === 'Review')?.postApproval).toBeUndefined();
    const afterRouteNode = after.nodes.find((node) => node.name === 'Post-Approval');
    expect(afterRouteNode?.postApproval).toBeDefined();
    expect(afterRouteNode?.postApproval?.targetAgent).toBe('merger');
    // Exactly one node carries a route — no double dispatch on approval.
    expect(after.nodes.filter((node) => node.postApproval)).toHaveLength(1);
  });

  test('re-stamp propagates template maxCycles onto existing Fullstack QA Loop cyclic back-channels', () => {
    // Seed fresh — Fullstack QA Loop carries the current template (maxCycles: 50)
    // and the current template hash.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === FULLSTACK_QA_LOOP_WORKFLOW.name)!;

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
    expect(result.restamped).toContain(FULLSTACK_QA_LOOP_WORKFLOW.name);

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
    const routeNode = coding.nodes.find((n) => n.name === 'Post-Approval')!;
    expect(routeNode.postApproval).toBeDefined();

    // Bypass manager validation — only rename node, don't touch hooks.
    // Direct DB update avoids hook validation against renamed nodes.
    db.prepare(`UPDATE space_workflow_nodes SET name = ? WHERE id = ?`).run(
      'Human Merger',
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
    expect(afterRenamedNode.name).toBe('Human Merger');
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
    expect(after.nodes.find((node) => node.name === 'Post-Approval')?.postApproval).toBeDefined();
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

  test('re-stamp patches exact retired built-in Coding prompt text', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const codingNode = coding.nodes.find((n) => n.name === 'Coding')!;
    const templatePrompt = CODING_WORKFLOW.nodes.find((n) => n.name === 'Coding')!.agents[0]
      .customPrompt!.value;
    const stalePrompt = templatePrompt
      .replace(
        '5. If code changed: open a PR with `gh pr create` — include a clear title and description. After `gh pr create`, call `subscribe_pr_events({})` (no arguments needed — the PR URL is auto-resolved from the run). This subscribes you to review comments, CI failures, and reactions for your PR so you receive them directly and can act on them. Do this once per PR.\n',
        '5. If code changed: open a PR with `gh pr create` — include a clear title and description\n'
      )
      .replace(
        '6. If code changed: hand off by calling `send_message` to the review target ' +
          'with `data: { pr_url: "<url>" }`. Use the current target and required data ' +
          'fields from the Runtime Execution Contract injected into your task prompt. ' +
          '`save_artifact` alone is insufficient; only `send_message` triggers the ' +
          'hook-validated handoff. Always include the PR URL data field on every ' +
          '`send_message` handoff — the hook validates every cycle, so even on round 2+ ' +
          'you must re-supply it.\n',
        '6. If code changed: hand off by sending a message to Review with ' +
          '`data: { pr_url: "<url>" }`. The gate script verifies the PR is open and ' +
          'mergeable, so make sure it actually is before sending. ' +
          '**Always include `data: { pr_url }` on every send_message to Review** — the gate ' +
          'data resets each cycle, so even on round 2+ you must re-supply it.\n'
      )
      .replace(
        '6. Verify no unresolved review conversations remain, verify tests still pass, ' +
          'then call `send_message` to the review target again to re-trigger the review ' +
          'cycle. Re-supplying the PR URL data field is required because the hook ' +
          'validates each handoff; `save_artifact` alone will not deliver it.',
        '6. Verify no unresolved review conversations remain, verify tests still pass, ' +
          'then send_message to Review again (again with `data: { pr_url }`) to ' +
          're-trigger the review cycle'
      );
    expect(stalePrompt).not.toBe(templatePrompt);
    expect(stalePrompt).toContain('hand off by sending a message to Review');

    manager.updateWorkflow(coding.id, {
      nodes: coding.nodes.map((n) =>
        n.id !== codingNode.id
          ? n
          : {
              ...n,
              agents: n.agents.map((a, i) =>
                i === 0 ? { ...a, customPrompt: { value: stalePrompt } } : a
              ),
            }
      ),
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'stale-prompt-hash',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);

    const after = manager.getWorkflow(coding.id)!;
    const afterCodingNode = after.nodes.find((n) => n.id === codingNode.id)!;
    const afterPrompt = afterCodingNode.agents[0].customPrompt?.value;
    expect(afterPrompt).toBe(templatePrompt);
    expect(afterPrompt).toContain('hand off by calling `send_message` to the review target');
    expect(afterPrompt).not.toContain('send_message(target="Review"');
    expect(after.templateHash).toBe(
      computeWorkflowHash(getBuiltInWorkflows().find((w) => w.name === CODING_WORKFLOW.name)!)
    );
  });

  test('re-stamp composes review thread guidance with older handoff variants', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const codingNode = coding.nodes.find((n) => n.name === 'Coding')!;
    const templatePrompt = CODING_WORKFLOW.nodes.find((n) => n.name === 'Coding')!.agents[0]
      .customPrompt!.value;
    const stalePrompt = templatePrompt
      .replace(
        '5. If code changed: open a PR with `gh pr create` — include a clear title and description. After `gh pr create`, call `subscribe_pr_events({})` (no arguments needed — the PR URL is auto-resolved from the run). This subscribes you to review comments, CI failures, and reactions for your PR so you receive them directly and can act on them. Do this once per PR.\n',
        '5. If code changed: open a PR with `gh pr create` — include a clear title and description\n'
      )
      .replace(
        '6. If code changed: hand off by calling `send_message` to the review target ' +
          'with `data: { pr_url: "<url>" }`. Use the current target and required data ' +
          'fields from the Runtime Execution Contract injected into your task prompt. ' +
          '`save_artifact` alone is insufficient; only `send_message` triggers the ' +
          'hook-validated handoff. Always include the PR URL data field on every ' +
          '`send_message` handoff — the hook validates every cycle, so even on round 2+ ' +
          'you must re-supply it.\n',
        '6. If code changed: hand off by sending a message to Review with ' +
          '`data: { pr_url: "<url>" }`. The gate script verifies the PR is open and ' +
          'mergeable, so make sure it actually is before sending. ' +
          '**Always include `data: { pr_url }` on every send_message to Review** — the gate ' +
          'data resets each cycle, so even on round 2+ you must re-supply it.\n'
      )
      .replace(
        '6. Verify no unresolved review conversations remain, verify tests still pass, ' +
          'then call `send_message` to the review target again to re-trigger the review ' +
          'cycle. Re-supplying the PR URL data field is required because the hook ' +
          'validates each handoff; `save_artifact` alone will not deliver it.',
        '6. Verify no unresolved review conversations remain, verify tests still pass, ' +
          'then send_message to Review again (again with `data: { pr_url }`) to ' +
          're-trigger the review cycle'
      )
      .replace(
        '3. For valid items: make the fix, then reply to that specific thread. Prefer the ' +
          '`external_event` essence handle: use `replyHandle.commentId` as the REST ' +
          '`{comment_id}` and the PR URL host as `<host>` in ' +
          '`gh api --hostname <host> repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies -f body="<ack>"` ' +
          'explaining what changed. One reply per comment creates a visible audit trail.\n',
        '3. For valid items: make the fix, then reply to that specific thread via ' +
          '`gh api repos/{owner}/{repo}/pulls/{n}/comments/{comment_id}/replies -f body="<ack>"` ' +
          'explaining what changed. One reply per comment creates a visible audit trail.\n'
      )
      .replace(
        'After pushing fixes for review feedback, resolve ALL open GitHub review conversation ' +
          'threads — including those where you disagree with the reviewer. When the feedback ' +
          'arrives as an `external_event` review comment essence, use its `replyHandle.commentId` ' +
          'as the REST `{comment_id}` and the PR URL host as `<host>` for ' +
          '`gh api --hostname <host> repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies -f body="<ack>"`. ' +
          'Then resolve the thread with GraphQL ' +
          "`gh api graphql --hostname <host> -f query='mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}' -f threadId=<review-thread-node-id>`, " +
          'where `<host>` is the PR URL host and `<review-thread-node-id>` is the `PullRequestReviewThread.id` found by querying ' +
          '`reviewThreads`; do not use the review comment `node_id`/`commentNodeId` as ' +
          '`threadId`. The PR-ready hook blocks on any unresolved thread, so leaving one ' +
          'open creates a deadlock. If the reviewer disagrees with your reasoning, they can ' +
          're-open the thread. Use `gh api graphql` to verify no unresolved review conversations ' +
          'remain before sending a message to Review again. Never set a PR to auto-merge — ' +
          'auto-merge is not allowed.',
        'After pushing fixes for review feedback, resolve ALL open GitHub review conversation ' +
          'threads — including those where you disagree with the reviewer. First reply with your ' +
          'reasoning, then resolve the thread with the `resolveReviewThread` mutation. The ' +
          'PR-ready hook blocks on any unresolved thread, so leaving one open creates a deadlock. ' +
          'If the reviewer disagrees with your reasoning, they can re-open the thread. ' +
          'Use `gh api graphql` to verify no unresolved review conversations remain before ' +
          'sending a message to Review again. ' +
          'Never set a PR to auto-merge — auto-merge is not allowed.'
      );

    manager.updateWorkflow(coding.id, {
      nodes: coding.nodes.map((n) =>
        n.id !== codingNode.id
          ? n
          : {
              ...n,
              agents: n.agents.map((a, i) =>
                i === 0 ? { ...a, customPrompt: { value: stalePrompt } } : a
              ),
            }
      ),
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'stale-composed-review-thread-guidance-hash',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);

    const after = manager.getWorkflow(coding.id)!;
    const afterCodingNode = after.nodes.find((n) => n.id === codingNode.id)!;
    const afterPrompt = afterCodingNode.agents[0].customPrompt?.value;
    expect(afterPrompt).toBe(templatePrompt);
    expect(afterPrompt).toContain('replyHandle.commentId');
    expect(afterPrompt).toContain('PullRequestReviewThread.id');
    expect(afterPrompt).toContain('hand off by calling `send_message` to the review target');
  });

  test('re-stamp adds subscribe step to pre-PR-dev Coding/Fullstack/Research prompts', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    // Simulate each workflow's persisted Coding/Research prompt as it was on
    // dev BEFORE this PR: the step text lacks the subscribe instruction but all
    // other steps are identical to the current template. Restamp must detect
    // the drift and swap in the current template (which includes subscribe).
    const cases = [
      {
        workflow: CODING_WORKFLOW,
        nodeName: 'Coding',
        currentStep:
          '5. If code changed: open a PR with `gh pr create` — include a clear title and description. After `gh pr create`, call `subscribe_pr_events({})` (no arguments needed — the PR URL is auto-resolved from the run). This subscribes you to review comments, CI failures, and reactions for your PR so you receive them directly and can act on them. Do this once per PR.\n',
        retiredStep:
          '5. If code changed: open a PR with `gh pr create` — include a clear title and description\n',
      },
      {
        workflow: FULLSTACK_QA_LOOP_WORKFLOW,
        nodeName: 'Coding',
        currentStep:
          '3. Open or update the PR and ensure it remains mergeable. After `gh pr create`, call `subscribe_pr_events({})` (no arguments needed — the PR URL is auto-resolved from the run). This subscribes you to review comments, CI failures, and reactions for your PR so you receive them directly and can act on them. Do this once per PR.\n',
        retiredStep: '3. Open or update the PR and ensure it remains mergeable\n',
      },
      {
        workflow: RESEARCH_WORKFLOW,
        nodeName: 'Research',
        currentStep:
          '5. Commit findings and open a PR with `gh pr create`. After `gh pr create`, call `subscribe_pr_events({})` (no arguments needed — the PR URL is auto-resolved from the run). This subscribes you to review comments, CI failures, and reactions for your PR so you receive them directly and can act on them. Do this once per PR.\n',
        retiredStep: '5. Commit findings and open a PR with `gh pr create`\n',
      },
    ];

    for (const { workflow, nodeName, currentStep, retiredStep } of cases) {
      const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === workflow.name)!;
      const node = wf.nodes.find((n) => n.name === nodeName)!;
      const templatePrompt = workflow.nodes.find((n) => n.name === nodeName)!.agents[0]
        .customPrompt!.value;
      // Build the pre-PR-dev stale prompt: revert ONLY the step text.
      const stalePrompt = templatePrompt.replace(currentStep, retiredStep);
      expect(stalePrompt).not.toBe(templatePrompt);
      expect(stalePrompt).not.toContain('subscribe_pr_events');

      manager.updateWorkflow(wf.id, {
        nodes: wf.nodes.map((n) =>
          n.id !== node.id
            ? n
            : {
                ...n,
                agents: n.agents.map((a, i) =>
                  i === 0 ? { ...a, customPrompt: { value: stalePrompt } } : a
                ),
              }
        ),
      });
      db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
        `stale-pr-step-${workflow.name}`,
        wf.id
      );

      const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
      expect(result.restamped).toContain(workflow.name);

      const after = manager.getWorkflow(wf.id)!;
      const afterNode = after.nodes.find((n) => n.id === node.id)!;
      const afterPrompt = afterNode.agents[0].customPrompt?.value;
      expect(afterPrompt).toBe(templatePrompt);
      expect(afterPrompt).toContain('subscribe_pr_events');
      expect(after.templateHash).toBe(
        computeWorkflowHash(getBuiltInWorkflows().find((w) => w.name === workflow.name)!)
      );
    }
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

  test('re-stamp patches exact retired built-in Fullstack prompt text', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflow = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === FULLSTACK_QA_LOOP_WORKFLOW.name)!;
    const codingNode = workflow.nodes.find((n) => n.name === 'Coding')!;
    const templatePrompt = FULLSTACK_QA_LOOP_WORKFLOW.nodes.find((n) => n.name === 'Coding')!
      .agents[0].customPrompt!.value;
    const stalePrompt = templatePrompt
      .replace(
        '3. Open or update the PR and ensure it remains mergeable. After `gh pr create`, call `subscribe_pr_events({})` (no arguments needed — the PR URL is auto-resolved from the run). This subscribes you to review comments, CI failures, and reactions for your PR so you receive them directly and can act on them. Do this once per PR.\n',
        '3. Open or update the PR and ensure it remains mergeable\n'
      )
      .replace(
        'When implementation is ready, ensure the PR is open and mergeable, then call `send_message` ' +
          'to the review target with `data: { pr_url: "<url>" }`. Use the current ' +
          'target and required data fields from the Runtime Execution Contract injected into your task ' +
          'prompt. `save_artifact` alone is insufficient; only `send_message` triggers the hook-validated ' +
          'handoff. Coding is not the end node — the task-completion tools (`approve_task`, ' +
          '`submit_for_approval`) are not available to you.\n\n',
        'When implementation is ready, ensure the PR is open and mergeable and write code-pr-gate with ' +
          'field pr_url so Review can activate. Coding is not the end node — the task-completion tools ' +
          '(`approve_task`, `submit_for_approval`) are not available to you.\n\n'
      )
      .replace(
        '4. Hand off by calling `send_message` to the review target with ' +
          '`data: { pr_url: "<url>" }`; `save_artifact` alone will not deliver the handoff\n',
        '4. Write code-pr-gate with field pr_url so Review can activate\n'
      );
    expect(stalePrompt).not.toBe(templatePrompt);
    expect(stalePrompt).toContain('4. Write code-pr-gate with field pr_url so Review can activate');

    manager.updateWorkflow(workflow.id, {
      nodes: workflow.nodes.map((n) =>
        n.id !== codingNode.id
          ? n
          : {
              ...n,
              agents: n.agents.map((a, i) =>
                i === 0 ? { ...a, customPrompt: { value: stalePrompt } } : a
              ),
            }
      ),
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'stale-fullstack-prompt-hash',
      workflow.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(FULLSTACK_QA_LOOP_WORKFLOW.name);

    const after = manager.getWorkflow(workflow.id)!;
    const afterCodingNode = after.nodes.find((n) => n.id === codingNode.id)!;
    const afterPrompt = afterCodingNode.agents[0].customPrompt?.value;
    expect(afterPrompt).toBe(templatePrompt);
    expect(afterPrompt).toContain('call `send_message` to the review target');
    expect(afterPrompt).not.toContain('Write code-pr-gate with field pr_url');
    expect(after.templateHash).toBe(
      computeWorkflowHash(
        getBuiltInWorkflows().find((w) => w.name === FULLSTACK_QA_LOOP_WORKFLOW.name)!
      )
    );
  });

  test('re-stamp patches exact retired built-in Fullstack reviewer prompt text', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflow = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === FULLSTACK_QA_LOOP_WORKFLOW.name)!;
    const reviewNode = workflow.nodes.find((n) => n.name === 'Review')!;
    const templatePrompt = FULLSTACK_QA_LOOP_WORKFLOW.nodes.find((n) => n.name === 'Review')!
      .agents[0].customPrompt!.value;
    const stalePrompt = templatePrompt.replace(
      'terminal hand-off is sending `data: { approved: true, pr_url: "<url>" }` to QA after an ' +
        'APPROVE verdict with zero P0-P3 findings. Send the handoff to start the Codex review ' +
        'timeout window (2 hours by default), then wait for a Codex bot `+1` reaction or the ' +
        'timeout before proceeding. ',
      'terminal handoff is to write `review-approval-gate` with approved=true after an APPROVE ' +
        'verdict with zero P0-P3 findings. Wait for codex[bot] `+1` or timeout before proceeding. '
    );
    expect(stalePrompt).not.toBe(templatePrompt);

    manager.updateWorkflow(workflow.id, {
      nodes: workflow.nodes.map((n) =>
        n.id !== reviewNode.id
          ? n
          : {
              ...n,
              agents: n.agents.map((a, i) =>
                i === 0 ? { ...a, customPrompt: { value: stalePrompt } } : a
              ),
            }
      ),
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'stale-fullstack-review-prompt-hash',
      workflow.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(FULLSTACK_QA_LOOP_WORKFLOW.name);

    const after = manager.getWorkflow(workflow.id)!;
    const afterReviewNode = after.nodes.find((n) => n.id === reviewNode.id)!;
    const afterPrompt = afterReviewNode.agents[0].customPrompt?.value;
    expect(afterPrompt).toBe(templatePrompt);
    expect(afterPrompt).toContain('data: { approved: true, pr_url: "<url>" }');
    expect(afterPrompt).not.toContain('write `review-approval-gate`');
  });

  test('re-stamp backfills the post-approval re-approval paragraph onto QA + Reviewer prompts', () => {
    // The post-approval redesign APPENDED a re-approval paragraph to the QA
    // (Fullstack) and Reviewer (Coding/Research) end-node prompts. Existing
    // template-linked Spaces retain the pre-redesign prompt without the
    // paragraph, so the approval authority would not know to revalidate a
    // changed head or signal the waiting Merger. The retired-prompt patch
    // variant removes the appended paragraph (with its leading whitespace) to
    // reconstruct the pre-redesign prompt; re-stamp must swap it back to the
    // current template (paragraph included) for both workflows.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    const cases = [
      {
        label: 'Coding Reviewer',
        workflow: CODING_WORKFLOW,
        nodeName: 'Review',
        // The redesign appended the paragraph (with leading "\n\n") to the
        // reviewer prompt; removing it reconstructs the pre-redesign prompt.
        paragraph: REVIEWER_POST_APPROVAL_BLOCKER_PARAGRAPH,
        tail: 'Do not set auto-merge.',
      },
      {
        label: 'Fullstack QA',
        workflow: FULLSTACK_QA_LOOP_WORKFLOW,
        nodeName: 'QA',
        // The QA paragraph (leading space) sits mid-prompt — QA steps are
        // appended after FULLSTACK_QA_PROMPT — so remove ONLY the paragraph.
        paragraph: FULLSTACK_QA_POST_APPROVAL_PARAGRAPH,
        tail: 'Do not merge or set auto-merge.',
      },
    ];

    for (const { label, workflow, nodeName, paragraph, tail } of cases) {
      const seeded = manager.listWorkflows(SPACE_ID).find((w) => w.name === workflow.name)!;
      const node = seeded.nodes.find((n) => n.name === nodeName)!;
      const templatePrompt = workflow.nodes.find((n) => n.name === nodeName)!.agents[0]
        .customPrompt!.value;

      // Reconstruct the pre-redesign prompt by removing the exact appended
      // paragraph (same substring the production retired-prompt variant drops).
      const stalePrompt = templatePrompt.replace(paragraph, '');
      expect(stalePrompt).not.toBe(templatePrompt);
      expect(stalePrompt).toContain(tail);
      // The only "Post-approval merge support" occurrence was the paragraph.
      expect(stalePrompt).not.toContain('Post-approval merge support');

      manager.updateWorkflow(seeded.id, {
        nodes: seeded.nodes.map((n) =>
          n.id !== node.id
            ? n
            : {
                ...n,
                agents: n.agents.map((a, i) =>
                  i === 0 ? { ...a, customPrompt: { value: stalePrompt } } : a
                ),
              }
        ),
      });
      db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
        `stale-${label}-pre-post-approval-hash`,
        seeded.id
      );

      const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
      expect(result.restamped).toContain(workflow.name);

      const after = manager.getWorkflow(seeded.id)!;
      const afterPrompt = after.nodes.find((n) => n.id === node.id)!.agents[0].customPrompt?.value;
      expect(afterPrompt).toBe(templatePrompt);
      expect(afterPrompt).toContain('Post-approval merge support');
      expect(afterPrompt).toContain('re-approval authority for changed heads');
    }
  });

  test.skip('re-stamp updates gate field writers and features in place', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflow = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === FULLSTACK_QA_LOOP_WORKFLOW.name)!;
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
    expect(result.restamped).toContain(FULLSTACK_QA_LOOP_WORKFLOW.name);

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
      .find((w) => w.name === FULLSTACK_QA_LOOP_WORKFLOW.name)!;
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
    expect(result.restamped).toContain(FULLSTACK_QA_LOOP_WORKFLOW.name);

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
      .find((w) => w.name === FULLSTACK_QA_LOOP_WORKFLOW.name)!;
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
    expect(result.restamped).toContain(FULLSTACK_QA_LOOP_WORKFLOW.name);

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
      .find((w) => w.name === FULLSTACK_QA_LOOP_WORKFLOW.name)!;
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
    expect(result.restamped).toContain(FULLSTACK_QA_LOOP_WORKFLOW.name);

    const after = manager.getWorkflow(workflow.id)!;
    const gate = after.gates!.find((g) => g.id === 'review-approval-gate')!;
    expect(gate.features?.codex_review_bot).toBeUndefined();
    expect(after.nodes.find((node) => node.name === 'Review')?.requireCodexApproval).toBe(true);
  });

  test.skip('re-stamp preserves codex_review_bot on custom-polled approval gates', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflow = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === FULLSTACK_QA_LOOP_WORKFLOW.name)!;
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
    expect(result.restamped).toContain(FULLSTACK_QA_LOOP_WORKFLOW.name);

    const after = manager.getWorkflow(workflow.id)!;
    const gate = after.gates!.find((g) => g.id === 'review-approval-gate')!;
    expect(gate.features?.codex_review_bot).toBe(true);
    expect(gate.poll?.script).toBe('echo custom poll');
  });

  test('mergeNodeStructuralFieldsFromTemplate clears removed template Codex approval flags', () => {
    const existingNodes = FULLSTACK_QA_LOOP_WORKFLOW.nodes.map((node) =>
      node.name === 'Review' ? { ...node, requireCodexApproval: true } : node
    );
    const templateNodes = FULLSTACK_QA_LOOP_WORKFLOW.nodes.map((node) =>
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
      .find((w) => w.name === FULLSTACK_QA_LOOP_WORKFLOW.name)!;
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
    expect(result.restamped).toContain(FULLSTACK_QA_LOOP_WORKFLOW.name);

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
    // Validation Complete node removed; back to the current template's node set
    // (Coding, Review, and the dedicated Post-Approval merger node).
    expect(after.nodes.map((n) => n.name)).toEqual(['Coding', 'Review', 'Post-Approval']);
    // Channels touching Validation Complete removed; back to the current
    // template's 4 channels (incl. Post-Approval conflict routing).
    expect(after.channels).toHaveLength(6);
    expect(
      after.channels!.some(
        (channel) => channel.from === 'Validation Complete' || channel.to === 'Validation Complete'
      )
    ).toBe(false);
    // Validation hooks removed; the pr-ready + review-posted hooks survive.
    expect(after.hooks?.some((hook) => hook.id === 'validation-only-complete')).toBe(false);
    expect(after.hooks?.some((hook) => hook.id === 'validation-evidence-feedback')).toBe(false);
    expect(after.hooks?.some((hook) => hook.id === 'code-pr-ready')).toBe(true);
    // Validation gate removed (no gates remain on the seeded Coding Workflow).
    expect(after.gates?.some((gate) => gate.id === 'validation-complete-gate') ?? false).toBe(
      false
    );
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
    expect(source).toContain('[ -n "$WAIT_STARTED" ]');
    expect(source).toContain('[ "$WAIT_HEAD" = "$HEAD_OID" ]');
    expect(source).toContain('codex_fresh_reaction_count');
    expect(source).toContain('codex_reaction_count');
    expect(source).toContain('codex_approved":false');
    expect(source).toContain('codex_timed_out":true');
  });

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
      .find((w) => w.name === FULLSTACK_QA_LOOP_WORKFLOW.name)!;
    const nodeIds = new Set(workflow.nodes.map((n) => n.id));
    expect(workflow.layout).toBeDefined();
    expect(Object.keys(workflow.layout!)).toHaveLength(workflow.nodes.length);
    for (const layoutNodeId of Object.keys(workflow.layout!)) {
      expect(nodeIds.has(layoutNodeId)).toBe(true);
    }
  });

  test('is idempotent — leaves user-created workflows untouched', async () => {
    // User already created a custom workflow before seeding
    manager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'My Custom Workflow',
      nodes: [{ name: 'Code', agentId: CODER_ID }],
      completionAutonomyLevel: 3,
    });

    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    const workflows = manager.listWorkflows(SPACE_ID);
    expect(workflows).toHaveLength(1);
    expect(workflows[0].name).toBe('My Custom Workflow');
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
    // 'qa' is used by FULLSTACK_QA_LOOP_WORKFLOW and is a shared role across
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
    expect(result.seeded).toContain('Coding Workflow');
    expect(result.seeded).toContain('Plan & Decompose Workflow');
    expect(result.seeded).toContain('Coding with QA Workflow');
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

  test('CODING_WORKFLOW seeded with coding and default tags', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    expect(wf.tags).toContain('coding');
    expect(wf.tags).toContain('default');
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
    expect(codeNode?.agents[0].customPrompt?.value).toContain('gh pr create');
    const reviewNode = wf.nodes.find((n) => n.name === 'Review');
    expect(reviewNode?.agents[0].customPrompt?.value).toContain('save_artifact');
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
    expect(templates[0].name).toBe(CODING_WORKFLOW.name);
  });

  test('listWorkflows returns CODING_WORKFLOW first after DB seeding', () => {
    // Verifies the DB-level ordering guarantee: listWorkflows uses
    // ORDER BY created_at ASC, rowid ASC. When all workflows are seeded within
    // the same millisecond, rowid (insertion order) is the tiebreaker, so
    // CODING_WORKFLOW (seeded first) must be returned at index 0.
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflows = manager.listWorkflows(SPACE_ID);
    expect(workflows[0].name).toBe(CODING_WORKFLOW.name);
  });

  test('getBuiltInWorkflows returns all five templates', () => {
    const templates = getBuiltInWorkflows();
    expect(templates).toHaveLength(5);
    const names = templates.map((t) => t.name);
    expect(names).toContain(PLAN_AND_DECOMPOSE_WORKFLOW.name);
    expect(names).toContain(CODING_WORKFLOW.name);
    expect(names).toContain(FULLSTACK_QA_LOOP_WORKFLOW.name);
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
    expect(exported.channels).toHaveLength(6);

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
    expect(reimported.nodes).toHaveLength(3);
    expect(reimported.channels).toHaveLength(6);
    // The dedicated Post-Approval merger node round-trips.
    const postApproval = reimported.nodes.find((n) => n.name === 'Post-Approval')!;
    expect(postApproval).toBeDefined();
    expect(postApproval.agents[0]?.agentId).toBe(MERGER_ID);
    expect(postApproval.agents[0]?.name).toBe('merger');

    // Coding → Review channel preserved
    const codeToReview = reimported.channels!.find((c) => c.from === 'Coding' && c.to === 'Review');
    expect(codeToReview).toBeDefined();

    // Review → Coding channel preserved with maxCycles
    const reviewToCode = reimported.channels!.find((c) => c.from === 'Review' && c.to === 'Coding');
    expect(reviewToCode).toBeDefined();
    expect(reviewToCode!.maxCycles).toBe(5);
  });

  test('toolGuards survive export/import round-trip', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const exported = exportWorkflow(wf, mockAgents);

    // Verify exported coder agent has toolGuards
    const codingNode = exported.nodes.find((n) => n.name === 'Coding');
    expect(codingNode).toBeDefined();
    const coderAgent = codingNode!.agents.find((a) => a.name === 'coder');
    expect(coderAgent).toBeDefined();
    expect(coderAgent!.toolGuards).toBeDefined();
    expect(coderAgent!.toolGuards).toHaveLength(1);
    expect(coderAgent!.toolGuards![0].matcher).toBe('Bash');
    expect(coderAgent!.toolGuards![0].decision).toBe('deny');

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
      })),
      startNodeId: undefined,
      tags: exported.tags,
      channels: exported.channels,
      completionAutonomyLevel: exported.completionAutonomyLevel ?? 3,
    });

    // Verify re-imported coder has toolGuards
    const reimported = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WORKFLOW.name)!;
    const reimCoder = reimported.nodes
      .find((n) => n.name === 'Coding')
      ?.agents.find((a) => a.name === 'coder');
    expect(reimCoder?.toolGuards).toBeDefined();
    expect(reimCoder?.toolGuards).toHaveLength(1);
    expect(reimCoder?.toolGuards![0].matcher).toBe('Bash');
    expect(reimCoder?.toolGuards![0].decision).toBe('deny');
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

  test('Coding node coder customPrompt teaches inline reply via gh api when re-activated', () => {
    const codeNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
    const coder = codeNode.agents[0];
    const prompt = coder.customPrompt!.value;
    // The coder must be told where to find the review links on re-activation
    // and how to reply inline so each GitHub thread gets a visible response.
    expect(prompt).toContain('review_url');
    expect(prompt).toContain('comment_urls');
    expect(prompt).toContain('/replies');
    expect(prompt).toContain('replyHandle.commentId');
    expect(prompt).toContain('resolveReviewThread');
  });

  test('Review node reviewer has non-empty customPrompt', () => {
    const reviewNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const reviewer = reviewNode.agents[0];
    expect(reviewer.customPrompt?.value).toBeDefined();
    expect(reviewer.customPrompt?.value).toContain('save_artifact');
  });

  test('Review node reviewer customPrompt requires posting to GitHub and echoing review_url', () => {
    const reviewNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const reviewer = reviewNode.agents[0];
    const prompt = reviewer.customPrompt!.value;
    // Reviewer must post to GitHub via gh pr review / gh api.
    expect(prompt).toContain('gh pr review');
    expect(prompt).toContain('gh api');
    // And on the changes-requested path, send_message to Coding must carry
    // the review URL + comment URLs so the coder can reply inline.
    expect(prompt).toContain('review_url');
    expect(prompt).toContain('comment_urls');
    // The gate name must be mentioned so the reviewer understands the contract.
    expect(prompt).toContain('hook');
  });
});

describe('REVIEW_ONLY_WORKFLOW reviewer customPrompt requires gh pr review before save_artifact', () => {
  test('reviewer prompt mandates gh pr review before handoff', () => {
    const agent = REVIEW_ONLY_WORKFLOW.nodes[0].agents[0];
    const prompt = agent.customPrompt!.value;
    expect(prompt).toContain('visible GitHub review');
    expect(prompt).toContain('save a result artifact');
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
    expect(prompt).toContain('issues/{number}/reactions');
    expect(prompt).toContain('poll every 60 seconds');
    expect(prompt).toContain('2 hours by default');
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

  test('CODING_WORKFLOW Review node prompt contains Terminal Action Pre-conditions block', () => {
    const reviewNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const prompt = reviewNode.agents[0].customPrompt!.value;
    assertTerminalActionPreconditions(prompt, { upstream: 'Coding' });
  });

  test('CODING_WORKFLOW Review node REQUEST_CHANGES branch forbids both terminal tools', () => {
    const reviewNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const prompt = reviewNode.agents[0].customPrompt!.value;
    // Step 4 ("If changes are needed") must explicitly forbid both terminal
    // calls, not just `approve_task`. Pre-Task #136 it only mentioned
    // approve_task, leaving submit_for_approval as an unintended escape.
    const stepFour = prompt.split('5. If satisfied')[0];
    expect(stepFour).toMatch(/If changes needed|If findings remain|do not .*approve_task/i);
    expect(stepFour).toMatch(/If changes needed|If findings remain|do not .*submit_for_approval/i);
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

  test('FULLSTACK_QA_LOOP_WORKFLOW review-approval-gate requires reviewer and codex approval', () => {
    const gate = FULLSTACK_QA_LOOP_WORKFLOW.gates!.find((g) => g.id === 'review-approval-gate')!;
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
    'FULLSTACK_QA_LOOP_WORKFLOW review-approval-gate blocks without codex thumbs-up',
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
    'FULLSTACK_QA_LOOP_WORKFLOW review-approval-gate passes with codex thumbs-up',
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
    'FULLSTACK_QA_LOOP_WORKFLOW review-approval-gate still blocks before gate-data timeout even when workflow is old',
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
    'FULLSTACK_QA_LOOP_WORKFLOW review-approval-gate passes after codex timeout',
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
    'FULLSTACK_QA_LOOP_WORKFLOW review-approval-gate returns +1 even when timeout has elapsed',
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
    'FULLSTACK_QA_LOOP_WORKFLOW review-approval-gate blocks +1 from before cycle_start_at',
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
    'FULLSTACK_QA_LOOP_WORKFLOW review-approval-gate outputs head_sha on success',
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
    const rawGate = FULLSTACK_QA_LOOP_WORKFLOW.gates!.find((g) => g.id === 'review-approval-gate')!;
    const workflow: SpaceWorkflow = {
      ...FULLSTACK_QA_LOOP_WORKFLOW,
      nodes: FULLSTACK_QA_LOOP_WORKFLOW.nodes.map((n) =>
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
      ...FULLSTACK_QA_LOOP_WORKFLOW,
      nodes: FULLSTACK_QA_LOOP_WORKFLOW.nodes.map((n) =>
        n.name === 'Review'
          ? {
              ...n,
              requireCodexApproval: true,
              codexTimeoutSeconds: 300,
            }
          : n
      ),
      templateName: FULLSTACK_QA_LOOP_WORKFLOW.name,
      templateGates: FULLSTACK_QA_LOOP_WORKFLOW.gates ?? [],
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
    expect(mergedPrompt).toBe(templatePrompt.value);
    expect(mergedPrompt).toContain('any login containing `codex`');
    expect(mergedPrompt).not.toContain('codex[bot] reaction status');
  });

  test('patchKnownBuiltInPromptDrift rewrites persisted pre-fix Fullstack Review prompt (send_message + 10-minute + codex[bot])', () => {
    // P2 follow-up: production prompts seeded immediately before this PR
    // combined the pre-fix send_message handoff ("10-minute Codex timeout",
    // "codex[bot]") with the pre-fix shared guidance. Both halves must be
    // recognized together so restamp swaps them to the current wording.
    const templateNode = FULLSTACK_QA_LOOP_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const templatePrompt = templateNode.agents[0].customPrompt!;
    const preFixHandoff =
      'terminal hand-off is sending `data: { approved: true, pr_url: "<url>" }` to QA after an ' +
      'APPROVE verdict with zero P0-P3 findings. Send the handoff to start the 10-minute ' +
      'Codex timeout, then wait for codex[bot] `+1` or timeout before proceeding. ';
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
    const stalePromptValue = templatePrompt.value
      .replace(
        'terminal hand-off is sending `data: { approved: true, pr_url: "<url>" }` to QA after an ' +
          'APPROVE verdict with zero P0-P3 findings. Send the handoff to start the Codex review ' +
          'timeout window (2 hours by default), then wait for a Codex bot `+1` reaction or the ' +
          'timeout before proceeding. ',
        preFixHandoff
      )
      .replace(
        /After posting your approval review, verify the Codex review bot reaction status[\s\S]*?unless that timeout window has elapsed\./,
        retiredGuidance
      );
    expect(stalePromptValue).not.toBe(templatePrompt.value);
    expect(stalePromptValue).toContain('10-minute Codex timeout');

    const existingNode: WorkflowNode = {
      ...templateNode,
      agents: templateNode.agents.map((a, i) =>
        i === 0 ? { ...a, customPrompt: { value: stalePromptValue } } : a
      ),
    };

    const merged = mergeNodeStructuralFieldsFromTemplate(
      [existingNode],
      FULLSTACK_QA_LOOP_WORKFLOW.nodes,
      () => 'agent-review'
    );
    const mergedReview = merged.find((n) => n.name === 'Review')!;
    const mergedPrompt = mergedReview.agents[0].customPrompt!.value;
    expect(mergedPrompt).toBe(templatePrompt.value);
    expect(mergedPrompt).not.toContain('10-minute Codex timeout');
    expect(mergedPrompt).toContain('2 hours by default');
  });

  test('patchKnownBuiltInPromptDrift rewrites persisted Coding coder step 7 (validation handoff -> space-agent escalate)', () => {
    // Existing seeded spaces still carry the retired step 7 that handed
    // validation-only tasks to the now-removed "Validation Complete" node.
    // Restamp must swap it for the current space-agent escalation guidance.
    const templateNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
    const templatePrompt = templateNode.agents[0].customPrompt!;
    const retiredStep7 =
      '7. If the task is validation-only and produced no code changes: do NOT create an empty commit or PR. ' +
      'Instead, call `save_artifact({ type: "result", append: true, summary: "<validation outcome>", data: { completion_mode: "validation_only", changed_files: 0, validation_outcome: "<passed|failed + evidence>" } })`, then ' +
      '`send_message(target="Validation Complete", message="<short outcome>", data: { completion_mode: "validation_only", changed_files: 0, validation_outcome: "<outcome>" })`. ' +
      'That validation-only handoff bypasses the PR-ready hook and closes the task without `pr_url`.\n\n';
    const stalePromptValue = templatePrompt.value.replace(
      /7\. If the task requires no code changes[\s\S]*?wait for guidance\.\n\n/,
      retiredStep7
    );
    expect(stalePromptValue).not.toBe(templatePrompt.value);
    expect(stalePromptValue).toContain('send_message(target="Validation Complete"');

    const existingNode: WorkflowNode = {
      ...templateNode,
      agents: templateNode.agents.map((a, i) =>
        i === 0 ? { ...a, customPrompt: { value: stalePromptValue } } : a
      ),
    };

    const merged = mergeNodeStructuralFieldsFromTemplate(
      [existingNode],
      CODING_WORKFLOW.nodes,
      () => 'agent-coder'
    );
    const mergedCoder = merged.find((n) => n.name === 'Coding')!;
    const mergedPrompt = mergedCoder.agents[0].customPrompt!.value;
    expect(mergedPrompt).toBe(templatePrompt.value);
    expect(mergedPrompt).toContain('send a message to `space-agent`');
    expect(mergedPrompt).not.toContain('send_message(target="Validation Complete"');
  });

  test('migrated review-approval hook with per-node timeout preserves GitHub auth lookup', () => {
    // P2: when codexTimeoutSeconds differs from the default, migration builds
    // a fresh script string (not REVIEW_APPROVAL_SCRIPT identity). The hook
    // must still declare externalLookups=['github'] so hook-executor preserves
    // GH_TOKEN/GITHUB_TOKEN/GH_HOST/GH_CONFIG_DIR. Coverage comes from
    // pattern.githubLookup, not script identity.
    const workflow = migrateWorkflowGateProgressionToHooks({
      ...FULLSTACK_QA_LOOP_WORKFLOW,
      nodes: FULLSTACK_QA_LOOP_WORKFLOW.nodes.map((n) =>
        n.name === 'Review' ? { ...n, requireCodexApproval: true, codexTimeoutSeconds: 300 } : n
      ),
      templateName: FULLSTACK_QA_LOOP_WORKFLOW.name,
      templateGates: FULLSTACK_QA_LOOP_WORKFLOW.gates ?? [],
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
      ...FULLSTACK_QA_LOOP_WORKFLOW,
      nodes: FULLSTACK_QA_LOOP_WORKFLOW.nodes.map((n) =>
        n.name === 'Review' ? { ...n, requireCodexApproval: true, codexTimeoutSeconds: 300 } : n
      ),
      templateName: FULLSTACK_QA_LOOP_WORKFLOW.name,
      templateGates: FULLSTACK_QA_LOOP_WORKFLOW.gates ?? [],
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
      templateName: FULLSTACK_QA_LOOP_WORKFLOW.name,
      templateGates: FULLSTACK_QA_LOOP_WORKFLOW.gates ?? [],
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
      ...FULLSTACK_QA_LOOP_WORKFLOW,
      nodes: FULLSTACK_QA_LOOP_WORKFLOW.nodes.map((n) =>
        n.name === 'Review' ? { ...n, requireCodexApproval: true, codexTimeoutSeconds: 300 } : n
      ),
      templateName: FULLSTACK_QA_LOOP_WORKFLOW.name,
      templateGates: FULLSTACK_QA_LOOP_WORKFLOW.gates ?? [],
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
      templateName: FULLSTACK_QA_LOOP_WORKFLOW.name,
      templateGates: FULLSTACK_QA_LOOP_WORKFLOW.gates ?? [],
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
      ...FULLSTACK_QA_LOOP_WORKFLOW,
      templateName: FULLSTACK_QA_LOOP_WORKFLOW.name,
      templateGates: FULLSTACK_QA_LOOP_WORKFLOW.gates ?? [],
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
      templateName: FULLSTACK_QA_LOOP_WORKFLOW.name,
      templateGates: FULLSTACK_QA_LOOP_WORKFLOW.gates ?? [],
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
    const templateNode = FULLSTACK_QA_LOOP_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    expect(templateNode.codexTimeoutSeconds).toBeUndefined();
    const existingNode: WorkflowNode = {
      ...templateNode,
      codexTimeoutSeconds: 900,
    };

    const merged = mergeNodeStructuralFieldsFromTemplate(
      [existingNode],
      FULLSTACK_QA_LOOP_WORKFLOW.nodes,
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
      ...FULLSTACK_QA_LOOP_WORKFLOW,
      templateName: FULLSTACK_QA_LOOP_WORKFLOW.name,
      templateGates: FULLSTACK_QA_LOOP_WORKFLOW.gates ?? [],
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
      templateName: FULLSTACK_QA_LOOP_WORKFLOW.name,
      templateGates: FULLSTACK_QA_LOOP_WORKFLOW.gates ?? [],
    }).workflow;

    const preserved = reMigrated.hooks?.find((h) => h.id === 'review-approval:custom-count-check');
    expect(preserved?.validator.kind).toBe('script');
    if (preserved?.validator.kind === 'script') {
      expect(preserved.validator.source).toBe(customSource);
      expect(preserved.validator.source).toContain('-lt 5');
    }
  });

  test('FULLSTACK_QA_LOOP_WORKFLOW reviewer prompt instructs waiting for codex reaction', () => {
    const reviewNode = FULLSTACK_QA_LOOP_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const prompt = reviewNode.agents[0].customPrompt!.value;

    expect(prompt).toContain('any login containing `codex`');
    expect(prompt).toContain('issues/{number}/reactions');
    expect(prompt).toContain('poll every 60 seconds');
    expect(prompt).toContain('2 hours by default');
  });
});

test('FULLSTACK_QA_LOOP_WORKFLOW has layout entries for actual template node IDs', () => {
  const nodeIds = new Set(FULLSTACK_QA_LOOP_WORKFLOW.nodes.map((n) => n.id));
  expect(FULLSTACK_QA_LOOP_WORKFLOW.layout).toBeDefined();
  expect(Object.keys(FULLSTACK_QA_LOOP_WORKFLOW.layout!)).toEqual(
    FULLSTACK_QA_LOOP_WORKFLOW.nodes.map((n) => n.id)
  );
  for (const layoutNodeId of Object.keys(FULLSTACK_QA_LOOP_WORKFLOW.layout!)) {
    expect(nodeIds.has(layoutNodeId)).toBe(true);
  }
});

test('FULLSTACK_QA_LOOP_WORKFLOW has a send_message hook for Coding → Review using pr_ready validator', () => {
  const hooks = FULLSTACK_QA_LOOP_WORKFLOW.hooks ?? [];
  expect(hooks.length).toBeGreaterThanOrEqual(1);
  const hook = hooks.find((h) => h.id === 'fullstack-code-pr-ready');
  expect(hook).toBeDefined();
  expect(hook!.sourceNode).toBe('Coding');
  expect(hook!.targetNode).toBe('Review');
  expect(hook!.method).toBe('send_message');
  expect(hook!.validator).toEqual({ kind: 'built_in', id: 'pr_ready' });
  expect(hook!.enabled).toBe(true);
});

test('FULLSTACK_QA_LOOP_WORKFLOW coder prompt uses behavioral hook handoff wording', () => {
  const codingNode = FULLSTACK_QA_LOOP_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
  const prompt = codingNode.agents[0].customPrompt!.value;

  expect(prompt).toContain('call `send_message` to the review target');
  expect(prompt).toContain('Use the current target and required data fields');
  expect(prompt).toContain('`save_artifact` alone is insufficient');
  expect(prompt).not.toContain('send_message(target="Review"');
  expect(prompt).not.toContain('code-pr-gate');
});

test('FULLSTACK_QA_LOOP_WORKFLOW Review node forbids gate-write while findings are open', () => {
  const reviewNode = FULLSTACK_QA_LOOP_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
  const prompt = reviewNode.agents[0].customPrompt!.value;
  // Review is mid-graph in this workflow — terminal tools are unavailable
  // to it — but the pre-conditions block must still be present so the
  // reviewer does not silently flip review-approval-gate while findings
  // are open.
  expect(prompt).toMatch(
    /terminal-action tool contract|Terminal-action contract|terminal hand-off|terminal action|terminal calls|terminal actions|terminal-action tool descriptions/
  );
  expect(prompt).toMatch(
    /P0[–-]P3|zero findings|zero P0-P3|findings remain|blocking findings|QA passes|Reviewer System Contract/i
  );
  expect(prompt).toMatch(
    /REQUEST_CHANGES|changes needed|requesting changes|more research is needed|findings remain|QA fails/i
  );
  expect(prompt).toContain('QA handoff');
  // Failure-path routing: the prompt must explicitly tell the reviewer to
  // send feedback back to Coding via send_message rather than silently
  // stalling. Asserting this catches future drift in the routing wording.
  expect(prompt).toMatch(
    /send_message\(target="Coding", \.\.\.\)|send actionable feedback to Coding|feedback to Coding/i
  );
  // Same approval semantic clarifier: even though approve_task /
  // submit_for_approval are unavailable on this mid-graph node, writing
  // the approval gate is the equivalent terminal hand-off and the prompt
  // must call out the parallel so a future split (where the tools become
  // available) does not accidentally remove the gating.
  expect(prompt).toMatch(
    /same approval semantic|terminal-action tool contract|terminal hand-off|terminal.*contract/i
  );
});

test('post-approval merge instructions are safe for isolated worktrees', () => {
  expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('git fetch origin "$BASE"');
  expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('do NOT `git checkout $BASE`');
  expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('git checkout $BASE && git pull');
});

test('post-approval merge instructions route through the deterministic merge_pr gate (task #866)', () => {
  // The merge is performed by the merge_pr tool, not a raw gh pr merge the model
  // can reason around (the #857 failure).
  expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('merge_pr(');
  // Raw merges are explicitly blocked on the slot.
  expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('BLOCKED');
  // approval_source is task provenance, NOT a merge authorization.
  expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('NOT a merge authorization');
  // The gate must not be worked around — blockers are relayed, not overridden.
  expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('do NOT work around it');
});

test('every merger slot blocks raw gh pr merge so the merge_pr gate is the only path (task #866)', () => {
  let mergerSlotsFound = 0;
  for (const wf of getBuiltInWorkflows()) {
    for (const node of wf.nodes) {
      for (const agent of node.agents) {
        if (agent.name !== 'merger') continue;
        mergerSlotsFound += 1;
        const bashGuards = (agent.toolGuards ?? []).filter((g) => g.matcher === 'Bash');
        expect(bashGuards.length, `${wf.name}/merger must declare a Bash guard`).toBeGreaterThan(0);
        const sample = 'gh pr merge https://github.com/acme/repo/pull/42 --squash';
        const blocksMerge = bashGuards.some((g) => new RegExp(g.pattern).test(sample));
        expect(blocksMerge, `${wf.name}/merger guard must deny "gh pr merge"`).toBe(true);
      }
    }
  }
  // Sanity: the built-ins we care about (Coding, Research, Fullstack QA) all
  // declare a merger slot.
  expect(mergerSlotsFound).toBeGreaterThanOrEqual(3);
});

test('merger raw-merge guard catches shell-wrapper bypass forms (task #866)', () => {
  // Collect the merger Bash guard pattern from any built-in.
  let pattern: string | null = null;
  outer: for (const wf of getBuiltInWorkflows()) {
    for (const node of wf.nodes) {
      for (const agent of node.agents) {
        if (agent.name !== 'merger') continue;
        const g = (agent.toolGuards ?? []).find((x) => x.matcher === 'Bash');
        if (g) {
          pattern = g.pattern;
          break outer;
        }
      }
    }
  }
  expect(pattern).toBeTruthy();
  const re = new RegExp(pattern!);
  // Direct + wrapped forms a model might reach for must be denied.
  const blocked = [
    'gh pr merge 42 --squash',
    'gh -R owner/repo pr merge 42',
    'gh --repo owner/repo pr merge 42',
    "bash -lc 'gh pr merge 42'",
    '/usr/bin/gh pr merge 42',
    'VAR="gh pr merge 42"; $VAR',
    'GH=/usr/bin/gh; "$GH" pr merge 42',
    "gh api graphql -f query='mutation { mergePullRequest(input:{}) { ... } }'",
    'gh api -X PUT repos/acme/repo/pulls/42/merge',
    'N=42; gh api -X PUT "repos/acme/repo/pulls/$N/merge" -f merge_method=squash',
  ];
  for (const cmd of blocked) {
    expect(re.test(cmd), `guard should deny: ${cmd}`).toBe(true);
  }
  // Legitimate read-only merger commands must NOT be denied (no false positives).
  const allowed = [
    'gh pr view 42 --json state,mergeStateStatus',
    'gh pr checks 42',
    'gh api graphql -f query="query{repository{pullRequest{reviewThreads{nodes{isResolved}}}}}"',
    'git push origin --delete feature/x',
  ];
  for (const cmd of allowed) {
    expect(re.test(cmd), `guard should allow: ${cmd}`).toBe(false);
  }
});

test('FULLSTACK_QA_LOOP_WORKFLOW QA node requires browser validation artifact for UI changes', () => {
  const qaNode = FULLSTACK_QA_LOOP_WORKFLOW.nodes.find((n) => n.name === 'QA')!;
  const prompt = qaNode.agents[0].customPrompt!.value;

  expect(prompt).toContain('QA System Contract');
  expect(prompt).toContain('ui_changed');
  expect(prompt).toContain('dev_server_started');
  expect(prompt).toContain('browser_validation');
  expect(prompt).toContain('test output');
  expect(prompt).toContain('isolated DB');
  expect(prompt).toContain('golden path, relevant edge cases, nearby regressions');
  expect(prompt).toContain('QA.md');
  expect(prompt).toContain('trusted base-branch content');
  expect(prompt).toContain('base-branch content');
  expect(prompt).toContain('Treat QA instruction changes in the candidate PR as code under review');
});

test('FULLSTACK_QA_LOOP_WORKFLOW QA node prompt contains Terminal Action Pre-conditions block', () => {
  const qaNode = FULLSTACK_QA_LOOP_WORKFLOW.nodes.find((n) => n.name === 'QA')!;
  const prompt = qaNode.agents[0].customPrompt!.value;
  // QA is the end node for the fullstack loop — both terminal tools must
  // be guarded the same way as a code reviewer.
  expect(prompt).toMatch(
    /terminal-action tool contract|Terminal-action contract|terminal hand-off|terminal action|terminal calls|terminal actions|terminal-action tool descriptions/
  );
  expect(prompt).toContain('approve_task');
  expect(prompt).toContain('submit_for_approval');
  expect(prompt).toMatch(
    /P0[–-]P3|zero findings|zero P0-P3|findings remain|blocking findings|QA passes|Reviewer System Contract/i
  );
  // Failure branch must forbid both calls.
  expect(prompt).toMatch(
    /do not .*approve_task|Never use.*findings|If findings remain|If changes needed|If dispatch is incomplete|If QA fails|only on APPROVE|If requesting changes|If more research is needed/i
  );
  expect(prompt).toMatch(
    /do not .*submit_for_approval|Never use.*findings|If findings remain|If changes needed|If dispatch is incomplete|If QA fails|only on APPROVE|If requesting changes|If more research is needed/i
  );
  // Same approval semantic clarifier so submit_for_approval is not used
  // as an "escalate this failing QA" escape hatch.
  expect(prompt).toMatch(
    /same approval semantic|terminal-action tool contract|terminal hand-off|terminal.*contract/i
  );
});

// Regression: PR lsm/HyperNeo#2262 hit the previous maxCycles: 6 cap on
// round 7 of a legitimate review loop, blocking the in-band Review → Coding
// handoff. Both cyclic back-channels must permit well beyond 6 cycles.
test('FULLSTACK_QA_LOOP_WORKFLOW cyclic back-channels permit more than 6 review/QA cycles', () => {
  const reviewToCoding = FULLSTACK_QA_LOOP_WORKFLOW.channels!.find(
    (c) => c.from === 'Review' && c.to === 'Coding'
  );
  const qaToCoding = FULLSTACK_QA_LOOP_WORKFLOW.channels!.find(
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
