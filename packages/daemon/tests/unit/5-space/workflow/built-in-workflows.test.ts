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
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { isWorkflowTerminalNode } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import {
  builtInWorkflowRequiresPrMerge,
  CODER_EXTERNAL_GATE_BLOCK,
  CODER_ONLY_MERGE_INSTRUCTIONS,
  CODER_ONLY_PROMPT,
  CODER_ONLY_WORKFLOW,
  CODER_OWNED_MERGE_PROMPT,
  CODER_OWNED_PR_SUBSCRIBE_GUIDANCE,
  EXTERNAL_REVIEW_BOTS_GUIDANCE,
  CODING_WITH_QA_WORKFLOW,
  CODING_WORKFLOW,
  getBuiltInWorkflows,
  LEGACY_CODING_TEMPLATE_IDENTITIES,
  mergeChannelsFromTemplate,
  mergeNodeStructuralFieldsFromTemplate,
  RESEARCH_WORKFLOW,
  RETIRED_MERGER_RAW_MERGE_GUARD,
  RETIRED_PRE_REVIEW_MODES_CODER_ONLY_PROMPT,
  RETIRED_PRE_REVIEW_MODES_CODER_OWNED_MERGE_PROMPT,
  RETIRED_PRE_BASE_ADVANCE_POLICY_CODER_ONLY_PROMPT,
  RETIRED_PRE_BASE_ADVANCE_POLICY_CODER_OWNED_MERGE_PROMPT,
  RETIRED_PRE_BASE_ADVANCE_POLICY_RESEARCH_PROMPT,
  RETIRED_PR_MERGER_SLOT_PROMPT,
  REVIEW_ONLY_WORKFLOW,
  REVIEW_POLICY_GUIDANCE,
  RESEARCH_PROMPT,
  REVIEWER_ZERO_FINDINGS_GATE,
  CODING_WORKFLOW as STABLE_CODING_WORKFLOW,
  seedBuiltInWorkflows,
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import { CODER_OWNED_MERGE_INSTRUCTIONS } from '../../../../src/lib/space/workflows/post-approval-merge-template.ts';
import { computeWorkflowHash } from '../../../../src/lib/space/workflows/template-hash.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { PR_MERGE_POST_APPROVAL_INSTRUCTIONS } from './fixtures/retired-post-approval-merge-template.ts';

function makeDb(): BunDatabase {
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

const VALID_BUILTIN_ROLES = new Set<string>([
  'planner',
  'coder',
  'general',
  'research',
  'reviewer',
  'pr merger',
  'qa',
]);

function hasLeaderAgentId(wf: SpaceWorkflow): boolean {
  return wf.nodes.some((s) =>
    (s.agents ?? []).some(
      (agent) => agent.agentId === 'leader' || agent.name?.toLowerCase() === 'leader'
    )
  );
}

describe('stable coding workflow templates', () => {
  test('expose concise stable identities and coder-owned post-approval routes', () => {
    expect(STABLE_CODING_WORKFLOW.name).toBe('Coding');
    expect(STABLE_CODING_WORKFLOW.handle).toBe('coding');
    expect(STABLE_CODING_WORKFLOW.nodes.map((node) => node.name)).toEqual(['Coding', 'Review']);
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
    for (const wf of getBuiltInWorkflows()) {
      expect(wf.nodes.map((node) => node.name)).not.toContain('Post-Approval');
      expect(wf.nodes.flatMap((node) => node.agents).some((agent) => agent.name === 'merger')).toBe(
        false
      );
    }
  });

  test('stable coder owns the post-approval merge and has NO tool guards', () => {
    const assertCoderOwnsMerge = (wf: SpaceWorkflow) => {
      const codingNode = wf.nodes.find((node) => node.name === 'Coding')!;
      expect(codingNode.postApproval?.targetAgent).toBe('coder');
      expect(codingNode.postApproval?.instructions).toBe(CODER_OWNED_MERGE_INSTRUCTIONS);
      const coder = codingNode.agents.find((agent) => agent.name === 'coder')!;
      expect(coder.toolGuards).toBeUndefined();
      expect(coder.customPrompt?.value).not.toContain('Do NOT merge PRs');
      expect(coder.customPrompt?.value).toContain('Runtime Execution Contract');
    };
    assertCoderOwnsMerge(STABLE_CODING_WORKFLOW);
    assertCoderOwnsMerge(CODING_WITH_QA_WORKFLOW);
  });

  test('coder slots declare the primaryLink PR-event interest (task #907)', () => {
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
      for (const node of wf.nodes) {
        for (const agent of node.agents) {
          if (agent.name === 'coder') continue;
          expect(agent.eventInterests).toBeUndefined();
        }
      }
    }
  });

  test('stable Coding Review is the end node and calls approve_task', () => {
    expect(STABLE_CODING_WORKFLOW.endNodeId).toBe(
      STABLE_CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!.id
    );
    const prompt = STABLE_CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!.agents[0]!
      .customPrompt!.value;
    expect(prompt).toContain('approve_task');
  });

  test('stable Coding-with-QA Review is intermediate and defers the QA handoff to the central contract', () => {
    expect(CODING_WITH_QA_WORKFLOW.endNodeId).toBe(
      CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'QA')!.id
    );
    const reviewPrompt = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Review')!.agents[0]!
      .customPrompt!.value;
    expect(reviewPrompt).toMatch(/do not call approve_task/i);
    expect(reviewPrompt).toMatch(/final approval authority/i);
    expect(reviewPrompt).toMatch(/gated handoff/i);
    expect(reviewPrompt).not.toMatch(/send_message\(target="?QA"?/);
    expect(reviewPrompt).not.toContain('approved: true');
    expect(reviewPrompt).not.toMatch(/Review . QA gate/);
  });

  test('stable Coding-with-QA has a Coding → QA post-approval blocker channel', () => {
    const channels = CODING_WITH_QA_WORKFLOW.channels ?? [];
    expect(channels.some((c) => c.from === 'Coding' && c.to === 'QA')).toBe(true);
    expect(channels.some((c) => c.from === 'QA' && c.to === 'Coding')).toBe(true);
    const qaPrompt = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'QA')!.agents[0]!
      .customPrompt!.value;
    expect(qaPrompt).toContain('post-approval merge blocker');
  });

  test('stable Coding-with-QA gates the Coding → QA channel to post-approval only', () => {
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
    expect(hook!.authorizedCallers).toEqual([{ sourceNode: 'Coding', agentSlots: ['coder'] }]);
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
    expect(LEGACY_CODING_TEMPLATE_IDENTITIES.map((i) => i.legacyName)).toEqual([
      'Coding Workflow',
      'Coding with QA Workflow',
    ]);
    expect(LEGACY_CODING_TEMPLATE_IDENTITIES.map((i) => i.name)).toEqual([
      STABLE_CODING_WORKFLOW.name,
      CODING_WITH_QA_WORKFLOW.name,
    ]);
  });

  test('stable coder prompt does not hard-code a specific approval authority', () => {
    const prompt = STABLE_CODING_WORKFLOW.nodes
      .find((n) => n.name === 'Coding')!
      .agents.find((a) => a.name === 'coder')!.customPrompt!.value;
    expect(prompt).not.toContain('Review is the approval and re-approval authority');
    expect(prompt).toMatch(/Runtime Execution Contract/i);
  });

  test('stable reviewer prompts defer execution to the central contract', () => {
    for (const wf of [STABLE_CODING_WORKFLOW, CODING_WITH_QA_WORKFLOW]) {
      const prompt = wf.nodes.find((n) => n.name === 'Review')!.agents[0]!.customPrompt!.value;
      expect(prompt).not.toMatch(/run checks/i);
    }
  });

  test('only the stable Coding template is tagged default', () => {
    expect(STABLE_CODING_WORKFLOW.tags).toContain('default');
    expect(CODING_WITH_QA_WORKFLOW.tags).not.toContain('default');
  });

  test('coder-owned merge instructions verify the Space checkout is not ahead of origin', () => {
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('space-checkout-ahead');
  });

  test('coder-owned merge-queue poll inspects queue status and is bounded', () => {
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('mergeStateStatus');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).not.toMatch(/--json [^\n]*autoMergeRequest/);
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).not.toMatch(/--json state --jq \.state/);
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toMatch(/~10 attempts|up to ~10/);
  });
});

