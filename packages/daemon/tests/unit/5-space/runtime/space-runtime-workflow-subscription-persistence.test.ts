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
    nodeId?: string;
    agentName?: string;
    subscriptionKind?: 'static' | 'dynamic';
    topic?: string;
  }>;
}

function trieOf(runtime: SpaceRuntime): TrieInspector {
  return runtime as unknown as TrieInspector;
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

  /** Create a workflow + a (pending) run. Pending runs are excluded from
   * executor rehydration, keeping these tests focused on the trie. */
  function createRun(options: { eventInterests?: Array<{ topic: string }> } = {}): {
    workflow: SpaceWorkflow;
    runId: string;
  } {
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
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
              ...(options.eventInterests ? { eventInterests: options.eventInterests } : {}),
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
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Persist Run',
    });
    return { workflow, runId: run.id };
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
    const { runId } = createRun();
    const topic = 'github/owner/repo/pull_request/42.*';

    const result = runtime.registerSubscription(runId, 'task-1', 'code', 'coder', topic);

    expect(result.success).toBe(true);
    // Trie has the target...
    const trieMatches = trieOf(runtime).lookupSubscriptionTargets(topic);
    expect(trieMatches).toHaveLength(1);
    expect(trieMatches[0]).toMatchObject({
      workflowRunId: runId,
      nodeId: 'code',
      agentName: 'coder',
      subscriptionKind: 'dynamic',
    });
    // ...and so does the durable table.
    const rows = subscriptionRepo.listBySpace(SPACE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workflowRunId: runId,
      taskId: 'task-1',
      nodeId: 'code',
      agentName: 'coder',
      topic,
      subscriptionKind: 'dynamic',
    });
  });

  test('registerRunInterests writes static interests through to the table', () => {
    const runtime = makeRuntime();
    const { workflow, runId } = createRun({
      eventInterests: [{ topic: 'github/owner/repo/issues/*' }],
    });

    runtime.registerRunInterests(runId, 'task-1', workflow.nodes);

    const rows = subscriptionRepo.listBySpace(SPACE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subscriptionKind).toBe('static');
    expect(rows[0]!.topic).toBe('github/owner/repo/issues/*');
    expect(trieOf(runtime).lookupSubscriptionTargets('github/owner/repo/issues/7')).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Removal (write-through both sides)
  // -------------------------------------------------------------------------

  test('unregisterSubscription removes from both the table and the trie', () => {
    const runtime = makeRuntime();
    const { runId } = createRun();
    const topic = 'github/owner/repo/pull_request/42.*';
    runtime.registerSubscription(runId, 'task-1', 'code', 'coder', topic);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);

    runtime.unregisterSubscription(runId, 'task-1', 'code', 'coder', topic);

    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);
    expect(trieOf(runtime).lookupSubscriptionTargets(topic)).toHaveLength(0);
  });

  test('unregisterExecution removes the whole slot from both stores', () => {
    const runtime = makeRuntime();
    const { runId } = createRun();
    runtime.registerSubscription(runId, 'task-1', 'code', 'coder', 'github/a/*');
    runtime.registerSubscription(runId, 'task-1', 'code', 'coder', 'github/b/*');

    runtime.unregisterExecution(runId, 'task-1', 'code', 'coder');

    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);
    expect(trieOf(runtime).lookupSubscriptionTargets('github/a/x')).toHaveLength(0);
    expect(trieOf(runtime).lookupSubscriptionTargets('github/b/x')).toHaveLength(0);
  });

  test('clearRunInterests drops every subscription for the run', () => {
    const runtime = makeRuntime();
    const { runId } = createRun();
    runtime.registerSubscription(runId, 'task-1', 'code', 'coder', 'github/a/*');

    runtime.clearRunInterests(runId);

    expect(subscriptionRepo.listByRun(runId)).toHaveLength(0);
    expect(trieOf(runtime).lookupSubscriptionTargets('github/a/x')).toHaveLength(0);
  });

  test('clearRunInterestsPreservingDynamic keeps dynamic rows in both stores', () => {
    const runtime = makeRuntime();
    const { workflow, runId } = createRun({
      eventInterests: [{ topic: 'github/static/*' }],
    });
    // One static (from the workflow) + one dynamic (agent-registered).
    runtime.registerRunInterests(runId, 'task-1', workflow.nodes);
    runtime.registerSubscription(runId, 'task-1', 'code', 'coder', 'github/dynamic/*');

    runtime.clearRunInterestsPreservingDynamic(runId);

    const rows = subscriptionRepo.listByRun(runId);
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
    const { runId } = createRun();

    // --- First runtime: agent registers a dynamic subscription. ---
    const runtime1 = makeRuntime();
    runtime1.registerSubscription(runId, 'task-1', 'code', 'coder', topic);
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
      nodeId: 'code',
      agentName: 'coder',
      subscriptionKind: 'dynamic',
    });
  });

  test('static and dynamic subscriptions are both reconstructed identically on rehydrate', async () => {
    const staticTopic = 'github/owner/repo/issues/*';
    const dynamicTopic = 'github/owner/repo/pull_request/42.*';
    const { workflow, runId } = createRun({ eventInterests: [{ topic: staticTopic }] });

    const runtime1 = makeRuntime();
    runtime1.registerRunInterests(runId, 'task-1', workflow.nodes);
    runtime1.registerSubscription(runId, 'task-1', 'code', 'coder', dynamicTopic);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(2);

    const runtime2 = makeRuntime();
    await runtime2.rehydrateExecutors();

    // Static interest matches its glob...
    expect(trieOf(runtime2).lookupSubscriptionTargets('github/owner/repo/issues/9')).toHaveLength(
      1
    );
    // ...and so does the dynamic one. Both kinds rebuilt from the table.
    const dynamicMatches = trieOf(runtime2).lookupSubscriptionTargets(dynamicTopic);
    expect(dynamicMatches).toHaveLength(1);
    expect(dynamicMatches[0]!.subscriptionKind).toBe('dynamic');
  });

  test('rehydrate drops a subscription that was cleared before restart', async () => {
    const topic = 'github/owner/repo/pull_request/42.*';
    const { runId } = createRun();

    const runtime1 = makeRuntime();
    runtime1.registerSubscription(runId, 'task-1', 'code', 'coder', topic);
    runtime1.unregisterSubscription(runId, 'task-1', 'code', 'coder', topic);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);

    const runtime2 = makeRuntime();
    await runtime2.rehydrateExecutors();

    expect(trieOf(runtime2).lookupSubscriptionTargets(topic)).toHaveLength(0);
  });
});
