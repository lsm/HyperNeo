/**
 * SpaceRuntime.listSubscriptions — read-only diagnostic (Task #908, PR 6).
 *
 * The tool snapshots a run's external-event subscriptions across three layers:
 *   1. `declared`  — static interests from the workflow definition (durable).
 *   2. `persisted` — dynamic rows from `space_workflow_event_subscriptions` (durable).
 *   3. `active`    — in-memory trie entries (live cross-check ONLY).
 *
 * Durable layers (1 + 2) are the source of truth; the trie (3) is never the
 * answer. These tests cover all three layers, the declared/persisted/orphan
 * reconciliation, the nodeId filter, and the cross-space guard.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SpaceWorkflow } from '@hyperneo/shared';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { CodingArtifactProfile } from '../../../../src/lib/space/workflows/coding-artifact-profile.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowEventSubscriptionRepository } from '../../../../src/storage/repositories/space-workflow-event-subscription-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-list-1';
const AGENT_ID = 'agent-list-1';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, `/tmp/${spaceId}`, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, `Agent ${agentId}`, Date.now(), Date.now());
}

describe('SpaceRuntime.listSubscriptions', () => {
  let db: BunDatabase;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;
  let agentManager: SpaceAgentManager;
  let subscriptionRepo: SpaceWorkflowEventSubscriptionRepository;

  function makeRuntime(overrides?: Partial<SpaceRuntimeConfig>): SpaceRuntime {
    const artifactProfile = new CodingArtifactProfile({ db });
    return new SpaceRuntime({
      db,
      spaceManager,
      spaceAgentManager: agentManager,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo: new NodeExecutionRepository(db),
      artifactProfile,
      ...overrides,
    });
  }

  /** Create a workflow + a (pending) run with a canonical in_progress task. */
  function createRun(
    options: {
      coderInterests?: Array<{
        topic?: string;
        topicFrom?: { source: 'primaryLink'; pattern: string };
        label?: string;
      }>;
      reviewerInterests?: Array<{ topic?: string }>;
      spaceId?: string;
    } = {}
  ): { workflow: SpaceWorkflow; runId: string; taskId: string } {
    const spaceId = options.spaceId ?? SPACE_ID;
    const workflow = workflowManager.createWorkflow({
      spaceId,
      name: `Workflow-${Math.random()}`,
      description: '',
      nodes: [
        {
          id: 'code',
          name: 'Code',
          agents: [
            {
              agentId: AGENT_ID,
              name: 'coder',
              ...(options.coderInterests ? { eventInterests: options.coderInterests } : {}),
            },
          ],
        },
        {
          id: 'review',
          name: 'Review',
          agents: [
            {
              agentId: AGENT_ID,
              name: 'reviewer',
              ...(options.reviewerInterests ? { eventInterests: options.reviewerInterests } : {}),
            },
          ],
        },
      ],
      transitions: [],
      startNodeId: 'code',
      rules: [],
      tags: [],
    });
    const run = workflowRunRepo.createRun({
      spaceId,
      workflowId: workflow.id,
      title: 'List Run',
    });
    const task = taskRepo.createTask({
      spaceId,
      workflowRunId: run.id,
      title: 'List Run',
      description: '',
      status: 'in_progress',
    });
    return { workflow, runId: run.id, taskId: task.id };
  }

  beforeEach(() => {
    db = makeDb();
    seedSpaceRow(db, SPACE_ID);
    seedSpaceRow(db, 'space-other');
    seedAgentRow(db, AGENT_ID, SPACE_ID);
    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);
    workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
    spaceManager = new SpaceManager(db);
    agentManager = new SpaceAgentManager(new SpaceAgentRepository(db));
    subscriptionRepo = new SpaceWorkflowEventSubscriptionRepository(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  });

  test('returns all three layers reconciled when declared + dynamic are active', () => {
    const runtime = makeRuntime();
    const { workflow, runId, taskId } = createRun({
      coderInterests: [{ topic: 'github/owner/repo/issues/*', label: 'issue events' }],
    });
    // Materialize the static interest into the trie.
    runtime.registerRunInterests(runId, taskId, workflow.nodes);
    // Add a dynamic subscription (write-through: trie + table).
    const dynamicTopic = 'github/owner/repo/pull_request/42.*';
    expect(runtime.registerSubscription(runId, taskId, 'code', 'coder', dynamicTopic).success).toBe(
      true
    );

    const res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    const { result } = res;

    // Layer 1 — declared static interest from the definition, now active.
    expect(result.declared).toHaveLength(1);
    expect(result.declared[0]).toMatchObject({
      nodeId: 'code',
      nodeName: 'Code',
      agentName: 'coder',
      topic: 'github/owner/repo/issues/*',
      label: 'issue events',
      active: true,
    });

    // Layer 2 — persisted dynamic row, active in the trie.
    expect(result.persisted).toHaveLength(1);
    expect(result.persisted[0]).toMatchObject({
      nodeId: 'code',
      agentName: 'coder',
      taskId,
      topic: dynamicTopic,
      active: true,
    });

    // Layer 3 — active trie entries, each backed by durable state.
    expect(result.active).toHaveLength(2);
    const staticActive = result.active.find((a) => a.subscriptionKind === 'static');
    const dynamicActive = result.active.find((a) => a.subscriptionKind === 'dynamic');
    expect(staticActive?.source).toBe('declared');
    expect(staticActive?.topic).toBe('github/owner/repo/issues/*');
    expect(dynamicActive?.source).toBe('persisted');
    expect(dynamicActive?.topic).toBe(dynamicTopic);

    // No drift.
    expect(result.mismatches).toEqual({
      declaredNotActive: 0,
      persistedNotActive: 0,
      orphanActive: 0,
    });
  });

  test('#896 scenario: a node with no declared PR-event interest shows declared empty from durable data', () => {
    const runtime = makeRuntime();
    const { runId, taskId } = createRun({
      // coder has an issue interest but NO pull_request interest declared.
      coderInterests: [{ topic: 'github/owner/repo/issues/*' }],
    });

    const res = runtime.listSubscriptions(runId, SPACE_ID, 'code');
    expect(res.success).toBe(true);
    if (!res.success) return;
    const { result } = res;

    // From durable data alone: the Code node declares only issue events — no
    // PR-event interest. That is the diagnosis the investigation needed.
    const declaredTopics = result.declared.map((d) => d.topic);
    expect(declaredTopics).not.toContain(expect.stringContaining('pull_request'));
    expect(declaredTopics).toEqual(['github/owner/repo/issues/*']);
    // Nothing is active yet (static not materialized).
    expect(result.mismatches.declaredNotActive).toBe(1);
  });

  test('declared-but-not-active surfaces when static interests are not materialized', () => {
    const runtime = makeRuntime();
    const { runId } = createRun({
      coderInterests: [{ topic: 'github/owner/repo/issues/*' }],
    });
    // Deliberately do NOT call registerRunInterests — the definition declares
    // the interest, but the trie has not materialized it (e.g. a run whose
    // static rebuild has not run / has been cleared).

    const res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    const { result } = res;

    expect(result.declared).toHaveLength(1);
    expect(result.declared[0].active).toBe(false);
    expect(result.active).toEqual([]);
    expect(result.mismatches.declaredNotActive).toBe(1);
    expect(result.mismatches.orphanActive).toBe(0);
  });

  test('persisted-but-not-active surfaces a durable row missing from the trie', () => {
    const runtime = makeRuntime();
    const { runId, taskId } = createRun();
    // Persist a dynamic row directly (bypassing the runtime), so the table has
    // it but the trie does not — e.g. mid-rehydrate before the trie rebuild.
    subscriptionRepo.upsert({
      spaceId: SPACE_ID,
      workflowRunId: runId,
      taskId,
      nodeId: 'code',
      agentName: 'coder',
      topic: 'github/owner/repo/pull_request/7.*',
      subscriptionKind: 'dynamic',
    });

    const res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    const { result } = res;

    expect(result.persisted).toHaveLength(1);
    expect(result.persisted[0].active).toBe(false);
    expect(result.active).toEqual([]);
    expect(result.mismatches.persistedNotActive).toBe(1);
  });

  test('orphan active entry surfaces a trie target with no durable backing', () => {
    const runtime = makeRuntime();
    const { runId, taskId } = createRun();
    // registerSubscription is write-through (trie + table) → backed.
    runtime.registerSubscription(
      runId,
      taskId,
      'code',
      'coder',
      'github/owner/repo/pull_request/42.*'
    );
    // Now wipe only the durable row, leaving a trie entry with no backing —
    // simulating drift between the table and the trie.
    subscriptionRepo.deleteByRun(runId);

    const res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    const { result } = res;

    expect(result.persisted).toEqual([]);
    expect(result.active).toHaveLength(1);
    expect(result.active[0].subscriptionKind).toBe('dynamic');
    expect(result.active[0].source).toBe('orphan');
    expect(result.mismatches.orphanActive).toBe(1);
  });

  test('topicFrom declared interest is listed but excluded from the mismatch count', () => {
    const runtime = makeRuntime();
    const { runId } = createRun({
      coderInterests: [
        {
          topicFrom: {
            source: 'primaryLink',
            pattern: 'github/{owner}/{repo}/pull_request/{number}.*',
          },
        },
      ],
    });

    const res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    const { result } = res;

    expect(result.declared).toHaveLength(1);
    expect(result.declared[0].topic).toBeNull();
    expect(result.declared[0].topicFrom).toEqual({
      source: 'primaryLink',
      pattern: 'github/{owner}/{repo}/pull_request/{number}.*',
    });
    // topicFrom is inert (no resolver yet) → not active, but NOT a drift signal.
    expect(result.declared[0].active).toBe(false);
    expect(result.mismatches.declaredNotActive).toBe(0);
  });

  test('nodeId filter scopes all three layers to one node', () => {
    const runtime = makeRuntime();
    const { workflow, runId, taskId } = createRun({
      coderInterests: [{ topic: 'github/owner/repo/issues/*' }],
      reviewerInterests: [{ topic: 'github/owner/repo/pull_request/*.*' }],
    });
    runtime.registerRunInterests(runId, taskId, workflow.nodes);

    const res = runtime.listSubscriptions(runId, SPACE_ID, 'review');
    expect(res.success).toBe(true);
    if (!res.success) return;
    const { result } = res;

    expect(result.nodeId).toBe('review');
    expect(result.declared).toHaveLength(1);
    expect(result.declared[0].nodeId).toBe('review');
    expect(result.declared[0].agentName).toBe('reviewer');
    expect(result.active).toHaveLength(1);
    expect(result.active[0].nodeId).toBe('review');
  });

  test('rejects a run in another space', () => {
    const runtime = makeRuntime();
    const { runId } = createRun({ spaceId: 'space-other' });

    const res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toContain('not in this space');
  });

  test('returns an error for an unknown run', () => {
    const runtime = makeRuntime();
    const res = runtime.listSubscriptions('run-does-not-exist', SPACE_ID);
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toContain('not found');
  });
});
