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
    runtime.registerRunInterests(runId, taskId, workflow.nodes);
    const dynamicTopic = 'github/owner/repo/pull_request/42.*';
    expect(runtime.registerSubscription(runId, taskId, 'code', 'coder', dynamicTopic).success).toBe(
      true
    );

    const res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    const { result } = res;

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

    expect(result.persisted).toHaveLength(1);
    expect(result.persisted[0]).toMatchObject({
      nodeId: 'code',
      agentName: 'coder',
      taskId,
      topic: dynamicTopic,
      active: true,
    });

    expect(result.active).toHaveLength(2);
    const staticActive = result.active.find((a) => a.subscriptionKind === 'static');
    const dynamicActive = result.active.find((a) => a.subscriptionKind === 'dynamic');
    expect(staticActive?.source).toBe('declared');
    expect(staticActive?.topic).toBe('github/owner/repo/issues/*');
    expect(dynamicActive?.source).toBe('persisted');
    expect(dynamicActive?.topic).toBe(dynamicTopic);

    expect(result.mismatches).toEqual({
      declaredNotActive: 0,
      persistedNotActive: 0,
      orphanActive: 0,
    });
  });

  test('#896 scenario: a node with no declared PR-event interest shows declared empty from durable data', () => {
    const runtime = makeRuntime();
    const { runId, taskId } = createRun({
      coderInterests: [{ topic: 'github/owner/repo/issues/*' }],
    });

    const res = runtime.listSubscriptions(runId, SPACE_ID, 'code');
    expect(res.success).toBe(true);
    if (!res.success) return;
    const { result } = res;

    const declaredTopics = result.declared.map((d) => d.topic);
    expect(declaredTopics).not.toContain(expect.stringContaining('pull_request'));
    expect(declaredTopics).toEqual(['github/owner/repo/issues/*']);
    expect(result.mismatches.declaredNotActive).toBe(1);
  });

  test('declared-but-not-active surfaces when static interests are not materialized', () => {
    const runtime = makeRuntime();
    const { runId } = createRun({
      coderInterests: [{ topic: 'github/owner/repo/issues/*' }],
    });

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
    runtime.registerSubscription(
      runId,
      taskId,
      'code',
      'coder',
      'github/owner/repo/pull_request/42.*'
    );
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

  test('P1: a terminal-task run does not report cleared static interests as drift', () => {
    const runtime = makeRuntime();
    const { workflow, runId, taskId } = createRun({
      coderInterests: [{ topic: 'github/owner/repo/issues/*' }],
    });
    runtime.registerRunInterests(runId, taskId, workflow.nodes);

    let res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.result.declared[0].active).toBe(true);
    expect(res.result.mismatches.declaredNotActive).toBe(0);

    taskRepo.updateTask(taskId, { status: 'done' });
    runtime.clearTaskInterests(taskId);

    res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.result.declared).toHaveLength(1);
    expect(res.result.declared[0].active).toBe(false);
    expect(res.result.mismatches.declaredNotActive).toBe(0);
  });

  test('a terminal task with a leftover static trie entry surfaces it as orphan', () => {
    const runtime = makeRuntime();
    const { workflow, runId, taskId } = createRun({
      coderInterests: [{ topic: 'github/owner/repo/issues/*' }],
    });
    runtime.registerRunInterests(runId, taskId, workflow.nodes);
    taskRepo.updateTask(taskId, { status: 'done' });

    const res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.result.mismatches.declaredNotActive).toBe(0);
    expect(res.result.active).toHaveLength(1);
    expect(res.result.active[0].subscriptionKind).toBe('static');
    expect(res.result.active[0].source).toBe('orphan');
    expect(res.result.mismatches.orphanActive).toBe(1);
  });

  test('a static entry is "unknown" (not orphan) when the definition cannot be loaded', () => {
    const runtime = makeRuntime({
      spaceWorkflowManager: { getWorkflowForRun: () => null } as unknown as typeof workflowManager,
    });
    const { workflow, runId, taskId } = createRun({
      coderInterests: [{ topic: 'github/owner/repo/issues/*' }],
    });
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
    const runtime = makeRuntime();
    const {
      workflow,
      runId,
      taskId: canonicalId,
    } = createRun({
      coderInterests: [{ topic: 'github/owner/repo/issues/*' }],
    });
    const dupTask = taskRepo.createTask({
      spaceId: SPACE_ID,
      workflowRunId: runId,
      title: 'Duplicate',
      description: '',
      status: 'in_progress',
    }).id;
    expect(dupTask).not.toBe(canonicalId);
    runtime.registerRunInterests(runId, dupTask, workflow.nodes);

    const res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.result.active).toHaveLength(1);
    expect(res.result.active[0].taskId).toBe(dupTask);
    expect(res.result.active[0].source).toBe('orphan');
    expect(res.result.mismatches.orphanActive).toBe(1);
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
    runtime.registerRunInterests(runId, taskId, workflow.nodes);

    const res = runtime.listSubscriptions(runId, SPACE_ID);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.result.active.filter((a) => a.subscriptionKind === 'static')).toHaveLength(1);
    expect(res.result.declared).toHaveLength(1);
    expect(res.result.declared[0].active).toBe(true);
  });

  test('a run whose workflow definition no longer resolves reports declared empty without crashing', () => {
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
    expect(byTask.get(taskA)?.active).toBe(true);
    expect(byTask.get(taskB)?.active).toBe(false);
    expect(res.result.mismatches.persistedNotActive).toBe(1);
    expect(res.result.active).toHaveLength(1);
    expect(res.result.active[0].source).toBe('persisted');
  });
});
