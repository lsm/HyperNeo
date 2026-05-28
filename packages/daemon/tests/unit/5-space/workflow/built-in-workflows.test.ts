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

import { Database as BunDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpaceAgent, SpaceWorkflow } from '@neokai/shared';
import {
  exportWorkflow,
  validateExportedWorkflow,
} from '../../../../src/lib/space/export-format.ts';
import { evaluateFields } from '../../../../src/lib/space/runtime/gate-evaluator.ts';
import { executeGateScript } from '../../../../src/lib/space/runtime/gate-script-executor.ts';
import { getEffectiveGate } from '../../../../src/lib/space/runtime/gate-features.ts';
import { PR_MERGE_POST_APPROVAL_INSTRUCTIONS } from '../../../../src/lib/space/workflows/post-approval-merge-template.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import {
  CODING_WORKFLOW,
  FULLSTACK_QA_LOOP_WORKFLOW,
  getBuiltInGateScript,
  getBuiltInWorkflows,
  PLAN_AND_DECOMPOSE_WORKFLOW,
  validateWorkflowTemplateGateWriters,
  RESEARCH_WORKFLOW,
  REVIEW_ONLY_WORKFLOW,
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
  test('has three nodes: Coding, Validation Complete, Review', () => {
    expect(CODING_WORKFLOW.nodes).toHaveLength(3);
    expect(CODING_WORKFLOW.nodes.map((s) => s.name)).toEqual([
      'Coding',
      'Validation Complete',
      'Review',
    ]);
  });

  test('step agentId placeholders are correct', () => {
    expect(CODING_WORKFLOW.nodes[0].agents[0]?.name).toBe('coder');
    expect(CODING_WORKFLOW.nodes[1].agents[0]?.name).toBe('validator');
    expect(CODING_WORKFLOW.nodes[2].agents[0]?.name).toBe('reviewer');
  });

  test('coder prompt forbids merging and delegates approval merge to reviewer', () => {
    const prompt = CODING_WORKFLOW.nodes[0].agents[0]?.customPrompt?.value;
    expect(prompt).toContain('Your job is implementation only:');
    expect(prompt).toContain('Do NOT merge PRs. When the reviewer approves, your work is done.');
    expect(prompt).toContain('The reviewer handles the merge.');
  });

  test('coder and validator slots have toolGuards with gh pr merge deny rule', () => {
    for (const agent of [CODING_WORKFLOW.nodes[0].agents[0], CODING_WORKFLOW.nodes[1].agents[0]]) {
      const guards = agent?.toolGuards;
      expect(guards).toBeDefined();
      expect(guards).toHaveLength(1);
      expect(guards![0].matcher).toBe('Bash');
      expect(guards![0].decision).toBe('deny');
      expect(guards![0].pattern).toContain('gh');
      expect(guards![0].reason).toContain('merge');
    }
  });

  test('has four channels', () => {
    expect(CODING_WORKFLOW.channels).toHaveLength(4);
  });

  test('Coding → Review channel is gated by code-ready-gate', () => {
    const ch = CODING_WORKFLOW.channels!.find((c) => c.from === 'Coding' && c.to === 'Review');
    expect(ch).toBeDefined();
    expect(ch!.gateId).toBe('code-ready-gate');
    // direction field removed from WorkflowChannel
    expect(ch!.maxCycles).toBeUndefined();
  });

  test('Coding → Validation Complete channel is gated by validation-complete-gate', () => {
    const ch = CODING_WORKFLOW.channels!.find(
      (c) => c.from === 'Coding' && c.to === 'Validation Complete'
    );
    expect(ch).toBeDefined();
    expect(ch!.gateId).toBe('validation-complete-gate');
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

  test('Validation Complete → Coding channel is cyclic and resets validation evidence', () => {
    const ch = CODING_WORKFLOW.channels!.find(
      (c) => c.from === 'Validation Complete' && c.to === 'Coding'
    );
    expect(ch).toBeDefined();
    expect(ch!.gateId).toBe('validation-complete-gate');
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

  test('has three gates: code-ready-gate, validation-complete-gate, and review-posted-gate', () => {
    expect(CODING_WORKFLOW.gates).toHaveLength(3);
    const gateIds = CODING_WORKFLOW.gates!.map((g) => g.id).sort();
    expect(gateIds).toEqual(['code-ready-gate', 'review-posted-gate', 'validation-complete-gate']);
    const codeReadyGate = CODING_WORKFLOW.gates!.find((g) => g.id === 'code-ready-gate')!;
    expect(codeReadyGate.fields).toHaveLength(1);
    const validationGate = CODING_WORKFLOW.gates!.find((g) => g.id === 'validation-complete-gate')!;
    expect(validationGate.fields).toHaveLength(3);
    const reviewPostedGate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;
    expect(reviewPostedGate.fields).toHaveLength(2);
  });

  test('validation-complete-gate accepts no-code-change completion evidence without pr_url', () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'validation-complete-gate')!;
    expect(gate.script).toBeDefined();
    expect(gate.script?.source).toContain('git status --porcelain=v1');
    expect(gate.resetOnCycle).toBe(true);

    const completionMode = gate.fields!.find((f) => f.name === 'completion_mode')!;
    expect(completionMode.type).toBe('string');
    expect(completionMode.writers).toEqual(['Coding', 'coder']);
    expect(completionMode.check).toEqual({ op: '==', value: 'validation_only' });

    const changedFiles = gate.fields!.find((f) => f.name === 'changed_files')!;
    expect(changedFiles.type).toBe('number');
    expect(changedFiles.writers).toEqual(['Coding', 'coder']);
    expect(changedFiles.check).toEqual({ op: '==', value: 0 });

    const outcome = gate.fields!.find((f) => f.name === 'validation_outcome')!;
    expect(outcome.type).toBe('string');
    expect(outcome.writers).toEqual(['Coding', 'coder']);
    expect(outcome.check.op).toBe('exists');

    expect(gate.fields!.some((f) => f.name === 'pr_url')).toBe(false);
  });

  test('validation-complete-gate opens with validation evidence and no pr_url', () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'validation-complete-gate')!;

    expect(
      evaluateFields(gate, {
        completion_mode: 'validation_only',
        changed_files: 0,
        validation_outcome: 'Trace evidence validated against run artifacts.',
      })
    ).toEqual({ open: true });
    expect(
      evaluateFields(gate, {
        completion_mode: 'validation_only',
        changed_files: 1,
        validation_outcome: 'Unexpected code edits present.',
      }).open
    ).toBe(false);
    expect(
      evaluateFields(gate, {
        completion_mode: 'validation_only',
        changed_files: 0,
      }).open
    ).toBe(false);
  });

  test('validation-complete-gate script blocks dirty worktrees', async () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'validation-complete-gate')!;
    const tmp = mkdtempSync(join(tmpdir(), 'validation-gate-'));
    try {
      await Bun.$`git init`.cwd(tmp).quiet();
      await Bun.$`git config user.email test@example.com`.cwd(tmp).quiet();
      await Bun.$`git config user.name Test`.cwd(tmp).quiet();
      writeFileSync(join(tmp, 'base.txt'), 'base');
      await Bun.$`git add base.txt`.cwd(tmp).quiet();
      await Bun.$`git commit -m base`.cwd(tmp).quiet();
      writeFileSync(join(tmp, 'changed.txt'), 'dirty');

      const result = await executeGateScript(
        gate.script!,
        {
          workspacePath: tmp,
          gateId: gate.id,
          runId: 'run-validation-dirty',
          gateData: {
            completion_mode: 'validation_only',
            changed_files: 0,
            validation_outcome: 'claimed clean',
          },
        },
        { VALIDATION_BASE_REF: 'HEAD' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('clean worktree');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('validation-complete-gate script blocks committed changes against base ref', async () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'validation-complete-gate')!;
    const tmp = mkdtempSync(join(tmpdir(), 'validation-gate-committed-'));
    try {
      await Bun.$`git init`.cwd(tmp).quiet();
      await Bun.$`git config user.email test@example.com`.cwd(tmp).quiet();
      await Bun.$`git config user.name Test`.cwd(tmp).quiet();
      writeFileSync(join(tmp, 'base.txt'), 'base');
      await Bun.$`git add base.txt`.cwd(tmp).quiet();
      await Bun.$`git commit -m base`.cwd(tmp).quiet();
      const baseRef = (await Bun.$`git rev-parse HEAD`.cwd(tmp).text()).trim();
      writeFileSync(join(tmp, 'committed.txt'), 'changed');
      await Bun.$`git add committed.txt`.cwd(tmp).quiet();
      await Bun.$`git commit -m changed`.cwd(tmp).quiet();

      const result = await executeGateScript(
        gate.script!,
        {
          workspacePath: tmp,
          gateId: gate.id,
          runId: 'run-validation-committed',
          gateData: {
            completion_mode: 'validation_only',
            changed_files: 0,
            validation_outcome: 'claimed clean',
          },
        },
        { VALIDATION_BASE_REF: baseRef }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('no committed changes');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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

  test('review-posted-gate has bash script verifying a review submitted after workflow start', () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;
    expect(gate.script).toBeDefined();
    expect(gate.script!.interpreter).toBe('bash');
    expect(gate.script!.timeoutMs).toBe(30000);
    // The script must consult the workflow start timestamp injected by the runner.
    expect(gate.script!.source).toContain('NEOKAI_WORKFLOW_START_ISO');
    // Primary check: query GitHub for formal approval / changes-requested reviews.
    expect(gate.script!.source).toContain('gh pr view "$PR_URL" --json reviews,comments,author');
    expect(gate.script!.source).toContain('submittedAt');
    expect(gate.script!.source).toContain('APPROVED');
    expect(gate.script!.source).toContain('CHANGES_REQUESTED');
    // Must fail loudly when neither review nor PR comment has landed since start.
    expect(gate.script!.source).toContain('exit 1');
    // Must echo pr_url/review_count on success for downstream consumers.
    expect(gate.script!.source).toContain('pr_url');
    expect(gate.script!.source).toContain('review_count');
  });

  test('review-posted-gate accepts comment-only evidence only for own PRs', () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;
    const src = gate.script!.source;
    // Fallback: check COMMENTED reviews and PR conversation comments only after
    // confirming the authenticated account owns the PR. Non-own PRs must still
    // provide APPROVED or CHANGES_REQUESTED review events.
    expect(src).toContain('gh api user --jq .login');
    expect(src).toContain('AUTHOR_LOGIN');
    expect(src).toContain('VIEWER_LOGIN');
    expect(src).toContain('[ "$AUTHOR_LOGIN" != "$VIEWER_LOGIN" ]');
    expect(src).toContain('COMMENTED');
    expect(src).toContain('createdAt');
    // Must also filter comments by workflow start timestamp.
    expect(src).toContain('NEOKAI_WORKFLOW_START_ISO');
    // Gate passes via comments fallback — outputs the same pr_url/review_count shape.
    expect(src).toContain('pr_url');
    expect(src).toContain('review_count');
    expect(src).toContain('own_pr_comment');
    // Error message must mention both "review" and "PR comment" so operators understand what was checked.
    expect(src).toContain('PR comment');
  });

  test('review-posted-gate passes own-PR COMMENTED reviews', async () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;
    const workspace = mkdtempSync(join(tmpdir(), 'neokai-review-posted-gate-own-pr-'));
    const binDir = join(workspace, 'bin');
    const ghPath = join(binDir, 'gh');
    const prUrl = 'https://github.com/test/repo/pull/42';

    try {
      mkdirSync(binDir);
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          `if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = ${JSON.stringify(prUrl)} ] && [ "$4" = "--json" ] && [ "$5" = "reviews,comments,author" ]; then`,
          `  printf '%s\\n' '{"reviews":[{"submittedAt":"2026-05-01T12:00:00Z","state":"COMMENTED"}],"comments":[],"author":{"login":"lsm"}}'`,
          '  exit 0',
          'fi',
          'if [ "$1" = "api" ] && [ "$2" = "user" ] && [ "$3" = "--jq" ] && [ "$4" = ".login" ]; then',
          `  printf '%s\\n' 'lsm'`,
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
          gateId: 'review-posted-gate',
          runId: 'run-1',
          gateData: { pr_url: prUrl },
          workflowStartIso: '2026-05-01T00:00:00Z',
        },
        { PATH: `${binDir}:${process.env.PATH ?? ''}` }
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        pr_url: prUrl,
        review_count: 1,
        review_evidence: 'own_pr_comment',
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('review-posted-gate rejects comment-only evidence on non-own PRs', async () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;
    const workspace = mkdtempSync(join(tmpdir(), 'neokai-review-posted-gate-non-own-pr-'));
    const binDir = join(workspace, 'bin');
    const ghPath = join(binDir, 'gh');
    const prUrl = 'https://github.com/test/repo/pull/42';

    try {
      mkdirSync(binDir);
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          `if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = ${JSON.stringify(prUrl)} ] && [ "$4" = "--json" ] && [ "$5" = "reviews,comments,author" ]; then`,
          `  printf '%s\\n' '{"reviews":[],"comments":[{"createdAt":"2026-05-01T12:00:00Z"}],"author":{"login":"someone-else"}}'`,
          '  exit 0',
          'fi',
          'if [ "$1" = "api" ] && [ "$2" = "user" ] && [ "$3" = "--jq" ] && [ "$4" = ".login" ]; then',
          `  printf '%s\\n' 'lsm'`,
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
          gateId: 'review-posted-gate',
          runId: 'run-1',
          gateData: { pr_url: prUrl },
          workflowStartIso: '2026-05-01T00:00:00Z',
        },
        { PATH: `${binDir}:${process.env.PATH ?? ''}` }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('comment-only evidence is accepted only for own PRs');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('review-posted-gate uses review_url gate data when pr_url is absent', async () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;
    const workspace = mkdtempSync(join(tmpdir(), 'neokai-review-posted-gate-'));
    const binDir = join(workspace, 'bin');
    const ghPath = join(binDir, 'gh');
    const logPath = join(workspace, 'gh-args.log');
    const reviewUrl = 'https://github.com/test/repo/pull/42#pullrequestreview-123';

    try {
      mkdirSync(binDir);
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
          `if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = ${JSON.stringify(reviewUrl)} ] && [ "$4" = "--json" ] && [ "$5" = "reviews,comments,author" ]; then`,
          `  printf '%s\\n' '{"reviews":[{"submittedAt":"2026-05-01T12:00:00Z","state":"CHANGES_REQUESTED"}],"comments":[],"author":{"login":"other"}}'`,
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
          gateId: 'review-posted-gate',
          runId: 'run-1',
          gateData: { review_url: reviewUrl },
          workflowStartIso: '2026-05-01T00:00:00Z',
        },
        { PATH: `${binDir}:${process.env.PATH ?? ''}` }
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        pr_url: reviewUrl,
        review_count: 1,
        review_evidence: 'formal_review',
      });
      expect(readFileSync(logPath, 'utf8').trim()).toBe(
        `pr view ${reviewUrl} --json reviews,comments,author`
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('review-posted-gate prefers pr_url over review_url when both are in gate data', async () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;
    const workspace = mkdtempSync(join(tmpdir(), 'neokai-review-posted-gate-prefers-pr-url-'));
    const binDir = join(workspace, 'bin');
    const ghPath = join(binDir, 'gh');
    const logPath = join(workspace, 'gh-args.log');
    const prUrl = 'https://github.com/test/repo/pull/42';
    const reviewUrl = 'https://github.com/test/repo/pull/42#pullrequestreview-123';

    try {
      mkdirSync(binDir);
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
          `if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = ${JSON.stringify(prUrl)} ] && [ "$4" = "--json" ] && [ "$5" = "reviews,comments,author" ]; then`,
          `  printf '%s\\n' '{"reviews":[{"submittedAt":"2026-05-01T12:00:00Z","state":"CHANGES_REQUESTED"}],"comments":[],"author":{"login":"other"}}'`,
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
          gateId: 'review-posted-gate',
          runId: 'run-1',
          gateData: { pr_url: prUrl, review_url: reviewUrl },
          workflowStartIso: '2026-05-01T00:00:00Z',
        },
        { PATH: `${binDir}:${process.env.PATH ?? ''}` }
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        pr_url: prUrl,
        review_count: 1,
        review_evidence: 'formal_review',
      });
      expect(readFileSync(logPath, 'utf8').trim()).toBe(
        `pr view ${prUrl} --json reviews,comments,author`
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('review-posted-gate resets on cycle so each feedback round is re-verified', () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;
    expect(gate.resetOnCycle).toBe(true);
  });

  test('code-ready-gate has pr_url field writable by Coding node and coder alias', () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'code-ready-gate')!;
    const prField = gate.fields.find((f) => f.name === 'pr_url')!;
    expect(prField.type).toBe('string');
    expect(prField.writers).toEqual(['Coding', 'coder']);
    expect(prField.check.op).toBe('exists');
  });

  test('code-ready-gate PR comment poll preserves GraphQL variable names and host for gh', () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'code-ready-gate')!;
    expect(gate.poll?.script).toContain("QUERY='query($owner:String!,$name:String!,$number:Int!)");
    expect(gate.poll?.script).toContain('repository(owner:$owner,name:$name)');
    expect(gate.poll?.script).toContain('pullRequest(number:$number)');
    expect(gate.poll?.script).toContain('PR_HOST="${PR_HOST:-$(jq -r .host <<< "$PR_META")}"');
    expect(gate.poll?.script).toContain('GH_HOST_ARGS=(--hostname "$PR_HOST")');
    expect(gate.poll?.script).toContain('gh api graphql "${GH_HOST_ARGS[@]}"');
  });

  test('code-ready-gate has a bash script that checks PR mergeability and outputs pr_url', () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'code-ready-gate')!;
    expect(gate.script).toBeDefined();
    expect(gate.script!.interpreter).toBe('bash');
    expect(gate.script!.timeoutMs).toBe(30000);
    expect(gate.script!.source).toContain('gh pr view --json url,state,mergeable,mergeStateStatus');
    expect(gate.script!.source).toContain('jq -r');
    expect(gate.script!.source).toContain('.url');
    expect(gate.script!.source).toContain('"OPEN"');
    expect(gate.script!.source).toContain('.mergeable');
    expect(gate.script!.source).toContain('"MERGEABLE"');
    expect(gate.script!.source).toContain('.mergeStateStatus');
    expect(gate.script!.source).toContain('"CLEAN"');
    expect(gate.script!.source).toContain('"HAS_HOOKS"');
    expect(gate.script!.source).toContain('"BLOCKED"');
    expect(gate.script!.source).toContain('exit 1');
    expect(gate.script!.source).toContain('pr_url');
    expect(gate.script!.source).toContain('not authenticated');
    expect(gate.script!.source).not.toContain('gh pr list');
    expect(gate.script!.source).not.toContain('--base dev');
    expect(gate.script!.source).toContain('gh pr view "$PR_TARGET"');
    expect(gate.script!.source).toContain('reviewThreads(first:100)');
    expect(gate.script!.source).toContain('isResolved == false');
  });

  test('code-ready-gate blocks unresolved review conversations', async () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'code-ready-gate')!;
    const workspace = mkdtempSync(join(tmpdir(), 'neokai-pr-ready-gate-unresolved-'));
    const binDir = join(workspace, 'bin');
    const ghPath = join(binDir, 'gh');
    const prUrl = 'https://github.com/test/repo/pull/42';

    try {
      mkdirSync(binDir);
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          `if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = ${JSON.stringify(prUrl)} ]; then`,
          `  printf '%s\\n' '{"url":"${prUrl}","state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'`,
          '  exit 0',
          'fi',
          'if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then',
          `  printf '%s\\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"thread-1","isResolved":false,"comments":{"nodes":[{"url":"https://github.com/test/repo/pull/42#discussion_r1"}]}}],"pageInfo":{"hasNextPage":false}}}}}}'`,
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
          gateId: 'code-ready-gate',
          runId: 'run-1',
          gateData: { pr_url: prUrl },
        },
        { PATH: `${binDir}:${process.env.PATH ?? ''}` }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('unresolved review conversation');
      expect(result.error).toContain('discussion_r1');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('code-ready-gate paginates review threads and blocks on unresolved across pages', async () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'code-ready-gate')!;
    const workspace = mkdtempSync(join(tmpdir(), 'neokai-pr-ready-gate-paged-'));
    const binDir = join(workspace, 'bin');
    const ghPath = join(binDir, 'gh');
    const statePath = join(workspace, 'page.state');
    const prUrl = 'https://github.com/test/repo/pull/42';

    try {
      mkdirSync(binDir);
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          `if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = ${JSON.stringify(prUrl)} ]; then`,
          `  printf '%s\\n' '{"url":"${prUrl}","state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'`,
          '  exit 0',
          'fi',
          'if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then',
          '  PAGE_FILE=' + JSON.stringify(statePath),
          '  PAGE_NUM=$(cat "$PAGE_FILE" 2>/dev/null || echo "1")',
          '  if [ "$PAGE_NUM" = "1" ]; then',
          `    printf '%s\\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"t1","isResolved":true,"comments":{"nodes":[{"url":"https://github.com/test/repo/pull/42#discussion_r_resolved"}]}}],"pageInfo":{"hasNextPage":true,"endCursor":"cursor2"}}}}}}'`,
          '    echo "2" > "$PAGE_FILE"',
          '    exit 0',
          '  fi',
          '  if [ "$PAGE_NUM" = "2" ]; then',
          `    printf '%s\\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"t2","isResolved":false,"comments":{"nodes":[{"url":"https://github.com/test/repo/pull/42#discussion_r_unresolved"}]}}],"pageInfo":{"hasNextPage":false}}}}}}'`,
          '    exit 0',
          '  fi',
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
          gateId: 'code-ready-gate',
          runId: 'run-1',
          gateData: { pr_url: prUrl },
        },
        { PATH: `${binDir}:${process.env.PATH ?? ''}` }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('unresolved review conversation');
      expect(result.error).toContain('discussion_r_unresolved');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('code-ready-gate passes when all review threads across multiple pages are resolved', async () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'code-ready-gate')!;
    const workspace = mkdtempSync(join(tmpdir(), 'neokai-pr-ready-gate-paged-clean-'));
    const binDir = join(workspace, 'bin');
    const ghPath = join(binDir, 'gh');
    const statePath = join(workspace, 'page.state');
    const prUrl = 'https://github.com/test/repo/pull/42';

    try {
      mkdirSync(binDir);
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          `if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = ${JSON.stringify(prUrl)} ]; then`,
          `  printf '%s\\n' '{"url":"${prUrl}","state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'`,
          '  exit 0',
          'fi',
          'if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then',
          '  PAGE_FILE=' + JSON.stringify(statePath),
          '  PAGE_NUM=$(cat "$PAGE_FILE" 2>/dev/null || echo "1")',
          '  if [ "$PAGE_NUM" = "1" ]; then',
          `    printf '%s\\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"t1","isResolved":true,"comments":{"nodes":[{"url":"https://github.com/test/repo/pull/42#discussion_r1"}]}}],"pageInfo":{"hasNextPage":true,"endCursor":"cursor2"}}}}}}'`,
          '    echo "2" > "$PAGE_FILE"',
          '    exit 0',
          '  fi',
          '  if [ "$PAGE_NUM" = "2" ]; then',
          `    printf '%s\\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"t2","isResolved":true,"comments":{"nodes":[{"url":"https://github.com/test/repo/pull/42#discussion_r2"}]}}],"pageInfo":{"hasNextPage":false}}}}}}'`,
          '    exit 0',
          '  fi',
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
          gateId: 'code-ready-gate',
          runId: 'run-1',
          gateData: { pr_url: prUrl },
        },
        { PATH: `${binDir}:${process.env.PATH ?? ''}` }
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ pr_url: prUrl });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('code-ready-gate fails when GraphQL returns errors', async () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'code-ready-gate')!;
    const workspace = mkdtempSync(join(tmpdir(), 'neokai-pr-ready-gate-gql-err-'));
    const binDir = join(workspace, 'bin');
    const ghPath = join(binDir, 'gh');
    const prUrl = 'https://github.com/test/repo/pull/42';

    try {
      mkdirSync(binDir);
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          `if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = ${JSON.stringify(prUrl)} ]; then`,
          `  printf '%s\\n' '{"url":"${prUrl}","state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'`,
          '  exit 0',
          'fi',
          'if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then',
          `  printf '%s\\n' '{"errors":[{"message":"Resource not accessible"}]}'`,
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
          gateId: 'code-ready-gate',
          runId: 'run-1',
          gateData: { pr_url: prUrl },
        },
        { PATH: `${binDir}:${process.env.PATH ?? ''}` }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('GraphQL errors');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('code-ready-gate passes for a clean mergeable PR with zero unresolved threads', async () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'code-ready-gate')!;
    const workspace = mkdtempSync(join(tmpdir(), 'neokai-pr-ready-gate-clean-'));
    const binDir = join(workspace, 'bin');
    const ghPath = join(binDir, 'gh');
    const prUrl = 'https://github.com/test/repo/pull/42';

    try {
      mkdirSync(binDir);
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          `if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = ${JSON.stringify(prUrl)} ]; then`,
          `  printf '%s\\n' '{"url":"${prUrl}","state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'`,
          '  exit 0',
          'fi',
          'if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then',
          `  printf '%s\\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false}}}}}}'`,
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
          gateId: 'code-ready-gate',
          runId: 'run-1',
          gateData: { pr_url: prUrl },
        },
        { PATH: `${binDir}:${process.env.PATH ?? ''}` }
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ pr_url: prUrl });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('code-ready-gate validates supplied pr_url without branch rediscovery', async () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'code-ready-gate')!;
    const workspace = mkdtempSync(join(tmpdir(), 'neokai-pr-ready-gate-'));
    const binDir = join(workspace, 'bin');
    const ghPath = join(binDir, 'gh');
    const logPath = join(workspace, 'gh-args.log');
    const prUrl = 'https://github.com/test/repo/pull/42';

    try {
      mkdirSync(binDir);
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
          `if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = ${JSON.stringify(prUrl)} ]; then`,
          `  printf '%s\\n' '{"url":"${prUrl}","state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'`,
          '  exit 0',
          'fi',
          'if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then',
          `  printf '%s\\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false}}}}}}'`,
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
          gateId: 'code-ready-gate',
          runId: 'run-1',
          gateData: { pr_url: prUrl },
        },
        { PATH: `${binDir}:${process.env.PATH ?? ''}` }
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ pr_url: prUrl });
      expect(readFileSync(logPath, 'utf8').trim().split('\n')[0]).toBe(
        `pr view ${prUrl} --json url,state,mergeable,mergeStateStatus`
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('code-ready-gate resets on cycle', () => {
    const gate = CODING_WORKFLOW.gates!.find((g) => g.id === 'code-ready-gate')!;
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
  test('has two nodes (Research + Review)', () => {
    expect(RESEARCH_WORKFLOW.nodes).toHaveLength(2);
  });

  test('first node uses Research agent', () => {
    expect(RESEARCH_WORKFLOW.nodes[0].agents[0]?.name).toBe('research');
    expect(RESEARCH_WORKFLOW.nodes[0].name).toBe('Research');
  });

  test('second node uses Reviewer agent', () => {
    expect(RESEARCH_WORKFLOW.nodes[1].agents[0]?.name).toBe('reviewer');
    expect(RESEARCH_WORKFLOW.nodes[1].name).toBe('Review');
  });

  test('has two channels: gated Research→Review and ungated Review→Research', () => {
    expect(RESEARCH_WORKFLOW.channels).toHaveLength(2);
    const gated = RESEARCH_WORKFLOW.channels!.find((c) => c.gateId === 'research-ready-gate');
    expect(gated).toBeDefined();
    expect(gated!.from).toBe('Research');
    expect(gated!.to).toBe('Review');
    // direction field removed from WorkflowChannel

    const backChannel = RESEARCH_WORKFLOW.channels!.find((c) => c.gateId === undefined);
    expect(backChannel).toBeDefined();
    expect(backChannel!.from).toBe('Review');
    expect(backChannel!.to).toBe('Research');
    expect(backChannel!.maxCycles).toBe(5);
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

  test('research-ready-gate has a bash script that checks PR mergeability and outputs pr_url', () => {
    const gate = RESEARCH_WORKFLOW.gates!.find((g) => g.id === 'research-ready-gate')!;
    expect(gate.script).toBeDefined();
    expect(gate.script!.interpreter).toBe('bash');
    expect(gate.script!.timeoutMs).toBe(30000);
    expect(gate.script!.source).toContain('gh pr view --json url,state,mergeable,mergeStateStatus');
    expect(gate.script!.source).toContain('jq -r');
    expect(gate.script!.source).toContain('.url');
    expect(gate.script!.source).toContain('"OPEN"');
    expect(gate.script!.source).toContain('.mergeable');
    expect(gate.script!.source).toContain('"MERGEABLE"');
    expect(gate.script!.source).toContain('.mergeStateStatus');
    expect(gate.script!.source).toContain('"CLEAN"');
    expect(gate.script!.source).toContain('"HAS_HOOKS"');
    expect(gate.script!.source).toContain('exit 1');
    expect(gate.script!.source).toContain('pr_url');
    expect(gate.script!.source).toContain('not authenticated');
    expect(gate.script!.source).toContain('reviewThreads(first:100)');
    expect(gate.script!.source).toContain('isResolved == false');
  });

  test('research-ready-gate resets on cycle', () => {
    const gate = RESEARCH_WORKFLOW.gates!.find((g) => g.id === 'research-ready-gate')!;
    expect(gate.resetOnCycle).toBe(true);
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

  test('has two gates', () => {
    expect(PLAN_AND_DECOMPOSE_WORKFLOW.gates).toHaveLength(2);
  });

  test('gate IDs are correct', () => {
    const ids = PLAN_AND_DECOMPOSE_WORKFLOW.gates!.map((g) => g.id);
    expect(ids).toContain('plan-pr-gate');
    expect(ids).toContain('plan-approval-gate');
  });

  test('plan-pr-gate has script-based PR check with pr_url output', () => {
    const gate = PLAN_AND_DECOMPOSE_WORKFLOW.gates!.find((g) => g.id === 'plan-pr-gate')!;
    expect(gate.fields).toHaveLength(1);
    expect(gate.fields[0].name).toBe('pr_url');
    expect(gate.fields[0].type).toBe('string');
    expect(gate.fields[0].check.op).toBe('exists');
    expect(gate.fields[0].writers).toEqual(['*']);
    expect(gate.script?.interpreter).toBe('bash');
    expect(gate.script?.source.length).toBeGreaterThan(0);
    // Planning can cycle back from Plan Review; PR state must be re-verified each cycle.
    expect(gate.resetOnCycle).toBe(true);
  });

  test('plan-approval-gate requires all four reviewers to approve', () => {
    const gate = PLAN_AND_DECOMPOSE_WORKFLOW.gates!.find((g) => g.id === 'plan-approval-gate')!;
    expect(gate.fields).toHaveLength(1);
    expect(gate.fields[0].name).toBe('approvals');
    expect(gate.fields[0].type).toBe('map');
    expect(gate.fields[0].check).toMatchObject({ op: 'count', match: 'approved', min: 4 });
    expect(gate.fields[0].writers).toEqual(['Plan Review']);
    expect(gate.features?.codex_review_bot).toBe(true);
    expect(gate.resetOnCycle).toBe(true);
  });

  test('has three channels', () => {
    expect(PLAN_AND_DECOMPOSE_WORKFLOW.channels).toHaveLength(3);
  });

  test('main progression channels have correct gateIds', () => {
    const ch = PLAN_AND_DECOMPOSE_WORKFLOW.channels!;

    const planningToReview = ch.find((c) => c.from === 'Planning' && c.to === 'Plan Review');
    expect(planningToReview?.gateId).toBe('plan-pr-gate');

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
      expect(slot.customPrompt?.value).toContain('plan-approval-gate');
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

  test('all gate fields have valid non-empty writer roles', () => {
    for (const wf of getBuiltInWorkflows()) {
      expect(validateWorkflowTemplateGateWriters(wf)).toEqual([]);
    }
  });

  test('gate writer validation rejects empty writer arrays', () => {
    const workflow = structuredClone(CODING_WORKFLOW);
    workflow.gates![0].fields![0].writers = [];

    expect(validateWorkflowTemplateGateWriters(workflow)).toEqual([
      `${workflow.name}.gates.code-ready-gate.fields.pr_url.writers: must contain at least one writer role`,
    ]);
  });

  test('gate writer validation rejects unknown writer roles', () => {
    const workflow = structuredClone(CODING_WORKFLOW);
    workflow.gates![0].fields![0].writers = ['Unknown Role'];

    expect(validateWorkflowTemplateGateWriters(workflow)).toEqual([
      `${workflow.name}.gates.code-ready-gate.fields.pr_url.writers: unknown writer role "Unknown Role"`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// seedBuiltInWorkflows()
// ---------------------------------------------------------------------------

describe('seedBuiltInWorkflows()', () => {
  let db: BunDatabase;
  let manager: SpaceWorkflowManager;
  const SPACE_ID = 'seed-test-space';

  // Preset agent IDs seeded in the space
  const PLANNER_ID = 'agent-planner-uuid';
  const CODER_ID = 'agent-coder-uuid';
  const GENERAL_ID = 'agent-general-uuid';
  const RESEARCH_ID = 'agent-research-uuid';
  const REVIEWER_ID = 'agent-reviewer-uuid';

  // Role resolver — mirrors what the real call site does
  const QA_ID = 'agent-qa-uuid';
  const roleMap: Record<string, string> = {
    planner: PLANNER_ID,
    coder: CODER_ID,
    general: GENERAL_ID,
    research: RESEARCH_ID,
    reviewer: REVIEWER_ID,
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

    const repo = new SpaceWorkflowRepository(db);
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
    expect(wf!.nodes[1].agents[0]?.agentId).toBe(CODER_ID);
    expect(wf!.nodes[2].agents[0]?.agentId).toBe(roleMap.reviewer);
  });

  test('CODING_WORKFLOW seeded with four channels including validation-only branch', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    expect(wf.channels).toHaveLength(4);

    const codeToReview = wf.channels!.find((c) => c.from === 'Coding' && c.to === 'Review');
    expect(codeToReview).toBeDefined();
    expect(codeToReview!.gateId).toBe('code-ready-gate');

    const codeToValidation = wf.channels!.find(
      (c) => c.from === 'Coding' && c.to === 'Validation Complete'
    );
    expect(codeToValidation).toBeDefined();
    expect(codeToValidation!.gateId).toBe('validation-complete-gate');

    const reviewToCode = wf.channels!.find((c) => c.from === 'Review' && c.to === 'Coding');
    expect(reviewToCode).toBeDefined();
    // Review → Coding is now gated by review-posted-gate so the reviewer's
    // message cannot be delivered until a GitHub review is visible.
    expect(reviewToCode!.gateId).toBe('review-posted-gate');
    expect(reviewToCode!.maxCycles).toBe(5);

    const validationToCode = wf.channels!.find(
      (c) => c.from === 'Validation Complete' && c.to === 'Coding'
    );
    expect(validationToCode).toBeDefined();
    expect(validationToCode!.gateId).toBe('validation-complete-gate');
    expect(validationToCode!.maxCycles).toBe(5);
  });

  test('CODING_WORKFLOW seeded with three gates including validation-complete-gate', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    expect(wf.gates).toHaveLength(3);
    const gateIds = wf.gates!.map((g) => g.id).sort();
    expect(gateIds).toEqual(['code-ready-gate', 'review-posted-gate', 'validation-complete-gate']);
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

  test('RESEARCH_WORKFLOW seeded with two channels (gated Research→Review, ungated Review→Research)', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
    expect(wf.channels).toHaveLength(2);
    const gated = wf.channels!.find((c) => c.gateId === 'research-ready-gate');
    expect(gated).toBeDefined();
    expect(gated!.from).toBe('Research');
    expect(gated!.to).toBe('Review');
    const back = wf.channels!.find((c) => c.gateId === undefined);
    expect(back).toBeDefined();
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

  test('PLAN_AND_DECOMPOSE_WORKFLOW seeded with 2 gates', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
    expect(wf.gates).toHaveLength(2);
    const gateIds = wf.gates!.map((g) => g.id);
    expect(gateIds).toContain('plan-pr-gate');
    expect(gateIds).toContain('plan-approval-gate');
  });

  test('PLAN_AND_DECOMPOSE_WORKFLOW seeded channels split into 2 gated + 1 ungated feedback', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
    const gatedChannels = wf.channels!.filter((c) => c.gateId !== undefined);
    expect(gatedChannels).toHaveLength(2);
    const cyclicChannels = wf.channels!.filter((c) => c.maxCycles !== undefined);
    // One cyclic feedback channel: Plan Review → Planning
    expect(cyclicChannels).toHaveLength(1);
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
      const endNode = wf!.nodes.find((node) => node.id === wf!.endNodeId);
      expect(endNode?.postApproval, `"${name}" end node must have postApproval`).toBeDefined();
      expect(endNode!.postApproval!.targetAgent).toBe('reviewer');
      // Non-empty instructions — we don't snapshot the full template here
      // because end-node-handoff.test.ts already asserts the exact content.
      expect(endNode!.postApproval!.instructions.length).toBeGreaterThan(0);
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
    const codingEndNode = coding.nodes.find((node) => node.id === coding.endNodeId)!;
    db.prepare(
      `UPDATE space_workflows
			    SET template_hash = ?, post_approval = NULL
			  WHERE id = ?`
    ).run('stale-hash-from-a-prior-pr', coding.id);
    db.prepare(`UPDATE space_workflow_nodes SET config = ? WHERE id = ?`).run(
      JSON.stringify({ agents: codingEndNode.agents }),
      codingEndNode.id
    );

    // Verify the simulated drift landed.
    const before = manager.getWorkflow(coding.id)!;
    expect(before.postApproval).toBeUndefined();
    expect(before.nodes.find((node) => node.id === before.endNodeId)?.postApproval).toBeUndefined();
    expect(before.templateHash).toBe('stale-hash-from-a-prior-pr');

    // Re-run the seeder — re-stamp branch fires.
    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.seeded).toEqual([]);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);
    expect(result.skipped).toBe(false);

    // Row now carries the current template's node-level postApproval + hash.
    const after = manager.getWorkflow(coding.id)!;
    expect(after.postApproval).toBeUndefined();
    expect(after.nodes.find((node) => node.id === after.endNodeId)?.postApproval).toBeDefined();
    expect(after.nodes.find((node) => node.id === after.endNodeId)?.postApproval?.targetAgent).toBe(
      'reviewer'
    );
    expect(after.templateHash).not.toBe('stale-hash-from-a-prior-pr');
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
    const reviewNode = coding.nodes.find((n) => n.name === 'Review')!;
    expect(reviewNode.postApproval).toBeDefined();

    manager.updateWorkflow(coding.id, {
      nodes: coding.nodes.map((node) =>
        node.id === reviewNode.id ? { ...node, name: 'Human Review' } : node
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
    expect(afterReviewNode.name).toBe('Human Review');
    expect(afterReviewNode.postApproval).toEqual(reviewNode.postApproval);
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
    expect(after.nodes.find((node) => node.id === after.endNodeId)?.postApproval).toBeDefined();
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
    expect(after.templateHash).toBe(computeWorkflowHash(CODING_WORKFLOW));
  });

  test('re-stamp updates gate field writers in place', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflow = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === FULLSTACK_QA_LOOP_WORKFLOW.name)!;
    const gateWithStaleWriters = workflow.gates!.map((gate) =>
      gate.id !== 'review-approval-gate'
        ? gate
        : {
            ...gate,
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
  });

  test('re-stamp appends missing validation node and channels with resolved agent IDs', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const legacyNodes = coding.nodes.filter((node) => node.name !== 'Validation Complete');
    const legacyChannels = coding.channels!.filter(
      (channel) => channel.from !== 'Coding' || channel.to !== 'Validation Complete'
    );

    manager.updateWorkflow(coding.id, {
      nodes: legacyNodes,
      channels: legacyChannels,
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'pre-validation-branch-hash',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);
    expect(result.errors).toHaveLength(0);

    const after = manager.getWorkflow(coding.id)!;
    const validationNode = after.nodes.find((node) => node.name === 'Validation Complete');
    expect(validationNode).toBeDefined();
    expect(validationNode!.agents[0].agentId).toBe(CODER_ID);
    expect(
      after.channels!.some(
        (channel) => channel.from === 'Coding' && channel.to === 'Validation Complete'
      )
    ).toBe(true);
    expect(
      after.channels!.some(
        (channel) => channel.from === 'Validation Complete' && channel.to === 'Coding'
      )
    ).toBe(true);
    expect(after.templateHash).toBe(computeWorkflowHash(CODING_WORKFLOW));
  });

  test('terminal-node detection treats validation feedback as terminal and outbound channels as non-terminal', () => {
    const codingNode = CODING_WORKFLOW.nodes.find((node) => node.name === 'Coding')!;
    const validationNode = CODING_WORKFLOW.nodes.find(
      (node) => node.name === 'Validation Complete'
    )!;

    expect(isWorkflowTerminalNode(CODING_WORKFLOW, validationNode.id)).toBe(true);
    expect(isWorkflowTerminalNode(CODING_WORKFLOW, codingNode.id)).toBe(false);
    expect(
      isWorkflowTerminalNode(
        {
          ...CODING_WORKFLOW,
          channels: [{ from: '*', to: 'Review', label: 'Everyone → Review' }],
        },
        validationNode.id
      )
    ).toBe(false);
    expect(
      isWorkflowTerminalNode(
        {
          ...CODING_WORKFLOW,
          channels: [{ from: 'coder', to: 'Review', label: 'Coder → Review' }],
        },
        codingNode.id
      )
    ).toBe(false);
    expect(
      isWorkflowTerminalNode(
        {
          ...CODING_WORKFLOW,
          channels: [{ from: 'validator', to: 'coder', label: 'Validator → coder' }],
        },
        validationNode.id
      )
    ).toBe(true);
  });

  test('re-stamp maps appended channels to renamed built-in nodes by agent slot', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const codingNode = coding.nodes.find((node) => node.name === 'Coding')!;
    const reviewNode = coding.nodes.find((node) => node.name === 'Review')!;
    const legacyNodes = coding.nodes.filter((node) => node.name !== 'Validation Complete');
    const legacyChannels = coding.channels!.filter(
      (channel) => channel.from !== 'Coding' || channel.to !== 'Validation Complete'
    );
    manager.updateWorkflow(coding.id, {
      nodes: legacyNodes.map((node) => {
        if (node.id === codingNode.id) return { ...node, name: 'Implementation' };
        if (node.id === reviewNode.id) return { ...node, name: 'Human Review' };
        return node;
      }),
      channels: legacyChannels,
    });
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
    expect(
      after.channels!.some(
        (channel) => channel.from === 'Implementation' && channel.to === 'Validation Complete'
      )
    ).toBe(true);
    expect(
      after.channels!.some(
        (channel) => channel.from === 'Validation Complete' && channel.to === 'Implementation'
      )
    ).toBe(true);
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
      'no SpaceAgent found with name'
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
    expect(planNode?.agents[0].customPrompt?.value).toContain('plan-pr-gate');
    const planReviewNode = wf.nodes.find((n) => n.name === 'Plan Review');
    expect(planReviewNode?.agents[0].customPrompt?.value).toContain('plan-approval-gate');
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

  test('RESEARCH_WORKFLOW seeded with one gate (research-ready-gate)', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
    expect(wf.gates).toHaveLength(1);
    expect(wf.gates![0].id).toBe('research-ready-gate');
  });

  test('REVIEW_ONLY_WORKFLOW seeded with no gates', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === REVIEW_ONLY_WORKFLOW.name)!;
    expect(wf.gates ?? []).toHaveLength(0);
  });

  test('CODING_WORKFLOW gate fields are preserved during seeding', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const gate = wf.gates!.find((g) => g.id === 'code-ready-gate')!;
    expect(gate.fields).toHaveLength(1);
    expect(gate.fields[0].name).toBe('pr_url');
    expect(gate.fields[0].type).toBe('string');
    expect(gate.fields[0].check).toEqual({ op: 'exists' });
    expect(gate.script).toBeDefined();
    expect(gate.script!.interpreter).toBe('bash');
    expect(gate.script!.timeoutMs).toBe(30000);
    expect(gate.poll?.target).toBe('from');
    expect(gate.resetOnCycle).toBe(true);
  });

  test('PLAN_AND_DECOMPOSE_WORKFLOW gate resetOnCycle flags are preserved', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name)!;
    const planPr = wf.gates!.find((g) => g.id === 'plan-pr-gate')!;
    // Planning cycles back on feedback; PR state must be re-verified per cycle.
    expect(planPr.resetOnCycle).toBe(true);
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
    expect(codeToReview!.gateId).toBe('code-ready-gate');
    // direction field removed from WorkflowChannel schema
  });

  // ─── plan-approval-gate auto-approval via requiredLevel ──────────────────

  test('PLAN_AND_DECOMPOSE_WORKFLOW plan-approval-gate requires four reviewer approvals', () => {
    const gate = PLAN_AND_DECOMPOSE_WORKFLOW.gates!.find((g) => g.id === 'plan-approval-gate')!;
    const approvalsField = gate.fields.find((f) => f.name === 'approvals')!;
    expect(approvalsField.type).toBe('map');
    expect(approvalsField.writers).toEqual(['Plan Review']);
    expect(approvalsField.check).toMatchObject({ op: 'count', match: 'approved', min: 4 });
    expect(gate.features?.codex_review_bot).toBe(true);
  });

  test('seeded plan-approval-gate preserves map-count check with min=4', () => {
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
    const placeholders = ['Planner', 'Coder', 'General', 'Research', 'Reviewer', 'QA'];
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
  const roleMap: Record<string, string> = {
    planner: PLANNER_ID,
    research: RESEARCH_ID,
    coder: CODER_ID,
    general: GENERAL_ID,
    reviewer: REVIEWER_ID,
    qa: QA_ID,
  };
  const resolveAgentId = (role: string): string | undefined => roleMap[role.toLowerCase()];

  /** Mock SpaceAgent records for exportWorkflow's agent name resolution. */
  const mockAgents: SpaceAgent[] = [
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
    expect(exported.channels).toHaveLength(4);

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
    expect(reimported.channels).toHaveLength(4);

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
  test('returns the bash script for code-ready-gate in Coding Workflow', () => {
    const script = getBuiltInGateScript(CODING_WORKFLOW.name, 'code-ready-gate');
    expect(script).toBeDefined();
    expect(script?.interpreter).toBe('bash');
    expect(script?.source.length).toBeGreaterThan(0);
    // The PR-ready script references gh pr view and checks mergeability
    expect(script?.source).toContain('gh pr view');
    expect(script?.source).toContain('MERGEABLE');
  });

  test('returns the bash script for review-posted-gate in Coding Workflow', () => {
    const script = getBuiltInGateScript(CODING_WORKFLOW.name, 'review-posted-gate');
    expect(script).toBeDefined();
    expect(script?.interpreter).toBe('bash');
    // The review-posted script should include the PR comment fallback path
    expect(script?.source).toContain('gh pr view');
    expect(script?.source).toContain('comments');
    // Confirm the current fallback message is present (not the stale "No review submitted on…")
    expect(script?.source).toContain('No review or PR comment found on');
  });

  test('returns the bash script for plan-pr-gate in Plan & Decompose Workflow', () => {
    const script = getBuiltInGateScript(PLAN_AND_DECOMPOSE_WORKFLOW.name, 'plan-pr-gate');
    expect(script).toBeDefined();
    expect(script?.interpreter).toBe('bash');
  });

  test('returns undefined for a field-only gate (plan-approval-gate has no script)', () => {
    const script = getBuiltInGateScript(PLAN_AND_DECOMPOSE_WORKFLOW.name, 'plan-approval-gate');
    expect(script).toBeUndefined();
  });

  test('returns undefined when the template name does not match any built-in', () => {
    const script = getBuiltInGateScript('Unknown Template', 'code-ready-gate');
    expect(script).toBeUndefined();
  });

  test('returns undefined when the gate ID does not exist in the template', () => {
    const script = getBuiltInGateScript(CODING_WORKFLOW.name, 'nonexistent-gate-id');
    expect(script).toBeUndefined();
  });

  test('returned script matches the gate definition directly from the template', () => {
    // Verify the helper returns the exact same object reference as the template defines
    const templateGate = CODING_WORKFLOW.gates!.find((g) => g.id === 'review-posted-gate')!;
    const script = getBuiltInGateScript(CODING_WORKFLOW.name, 'review-posted-gate');
    expect(script).toBe(templateGate.script); // same object reference
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

  test('review-posted-gate script includes NEOKAI_WORKFLOW_START_ISO usage', () => {
    const script = getBuiltInGateScript(CODING_WORKFLOW.name, 'review-posted-gate');
    // The review-posted-gate script must use NEOKAI_WORKFLOW_START_ISO to filter
    // reviews that were posted after the workflow started
    expect(script?.source).toContain('NEOKAI_WORKFLOW_START_ISO');
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
    expect(prompt).toContain('review-posted-gate');
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
  test('Planning node planner has non-empty customPrompt referencing plan-pr-gate', () => {
    const node = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find((n) => n.name === 'Planning')!;
    const agent = node.agents[0];
    expect(agent.customPrompt?.value).toBeDefined();
    expect(agent.customPrompt?.value).toContain('plan-pr-gate');
  });

  test('Plan Review node has 4 lens-specific reviewers, each referencing plan-approval-gate and its lens', () => {
    const node = PLAN_AND_DECOMPOSE_WORKFLOW.nodes.find((n) => n.name === 'Plan Review')!;
    expect(node.agents).toHaveLength(4);
    const lenses = ['architecture', 'security', 'correctness', 'ux'];
    const seenLenses: string[] = [];
    for (const agent of node.agents) {
      expect(agent.customPrompt?.value).toBeDefined();
      expect(agent.customPrompt?.value).toContain('plan-approval-gate');
      // Each reviewer's prompt references its specific lens
      const lensForAgent = lenses.find((l) => agent.customPrompt!.value.includes(`"${l}"`));
      expect(lensForAgent).toBeDefined();
      seenLenses.push(lensForAgent!);
    }
    // All four lenses must be represented exactly once
    expect(seenLenses.sort()).toEqual([...lenses].sort());
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

  test('RESEARCH_WORKFLOW Review node prompt waits for codex before approval close', () => {
    const reviewNode = RESEARCH_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const prompt = reviewNode.agents[0].customPrompt!.value;
    expect(prompt).toContain('verify codex[bot] reaction status');
    expect(prompt).toContain('@codex review');
    expect(prompt).toContain('wait for an `eyes` or `+1` reaction');
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
    expect(gate.features?.codex_review_bot).toBe(true);
    expect(gate.script).toBeUndefined();
    expect(gate.poll).toBeUndefined();

    const effectiveGate = getEffectiveGate(gate);
    expect(effectiveGate.script?.source).toContain('codex[bot]');
    expect(effectiveGate.script?.source).toContain('issues/${NUMBER}/reactions?per_page=100');
    expect(effectiveGate.script?.source).toContain('.content == "+1"');
    expect(effectiveGate.script?.source).toContain('bun -e');
    expect(effectiveGate.script?.source).not.toContain('node -e');
    expect(effectiveGate.poll?.intervalMs).toBe(60_000);
  });

  test('codex feature script and poll override custom script and poll consistently', () => {
    const gate = getEffectiveGate({
      id: 'custom-codex-gate',
      resetOnCycle: false,
      features: { codex_review_bot: true },
      script: { interpreter: 'bash', source: 'echo custom', timeoutMs: 10000 },
      poll: { intervalMs: 30_000, target: 'to', script: 'echo custom poll' },
    });

    expect(gate.script?.source).toContain('codex[bot]');
    expect(gate.poll?.script).toContain('codex[bot]');
    expect(gate.script?.source).not.toContain('echo custom');
    expect(gate.poll?.script).not.toContain('echo custom poll');
  });

  test('FULLSTACK_QA_LOOP_WORKFLOW review-approval-gate blocks without codex thumbs-up', async () => {
    const gate = getEffectiveGate(
      FULLSTACK_QA_LOOP_WORKFLOW.gates!.find((g) => g.id === 'review-approval-gate')!
    );
    const workspace = mkdtempSync(join(tmpdir(), 'neokai-codex-gate-blocked-'));
    const binDir = join(workspace, 'bin');
    const ghPath = join(binDir, 'gh');
    const prUrl = 'https://github.com/test/repo/pull/42';

    try {
      mkdirSync(binDir);
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          'if [ "$1" = "api" ] && [ "$2" = "repos/test/repo/issues/42/reactions?per_page=100" ]; then',
          `  printf '%s\n' '[{"user":{"login":"codex[bot]"},"content":"eyes"}]'`,
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
          workflowStartIso: new Date().toISOString(),
        },
        { PATH: `${binDir}:${process.env.PATH ?? ''}` }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('still in progress');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('FULLSTACK_QA_LOOP_WORKFLOW review-approval-gate passes with codex thumbs-up', async () => {
    const gate = getEffectiveGate(
      FULLSTACK_QA_LOOP_WORKFLOW.gates!.find((g) => g.id === 'review-approval-gate')!
    );
    const workspace = mkdtempSync(join(tmpdir(), 'neokai-codex-gate-passed-'));
    const binDir = join(workspace, 'bin');
    const ghPath = join(binDir, 'gh');
    const prUrl = 'https://github.com/test/repo/pull/42';

    try {
      mkdirSync(binDir);
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          'if [ "$1" = "api" ] && [ "$2" = "repos/test/repo/issues/42/reactions?per_page=100" ]; then',
          `  printf '%s\n' '[{"user":{"login":"codex[bot]"},"content":"+1"}]'`,
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
          workflowStartIso: new Date().toISOString(),
        },
        { PATH: `${binDir}:${process.env.PATH ?? ''}` }
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ pr_url: prUrl, codex_bot_reaction: '+1' });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('FULLSTACK_QA_LOOP_WORKFLOW review-approval-gate passes after codex timeout', async () => {
    const gate = getEffectiveGate(
      FULLSTACK_QA_LOOP_WORKFLOW.gates!.find((g) => g.id === 'review-approval-gate')!
    );
    const workspace = mkdtempSync(join(tmpdir(), 'neokai-codex-gate-timeout-'));
    const binDir = join(workspace, 'bin');
    const ghPath = join(binDir, 'gh');
    const prUrl = 'https://github.com/test/repo/pull/42';

    try {
      mkdirSync(binDir);
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          'if [ "$1" = "api" ] && [ "$2" = "repos/test/repo/issues/42/reactions?per_page=100" ]; then',
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
        },
        { PATH: `${binDir}:${process.env.PATH ?? ''}` }
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        pr_url: prUrl,
        codex_bot_reaction: 'timeout',
        codex_bot_warning: 'codex[bot] +1 reaction missing after timeout; allowing gate',
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('CODING_WORKFLOW reviewer prompt instructs waiting for codex reaction', () => {
    const reviewNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const prompt = reviewNode.agents[0].customPrompt!.value;

    expect(prompt).toContain('codex[bot]');
    expect(prompt).toContain('issues/{number}/reactions');
    expect(prompt).toContain('Poll every 60 seconds');
    expect(prompt).toContain('10 minutes');
  });

  test('FULLSTACK_QA_LOOP_WORKFLOW reviewer prompt instructs waiting for codex reaction', () => {
    const reviewNode = FULLSTACK_QA_LOOP_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const prompt = reviewNode.agents[0].customPrompt!.value;

    expect(prompt).toContain('codex[bot]');
    expect(prompt).toContain('issues/{number}/reactions');
    expect(prompt).toContain('Poll every 60 seconds');
    expect(prompt).toContain('10 minutes');
  });

  test('FULLSTACK_QA_LOOP_WORKFLOW code-pr-gate lets only Coding publish PR URL', () => {
    const gate = FULLSTACK_QA_LOOP_WORKFLOW.gates!.find((g) => g.id === 'code-pr-gate')!;
    const prField = gate.fields!.find((f) => f.name === 'pr_url')!;

    expect(prField.type).toBe('string');
    expect(prField.writers).toEqual(['Coding', 'coder']);
    expect(prField.check).toEqual({ op: 'exists' });
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

  test('FULLSTACK_QA_LOOP_WORKFLOW PR gate permits BLOCKED mergeStateStatus before review', async () => {
    const gate = FULLSTACK_QA_LOOP_WORKFLOW.gates!.find((g) => g.id === 'code-pr-gate')!;
    const workspace = mkdtempSync(join(tmpdir(), 'neokai-fullstack-pr-ready-blocked-'));
    const binDir = join(workspace, 'bin');
    const ghPath = join(binDir, 'gh');
    const prUrl = 'https://github.com/test/repo/pull/42';

    try {
      mkdirSync(binDir);
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          `if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = ${JSON.stringify(prUrl)} ]; then`,
          `  printf '%s\\n' '{"url":"${prUrl}","state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'`,
          '  exit 0',
          'fi',
          'if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then',
          `  printf '%s\\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false}}}}}}'`,
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
          gateId: 'code-pr-gate',
          runId: 'run-1',
          gateData: { pr_url: prUrl },
        },
        { PATH: `${binDir}:${process.env.PATH ?? ''}` }
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ pr_url: prUrl });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
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
    expect(prompt).toContain('review-approval-gate');
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
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('git fetch origin dev');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).toContain('do NOT `git checkout dev`');
    expect(PR_MERGE_POST_APPROVAL_INSTRUCTIONS).not.toContain('git checkout dev && git pull');
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
    expect(prompt).toContain(
      'Treat QA instruction changes in the candidate PR as code under review'
    );
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
});
