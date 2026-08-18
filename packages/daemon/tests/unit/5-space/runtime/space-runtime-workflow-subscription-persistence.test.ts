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

  test('registerSubscription writes through to the table and the trie', () => {
    const runtime = makeRuntime();
    const { runId, taskId } = createRun();
    const topic = 'github/owner/repo/pull_request/42.*';

    const result = runtime.registerSubscription(runId, taskId, 'code', 'coder', topic);

    expect(result.success).toBe(true);
    const trieMatches = trieOf(runtime).lookupSubscriptionTargets(topic);
    expect(trieMatches).toHaveLength(1);
    expect(trieMatches[0]).toMatchObject({
      workflowRunId: runId,
      taskId,
      nodeId: 'code',
      agentName: 'coder',
      subscriptionKind: 'dynamic',
    });
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
    const runtime = makeRuntime();
    const { workflow, runId, taskId } = createRun({
      eventInterests: [{ topic: 'github/owner/repo/issues/*' }],
    });

    runtime.registerRunInterests(runId, taskId, workflow.nodes);

    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);
    expect(trieOf(runtime).lookupSubscriptionTargets('github/owner/repo/issues/7')).toHaveLength(1);
  });

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

    const rows = subscriptionRepo.listBySpace(SPACE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subscriptionKind).toBe('dynamic');
    expect(trieOf(runtime).lookupSubscriptionTargets('github/static/x')).toHaveLength(0);
    expect(trieOf(runtime).lookupSubscriptionTargets('github/dynamic/x')).toHaveLength(1);
  });

  test('a dynamic subscription survives a daemon restart (trie rebuilt from table)', async () => {
    const topic = 'github/owner/repo/pull_request/42.*';
    const { runId, taskId } = createRun();

    const runtime1 = makeRuntime();
    runtime1.registerSubscription(runId, taskId, 'code', 'coder', topic);
    expect(trieOf(runtime1).lookupSubscriptionTargets(topic)).toHaveLength(1);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);

    const runtime2 = makeRuntime();
    expect(trieOf(runtime2).lookupSubscriptionTargets(topic)).toHaveLength(0);

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
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);
    expect(subscriptionRepo.listBySpace(SPACE_ID)[0]!.subscriptionKind).toBe('dynamic');

    const runtime2 = makeRuntime();
    await runtime2.rehydrateExecutors();

    expect(trieOf(runtime2).lookupSubscriptionTargets('github/owner/repo/issues/9')).toHaveLength(
      1
    );
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
    const topic = 'github/owner/repo/pull_request/42.*';
    const { runId, taskId } = createRun();

    const runtime1 = makeRuntime();
    runtime1.registerSubscription(runId, taskId, 'code', 'coder', topic);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);

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
    const topic = 'github/owner/repo/pull_request/42.*';
    const { runId, taskId } = createRun();

    const runtime1 = makeRuntime();
    runtime1.registerSubscription(runId, taskId, 'code', 'coder', topic);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);

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

    taskRepo.updateTask(taskId, { status: 'cancelled' });

    const runtime2 = makeRuntime();
    await runtime2.rehydrateExecutors();

    expect(trieOf(runtime2).lookupSubscriptionTargets(topic)).toHaveLength(1);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);
  });

  test('registerSubscription rejects when the run cannot be resolved (no trie entry, no row)', () => {
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
    const result = runtime.registerSubscription(a.runId, b.taskId, 'code', 'coder', 'github/a/*');

    expect(result.success).toBe(false);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);
  });

  test('a failed re-registration restores the displaced subscription', () => {
    const repo = new FailingUpsertRepo(db);
    const runtime = makeRuntime({ workflowEventSubscriptionRepo: repo });
    const { runId, taskId } = createRun();
    const topic = 'github/owner/repo/pull_request/42.*';

    runtime.registerSubscription(runId, taskId, 'code', 'coder', topic);
    expect(trieOf(runtime).lookupSubscriptionTargets(topic)).toHaveLength(1);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);

    repo.failNextUpsert = true;
    const result = runtime.registerSubscription(runId, taskId, 'code', 'coder', topic);

    expect(result.success).toBe(false);
    expect(trieOf(runtime).lookupSubscriptionTargets(topic)).toHaveLength(1);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);
  });

  test('rehydrate purges subscriptions for a cancelled run', async () => {
    const topic = 'github/owner/repo/pull_request/42.*';
    const { runId, taskId } = createRun();

    const runtime1 = makeRuntime();
    runtime1.registerSubscription(runId, taskId, 'code', 'coder', topic);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);

    workflowRunRepo.updateRun(runId, { status: 'cancelled' });

    const runtime2 = makeRuntime();
    await runtime2.rehydrateExecutors();

    expect(trieOf(runtime2).lookupSubscriptionTargets(topic)).toHaveLength(0);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);
  });

  test('rehydrate purges a row whose own (noncanonical) task is terminal, even with an active canonical task', async () => {
    const topic = 'github/owner/repo/pull_request/42.*';
    const { runId } = createRun();
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

    taskRepo.updateTask(dupTask.id, { status: 'done', completedAt: Date.now() });

    const runtime2 = makeRuntime();
    await runtime2.rehydrateExecutors();

    expect(trieOf(runtime2).lookupSubscriptionTargets(topic)).toHaveLength(0);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);
  });

  test('registerRunInterests does not throw for a cancelled canonical task (static skips the task gate)', () => {
    const runtime = makeRuntime();
    const { workflow, runId, taskId } = createRun({
      eventInterests: [{ topic: 'github/owner/repo/issues/*' }],
    });
    taskRepo.updateTask(taskId, { status: 'cancelled' });

    expect(() => runtime.registerRunInterests(runId, taskId, workflow.nodes)).not.toThrow();
    expect(trieOf(runtime).lookupSubscriptionTargets('github/owner/repo/issues/7')).toHaveLength(1);
  });

  test('registerRunInterestsFromWorkflow skips static rebuild for a cancelled canonical task', () => {
    const runtime = makeRuntime();
    const { workflow, runId, taskId } = createRun({
      eventInterests: [{ topic: 'github/owner/repo/issues/*' }],
    });
    taskRepo.updateTask(taskId, { status: 'cancelled' });
    const run = workflowRunRepo.getRun(runId);
    expect(run).toBeTruthy();

    (
      runtime as unknown as {
        registerRunInterestsFromWorkflow(
          run: { id: string; title: string },
          workflow: SpaceWorkflow
        ): void;
      }
    ).registerRunInterestsFromWorkflow(run!, workflow);

    expect(trieOf(runtime).lookupSubscriptionTargets('github/owner/repo/issues/7')).toHaveLength(0);
  });

  test('hard-deleting a task cascade-removes its subscription row (no durable phantom)', async () => {
    const topic = 'github/owner/repo/pull_request/42.*';
    const { runId, taskId } = createRun();

    const runtime1 = makeRuntime();
    runtime1.registerSubscription(runId, taskId, 'code', 'coder', topic);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(1);

    taskRepo.deleteTask(taskId);

    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);

    const runtime2 = makeRuntime();
    await runtime2.rehydrateExecutors();

    expect(trieOf(runtime2).lookupSubscriptionTargets(topic)).toHaveLength(0);
    expect(subscriptionRepo.listBySpace(SPACE_ID)).toHaveLength(0);
  });
});
