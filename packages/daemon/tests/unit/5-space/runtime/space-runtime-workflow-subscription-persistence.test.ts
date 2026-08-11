/**
 * SpaceRuntime — workflow event subscription persistence (Task #904, PR 5).
 *
 * The in-memory `TopicTrie` must be a pure, derived index of the durable
 * `space_workflow_event_subscriptions` table. These tests verify:
 *
 *   1. Write-through — `registerSubscription` / `registerRunInterests` write to
 *      the table as well as the trie.
 *   2. Removal — unregister/clear paths delete from both the table and the trie.
 *   3. Rebuild-from-table — a fresh runtime (simulating daemon restart) rebuilds
 *      an identical trie from the table, so a dynamic subscription survives.
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

const SPACE_ID = 'space-persist-1';
const AGENT_ID = 'agent-persist-1';

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

interface TrieInspector {
  lookupSubscriptionTargets(topic: string): Array<{
    workflowRunId?: string;
    taskId?: string;
    nodeId?: string;
    agentName?: string;
    subscriptionKind?: 'static' | 'dynamic';
    topic?: string;
  }>;
}

function trieOf(runtime: SpaceRuntime): TrieInspector {
  return runtime as unknown as TrieInspector;
}

/**
 * Repository wrapper whose `upsert` can be made to throw on demand, to exercise
 * the registerSubscription rollback that restores a displaced subscription.
 */
class FailingUpsertRepo extends SpaceWorkflowEventSubscriptionRepository {
  failNextUpsert = false;
  upsert(params: Parameters<SpaceWorkflowEventSubscriptionRepository['upsert']>[0]): void {
    if (this.failNextUpsert) throw new Error('injected upsert failure');
    super.upsert(params);
  }
}

