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
    expect(result.definitionResolved).toBe(true);
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

  // -------------------------------------------------------------------------
  // Edge cases & review-feedback coverage
  // -------------------------------------------------------------------------

  test('P1: a terminal-task run does not report cleared static interests as drift', () => {
    // registerRunInterestsFromWorkflow skips static re-materialization for a
    // terminal canonical task (its static interests are cleared by the task
    // lifecycle). listSubscriptions must NOT count those as declaredNotActive —
    // their active:false is expected cleanup, not drift.
    const runtime = makeRuntime();
    const { workflow, runId, taskId } = createRun({
      coderInterests: [{ topic: 'github/owner/repo/issues/*' }],
    });
    runtime.registerRunInterests(runId, taskId, workflow.nodes);

    // Baseline: active run → declared interest is live, no drift.
    let res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.result.declared[0].active).toBe(true);
    expect(res.result.mismatches.declaredNotActive).toBe(0);

    // Task completes → lifecycle clears its interests from the trie.
    taskRepo.updateTask(taskId, { status: 'done' });
    runtime.clearTaskInterests(taskId);

    res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    // Declared is still re-derived from the definition (the run DID declare it),
    // but it is no longer in the trie. Crucially, the mismatch count stays 0.
    expect(res.result.declared).toHaveLength(1);
    expect(res.result.declared[0].active).toBe(false);
    expect(res.result.mismatches.declaredNotActive).toBe(0);
  });

  test('a terminal task with a leftover static trie entry surfaces it as orphan', () => {
    // Inverse of the P1 case: if the lifecycle cleanup misses a static entry on
    // a terminal task, that stale entry must NOT be hidden — declaredNotActive
    // stays suppressed (terminal), but the surviving entry is reclassified as
    // orphan and counted so the drift is still visible.
    const runtime = makeRuntime();
    const { workflow, runId, taskId } = createRun({
      coderInterests: [{ topic: 'github/owner/repo/issues/*' }],
    });
    runtime.registerRunInterests(runId, taskId, workflow.nodes);
    // Mark terminal WITHOUT clearing the trie (simulates a failed/partial cleanup).
    taskRepo.updateTask(taskId, { status: 'done' });

    const res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.result.mismatches.declaredNotActive).toBe(0); // terminal → suppressed
    expect(res.result.active).toHaveLength(1);
    expect(res.result.active[0].subscriptionKind).toBe('static');
    expect(res.result.active[0].source).toBe('orphan');
    expect(res.result.mismatches.orphanActive).toBe(1);
  });

  test('a static entry is "unknown" (not orphan) when the definition cannot be loaded', () => {
    // If getWorkflowForRun returns null while a static entry is still in the
    // trie, the declaration layer is unavailable — not absent — so the entry's
    // backing is unverifiable. Report source:'unknown' and do not count it as
    // drift (a false orphan would mislead).
    const runtime = makeRuntime({
      spaceWorkflowManager: { getWorkflowForRun: () => null } as unknown as typeof workflowManager,
    });
    const { workflow, runId, taskId } = createRun({
      coderInterests: [{ topic: 'github/owner/repo/issues/*' }],
    });
    // Materialize the static entry (registerRunInterests needs no workflow def),
    // then inspect via the stubbed runtime whose definition won't resolve.
    runtime.registerRunInterests(runId, taskId, workflow.nodes);

    const res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.result.definitionResolved).toBe(false);
    expect(res.result.active).toHaveLength(1);
    expect(res.result.active[0].source).toBe('unknown');
    expect(res.result.mismatches.orphanActive).toBe(0);
  });

  test('a static entry on a non-canonical task is orphan, not declared', () => {
    // A run with a duplicate/superseded task: a static entry registered for the
    // non-canonical task must not mark the slot's declaration active or be
    // labeled declared. Only the canonical task's static entries back a
    // declaration; the stale entry surfaces as orphan.
    const runtime = makeRuntime();
    const {
      workflow,
      runId,
      taskId: canonicalId,
    } = createRun({
      coderInterests: [{ topic: 'github/owner/repo/issues/*' }],
    });
    // Create a second, non-canonical task (different title → not picked as canonical).
    const dupTask = taskRepo.createTask({
      spaceId: SPACE_ID,
      workflowRunId: runId,
      title: 'Duplicate',
      description: '',
      status: 'in_progress',
    }).id;
    expect(dupTask).not.toBe(canonicalId);
    // Register the static interest under the duplicate task only.
    runtime.registerRunInterests(runId, dupTask, workflow.nodes);

    const res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    // The duplicate's static entry is drift, not a backing for the declaration.
    expect(res.result.active).toHaveLength(1);
    expect(res.result.active[0].taskId).toBe(dupTask);
    expect(res.result.active[0].source).toBe('orphan');
    expect(res.result.mismatches.orphanActive).toBe(1);
    // And the slot's declared interest is NOT marked active by the stale entry.
    expect(res.result.declared[0].active).toBe(false);
    expect(res.result.mismatches.declaredNotActive).toBe(1);
  });

  test('multiple static interests on the same slot do not collapse', () => {
    const runtime = makeRuntime();
    const { workflow, runId, taskId } = createRun({
      coderInterests: [
        { topic: 'github/owner/repo/issues/*' },
        { topic: 'github/owner/repo/pull_request/*.*' },
      ],
    });
    runtime.registerRunInterests(runId, taskId, workflow.nodes);

    const res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.result.declared).toHaveLength(2);
    expect(res.result.declared.every((d) => d.active)).toBe(true);
    expect(res.result.mismatches.declaredNotActive).toBe(0);
  });

  test('reconciliation is case-insensitive across declared and the trie', () => {
    const runtime = makeRuntime();
    const { runId, taskId } = createRun();
    // Register a dynamic subscription with one casing; the reconcile key
    // lowercases both sides, so the persisted↔active match must hold.
    runtime.registerSubscription(
      runId,
      taskId,
      'code',
      'coder',
      'GitHub/Owner/Repo/Pull_Request/1.*'
    );

    const res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.result.persisted[0].active).toBe(true);
    expect(res.result.active[0].source).toBe('persisted');
    expect(res.result.mismatches).toEqual({
      declaredNotActive: 0,
      persistedNotActive: 0,
      orphanActive: 0,
    });
  });

  test('idempotent registerRunInterests re-registration does not double-count active', () => {
    const runtime = makeRuntime();
    const { workflow, runId, taskId } = createRun({
      coderInterests: [{ topic: 'github/owner/repo/issues/*' }],
    });
    runtime.registerRunInterests(runId, taskId, workflow.nodes);
    // registerRunInterests clears-and-reinserts static interests for the run;
    // re-calling it must not leave duplicate trie entries.
    runtime.registerRunInterests(runId, taskId, workflow.nodes);

    const res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.result.active.filter((a) => a.subscriptionKind === 'static')).toHaveLength(1);
    expect(res.result.declared).toHaveLength(1);
    expect(res.result.declared[0].active).toBe(true);
  });

  test('a run whose workflow definition no longer resolves reports declared empty without crashing', () => {
    // Simulate getWorkflowForRun → null (e.g. a stale/removed definition) by
    // stubbing the workflow manager. Persisted + active still reconcile, and the
    // empty `declared` layer is flagged as unavailable (definitionResolved:false)
    // so it is not misread as "the node declares no subscriptions."
    const runtime = makeRuntime({
      spaceWorkflowManager: { getWorkflowForRun: () => null } as unknown as typeof workflowManager,
    });
    const { runId, taskId } = createRun();
    runtime.registerSubscription(runId, taskId, 'code', 'coder', 'github/owner/repo/issues/*');

    const res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.result.definitionResolved).toBe(false);
    expect(res.result.declared).toEqual([]);
    expect(res.result.persisted).toHaveLength(1);
    expect(res.result.persisted[0].active).toBe(true);
  });

  test('dynamic reconciliation is scoped by taskId — sibling tasks do not cross-match', () => {
    // A run with two tasks sharing node + agent + topic. The persisted table and
    // the trie both key on taskId, so the reconcile key must too — otherwise an
    // active trie entry for task A would mark task B's persisted row active,
    // masking the persisted/active drift this tool exists to expose.
    const runtime = makeRuntime();
    const { runId, taskId: taskA } = createRun();
    const taskB = taskRepo.createTask({
      spaceId: SPACE_ID,
      workflowRunId: runId,
      title: 'B',
      description: '',
      status: 'in_progress',
    }).id;
    const topic = 'github/owner/repo/pull_request/42.*';
    // Task A: registered (write-through → trie + table). Task B: persisted only.
    runtime.registerSubscription(runId, taskA, 'code', 'coder', topic);
    subscriptionRepo.upsert({
      spaceId: SPACE_ID,
      workflowRunId: runId,
      taskId: taskB,
      nodeId: 'code',
      agentName: 'coder',
      topic,
      subscriptionKind: 'dynamic',
    });

    const res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    const byTask = new Map(res.result.persisted.map((p) => [p.taskId, p]));
    expect(byTask.get(taskA)?.active).toBe(true); // has a matching trie entry
    expect(byTask.get(taskB)?.active).toBe(false); // no trie entry for task B
    expect(res.result.mismatches.persistedNotActive).toBe(1);
    // Task A's active entry is backed; task B has no active entry at all.
    expect(res.result.active).toHaveLength(1);
    expect(res.result.active[0].source).toBe('persisted');
  });
});