describe('coder-only workflow template', () => {
  test('is a single Coding node that starts and ends itself', () => {
    expect(CODER_ONLY_WORKFLOW.nodes).toHaveLength(1);
    expect(CODER_ONLY_WORKFLOW.nodes[0]!.name).toBe('Coding');
    expect(CODER_ONLY_WORKFLOW.startNodeId).toBe(CODER_ONLY_WORKFLOW.endNodeId);
    expect(CODER_ONLY_WORKFLOW.channels ?? []).toHaveLength(0);
    expect(CODER_ONLY_WORKFLOW.tags).not.toContain('default');
  });

  test('coder owns the post-approval merge via the node-level route', () => {
    const codingNode = CODER_ONLY_WORKFLOW.nodes[0]!;
    expect(codingNode.postApproval?.targetAgent).toBe('coder');
    expect(codingNode.postApproval?.requirePrMerge).toBe(true);
    expect(codingNode.postApproval?.instructions).toBe(CODER_ONLY_MERGE_INSTRUCTIONS);
    const coder = codingNode.agents.find((agent) => agent.name === 'coder')!;
    expect(coder.eventInterests).toEqual([
      {
        topicFrom: {
          source: 'primaryLink',
          pattern: 'github/{owner}/{repo}/pull_request/{number}.*',
        },
        label: 'My PR events',
      },
    ]);
  });

  test('coder prompt gates on the bots it discovers, runs an informal review, and requests human sign-off', () => {
    expect(CODER_ONLY_PROMPT).toContain(CODER_OWNED_PR_SUBSCRIBE_GUIDANCE);
    expect(CODER_ONLY_PROMPT).toContain('Codex');
    expect(CODER_ONLY_PROMPT).toContain('Devin');
    expect(CODER_ONLY_PROMPT).toContain('Copilot');
    expect(CODER_ONLY_PROMPT).toContain('CodeRabbit');
    expect(CODER_ONLY_PROMPT).toContain('informal review');
    expect(CODER_ONLY_PROMPT).toContain('submit_for_approval');
    expect(CODER_ONLY_PROMPT).toContain('Runtime Execution Contract');
    expect(CODER_ONLY_PROMPT).not.toContain('approve_task(');
    expect(CODER_ONLY_PROMPT).not.toContain('Do NOT merge PRs');
    expect(CODER_ONLY_PROMPT).not.toContain('@devon');
  });

  test('gate discovers its bot set instead of assuming a fixed reviewer list', () => {
    expect(CODER_ONLY_PROMPT).toContain('DISCOVER the bots actually available');
    expect(CODER_ONLY_PROMPT).toContain('never a fixed checklist');
    expect(CODER_ONLY_PROMPT).toContain('gates on that one bot alone');
    expect(CODER_ONLY_PROMPT).toContain('no external review bot available');
    expect(CODER_ONLY_PROMPT).toContain('Verdicts are language, so read them');
    expect(CODER_ONLY_PROMPT).toContain('Silence is NOT a pass');
    expect(CODER_ONLY_PROMPT).toContain('drop it from the gate set');
    expect(CODER_ONLY_PROMPT).toContain('chatgpt-codex-connector[bot]');
    expect(CODER_ONLY_PROMPT).toContain('copilot-pull-request-reviewer[bot]');
    expect(CODER_ONLY_PROMPT).toContain('devin-ai-integration[bot]');
    expect(CODER_ONLY_PROMPT).toContain('coderabbitai[bot]');
    expect(CODER_ONLY_PROMPT).toContain('@coderabbitai review');
    expect(CODER_ONLY_PROMPT).toContain('Cursor Bugbot');
    expect(CODER_ONLY_PROMPT).toContain('greptile-app[bot]');
    expect(CODER_ONLY_PROMPT).toContain('Qodo PR-Agent');
  });

  test('gate evidence uses GraphQL enum names, cycle binding, and paginated reviews', () => {
    expect(CODER_ONLY_PROMPT).toContain('THUMBS_UP');
    expect(CODER_ONLY_PROMPT).toContain('EYES');
    expect(CODER_ONLY_PROMPT).toContain('createdAt');
    expect(CODER_ONLY_PROMPT).toContain('reactions(first:100,after:$cursor)');
    expect(CODER_ONLY_PROMPT).toContain('reviews(first:100,after:$cursor)');
    expect(CODER_ONLY_PROMPT).toContain('commit{oid} url body');
    expect(CODER_ONLY_PROMPT).toContain('pageInfo.hasNextPage');
    expect(CODER_ONLY_PROMPT).toContain('`[bot]`');
    expect(CODER_ONLY_PROMPT).toContain('ONLY when its `commit.oid` equals');
    expect(CODER_ONLY_PROMPT).toContain('is NOT a pass');
    expect(CODER_ONLY_PROMPT).toContain('Reject `DISMISSED` and `PENDING`');
    expect(CODER_ONLY_PROMPT).toContain('review CYCLE');
    expect(CODER_ONLY_PROMPT).toContain('Serialize review cycles');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('cycle triggered after the last push');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('every bot in your recorded gate set');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('per the coding-phase trigger knowledge');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).not.toContain('@devon');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('recover idempotently');
    expect(CODER_ONLY_PROMPT).not.toContain('content `+1` means');
    expect(CODER_ONLY_PROMPT).not.toContain('or its `submittedAt` is on or after');
    expect(CODER_ONLY_PROMPT).not.toContain('committedDate');
    expect(CODER_ONLY_PROMPT).not.toContain('pushedAt');
  });

  test('coder prompt persists the PR link and gates CI on required checks, not a fixed name', () => {
    expect(CODER_ONLY_PROMPT).toContain('shape: "link", kind: "pr"');
    expect(CODER_ONLY_PROMPT).toContain('--required');
    expect(CODER_ONLY_PROMPT).toContain('no required checks');
    expect(CODER_ONLY_PROMPT).not.toContain('All Tests Pass');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('--required');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('no required checks');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).not.toContain('All Tests Pass');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).not.toContain('`dev` branch ruleset');
  });

  test('coder prompt reroutes no-change tasks instead of fabricating a PR', () => {
    expect(CODER_ONLY_PROMPT).toContain('no code changes');
    expect(CODER_ONLY_PROMPT).toContain('needs');
    expect(CODER_ONLY_PROMPT).toContain('re-routing');
  });

  test('gate note artifact carries an explicit key, gate set, and inline reaction evidence', () => {
    expect(CODER_ONLY_PROMPT).toContain('kind: "external-review-gate", key: "gate"');
    expect(CODER_ONLY_PROMPT).toContain('gate_set: ["<bot logins>"]');
    expect(CODER_ONLY_PROMPT).toContain(
      'codex_reaction: { login, content: "THUMBS_UP", created_at }'
    );
    expect(CODER_ONLY_PROMPT).toContain('base_ref: "<baseRefName>"');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('key "gate"');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'its recorded base_ref equals the current baseRefName'
    );
  });

  test('coder prompt falls back to internal review when bots are unavailable or dead', () => {
    expect(CODER_ONLY_PROMPT).toContain('the internal fallback applies');
    expect(CODER_ONLY_PROMPT).toContain('internal-fallback');
    expect(CODER_ONLY_PROMPT).toContain('six internal review dimensions');
    expect(CODER_ONLY_PROMPT).toContain('fresh-eyes general-purpose sub-agent pass');
    expect(CODER_ONLY_PROMPT).toContain(
      'second independent sub-agent pass on the highest-risk dimension'
    );
    expect(CODER_ONLY_PROMPT).toContain('kind: "internal-review-gate", key: "internal"');
    expect(CODER_ONLY_PROMPT).toContain('NEVER under the external gate');
    expect(CODER_ONLY_PROMPT).toContain(
      'the artifact store upserts on the key, so writing the internal result there would destroy a recorded external gate'
    );
    expect(CODER_ONLY_PROMPT).toContain('when no external gate was recorded for this run');
    expect(CODER_ONLY_PROMPT).toContain('on a mid-run source switch TO `internal`');
    expect(CODER_ONLY_PROMPT).toContain('the internal fallback applies ONLY under `auto`');
    expect(CODER_ONLY_PROMPT).toContain('escalate saying the repository has no external reviewer');
    expect(CODER_ONLY_PROMPT).toContain('the merge cannot proceed under the selected source');
    expect(CODER_ONLY_PROMPT).toContain(
      'Capture `headRefOid`, `baseRefName`, and `baseRefOid` BEFORE starting the fallback review'
    );
    expect(CODER_ONLY_PROMPT).toContain(
      'so the merge procedure reads the gate that actually covers the current head'
    );
    expect(CODER_ONLY_PROMPT).toContain('treat that bot as failed');
    expect(CODER_ONLY_PROMPT).toContain('drop it from the gate set');
    expect(CODER_ONLY_PROMPT).toContain('switch to the internal fallback review above');
    expect(CODER_ONLY_PROMPT).toContain(
      'the external gate is REQUIRED — report the missing external gate as a blocker'
    );
    expect(CODER_ONLY_PROMPT).toContain('an emptied gate set there is a blocker');
    expect(CODER_ONLY_PROMPT).not.toContain('there is no internal backstop');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('internal fallback review');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('BOTH gates must re-run');
  });

  test('shared review policy vocabulary and external bot gate reach every consumer', () => {
    expect(REVIEW_POLICY_GUIDANCE).toContain('**Review source**');
    expect(REVIEW_POLICY_GUIDANCE).toContain(
      '`both` — both the external bots and the internal reviewer must pass'
    );
    expect(REVIEW_POLICY_GUIDANCE).toContain('`auto` (default)');
    expect(REVIEW_POLICY_GUIDANCE).toContain('**Review depth**');
    expect(REVIEW_POLICY_GUIDANCE).toContain('The most recent explicit instruction wins');
    expect(REVIEW_POLICY_GUIDANCE).toContain('message delivered to your session');
    expect(REVIEW_POLICY_GUIDANCE).toContain('are security surfaces');
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain('DISCOVER the bots actually available');
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain('Verdicts are language, so read them');
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain('Silence is NOT a pass');
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain('Poll the gate every 60 seconds');
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain('kind: "external-review-gate", key: "gate"');
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain(
      'the run-scoped `gh api graphql` lookup is permitted by your contract'
    );
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain('BOTH conditions must hold');
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain('reaction-only signaling must not read as');
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain(
      'ONLY when the reaction is itself a review-verdict signal'
    );
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain(
      'never joins the gate set, and its reaction can neither pass the gate nor hold it open'
    );
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain(
      'habitually passes cleanly leaves ONLY reactions'
    );
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain(
      'do NOT silently substitute the internal fallback'
    );
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain(
      'the IMPLEMENTER requests their re-review directly'
    );
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain(
      'no-activity window (~30 minutes after your trigger)'
    );
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain('no verdict within ~2 hours');
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain(
      'Resolving threads does NOT withdraw a `CHANGES_REQUESTED` review'
    );
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain('with NOTHING reported is a clean verdict');
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain('logins that are REVIEW bots');
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain('are NOT review bots');
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain(
      '`createdAt` is later than that trigger AND the headRefOid has not changed since'
    );
    expect(CODER_ONLY_PROMPT).toContain(EXTERNAL_REVIEW_BOTS_GUIDANCE);
    expect(CODER_ONLY_PROMPT).toContain(REVIEW_POLICY_GUIDANCE);
    expect(CODER_ONLY_PROMPT).toContain('there is no internal Reviewer node');
    expect(CODER_ONLY_PROMPT).toContain(
      'the external gate must pass AND the internal fallback review must run'
    );
    expect(CODER_ONLY_PROMPT.indexOf('Do this once per PR')).toBe(
      CODER_ONLY_PROMPT.lastIndexOf('Do this once per PR')
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('the internal fallback review is the gate');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'the two gates are separate records under separate keys, and `both` requires both of them'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'external under "gate", internal under "internal" — never overwrite one with the other'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('the internal artifact IS the gate of record');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'Under `both` OR explicit `external` an empty gate set is NOT an internal run'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      're-run the gate cycle under the CURRENT source'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'in MEANING — `internal-fallback` recorded for a run whose instructions selected `internal`'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('the review ran at the wrong depth');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'for a `both`-source run confirm BOTH gate artifacts'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'its recorded `base_oid` is informational under the same base-advance policy as the external artifact'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'the merged commit never passed the current policy'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('never as an external pass');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'record it INFORMATIONALLY in the step-7 merge artifact with the standardized acceptance line'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'record it INFORMATIONALLY in the step-7 merge artifact with the standardized acceptance line'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'the live baseRefOid has advanced past the merge and must not be compared'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'compare its `base_oid` with the merge commit' + "'" + 's first parent'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'proceed without a new review round and without asking for fresh sign-off'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      're-runs ONLY the internal fallback review (never a bot loop'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('report the gate that actually ran');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'the single fresh human sign-off covers both halves'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('validate ONLY that internal artifact');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'a re-triggered bot that engages but produces no verdict within its window'
    );
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain(REVIEW_POLICY_GUIDANCE);
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain(EXTERNAL_REVIEW_BOTS_GUIDANCE);
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain('always send the gated PR handoff');
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain('verifies the external gate and is the backup');
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain(
      "the Reviewer's backup role covers exactly this failure"
    );
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain('kind: "review-base", key: "base"');
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain(
      'the post-approval merge runs in a separate session that never sees that handoff'
    );
    expect(CODER_OWNED_MERGE_PROMPT).toContain(CODER_EXTERNAL_GATE_BLOCK);
    expect(CODING_WORKFLOW.nodes[0]!.agents[0]!.customPrompt!.value).toBe(CODER_OWNED_MERGE_PROMPT);
    expect(RESEARCH_PROMPT).toContain(CODER_EXTERNAL_GATE_BLOCK);
    expect(RESEARCH_PROMPT).toContain('always send the gated PR handoff to Review');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('never substitutes for the review source');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'a base ref NAME change is a retarget that changes the reviewed diff WITHOUT changing'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'the `base_ref` recorded in your `review-base` note artifact (key "base")'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'the `head_oid` and `base_ref` recorded in your `external-review-gate` artifact'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'Bind the review gates AND the approvals to the gated head AND the base ref name'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'either mismatch invalidates the gate and every approval given against the old head or base ref'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'A base TIP advance under the same name never does'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'a note still in its dispatch-time `pending` state is NOT proof'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'revalidate it BEFORE requesting any re-approval'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'treat the note as stale and re-send the gated PR handoff under the current source'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'review-source or review-depth instruction is newer than that note'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'a merge must never proceed under a policy the verified note predates'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'do NOT call mark_complete: report the mismatch'
    );
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain('source: "<external|internal|both|auto>"');
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain('depth: "<light|standard|deep|auto>"');
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain(
      'A review-DEPTH switch stales the gate the same way'
    );
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain(
      'WAIT for your confirmation that the note is `verified` before its terminal action'
    );
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain(
      'a source switch itself triggers that next handoff'
    );
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain(
      'treats the note as stale and refreshes it the same way'
    );
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain(
      'PENDING state only — a dispatch-time snapshot proves nothing'
    );
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain(
      'Only a "verified" note is proof of the base the Reviewer last inspected'
    );
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain(
      '(`Reviewed head <headRefOid> on base <name>@<baseRefOid>`'
    );
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain('or the head moved and returned');
    expect(CODER_EXTERNAL_GATE_BLOCK).toContain('base_oid: "<baseRefOid>"');
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain('base_oid: "<baseRefOid>"');
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain(
      'A base-OID excursion alone — the same branch name'
    );
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain('recorded, not discarded');
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain(
      'poll all three on every wait cycle while the gate is live'
    );
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain(
      'a reverted head excursion still passes the trigger-anchored freshness checks'
    );
    expect(EXTERNAL_REVIEW_BOTS_GUIDANCE).toContain('even a change that later reverts');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'a base TIP advance under the same name does not'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('--hostname \"$HOST\"');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('--hostname \"$HOST\"');
    expect(CODER_ONLY_PROMPT).toContain('depth: "<light|standard|deep|auto>", reason:');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('note artifact (key "base") in EVERY mode');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'a dead bot is a reported blocker to escalate, never substituted'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('after EVERY fresh external gate');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      'that ONE handoff satisfies both halves together'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      '`both` runs the external gate FIRST and never consumes two Review cycles'
    );
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('route the revalidation back through Review');
    expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain(
      "the Reviewer's backup re-review stands in for that bot's pass"
    );
  });

  test('merge instructions sync fork PRs from the base repository remote', () => {
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('BASE_REMOTE');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('git fetch "$BASE_REMOTE" "$BASE"');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'git -C "$SPACE_WS" pull --ff-only "$BASE_REMOTE" "$BASE"'
    );
  });

  test('merge instructions require fresh human sign-off after a post-approval push', () => {
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('merge_fix_pushed');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'The prior human approval never carries over to a head it was not given.'
    );
  });

  test('merge instructions block on required approvals and give branch cleanup commands', () => {
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('REVIEW_REQUIRED');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('never bypass it with `--admin`');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('IS_FORK');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('git ls-remote origin "refs/heads/$HEAD_REF"');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('git push origin --force-with-lease');
  });

  test('gate captures the base before reviewers run and verifies the recorded PR link', () => {
    expect(CODER_ONLY_PROMPT).toContain(
      'Capture the baseRefName, baseRefOid, AND headRefOid (`gh pr view <pr_url> --json baseRefName,baseRefOid,headRefOid`) when you START the external gate'
    );
    expect(CODER_ONLY_PROMPT).toContain('re-run the whole gate under the current base');
    expect(CODER_ONLY_PROMPT).toContain('headRefName,isCrossRepository,headRepository,url');
    expect(CODER_ONLY_PROMPT).toContain('must match the origin remote');
    expect(CODER_ONLY_PROMPT).toContain('the fork case');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'compare its `base_oid` with the merge commit' + "'" + 's first parent'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'a difference is a base-tip advance the policy accepts'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      '--force-with-lease="refs/heads/$HEAD_REF:$REMOTE_OID"'
    );
  });

  test('merge instructions give executable guarded commands for the Space checkout sync', () => {
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'git -C "$SPACE_WS" fetch "$BASE_REMOTE" "$BASE"'
    );
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('rev-parse FETCH_HEAD');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('space-checkout-base');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('space-checkout-pull');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('space-checkout-ahead');
  });

  test('merge instructions scan all reviews and verify merged-state recovery', () => {
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('by ANY author (human or bot)');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('a later `APPROVED` from that same author');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain(
      'gate artifact `head_oid` still equals the PR headRefOid'
    );
  });

  test('bot pass requires an unambiguous clean verdict', () => {
    expect(CODER_ONLY_PROMPT).toContain('EXPLICIT clean verdict');
    expect(CODER_ONLY_PROMPT).toContain('"No Issues Found"');
    expect(CODER_ONLY_PROMPT).toContain('minor findings are still findings');
  });

  test('requires human sign-off structurally', () => {
    expect(CODER_ONLY_WORKFLOW.completionAutonomyLevel).toBeGreaterThanOrEqual(3);
  });

  test('merge instructions verify the external gate and the Space checkout sync', () => {
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('mergeStateStatus');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).toContain('space-checkout-ahead');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).not.toContain('Recommendation: APPROVE');
    expect(CODER_ONLY_MERGE_INSTRUCTIONS).not.toContain('{{approval_authority}}');
  });
});