describe('SpaceRuntime workflow subscription persistence', () => {
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

  /** Create a workflow + a (pending) run with a canonical in_progress task.
   * Pending runs are excluded from executor rehydration (keeping these tests
   * focused on the trie), and the task makes the run `isRunInterestRebuildEligible`
   * so the rebuild path reconstructs its subscriptions. */
  function createRun(
    options: { eventInterests?: Array<{ topic: string }>; nodeId?: string } = {}
  ): {
    workflow: SpaceWorkflow;
    runId: string;
    taskId: string;
  } {
    const nodeId = options.nodeId ?? 'code';
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Workflow-${Math.random()}`,
      description: '',
      nodes: [
        {
          id: nodeId,
          name: 'Code',
          agents: [
            {
              agentId: AGENT_ID,
              name: 'coder',
              ...(options.eventInterests ? { eventInterests: options.eventInterests } : {}),
            },
          ],
        },
      ],
      transitions: [],
      startNodeId: nodeId,
      rules: [],
      tags: [],
    });
    const run = workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Persist Run',
    });
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      workflowRunId: run.id,
      title: 'Persist Run',
      description: '',
      status: 'in_progress',
    });
    return { workflow, runId: run.id, taskId: task.id };
  }

  beforeEach(() => {
    db = makeDb();
    seedSpaceRow(db, SPACE_ID);
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

  // -------------------------------------------------------------------------
  // Write-through
  // -------------------------------------------------------------------------

  test('registerSubscription writes through to the table and the trie', () => {
    const runtime = makeRuntime();
    const { runId, taskId } = createRun();
    const topic = 'github/owner/repo/pull_request/42.*';

    const result = runtime.registerSubscription(runId, taskId, 'code', 'coder', topic);

    expect(result.success).toBe(true);
    // Trie has the target...
    const trieMatches = trieOf(runtime).lookupSubscriptionTargets(topic);
    expect(trieMatches).toHaveLength(1);
    expect(trieMatches[0]).toMatchObject({
      workflowRunId: runId,
      taskId,
      nodeId: 'code',
      agentName: 'coder',
      subscriptionKind: 'dynamic',
    });
    // ...and so does the durable table.
    const rows = subscriptionRepo.listBySpace(SPACE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workflowRunId: runId,
      taskId,
      nodeId: 'code',
      agentName: 'coder',
      topic,
      subscriptionKind: 'dynamic',
    });
  });

  test('registerRunInterests registers static interests in the trie but does not persist them', () => {
    // Static interests are re-materialized from the workflow definition on
    // rehydrate, so they live in the trie only — the durable table backs
    // dynamic subscriptions exclusively.
    const runtime = makeRuntime();
    const { workflow, runId, taskId } = createRun({
      eventInterests: [{ topic: 'github/owner/repo/issues/*' }],
    });

    runtime.registerRunInterests(runId, taskId, workflow.nodes);

    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);
    expect(trieOf(runtime).lookupSubscriptionTargets('github/owner/repo/issues/7')).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Removal (write-through both sides)
  // -------------------------------------------------------------------------

  test('unregisterSubscription removes from both the table and the trie', () => {
    const runtime = makeRuntime();
    const { runId, taskId } = createRun();
    const topic = 'github/owner/repo/pull_request/42.*';
    runtime.registerSubscription(runId, taskId, 'code', 'coder', topic);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);

    runtime.unregisterSubscription(runId, taskId, 'code', 'coder', topic);

    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);
    expect(trieOf(runtime).lookupSubscriptionTargets(topic)).toHaveLength(0);
  });

  test('unregisterExecution removes the whole slot from both stores', () => {
    const runtime = makeRuntime();
    const { runId, taskId } = createRun();
    runtime.registerSubscription(runId, taskId, 'code', 'coder', 'github/a/*');
    runtime.registerSubscription(runId, taskId, 'code', 'coder', 'github/b/*');

    runtime.unregisterExecution(runId, taskId, 'code', 'coder');

    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);
    expect(trieOf(runtime).lookupSubscriptionTargets('github/a/x')).toHaveLength(0);
    expect(trieOf(runtime).lookupSubscriptionTargets('github/b/x')).toHaveLength(0);
  });

  test('clearRunInterests drops every subscription for the run', () => {
    const runtime = makeRuntime();
    const { runId, taskId } = createRun();
    runtime.registerSubscription(runId, taskId, 'code', 'coder', 'github/a/*');

    runtime.clearRunInterests(runId);

    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);
    expect(trieOf(runtime).lookupSubscriptionTargets('github/a/x')).toHaveLength(0);
  });

  test('clearRunInterestsPreservingDynamic keeps dynamic rows in both stores', () => {
    const runtime = makeRuntime();
    const { workflow, runId, taskId } = createRun({
      eventInterests: [{ topic: 'github/static/*' }],
    });
    // One static (from the workflow) + one dynamic (agent-registered).
    runtime.registerRunInterests(runId, taskId, workflow.nodes);
    runtime.registerSubscription(runId, taskId, 'code', 'coder', 'github/dynamic/*');

    runtime.clearRunInterestsPreservingDynamic(runId);

    const rows = subscriptionRepo.listBySpace(SPACE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subscriptionKind).toBe('dynamic');
    expect(trieOf(runtime).lookupSubscriptionTargets('github/static/x')).toHaveLength(0);
    expect(trieOf(runtime).lookupSubscriptionTargets('github/dynamic/x')).toHaveLength(1);
  });

  test('clearTaskInterests removes the task subscriptions from both stores', () => {
    const runtime = makeRuntime();
    const { runId, taskId } = createRun();
    runtime.registerSubscription(runId, taskId, 'code', 'coder', 'github/a/*');

    runtime.clearTaskInterests(taskId);

    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);
    expect(trieOf(runtime).lookupSubscriptionTargets('github/a/x')).toHaveLength(0);
  });

  test('clearTaskInterestsPreservingDynamic keeps dynamic rows in both stores', () => {
    const runtime = makeRuntime();
    const { workflow, runId, taskId } = createRun({
      eventInterests: [{ topic: 'github/static/*' }],
    });
    runtime.registerRunInterests(runId, taskId, workflow.nodes);
    runtime.registerSubscription(runId, taskId, 'code', 'coder', 'github/dynamic/*');

    runtime.clearTaskInterestsPreservingDynamic(taskId);

    // Static cleared from the trie; dynamic kept in both. The table holds only
    // the dynamic row (static was never persisted).
    const rows = subscriptionRepo.listBySpace(SPACE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subscriptionKind).toBe('dynamic');
    expect(trieOf(runtime).lookupSubscriptionTargets('github/static/x')).toHaveLength(0);
    expect(trieOf(runtime).lookupSubscriptionTargets('github/dynamic/x')).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Rebuild-from-table (the restart-survival fix)
  // -------------------------------------------------------------------------

  test('a dynamic subscription survives a daemon restart (trie rebuilt from table)', async () => {
    const topic = 'github/owner/repo/pull_request/42.*';
    const { runId, taskId } = createRun();

    // --- First runtime: agent registers a dynamic subscription. ---
    const runtime1 = makeRuntime();
    runtime1.registerSubscription(runId, taskId, 'code', 'coder', topic);
    expect(trieOf(runtime1).lookupSubscriptionTargets(topic)).toHaveLength(1);
    // Durable row exists independently of the runtime instance.
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);

    // --- Second runtime against the same DB simulates a daemon restart: its
    //     in-memory trie starts empty. ---
    const runtime2 = makeRuntime();
    expect(trieOf(runtime2).lookupSubscriptionTargets(topic)).toHaveLength(0);

    // Rehydrate rebuilds the trie purely from the table.
    await runtime2.rehydrateExecutors();

    const rebuilt = trieOf(runtime2).lookupSubscriptionTargets(topic);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]).toMatchObject({
      workflowRunId: runId,
      taskId,
      nodeId: 'code',
      agentName: 'coder',
      subscriptionKind: 'dynamic',
    });
  });

  test('static and dynamic subscriptions are both reconstructed identically on rehydrate', async () => {
    const staticTopic = 'github/owner/repo/issues/*';
    const dynamicTopic = 'github/owner/repo/pull_request/42.*';
    const { workflow, runId, taskId } = createRun({ eventInterests: [{ topic: staticTopic }] });

    const runtime1 = makeRuntime();
    runtime1.registerRunInterests(runId, taskId, workflow.nodes);
    runtime1.registerSubscription(runId, taskId, 'code', 'coder', dynamicTopic);
    // Only the dynamic interest is persisted; static is re-derived from the def.
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);
    expect(subscriptionRepo.listBySpace(SPACE_ID)[0]!.subscriptionKind).toBe('dynamic');

    const runtime2 = makeRuntime();
    await runtime2.rehydrateExecutors();

    // Static interest is re-materialized from the workflow definition...
    expect(trieOf(runtime2).lookupSubscriptionTargets('github/owner/repo/issues/9')).toHaveLength(
      1
    );
    // ...and the dynamic one is restored from the table, with the routing
    // taskId preserved.
    const dynamicMatches = trieOf(runtime2).lookupSubscriptionTargets(dynamicTopic);
    expect(dynamicMatches).toHaveLength(1);
    expect(dynamicMatches[0]!.subscriptionKind).toBe('dynamic');
    expect(dynamicMatches[0]!.taskId).toBe(taskId);
  });

  test('rehydrate drops a subscription that was cleared before restart', async () => {
    const topic = 'github/owner/repo/pull_request/42.*';
    const { runId, taskId } = createRun();

    const runtime1 = makeRuntime();
    runtime1.registerSubscription(runId, taskId, 'code', 'coder', topic);
    runtime1.unregisterSubscription(runId, taskId, 'code', 'coder', topic);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);

    const runtime2 = makeRuntime();
    await runtime2.rehydrateExecutors();

    expect(trieOf(runtime2).lookupSubscriptionTargets(topic)).toHaveLength(0);
  });

  test('rehydrate preserves a dynamic subscription on a succeeded run whose task is still in review', async () => {
    // A succeeded run whose canonical task parks at `review`/`approved` is in
    // the post-approval phase and still delivers events, so its dynamic
    // subscription must survive restart. (When the task finally goes
    // `done`/`archived`, the task-lifecycle cleanup clears the row, and a
    // subsequent rehydrate finds nothing to restore — covered by the
    // "cleared before restart" test above.)
    const topic = 'github/owner/repo/pull_request/42.*';
    const { runId, taskId } = createRun();

    const runtime1 = makeRuntime();
    runtime1.registerSubscription(runId, taskId, 'code', 'coder', topic);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);

    // Run succeeds; its task enters review between sessions.
    workflowRunRepo.updateRun(runId, { status: 'done', completedAt: Date.now() });
    taskRepo.updateTask(taskId, { status: 'review' });

    const runtime2 = makeRuntime();
    await runtime2.rehydrateExecutors();

    expect(trieOf(runtime2).lookupSubscriptionTargets(topic)).toHaveLength(1);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);
  });

  test('rehydrateExecutors is idempotent (no duplicate trie entries on repeat)', async () => {
    const topic = 'github/owner/repo/pull_request/42.*';
    const { runId, taskId } = createRun();

    const runtime1 = makeRuntime();
    runtime1.registerSubscription(runId, taskId, 'code', 'coder', topic);

    const runtime2 = makeRuntime();
    await runtime2.rehydrateExecutors();
    await runtime2.rehydrateExecutors();

    expect(trieOf(runtime2).lookupSubscriptionTargets(topic)).toHaveLength(1);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);
  });

  test('rehydrate purges a row whose task is terminal at restart (crash window)', async () => {
    // If the daemon died between committing a task's `done` status and the
    // task-lifecycle subscriber clearing the subscription row, the row survives.
    // The rebuild reconciles against the current task status and purges it so it
    // is not restored as a terminally-failing target. (Cancelled-task rows are
    // NOT purged — the lifecycle preserves them for retry.)
    const topic = 'github/owner/repo/pull_request/42.*';
    const { runId, taskId } = createRun();

    const runtime1 = makeRuntime();
    runtime1.registerSubscription(runId, taskId, 'code', 'coder', topic);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);

    // Task went terminal but the lifecycle subscriber never ran (crash window).
    taskRepo.updateTask(taskId, { status: 'done', completedAt: Date.now() });

    const runtime2 = makeRuntime();
    await runtime2.rehydrateExecutors();

    expect(trieOf(runtime2).lookupSubscriptionTargets(topic)).toHaveLength(0);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);
  });

  test('rehydrate keeps a row whose task is cancelled (retry semantics)', async () => {
    const topic = 'github/owner/repo/pull_request/42.*';
    const { runId, taskId } = createRun();

    const runtime1 = makeRuntime();
    runtime1.registerSubscription(runId, taskId, 'code', 'coder', topic);

    // Cancelled tasks preserve dynamic interests for a potential retry
    // (clearTaskInterestsPreservingDynamic), so the row survives rehydrate.
    taskRepo.updateTask(taskId, { status: 'cancelled' });

    const runtime2 = makeRuntime();
    await runtime2.rehydrateExecutors();

    expect(trieOf(runtime2).lookupSubscriptionTargets(topic)).toHaveLength(1);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);
  });

  test('registerSubscription rejects when the run cannot be resolved (no trie entry, no row)', () => {
    // A stale worker whose run is gone would yield an undeliverable, non-durable
    // target, so registration fails fast before mutating the trie or table.
    const runtime = makeRuntime();
    const topic = 'github/owner/repo/pull_request/42.*';

    const result = runtime.registerSubscription(
      'run-does-not-exist',
      'task-x',
      'code',
      'coder',
      topic
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(trieOf(runtime).lookupSubscriptionTargets(topic)).toHaveLength(0);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);
  });

  test('registerSubscription rejects a terminal-task subscription', () => {
    const runtime = makeRuntime();
    const { runId, taskId } = createRun();
    taskRepo.updateTask(taskId, { status: 'done', completedAt: Date.now() });

    const result = runtime.registerSubscription(
      runId,
      taskId,
      'code',
      'coder',
      'github/owner/repo/pull_request/42.*'
    );

    expect(result.success).toBe(false);
    expect(
      trieOf(runtime).lookupSubscriptionTargets('github/owner/repo/pull_request/42.*')
    ).toHaveLength(0);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);
  });

  test('registerSubscription rejects a subscription for a task not owned by the run', () => {
    const runtime = makeRuntime();
    const a = createRun();
    const b = createRun({ nodeId: 'code-b' });
    // b's task does not belong to a's run.
    const result = runtime.registerSubscription(a.runId, b.taskId, 'code', 'coder', 'github/a/*');

    expect(result.success).toBe(false);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);
  });

  test('a failed re-registration restores the displaced subscription', () => {
    const repo = new FailingUpsertRepo(db);
    const runtime = makeRuntime({ workflowEventSubscriptionRepo: repo });
    const { runId, taskId } = createRun();
    const topic = 'github/owner/repo/pull_request/42.*';

    // Register successfully — the trie + table carry the subscription.
    runtime.registerSubscription(runId, taskId, 'code', 'coder', topic);
    expect(trieOf(runtime).lookupSubscriptionTargets(topic)).toHaveLength(1);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);

    // Re-register the same topic with an injected upsert failure. The dedup
    // displaced the existing entry; the rollback must restore it rather than
    // leave the trie diverged from the still-persisted row.
    repo.failNextUpsert = true;
    const result = runtime.registerSubscription(runId, taskId, 'code', 'coder', topic);

    expect(result.success).toBe(false);
    expect(trieOf(runtime).lookupSubscriptionTargets(topic)).toHaveLength(1);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);
  });

  test('rehydrate purges subscriptions for a cancelled run', async () => {
    // A crash between cancelWorkflowRun committing `cancelled` and its
    // clearRunInterests leaves rows that the rehydrate must purge (cancelled-RUN
    // teardown), while a cancelled TASK on a non-cancelled run is preserved.
    const topic = 'github/owner/repo/pull_request/42.*';
    const { runId, taskId } = createRun();

    const runtime1 = makeRuntime();
    runtime1.registerSubscription(runId, taskId, 'code', 'coder', topic);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);

    // Run cancelled between sessions (clearRunInterests did not fire).
    workflowRunRepo.updateRun(runId, { status: 'cancelled' });

    const runtime2 = makeRuntime();
    await runtime2.rehydrateExecutors();

    expect(trieOf(runtime2).lookupSubscriptionTargets(topic)).toHaveLength(0);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);
  });

  test('rehydrate purges a row whose own (noncanonical) task is terminal, even with an active canonical task', async () => {
    // A run can briefly hold a noncanonical duplicate task. If that task goes
    // `done` in the crash window (clearTaskInterests didn't fire), its row must
    // be purged even though the run's canonical task is still active — so the
    // purge reconciles each row against its OWN task, not the canonical one.
    const topic = 'github/owner/repo/pull_request/42.*';
    const { runId } = createRun();
    // A second, noncanonical task on the same run (different title → not canonical).
    const dupTask = taskRepo.createTask({
      spaceId: SPACE_ID,
      workflowRunId: runId,
      title: 'Noncanonical',
      description: '',
      status: 'in_progress',
    });

    const runtime1 = makeRuntime();
    runtime1.registerSubscription(runId, dupTask.id, 'code', 'coder', topic);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);

    // The noncanonical task goes terminal in the crash window.
    taskRepo.updateTask(dupTask.id, { status: 'done', completedAt: Date.now() });

    const runtime2 = makeRuntime();
    await runtime2.rehydrateExecutors();

    expect(trieOf(runtime2).lookupSubscriptionTargets(topic)).toHaveLength(0);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);
  });

  test('registerRunInterests does not throw for a cancelled canonical task (static skips the task gate)', () => {
    // Static interests are runtime-driven re-materialization. A rehydratable run
    // can have a retryably-cancelled canonical task; rejecting it would make
    // registerRunInterests throw and abort the whole rehydrate pass. The task
    // gate applies to dynamic (agent) registrations only.
    const runtime = makeRuntime();
    const { workflow, runId, taskId } = createRun({
      eventInterests: [{ topic: 'github/owner/repo/issues/*' }],
    });
    taskRepo.updateTask(taskId, { status: 'cancelled' });

    expect(() => runtime.registerRunInterests(runId, taskId, workflow.nodes)).not.toThrow();
    expect(trieOf(runtime).lookupSubscriptionTargets('github/owner/repo/issues/7')).toHaveLength(1);
  });
});