describe('stable CODING_WORKFLOW template structure', () => {
  test('has two nodes: Coding and Review (no Post-Approval merger node)', () => {
    expect(CODING_WORKFLOW.nodes).toHaveLength(2);
    expect(CODING_WORKFLOW.nodes.map((s) => s.name)).toEqual(['Coding', 'Review']);
  });

  test('Coding node owns the post-approval merge via the node-level route', () => {
    const codingNode = CODING_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
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
    expect(prompt).not.toContain('Do NOT merge PRs');
    expect(prompt).not.toContain('send_message(target="Review"');
    expect(prompt).not.toContain('code-ready-gate');
    expect(prompt).toContain('subscribe_pr_events');
    expect(prompt).toContain('prUrl');
  });

  test('reviewer prompt instructs a visible GitHub review per the system contract', () => {
    const prompt = CODING_WORKFLOW.nodes[1].agents[0]?.customPrompt?.value;
    expect(prompt).toContain('post a visible GitHub review');
    expect(prompt).toContain('Reviewer system contract');
    expect(prompt).toContain('approve_task');
  });

  test('has two channels (Coding→Review + gated Review→Coding)', () => {
    expect(CODING_WORKFLOW.channels).toHaveLength(2);
  });

  test('Coding → Review channel is ungated (PR-ready hook replaces gate)', () => {
    const ch = CODING_WORKFLOW.channels!.find((c) => c.from === 'Coding' && c.to === 'Review');
    expect(ch).toBeDefined();
    expect(ch!.gateId).toBeUndefined();
    expect(ch!.maxCycles).toBeUndefined();
  });

  test('Review → Coding channel is ungated (plain handoff) with maxCycles', () => {
    const ch = CODING_WORKFLOW.channels!.find((c) => c.from === 'Review' && c.to === 'Coding');
    expect(ch).toBeDefined();
    expect(ch!.gateId).toBeUndefined();
    expect(ch!.maxCycles).toBe(5);
  });

  test('all channels have direction one-way', () => {
    for (const ch of CODING_WORKFLOW.channels!) {
      expect('direction' in ch).toBe(false);
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

describe('getBuiltInWorkflows()', () => {
  test('returns exactly five templates', () => {
    expect(getBuiltInWorkflows()).toHaveLength(5);
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

  test('includes CODER_ONLY_WORKFLOW', () => {
    const names = getBuiltInWorkflows().map((w) => w.name);
    expect(names).toContain(CODER_ONLY_WORKFLOW.name);
  });

  test('identifies merge-required workflows by durable template identity', () => {
    expect(builtInWorkflowRequiresPrMerge('Coding')).toBe(true);
    expect(builtInWorkflowRequiresPrMerge('Coding Workflow')).toBe(true);
    expect(builtInWorkflowRequiresPrMerge('Coding with QA')).toBe(true);
    expect(builtInWorkflowRequiresPrMerge('Research Workflow')).toBe(true);
    expect(builtInWorkflowRequiresPrMerge('Review-Only')).toBe(false);
    expect(builtInWorkflowRequiresPrMerge('Coder-Only Workflow')).toBe(true);
    expect(builtInWorkflowRequiresPrMerge('custom workflow')).toBe(false);
    expect(builtInWorkflowRequiresPrMerge(null)).toBe(false);
  });

  test('no template references leader as agent', () => {
    for (const wf of getBuiltInWorkflows()) {
      expect(hasLeaderAgentId(wf)).toBe(false);
    }
  });

  test('all agent placeholders are valid builtin role names', () => {
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
    expect(reviewPostedHook?.validator).toEqual({ kind: 'built_in', id: 'review_posted' });
  });
});

describe('seedBuiltInWorkflows()', () => {
  let db: BunDatabase;
  let repo: SpaceWorkflowRepository;
  let manager: SpaceWorkflowManager;
  const SPACE_ID = 'seed-test-space';

  const PLANNER_ID = 'agent-planner-uuid';
  const CODER_ID = 'agent-coder-uuid';
  const GENERAL_ID = 'agent-general-uuid';
  const RESEARCH_ID = 'agent-research-uuid';
  const REVIEWER_ID = 'agent-reviewer-uuid';
  const MERGER_ID = 'agent-merger-uuid';

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
    seedAgent(db, PLANNER_ID, SPACE_ID, 'Planner');
    seedAgent(db, CODER_ID, SPACE_ID, 'Coder');
    seedAgent(db, GENERAL_ID, SPACE_ID, 'General');
    seedAgent(db, RESEARCH_ID, SPACE_ID, 'Research');
    seedAgent(db, REVIEWER_ID, SPACE_ID, 'Reviewer');
    seedAgent(db, QA_ID, SPACE_ID, 'QA');

    repo = new SpaceWorkflowRepository(db);
    manager = new SpaceWorkflowManager(repo);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
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
      expect('direction' in ch).toBe(false);
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
    expect(wf!.nodes[0].postApproval?.targetAgent).toBe('research');
  });

  test('RESEARCH_WORKFLOW seeded channels reference valid node names', async () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === RESEARCH_WORKFLOW.name)!;
    const nodeNames = new Set(wf.nodes.map((n) => n.name));
    for (const ch of wf.channels!) {
      expect('direction' in ch).toBe(false);
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
    expect(workflows).toHaveLength(5);
  });

  test('threads node-level postApproval through to Coding, Research, QA seeded rows', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const workflows = manager.listWorkflows(SPACE_ID);
    const assertPostApproval = (name: string, targetAgent: 'coder' | 'research') => {
      const wf = workflows.find((w) => w.name === name);
      expect(wf, `workflow "${name}" must be seeded`).toBeDefined();
      expect(wf!.postApproval).toBeUndefined();
      const routeNode = wf!.nodes.find((node) => node.postApproval);
      expect(routeNode, `"${name}" must have a node carrying postApproval`).toBeDefined();
      expect(routeNode!.postApproval!.targetAgent).toBe(targetAgent);
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

  test('result exposes restamped=[] on a fresh seed', () => {
    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.skipped).toBe(false);
    expect(result.seeded).toHaveLength(5);
    expect(result.restamped).toEqual([]);
  });

  test('result exposes restamped=[] when all rows already match current template hashes', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const second = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(second.skipped).toBe(true);
    expect(second.seeded).toEqual([]);
    expect(second.restamped).toEqual([]);
  });

  test('re-stamps existing rows when stored templateHash differs from current template', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

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

    const before = manager.getWorkflow(coding.id)!;
    expect(before.postApproval).toBeUndefined();
    expect(before.nodes.find((node) => node.name === 'Coding')?.postApproval).toBeUndefined();
    expect(before.templateHash).toBe('stale-hash-from-a-prior-pr');

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.seeded).toEqual([]);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);
    expect(result.skipped).toBe(false);

    const after = manager.getWorkflow(coding.id)!;
    expect(after.postApproval).toBeUndefined();
    const afterCodingNode = after.nodes.find((node) => node.name === 'Coding');
    expect(afterCodingNode?.postApproval).toBeDefined();
    expect(afterCodingNode?.postApproval?.targetAgent).toBe('coder');
    expect(after.templateHash).not.toBe('stale-hash-from-a-prior-pr');
  });

  test('the stable Coding template carries exactly one coder-owned postApproval route', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const codingNode = coding.nodes.find((node) => node.name === 'Coding')!;
    const reviewNode = coding.nodes.find((node) => node.name === 'Review')!;
    expect(codingNode.postApproval?.targetAgent).toBe('coder');
    expect(codingNode.postApproval?.instructions).toBe(CODER_OWNED_MERGE_INSTRUCTIONS);
    expect(reviewNode.postApproval).toBeUndefined();
    expect(coding.nodes.filter((node) => node.postApproval)).toHaveLength(1);

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.skipped).toBe(true);
    const reRow = manager.getWorkflow(coding.id)!;
    expect(reRow.nodes.filter((node) => node.postApproval)).toHaveLength(1);
    expect(reRow.nodes.find((node) => node.name === 'Coding')!.postApproval?.targetAgent).toBe(
      'coder'
    );
  });

  test('re-stamp propagates template maxCycles onto existing Fullstack QA Loop cyclic back-channels', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WITH_QA_WORKFLOW.name)!;

    manager.updateWorkflow(wf.id, {
      channels: (wf.channels ?? []).map((ch) =>
        (ch.from === 'Review' && ch.to === 'Coding') || (ch.from === 'QA' && ch.to === 'Coding')
          ? { ...ch, maxCycles: 6 }
          : ch
      ),
    });

    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'stale-hash-pre-maxCycles-50',
      wf.id
    );

    const before = manager.getWorkflow(wf.id)!;
    expect(before.channels!.find((c) => c.from === 'Review' && c.to === 'Coding')!.maxCycles).toBe(
      6
    );
    expect(before.channels!.find((c) => c.from === 'QA' && c.to === 'Coding')!.maxCycles).toBe(6);

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WITH_QA_WORKFLOW.name);

    const after = manager.getWorkflow(wf.id)!;
    expect(after.channels!.find((c) => c.from === 'Review' && c.to === 'Coding')!.maxCycles).toBe(
      50
    );
    expect(after.channels!.find((c) => c.from === 'QA' && c.to === 'Coding')!.maxCycles).toBe(50);
  });

  test('re-stamp does NOT touch handles — custom user handle is preserved', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

    manager.updateWorkflow(coding.id, { handle: 'my-custom-handle' });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'stale-hash',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);

    const after = manager.getWorkflow(coding.id)!;
    expect(after.handle).toBe('my-custom-handle');
  });

  test('re-stamp preserves existing postApproval when a node was renamed', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const routeNode = coding.nodes.find((n) => n.name === 'Coding')!;
    expect(routeNode.postApproval).toBeDefined();

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
    expect(afterRenamedNode.postApproval).toEqual(routeNode.postApproval);
  });

  test('re-stamp succeeds and leaves handle field untouched (no handle write during restamp)', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

    db.prepare(`UPDATE space_workflows SET handle = NULL, template_hash = ? WHERE id = ?`).run(
      'stale-hash',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);
    expect(result.errors).toHaveLength(0);

    const after = manager.getWorkflow(coding.id)!;
    expect(after.postApproval).toBeUndefined();
    expect(after.nodes.find((node) => node.name === 'Coding')?.postApproval).toBeDefined();
    expect(after.completionAutonomyLevel).toBe(CODING_WORKFLOW.completionAutonomyLevel);
    expect(after.handle).toBeUndefined();
  });

  test('re-stamp does NOT touch rows without a templateName (user-created)', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    const userWf = manager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'My Custom Review',
      nodes: [{ name: 'Review', agentId: REVIEWER_ID }],
      completionAutonomyLevel: 2,
    });

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
    expect(after.templateHash).toBe('stale-hash');
    expect(after.templateHash).not.toBe(
      computeWorkflowHash(getBuiltInWorkflows().find((w) => w.name === CODING_WORKFLOW.name)!)
    );
  });

  test('re-stamp keeps updateAvailable alive when the template changed a non-merged field', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const template = getBuiltInWorkflows().find((w) => w.name === CODING_WORKFLOW.name)!;
    const expectedHash = computeWorkflowHash(template);

    manager.updateWorkflow(coding.id, { instructions: 'legacy custom instructions' });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'pre-instructions-change-hash',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);

    const after = manager.getWorkflow(coding.id)!;
    expect(after.instructions).toBe('legacy custom instructions');
    expect(after.templateHash).not.toBe(expectedHash);

    const rowHash = computeWorkflowHash(after);
    const updateAvailable = expectedHash !== (after.templateHash ?? null);
    const customized = rowHash !== (after.templateHash ?? null);
    expect(updateAvailable).toBe(true);
    expect(customized).toBe(true);
  });

  test('stable Coding coder prompt carries no retired step markers that retired patches could pseudo-converge', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const prompt = coding.nodes.find((n) => n.name === 'Coding')!.agents[0].customPrompt!.value;
    expect(prompt).not.toContain('5. If code changed: open a PR with `gh pr create`');
    expect(prompt).not.toContain('hand off by sending a message to Review');
    expect(prompt).not.toContain('replyHandle.commentId');
    expect(prompt).not.toContain('code-ready-gate');
    expect(prompt).toContain('Runtime Execution Contract');
    expect(prompt).toContain('`gh pr merge`');
  });

  test('Research prompt carries the subscribe step and merge preserves a non-exact custom research prompt', () => {
    const workflow = RESEARCH_WORKFLOW;
    const nodeName = 'Research';
    const researchNode = workflow.nodes.find((n) => n.name === nodeName)!;
    const templatePrompt = researchNode.agents[0].customPrompt!.value;
    expect(templatePrompt).toContain('subscribe_pr_events');
    expect(templatePrompt).toContain('REVIEW_THREAD_RESOLUTION_GUIDANCE'.length ? 'review' : '');

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
    expect(after.templateHash).toBe('customized-stale-prompt-hash');
    expect(after.templateHash).not.toBe(
      computeWorkflowHash(getBuiltInWorkflows().find((w) => w.name === CODING_WORKFLOW.name)!)
    );
  });

  test('re-stamp upgrades pre-review-modes coder prompts to the policy-aware template', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const codingNode = coding.nodes.find((n) => n.name === 'Coding')!;
    const coderOnly = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODER_ONLY_WORKFLOW.name)!;
    const coderOnlyNode = coderOnly.nodes[0]!;

    const staleCoding = manager.updateWorkflow(coding.id, {
      nodes: coding.nodes.map((n) =>
        n.id !== codingNode.id
          ? n
          : {
              ...n,
              agents: n.agents.map((a, i) =>
                i === 0
                  ? {
                      ...a,
                      customPrompt: { value: RETIRED_PRE_REVIEW_MODES_CODER_OWNED_MERGE_PROMPT },
                    }
                  : a
              ),
            }
      ),
    })!;
    const staleCoderOnly = manager.updateWorkflow(coderOnly.id, {
      nodes: coderOnly.nodes.map((n) =>
        n.id !== coderOnlyNode.id
          ? n
          : {
              ...n,
              agents: n.agents.map((a, i) =>
                i === 0
                  ? { ...a, customPrompt: { value: RETIRED_PRE_REVIEW_MODES_CODER_ONLY_PROMPT } }
                  : a
              ),
            }
      ),
    })!;
    expect(staleCoding).toBeTruthy();
    expect(staleCoderOnly).toBeTruthy();
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'stale-pre-review-modes-a',
      coding.id
    );
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'stale-pre-review-modes-b',
      coderOnly.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);
    expect(result.restamped).toContain(CODER_ONLY_WORKFLOW.name);

    const afterCoding = manager.getWorkflow(coding.id)!;
    const afterCodingNode = afterCoding.nodes.find((n) => n.name === 'Coding')!;
    expect(afterCodingNode.agents[0]!.customPrompt?.value).toBe(CODER_OWNED_MERGE_PROMPT);
    expect(afterCodingNode.agents[0]!.customPrompt?.value).toContain('Review policy');
    expect(afterCoding.templateHash).toBe(
      computeWorkflowHash(getBuiltInWorkflows().find((w) => w.name === CODING_WORKFLOW.name)!)
    );

    const afterCoderOnly = manager.getWorkflow(coderOnly.id)!;
    expect(afterCoderOnly.nodes[0]!.agents[0]!.customPrompt?.value).toBe(CODER_ONLY_PROMPT);
    expect(afterCoderOnly.nodes[0]!.agents[0]!.customPrompt?.value).toContain(
      'the internal fallback applies'
    );
    expect(afterCoderOnly.templateHash).toBe(
      computeWorkflowHash(getBuiltInWorkflows().find((w) => w.name === CODER_ONLY_WORKFLOW.name)!)
    );
  });

  test('re-stamp upgrades strict-base-revalidation coder prompts to the base-advance-policy template', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const codingNode = coding.nodes.find((n) => n.name === 'Coding')!;
    const coderOnly = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODER_ONLY_WORKFLOW.name)!;
    const coderOnlyNode = coderOnly.nodes[0]!;
    const research = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === RESEARCH_WORKFLOW.name)!;
    const researchNode = research.nodes.find((n) => n.name === 'Research')!;

    const staleCoding = manager.updateWorkflow(coding.id, {
      nodes: coding.nodes.map((n) =>
        n.id !== codingNode.id
          ? n
          : {
              ...n,
              agents: n.agents.map((a, i) =>
                i === 0
                  ? {
                      ...a,
                      customPrompt: {
                        value: RETIRED_PRE_BASE_ADVANCE_POLICY_CODER_OWNED_MERGE_PROMPT,
                      },
                    }
                  : a
              ),
            }
      ),
    })!;
    const staleCoderOnly = manager.updateWorkflow(coderOnly.id, {
      nodes: coderOnly.nodes.map((n) =>
        n.id !== coderOnlyNode.id
          ? n
          : {
              ...n,
              agents: n.agents.map((a, i) =>
                i === 0
                  ? {
                      ...a,
                      customPrompt: {
                        value: RETIRED_PRE_BASE_ADVANCE_POLICY_CODER_ONLY_PROMPT,
                      },
                    }
                  : a
              ),
            }
      ),
    })!;
    const staleResearch = manager.updateWorkflow(research.id, {
      nodes: research.nodes.map((n) =>
        n.id !== researchNode.id
          ? n
          : {
              ...n,
              agents: n.agents.map((a, i) =>
                i === 0
                  ? {
                      ...a,
                      customPrompt: { value: RETIRED_PRE_BASE_ADVANCE_POLICY_RESEARCH_PROMPT },
                    }
                  : a
              ),
            }
      ),
    })!;
    expect(staleCoding).toBeTruthy();
    expect(staleCoderOnly).toBeTruthy();
    expect(staleResearch).toBeTruthy();
    for (const workflow of [coding, coderOnly, research]) {
      db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
        'stale-strict-base-revalidation',
        workflow.id
      );
    }

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);
    expect(result.restamped).toContain(CODER_ONLY_WORKFLOW.name);
    expect(result.restamped).toContain(RESEARCH_WORKFLOW.name);

    const afterCoding = manager.getWorkflow(coding.id)!;
    const afterCodingNode = afterCoding.nodes.find((n) => n.name === 'Coding')!;
    expect(afterCodingNode.agents[0]!.customPrompt?.value).toBe(CODER_OWNED_MERGE_PROMPT);
    expect(afterCodingNode.agents[0]!.customPrompt?.value).toContain(
      'merged anyway per policy decided 2026-08-24'
    );

    const afterCoderOnly = manager.getWorkflow(coderOnly.id)!;
    expect(afterCoderOnly.nodes[0]!.agents[0]!.customPrompt?.value).toBe(CODER_ONLY_PROMPT);
    expect(afterCoderOnly.nodes[0]!.agents[0]!.customPrompt?.value).toContain(
      'A base-OID excursion alone'
    );

    const afterResearch = manager.getWorkflow(research.id)!;
    const afterResearchNode = afterResearch.nodes.find((n) => n.name === 'Research')!;
    expect(afterResearchNode.agents[0]!.customPrompt?.value).toBe(RESEARCH_PROMPT);
    expect(afterResearchNode.agents[0]!.customPrompt?.value).not.toBe(
      RETIRED_PRE_BASE_ADVANCE_POLICY_RESEARCH_PROMPT
    );
  });

  test('re-stamp restores the imperative subscribe instruction to the stable coder prompt', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const codingNode = coding.nodes.find((n) => n.name === 'Coding')!;

    const templatePrompt = codingNode.agents[0].customPrompt!.value;
    expect(templatePrompt).toContain('subscribe_pr_events');
    const retiredPrompt = templatePrompt.replace(CODER_OWNED_PR_SUBSCRIBE_GUIDANCE, '');
    expect(retiredPrompt).not.toContain('subscribe_pr_events');

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
    expect(afterCodingNode.agents[0].customPrompt?.value).toBe(templatePrompt);
    expect(afterCodingNode.agents[0].customPrompt?.value).toContain('subscribe_pr_events');
  });

  test('re-stamp restores the zero-findings verdict gate to the stable reviewer prompt', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const coding = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const reviewNode = coding.nodes.find((n) => n.name === 'Review')!;

    const templatePrompt = reviewNode.agents[0].customPrompt!.value;
    expect(templatePrompt).toContain('Verdict gate');
    const retiredPrompt = templatePrompt.replace(REVIEWER_ZERO_FINDINGS_GATE, '');
    expect(retiredPrompt).not.toContain('Verdict gate');

    manager.updateWorkflow(coding.id, {
      nodes: coding.nodes.map((n) =>
        n.id !== reviewNode.id
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
      'stale-pre-verdict-gate-hash',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);

    const after = manager.getWorkflow(coding.id)!;
    const afterReviewNode = after.nodes.find((n) => n.id === reviewNode.id)!;
    expect(afterReviewNode.agents[0].customPrompt?.value).toBe(templatePrompt);
    expect(afterReviewNode.agents[0].customPrompt?.value).toContain('Verdict gate');
  });

  test('every stable reviewer slot carries the zero-findings verdict gate', () => {
    const workflows = [
      CODING_WORKFLOW,
      CODING_WITH_QA_WORKFLOW,
      RESEARCH_WORKFLOW,
      REVIEW_ONLY_WORKFLOW,
    ];
    for (const workflow of workflows) {
      const reviewNode = workflow.nodes.find((n) => n.name === 'Review')!;
      const reviewer = reviewNode.agents.find((a) => a.name === 'reviewer')!;
      expect(reviewer.customPrompt?.value).toContain(REVIEWER_ZERO_FINDINGS_GATE);
      expect(reviewer.customPrompt?.value).toContain('REQUEST_CHANGES');
    }
  });

  test('restamp prompt migration operates on legacy slot prompts, not the stable behavioral prompts', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const seedAgain = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(seedAgain.skipped).toBe(true);

    const qaCoderPrompt = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Coding')!.agents[0]
      .customPrompt!.value;
    expect(qaCoderPrompt).not.toContain('3. Open or update the PR');
    expect(qaCoderPrompt).toContain('subscribe_pr_events');
    expect(qaCoderPrompt).not.toContain('code-pr-gate');
    expect(qaCoderPrompt).toContain('Runtime Execution Contract');
    expect(qaCoderPrompt).toContain('`gh pr merge`');
  });

  test('stable Coding-with-QA QA node approves via approve_task and never merges', () => {
    const qaPrompt = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'QA')!.agents[0]
      .customPrompt!.value;
    expect(qaPrompt).toContain('save the PR link and a passing decision artifact');
    expect(qaPrompt).toContain('approve_task');
    expect(qaPrompt).toContain('submit_for_approval');
    expect(qaPrompt).toContain('Do not merge');
    expect(qaPrompt).not.toContain('save_artifact({ type: "result"');
  });

  test('stable Coding reviewer prompt is behavioral and carries post-approval blocker handling', () => {
    const reviewPrompt = CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!.agents[0]
      .customPrompt!.value;
    expect(reviewPrompt).toContain('post a visible GitHub review');
    expect(reviewPrompt).toContain('Reviewer system contract');
    expect(reviewPrompt).toContain('approve_task');
    expect(reviewPrompt).toContain('post-approval merge blocker');
    expect(reviewPrompt).toMatch(/re-check the current head/i);
  });

  test('stable QA and Reviewer prompts carry post-approval re-approval wording', () => {
    const codingReviewPrompt = CODING_WORKFLOW.nodes.find((n) => n.name === 'Review')!.agents[0]
      .customPrompt!.value;
    const qaPrompt = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'QA')!.agents[0]
      .customPrompt!.value;
    expect(codingReviewPrompt).toMatch(
      /re-approv|re-check the current head|post a fresh approval/i
    );
    expect(qaPrompt).toMatch(/revalid|re-approve|fresh approval/i);
    expect(qaPrompt).toContain('Do not merge');
  });

  test('mergeChannelsFromTemplate matches scalar and single-element-array channel forms', () => {
    const nodes: WorkflowNode[] = [
      { id: 'n-review', name: 'Review', agents: [{ agentId: 'a1', name: 'reviewer' }] },
      { id: 'n-coding', name: 'Coding', agents: [{ agentId: 'a2', name: 'coder' }] },
    ];
    const existingChannels = [{ from: 'Review', to: ['Coding'], maxCycles: 6, label: 'old label' }];
    const templateChannels = [{ from: 'Review', to: 'Coding', maxCycles: 50, label: 'new label' }];

    const result = mergeChannelsFromTemplate(existingChannels, templateChannels, nodes, nodes);

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
    const existingNodes = CODING_WORKFLOW.nodes.map((node) =>
      node.name === 'Review'
        ? { ...node, agents: node.agents.map((a) => ({ ...a, resetContextPerTurn: undefined })) }
        : node
    );
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
    const outReviewer = result
      .find((node) => node.name === 'Review')!
      .agents.find((a) => a.name === 'reviewer')!;
    expect(outReviewer.eventInterests).toBeUndefined();
  });

  test('mergeNodeStructuralFieldsFromTemplate overwrites a divergent slot eventInterests from the template', () => {
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
    const customInterest = [{ topic: 'github/acme/widgets/pull_request/*.*', label: 'custom' }];
    const existingNodes: WorkflowNode[] = [
      {
        id: 'n1',
        name: 'Coding',
        agents: [{ agentId: 'a1', name: 'coder', eventInterests: customInterest }],
      },
    ];
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
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'custom-no-marker-hash',
      coding.id
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(result.errors).toHaveLength(0);
    expect(result.restamped).toContain(CODING_WORKFLOW.name);

    const after = manager.getWorkflow(coding.id)!;
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
    db.prepare(`UPDATE space_workflow_nodes SET name = ? WHERE id = ?`).run(
      'Implementation',
      codingNode.id
    );
    db.prepare(`UPDATE space_workflow_nodes SET name = ? WHERE id = ?`).run(
      'Human Review',
      reviewNode.id
    );
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
    expect(
      after.channels!.some(
        (channel) => channel.from === 'Implementation' && channel.to === 'Human Review'
      )
    ).toBe(true);
    expect(
      after.channels!.some(
        (channel) => channel.from === 'Validation Complete' || channel.to === 'Validation Complete'
      )
    ).toBe(false);
  });

  test('re-stamp preserves existing node rows, layout, and updates toolGuards in place', () => {
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
    expect(coder.eventInterests).toEqual(CODING_WORKFLOW.nodes[0].agents[0]!.eventInterests);
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

  function revertToLegacyIdentity(workflowId: string, legacyName: string, legacyHandle: string) {
    db.prepare(
      `UPDATE space_workflows SET name = ?, handle = ?, template_name = ? WHERE id = ?`
    ).run(legacyName, legacyHandle, legacyName, workflowId);
  }

  test('migrates legacy "Coding Workflow" identity to stable "Coding" and strips the Post-Approval node', () => {
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
          id: 'retired-pa',
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
        { id: 'pa-c', from: 'Post-Approval', to: 'Coding' },
        { id: 'c-pa', from: 'Coding', to: 'Post-Approval' },
      ],
    });
    db.prepare(`UPDATE space_workflows SET template_hash = ? WHERE id = ?`).run(
      'stale-pre-upgrade-hash',
      codingId
    );

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    const migrated = manager.listWorkflows(SPACE_ID).find((w) => w.id === codingId)!;
    expect(migrated).toBeDefined();
    expect(migrated.name).toBe('Coding');
    expect(migrated.handle).toBe('coding');
    expect(migrated.templateName).toBe('Coding');
    expect(migrated.nodes.map((n) => n.name)).toEqual(['Coding', 'Review']);
    expect(migrated.nodes.flatMap((n) => n.agents).some((a) => a.name === 'merger')).toBe(false);
    const migratedCodingNode = migrated.nodes.find((n) => n.name === 'Coding')!;
    expect(migratedCodingNode.postApproval?.targetAgent).toBe('coder');
    expect(migratedCodingNode.postApproval?.instructions).toBe(CODER_OWNED_MERGE_INSTRUCTIONS);
    expect(migrated.templateHash).toBe(
      computeWorkflowHash(getBuiltInWorkflows().find((w) => w.name === 'Coding')!)
    );

    expect(result.errors).toEqual([]);
    const second = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    expect(second.skipped).toBe(true);
    expect(second.seeded).toEqual([]);
    expect(second.errors).toEqual([]);
  });

  test('defers the retired-node strip while an active workflow run references the row', () => {
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

    const deferred = seedBuiltInWorkflows(
      SPACE_ID,
      manager,
      resolveAgentId,
      (workflowId) => workflowId === codingId
    );
    const stillLegacy = manager.listWorkflows(SPACE_ID).find((w) => w.id === codingId)!;
    expect(stillLegacy.name).toBe('Coding');
    expect(stillLegacy.templateName).toBe('Coding');
    expect(stillLegacy.nodes.some((n) => n.name === 'Post-Approval')).toBe(true);
    expect(stillLegacy.nodes.flatMap((n) => n.agents).some((a) => a.name === 'merger')).toBe(true);
    expect(deferred.restamped).not.toContain('Coding');
    expect(stillLegacy.templateHash).toBe(staleHash);

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
    expect(after.nodes.some((n) => n.name === 'Post-Approval')).toBe(true);
    const customPa = after.nodes.find((n) => n.name === 'Post-Approval')!;
    expect(customPa.agents[0].customPrompt?.value).toBe('My custom merger prompt (user-edited)');
  });

  test('preserves a Post-Approval node whose merger slot was model-customized', () => {
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
    expect(after.nodes.some((n) => n.name === 'Post-Approval')).toBe(true);
    const modelPa = after.nodes.find((n) => n.name === 'Post-Approval')!;
    expect(modelPa.agents[0].model).toBe('claude-sonnet-4-6');
  });

  test('preserves a Post-Approval node whose merger prompt was appended to', () => {
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
    expect(after.nodes.some((n) => n.name === 'Post-Approval')).toBe(true);
    const appendPa = after.nodes.find((n) => n.name === 'Post-Approval')!;
    expect(appendPa.agents[0].customPrompt?.value).toContain('Remember to also sync the docs.');
  });

  test('handle collision on a new stable template fails safely without aborting the seed', () => {
    manager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'My Coding',
      handle: 'coding',
      nodes: [{ name: 'Code', agentId: CODER_ID }],
    });

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    expect(result.seeded).toHaveLength(4);
    expect(result.seeded).not.toContain(STABLE_CODING_WORKFLOW.name);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toBe(STABLE_CODING_WORKFLOW.name);
    expect(result.errors[0].error).toContain('coding');
    expect(manager.listWorkflows(SPACE_ID)).toHaveLength(5);
  });

  test('partial legacy migration: a rename collision stamps templateName so the row still groups for cleanup', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const seeded = manager.listWorkflows(SPACE_ID);
    const codingRow = seeded.find((w) => w.name === STABLE_CODING_WORKFLOW.name)!;
    const stableQa = seeded.find((w) => w.name === CODING_WITH_QA_WORKFLOW.name)!;

    revertToLegacyIdentity(codingRow.id, 'Coding Workflow', 'coding-workflow');
    db.prepare(`DELETE FROM space_workflows WHERE id = ?`).run(stableQa.id);

    manager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Coding',
      nodes: [{ name: 'Code', agentId: CODER_ID }],
    });

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    const after = manager.listWorkflows(SPACE_ID);
    expect(after.find((w) => w.id === codingRow.id)!.name).toBe('Coding Workflow');
    expect(after.find((w) => w.id === codingRow.id)!.templateName).toBe('Coding');
    expect(after.find((w) => w.id === codingRow.id)!.handle).toBe('coding-workflow');
    expect(after.filter((w) => w.name === 'Coding')).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  test('duplicate legacy rows: every row is migrated, not just the newest', () => {
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

    const after = manager.listWorkflows(SPACE_ID);
    expect(after.filter((w) => w.templateName === 'Coding Workflow')).toHaveLength(0);
    expect(after.filter((w) => w.templateName === 'Coding')).toHaveLength(2);
    expect(after.find((w) => w.id === newer.id)!.name).toBe('Coding');
    expect(after.find((w) => w.id === older.id)!.name).toBe('Coding Workflow (dup-a)');
    expect(after.find((w) => w.id === older.id)!.templateName).toBe('Coding');
  });

  test('user-renamed legacy row keeps its custom name/handle (templateName only)', () => {
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
    expect(after.name).toBe('My Team Coding');
    expect(after.handle).toBe('my-team-coding');
    expect(after.templateName).toBe('Coding');
  });

  test('handle-only legacy customization is preserved (name unchanged, handle customized)', () => {
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
    expect(after.name).toBe('Coding Workflow');
    expect(after.handle).toBe('team-coding-flow');
    expect(after.templateName).toBe('Coding');
  });

  test('legacy identity migration strips the stale default tag from non-default rows', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const seeded = manager.listWorkflows(SPACE_ID);
    const qaRow = seeded.find((w) => w.name === CODING_WITH_QA_WORKFLOW.name)!;
    const stableCoding = seeded.find((w) => w.name === STABLE_CODING_WORKFLOW.name)!;
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
    expect(after.find((w) => w.id === stableCoding.id)!.tags).toContain('default');
  });

  test('throws if resolveAgentId returns undefined for a required role', () => {
    const brokenResolver = (_role: string): string | undefined => undefined;

    expect(() => seedBuiltInWorkflows(SPACE_ID, manager, brokenResolver)).toThrow(
      'no SpaceWorkerAgent found with name'
    );
  });

  test('does not persist any workflow when resolveAgentId fails on first-template role', async () => {
    const brokenResolver = (role: string): string | undefined =>
      role === 'planner' ? undefined : roleMap[role];

    try {
      seedBuiltInWorkflows(SPACE_ID, manager, brokenResolver);
    } catch {}
    expect(manager.listWorkflows(SPACE_ID)).toHaveLength(0);
  });

  test('does not persist any workflow when resolveAgentId fails on a shared role', async () => {
    const brokenResolver = (role: string): string | undefined =>
      role === 'qa' ? undefined : roleMap[role];

    try {
      seedBuiltInWorkflows(SPACE_ID, manager, brokenResolver);
    } catch {}
    expect(manager.listWorkflows(SPACE_ID)).toHaveLength(0);
  });

  test('returns seeded workflow names on success', () => {
    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    expect(result.skipped).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(result.seeded).toHaveLength(5);
    expect(result.seeded).toContain('Coding');
    expect(result.seeded).toContain('Coding with QA');
    expect(result.seeded).toContain('Research Workflow');
    expect(result.seeded).toContain('Review-Only Workflow');
    expect(result.seeded).toContain('Coder-Only Workflow');
  });

  test('returns skipped=true when workflows already exist', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    expect(result.skipped).toBe(true);
    expect(result.seeded).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test('per-workflow error isolation — remaining workflows seed when one createWorkflow throws', () => {
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

    expect(result.seeded).toHaveLength(4);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('Simulated DB constraint error');
    expect(result.skipped).toBe(false);

    const workflows = manager.listWorkflows(SPACE_ID);
    expect(workflows).toHaveLength(4);
  });

  test('per-workflow error isolation — captures error name correctly', () => {
    const originalCreate = manager.createWorkflow.bind(manager);
    let callCount = 0;
    const templates = getBuiltInWorkflows();
    manager.createWorkflow = (params) => {
      callCount++;
      if (callCount === 3) {
        throw new Error('Unique constraint violation');
      }
      return originalCreate(params);
    };

    const result = seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);

    expect(result.errors).toHaveLength(1);
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

  test('all seeded channels have non-empty id fields', () => {
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
  });

  test('getBuiltInWorkflows returns CODING_WORKFLOW first', () => {
    const templates = getBuiltInWorkflows();
    expect(templates[0].name).toBe(STABLE_CODING_WORKFLOW.name);
  });

  test('listWorkflows returns CODING_WORKFLOW first after DB seeding', () => {
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

  test('all seeded workflows have positive timestamps', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    for (const wf of manager.listWorkflows(SPACE_ID)) {
      expect(wf.createdAt).toBeGreaterThan(0);
      expect(wf.updatedAt).toBeGreaterThan(0);
    }
  });

  test('agent ID resolution is case-insensitive via resolver', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WITH_QA_WORKFLOW.name)!;
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
          expect(agent.agentId).toMatch(/^agent-[a-z]+-uuid$/);
        }
      }
    }
  });

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
    } catch {}
  });

  test('exported Coding Workflow passes Zod validation', () => {
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
    expect(exported.channels).toHaveLength(2);

    const reviewToCode = exported.channels!.find((c) => c.from === 'Review' && c.to === 'Coding');
    expect(reviewToCode).toBeDefined();
    expect(reviewToCode!.maxCycles).toBe(5);
  });

  test('exported Coding Workflow channels do not include gate field (gates are separate entities)', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;

    const exported = exportWorkflow(wf, mockAgents);

    for (const ch of exported.channels ?? []) {
      expect((ch as Record<string, unknown>).gate).toBeUndefined();
    }
  });

  test('re-imported Coding Workflow preserves channel structure', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const exported = exportWorkflow(wf, mockAgents);

    for (const w of manager.listWorkflows(SPACE_ID)) {
      manager.deleteWorkflow(w.id);
    }
    expect(manager.listWorkflows(SPACE_ID)).toHaveLength(0);

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

    const reimported = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WORKFLOW.name)!;
    expect(reimported).toBeDefined();
    expect(reimported.nodes).toHaveLength(2);
    expect(reimported.channels).toHaveLength(2);
    expect(reimported.nodes.some((n) => n.name === 'Post-Approval')).toBe(false);

    const codeToReview = reimported.channels!.find((c) => c.from === 'Coding' && c.to === 'Review');
    expect(codeToReview).toBeDefined();

    const reviewToCode = reimported.channels!.find((c) => c.from === 'Review' && c.to === 'Coding');
    expect(reviewToCode).toBeDefined();
    expect(reviewToCode!.maxCycles).toBe(5);
  });

  test('coder-owned postApproval route survives export/import round-trip', () => {
    seedBuiltInWorkflows(SPACE_ID, manager, resolveAgentId);
    const wf = manager.listWorkflows(SPACE_ID).find((w) => w.name === CODING_WORKFLOW.name)!;
    const exported = exportWorkflow(wf, mockAgents);

    const codingNode = exported.nodes.find((n) => n.name === 'Coding');
    expect(codingNode).toBeDefined();
    const coderAgent = codingNode!.agents.find((a) => a.name === 'coder');
    expect(coderAgent).toBeDefined();
    expect(coderAgent!.toolGuards).toBeUndefined();
    expect(exported.nodes.find((n) => n.name === 'Coding')!.postApproval?.targetAgent).toBe(
      'coder'
    );

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

    const reimported = manager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WORKFLOW.name)!;
    const reimCoderNode = reimported.nodes.find((n) => n.name === 'Coding');
    expect(reimCoderNode?.postApproval?.targetAgent).toBe('coder');
    const reimCoder = reimCoderNode?.agents.find((a) => a.name === 'coder');
    expect(reimCoder?.toolGuards).toBeUndefined();
  });
});

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
    expect(prompt).toContain('reply on the PR');
    expect(prompt).toContain('resolve review threads');
    expect(prompt).toContain('Runtime Execution Contract');
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
    expect(prompt).toContain('post a visible GitHub review');
    expect(prompt).toContain('Reviewer system contract');
    expect(prompt).not.toContain('pr_url');
    expect(prompt).not.toContain('review_url');
    expect(prompt).not.toContain('comment_urls');
    expect(prompt).toMatch(/specific\s+thread URLs|thread URLs you are raising/i);
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
  function assertTerminalActionPreconditions(prompt: string, opts: { upstream: string }): void {
    expect(prompt).toMatch(
      /terminal-action tool contract|Terminal-action contract|terminal hand-off|terminal action|terminal calls|terminal actions|terminal-action tool descriptions/
    );
    expect(prompt).toContain('approve_task');
    expect(prompt).toContain('submit_for_approval');
    expect(prompt).toMatch(
      /P0[–-]P2|zero findings|zero P0-P2|findings remain|blocking findings|QA passes|Reviewer System Contract/i
    );
    expect(prompt).toMatch(
      /verdict.*APPROVE|APPROVE.*verdict|If approved|If satisfied|approved only|QA passes|after every downstream task/i
    );
    expect(prompt).toMatch(
      /REQUEST_CHANGES|changes needed|requesting changes|more research is needed|findings remain|QA fails/i
    );
    expect(prompt).toMatch(
      /do not .*approve_task|Never use.*findings|If findings remain|If changes needed|If dispatch is incomplete|If QA fails|only on APPROVE|If requesting changes|If more research is needed/i
    );
    expect(prompt).toMatch(
      /do not .*submit_for_approval|Never use.*findings|If findings remain|If changes needed|If dispatch is incomplete|If QA fails|only on APPROVE|If requesting changes|If more research is needed/i
    );
    expect(prompt).toContain(`send_message(target="${opts.upstream}"`);
    expect(prompt).toMatch(
      /same approval semantic|terminal-action tool contract|terminal hand-off|terminal.*contract/i
    );
  }

  test('CODING_WORKFLOW Review node prompt reserves terminal calls for a clean, resolved head', () => {
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
    expect(prompt).toMatch(
      /terminal-action tool contract|Terminal-action contract|terminal hand-off|terminal action|terminal calls|terminal actions|terminal-action tool descriptions/
    );
    expect(prompt).toMatch(
      /P0[–-]P2|zero findings|zero P0-P2|findings remain|blocking findings|QA passes|Reviewer System Contract/i
    );
    expect(prompt).toContain('approve_task');
    expect(prompt).toContain('submit_for_approval');
    expect(prompt).toMatch(
      /do not .*approve_task|Never use.*findings|If findings remain|If changes needed|If dispatch is incomplete|If QA fails|only on APPROVE|If requesting changes|If more research is needed/i
    );
    expect(prompt).toMatch(
      /do not .*submit_for_approval|Never use.*findings|If findings remain|If changes needed|If dispatch is incomplete|If QA fails|only on APPROVE|If requesting changes|If more research is needed/i
    );
    expect(prompt).toMatch(
      /same approval semantic|terminal-action tool contract|terminal hand-off|terminal.*contract/i
    );
  });

  test('mergeNodeStructuralFieldsFromTemplate preserves operator-configured handoff transitions when the template is silent', () => {
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
    const codingTemplate = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
    const reviewTemplate = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const declared: HandoffTransition[] = [{ id: 'to-review', target: 'Review' }];
    const templateWithTransitions = CODING_WITH_QA_WORKFLOW.nodes.map((n) =>
      n.name === 'Coding' ? { ...n, transitions: declared } : n
    );
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
    const codingTemplate = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Coding')!;
    const reviewTemplate = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
    const reviewerSlotName = reviewTemplate.agents[0]?.name ?? 'Reviewer';
    const declared: HandoffTransition[] = [{ id: 'to-slot', target: reviewerSlotName }];
    const templateWithTransitions = CODING_WITH_QA_WORKFLOW.nodes.map((n) =>
      n.name === 'Coding' ? { ...n, transitions: declared } : n
    );
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

    expect(prompt).not.toContain('any login containing `codex`');
    expect(prompt).not.toContain('2 hours by default');
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
  expect(mergedPrompt).toBe(legacySeed);
});

test('CODING_WITH_QA_WORKFLOW Review node is intermediate and defers final approval to QA', () => {
  const reviewNode = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'Review')!;
  const prompt = reviewNode.agents[0].customPrompt!.value;
  expect(prompt).toMatch(/determines? final approval|a separate QA step owns final approval/i);
  expect(prompt).toMatch(/do not call approve_task/i);
  expect(prompt).toContain('post a visible GitHub review');
  expect(prompt).toContain('Reviewer system contract');
  expect(prompt).not.toContain('send_message(target="QA"');
  expect(prompt).not.toContain('approved: true');
});

test('post-approval merge instructions are safe for isolated worktrees', () => {
  expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('git fetch origin "$BASE"');
  expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('do NOT `git checkout $BASE`');
  expect(CODER_OWNED_MERGE_INSTRUCTIONS).not.toContain('git checkout $BASE && git pull');
});

test('coder-owned post-approval merge instructions merge via gh pr merge bound to the current head', () => {
  expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('gh pr merge');
  expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('--match-head-commit');
  expect(CODER_OWNED_MERGE_INSTRUCTIONS).toContain('NOT a merge authorization');
});

test('no built-in template declares a dedicated merger agent or Bash merge guard', () => {
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

  expect(prompt).toContain('your system contract defines how to validate it');
  expect(prompt).toMatch(/do not restate that methodology here/i);
  expect(prompt).toContain('re-approve the EXACT head you revalidated');
  expect(prompt).not.toMatch(/backend, frontend, browser, and CI checks/i);
  expect(prompt).toMatch(/concrete failures and reproduction steps/i);
  expect(prompt).toMatch(/the runtime supplies the target/i);
  expect(prompt).not.toMatch(/send Coding concrete failures/i);
  expect(prompt).toContain('non-terminal QA note');
  expect(prompt).toMatch(/save the PR link and a passing decision artifact/i);
  expect(prompt).toContain('approve_task');
  expect(prompt).toContain('submit_for_approval');
  expect(prompt).toContain('Do not merge');
  expect(prompt).toContain('post-approval merge blocker');
});

test('CODING_WITH_QA_WORKFLOW QA node routes post-approval merge-blockers via the Coding → QA channel', () => {
  const qaPrompt = CODING_WITH_QA_WORKFLOW.nodes.find((n) => n.name === 'QA')!.agents[0]
    .customPrompt!.value;
  expect(qaPrompt).toContain('re-approve the EXACT head you revalidated');
  expect(qaPrompt).toContain('VALIDATED_OID');
  expect(qaPrompt).toContain('commitOID');
  expect(qaPrompt).toContain('addPullRequestReview');
  expect(qaPrompt).toMatch(/own-PR where GitHub rejects your self-APPROVE/i);
  expect(qaPrompt).toContain('Recommendation: APPROVE');
  expect(qaPrompt).toMatch(/signal them to continue/i);
  expect(qaPrompt).not.toMatch(/signal Coding to continue/i);
  const channels = CODING_WITH_QA_WORKFLOW.channels ?? [];
  expect(channels.some((c) => c.from === 'Coding' && c.to === 'QA')).toBe(true);
});

test('CODING_WITH_QA_WORKFLOW cyclic back-channels permit more than 6 review/QA cycles', () => {
  const reviewToCoding = CODING_WITH_QA_WORKFLOW.channels!.find(
    (c) => c.from === 'Review' && c.to === 'Coding'
  );
  const qaToCoding = CODING_WITH_QA_WORKFLOW.channels!.find(
    (c) => c.from === 'QA' && c.to === 'Coding'
  );
  expect(reviewToCoding).toBeDefined();
  expect(qaToCoding).toBeDefined();
  expect(reviewToCoding!.maxCycles).toBe(50);
  expect(qaToCoding!.maxCycles).toBe(50);
  expect(reviewToCoding!.maxCycles).toBeGreaterThan(6);
  expect(qaToCoding!.maxCycles).toBeGreaterThan(6);
});
