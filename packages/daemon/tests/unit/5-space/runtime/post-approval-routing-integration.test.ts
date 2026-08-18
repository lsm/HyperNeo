import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository.ts';
import { CodingArtifactProfile } from '../../../../src/lib/space/workflows/coding-artifact-profile.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import {
  seedBuiltInWorkflows,
  CODING_WORKFLOW,
  REVIEW_ONLY_WORKFLOW,
  getBuiltInWorkflows,
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import {
  isPostApprovalRoutingEnabled,
  POST_APPROVAL_ROUTING_FLAG_ENV,
} from '../../../../src/lib/space/runtime/post-approval-router.ts';
import { createMarkCompleteHandler } from '../../../../src/lib/space/tools/end-node-handlers.ts';
import type { SpaceTask, SpaceWorkflow } from '@hyperneo/shared';

const SPACE_ID = 'space-par-int';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, autonomy_level, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', 4, ?, ?)`
  ).run(SPACE_ID, '/tmp/par-int', `Space ${SPACE_ID}`, SPACE_ID, Date.now(), Date.now());
  return db;
}

function seedAgents(db: BunDatabase): Map<string, string> {
  const names = new Set<string>();
  for (const template of getBuiltInWorkflows()) {
    for (const node of template.nodes) {
      for (const a of node.agents) names.add(a.agentId);
    }
  }
  const roleToId = new Map<string, string>();
  for (const name of names) {
    const id = `agent-${name.toLowerCase().replace(/\s+/g, '-')}`;
    db.prepare(
      `INSERT INTO space_agents (id, space_id, name, description, model, tools, custom_prompt, created_at, updated_at)
       VALUES (?, ?, ?, '', null, '[]', null, ?, ?)`
    ).run(id, SPACE_ID, name, Date.now(), Date.now());
    roleToId.set(name.toLowerCase(), id);
  }
  return roleToId;
}

interface RecordedSpawn {
  taskId: string;
  targetAgent: string;
  kickoffMessage: string;
  workflowId: string;
}

interface Harness {
  db: BunDatabase;
  runtime: SpaceRuntime;
  workflowManager: SpaceWorkflowManager;
  workflowRunRepo: SpaceWorkflowRunRepository;
  taskRepo: SpaceTaskRepository;
  taskManager: SpaceTaskManager;
  artifactRepo: WorkflowRunArtifactRepository;
  artifactProfile: CodingArtifactProfile;
  spawned: RecordedSpawn[];
  injected: Array<{ taskId: string; message: string }>;
  aliveSessions: Set<string>;
  emitted: Array<{ taskId: string; status: SpaceTask['status'] }>;
}

function buildHarness(opts: { spawnerThrows?: boolean } = {}): Harness {
  const db = makeDb();
  const agentRoles = seedAgents(db);

  const workflowRunRepo = new SpaceWorkflowRunRepository(db);
  const taskRepo = new SpaceTaskRepository(db);
  const nodeExecutionRepo = new NodeExecutionRepository(db);
  const agentRepo = new SpaceAgentRepository(db);
  const agentManager = new SpaceAgentManager(agentRepo);
  const workflowRepo = new SpaceWorkflowRepository(db);
  const workflowManager = new SpaceWorkflowManager(workflowRepo);
  const spaceManager = new SpaceManager(db);
  const taskManager = new SpaceTaskManager(db, SPACE_ID);
  const artifactRepo = new WorkflowRunArtifactRepository(db);

  const result = seedBuiltInWorkflows(SPACE_ID, workflowManager, (name) =>
    agentRoles.get(name.toLowerCase())
  );
  if (result.errors.length > 0) {
    throw new Error(`seedBuiltInWorkflows failed: ${JSON.stringify(result.errors)}`);
  }

  const spawned: RecordedSpawn[] = [];
  const injected: Array<{ taskId: string; message: string }> = [];
  const aliveSessions = new Set<string>();
  const emitted: Array<{ taskId: string; status: SpaceTask['status'] }> = [];

  const config: SpaceRuntimeConfig = {
    db,
    spaceManager,
    spaceAgentManager: agentManager,
    spaceWorkflowManager: workflowManager,
    workflowRunRepo,
    taskRepo,
    nodeExecutionRepo,
    artifactRepo,
    artifactProfile: new CodingArtifactProfile({ db, artifactRepo }),
    onTaskUpdated: async ({ task }) => {
      emitted.push({ taskId: task.id, status: task.status });
    },
    taskAgentManager: {
      injectIntoTaskAgent: async (taskId: string, message: string) => {
        injected.push({ taskId, message });
        return { injected: true, sessionId: `ta-${taskId}` };
      },
      spawnPostApprovalSubSession: async (args: {
        task: SpaceTask;
        workflow: SpaceWorkflow;
        targetAgent: string;
        kickoffMessage: string;
      }) => {
        if (opts.spawnerThrows) {
          throw new Error('user interrupted');
        }
        const sessionId = `sub-${spawned.length + 1}`;
        spawned.push({
          taskId: args.task.id,
          targetAgent: args.targetAgent,
          kickoffMessage: args.kickoffMessage,
          workflowId: args.workflow.id,
        });
        aliveSessions.add(sessionId);
        return { sessionId };
      },
      isSessionAlive: (sid: string) => aliveSessions.has(sid),
    } as unknown as NonNullable<SpaceRuntimeConfig['taskAgentManager']>,
  };

  const runtime = new SpaceRuntime(config);
  return {
    db,
    runtime,
    workflowManager,
    workflowRunRepo,
    taskRepo,
    taskManager,
    artifactRepo,
    spawned,
    injected,
    aliveSessions,
    emitted,
  };
}

function seedRunAndTask(
  h: Harness,
  workflowId: string,
  title = 'Test task',
  description = ''
): { runId: string; taskId: string } {
  const run = h.workflowRunRepo.createRun({
    spaceId: SPACE_ID,
    workflowId,
    title,
    description,
  });
  const task = h.taskRepo.createTask({
    spaceId: SPACE_ID,
    title,
    description,
    status: 'in_progress',
    workflowRunId: run.id,
  });
  return { runId: run.id, taskId: task.id };
}

describe('PR 3/5 integration — dispatchPostApproval → spawn → mark_complete', () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  afterEach(() => {
    try {
      h.db.close();
    } catch {
      /* ignore */
    }
  });

  test('approved Coding task: dispatchPostApproval threads artifact.data.prUrl into kickoff; mark_complete closes it', async () => {
    const coding = h.workflowManager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WORKFLOW.name);
    expect(coding).toBeDefined();
    const codingPostApprovalNode = coding!.nodes.find((node) => node.postApproval);
    expect(codingPostApprovalNode?.postApproval?.targetAgent).toBe('coder');
    expect(codingPostApprovalNode?.postApproval?.instructions).toContain('{{pr_url}}');

    const PR_URL = 'https://github.com/example/repo/pull/42';
    const { runId, taskId } = seedRunAndTask(
      h,
      coding!.id,
      'Ship feature X',
      'Implementation complete, PR opened'
    );
    h.artifactRepo.upsert({
      id: 'art-result-1',
      runId,
      nodeId: 'tpl-coding-review',
      artifactType: 'decision',
      artifactKey: 'cycle-1',
      data: { summary: 'Reviewer approved.', prUrl: PR_URL },
    });

    const result = await h.runtime.dispatchPostApproval(taskId, 'agent');

    expect(result.mode).toBe('spawn');
    if (result.mode !== 'spawn') throw new Error('unreachable');

    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].taskId).toBe(taskId);
    expect(h.spawned[0].targetAgent).toBe('coder');
    expect(h.spawned[0].kickoffMessage).toContain(PR_URL);
    expect(h.spawned[0].kickoffMessage).not.toContain('{{pr_url}}');
    expect(h.spawned[0].kickoffMessage).not.toContain('{{autonomy_level}}');
    expect(h.spawned[0].kickoffMessage).not.toContain('{{approval_source}}');
    expect(h.spawned[0].kickoffMessage).not.toContain('{{reviewer_name}}');
    expect(h.spawned[0].kickoffMessage).not.toContain('[end-node reviewer]');
    expect(h.spawned[0].kickoffMessage).toContain('Approval source: agent');
    expect(h.spawned[0].kickoffMessage).toContain('mark_complete');

    const mid = h.taskRepo.getTask(taskId)!;
    expect(mid.status).toBe('approved');
    expect(mid.postApprovalSessionId).toBe(result.postApprovalSessionId);
    expect(mid.postApprovalStartedAt).toBe(result.postApprovalStartedAt);

    const markComplete = createMarkCompleteHandler({
      taskId,
      spaceId: SPACE_ID,
      taskRepo: h.taskRepo,
      taskManager: h.taskManager,
      callerSessionId: result.postApprovalSessionId,
    });
    const toolResult = await markComplete({});
    const parsed = JSON.parse(
      toolResult.content.map((c) => ('text' in c ? c.text : '')).join('')
    ) as { success: boolean; error?: string };
    expect(parsed.success).toBe(true);

    const finalTask = h.taskRepo.getTask(taskId)!;
    expect(finalTask.status).toBe('done');
    expect(finalTask.postApprovalSessionId).toBeNull();
    expect(finalTask.postApprovalStartedAt).toBeNull();
  });

  test('dispatchPostApproval stays bound to the earliest reviewed PR artifact', async () => {
    const coding = h.workflowManager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WORKFLOW.name)!;

    const EARLIER_URL = 'https://github.com/example/repo/pull/100';
    const LATER_URL = 'https://github.com/example/repo/pull/101';
    const { runId, taskId } = seedRunAndTask(h, coding.id, 'Rebased PR');
    h.artifactRepo.upsert({
      id: 'art-earlier',
      runId,
      nodeId: 'tpl-coding-review',
      artifactType: 'decision',
      artifactKey: 'cycle-1',
      data: { summary: 'Requested changes.', prUrl: EARLIER_URL },
    });
    await new Promise((r) => setTimeout(r, 5));
    h.artifactRepo.upsert({
      id: 'art-later',
      runId,
      nodeId: 'tpl-coding-review',
      artifactType: 'decision',
      artifactKey: 'cycle-2',
      data: { summary: 'Approved.', prUrl: LATER_URL },
    });

    const result = await h.runtime.dispatchPostApproval(taskId, 'agent');
    expect(result.mode).toBe('spawn');
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].kickoffMessage).toContain(EARLIER_URL);
    expect(h.spawned[0].kickoffMessage).not.toContain(LATER_URL);
  });

  test('dispatchPostApproval accepts snake_case `pr_url` in artifact data', async () => {
    const coding = h.workflowManager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WORKFLOW.name)!;

    const PR_URL = 'https://github.com/example/repo/pull/7';
    const { runId, taskId } = seedRunAndTask(h, coding.id, 'Snake-case PR');
    h.artifactRepo.upsert({
      id: 'art-snake',
      runId,
      nodeId: 'tpl-coding-review',
      artifactType: 'decision',
      artifactKey: 'cycle-1',
      data: { summary: 'Approved.', pr_url: PR_URL },
    });

    const result = await h.runtime.dispatchPostApproval(taskId, 'agent');
    expect(result.mode).toBe('spawn');
    expect(h.spawned[0].kickoffMessage).toContain(PR_URL);
    expect(h.spawned[0].kickoffMessage).not.toContain('{{pr_url}}');
  });

  test('approved Coding task WITHOUT pr_url artifact still spawns; kickoff preserves literal {{pr_url}} placeholder', async () => {
    const coding = h.workflowManager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WORKFLOW.name)!;
    const { taskId } = seedRunAndTask(h, coding.id, 'No PR yet');

    const result = await h.runtime.dispatchPostApproval(taskId, 'agent');
    expect(result.mode).toBe('spawn');

    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].kickoffMessage).toContain('{{pr_url}}');
  });

  test('approved task with NO postApproval → dispatchPostApproval closes directly (Review-Only path)', async () => {
    const reviewOnly = h.workflowManager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === REVIEW_ONLY_WORKFLOW.name);
    expect(reviewOnly).toBeDefined();
    expect(reviewOnly!.postApproval).toBeUndefined();
    expect(reviewOnly!.nodes.some((node) => node.postApproval)).toBe(false);

    const { taskId } = seedRunAndTask(h, reviewOnly!.id, 'Review the work');

    const result = await h.runtime.dispatchPostApproval(taskId, 'human');

    expect(result.mode).toBe('no-route');
    expect(h.spawned).toHaveLength(0);
    expect(h.taskRepo.getTask(taskId)!.status).toBe('done');
  });

  test('kill-switch: HYPERNEO_TASK_AGENT_POST_APPROVAL_ROUTING=0 disables routing at the call site', () => {
    expect(isPostApprovalRoutingEnabled({ [POST_APPROVAL_ROUTING_FLAG_ENV]: '0' })).toBe(false);
    expect(isPostApprovalRoutingEnabled({ [POST_APPROVAL_ROUTING_FLAG_ENV]: 'false' })).toBe(false);
    expect(isPostApprovalRoutingEnabled({ [POST_APPROVAL_ROUTING_FLAG_ENV]: 'off' })).toBe(false);
    expect(isPostApprovalRoutingEnabled({})).toBe(true);
    expect(isPostApprovalRoutingEnabled({ [POST_APPROVAL_ROUTING_FLAG_ENV]: '1' })).toBe(true);
  });

  test('Layer B: clears pending-completion fields even when the spawner throws after the status commit', async () => {
    h = buildHarness({ spawnerThrows: true });
    const coding = h.workflowManager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WORKFLOW.name);
    expect(coding).toBeDefined();

    const { taskId } = seedRunAndTask(h, coding!.id, 'Throw-path task', '');
    h.taskRepo.updateTask(taskId, {
      status: 'review',
      pendingCheckpointType: 'task_completion',
      pendingCompletionSubmittedByNodeId: null,
      pendingCompletionSubmittedAt: Date.now(),
      pendingCompletionReason: 'ready',
    });

    await expect(h.runtime.dispatchPostApproval(taskId, 'human')).rejects.toThrow(
      'user interrupted'
    );

    const final = h.taskRepo.getTask(taskId);
    expect(final?.status).toBe('approved');
    expect(final?.postApprovalSessionId).toBeNull();
    expect(h.spawned).toHaveLength(0);
    expect(final?.pendingCheckpointType).toBeNull();
    expect(final?.pendingCompletionSubmittedByNodeId).toBeNull();
    expect(final?.pendingCompletionSubmittedAt).toBeNull();
    expect(final?.pendingCompletionReason).toBeNull();
  });

  test('resolvePrimaryLinkUrl accepts a decision-artifact pr_url (post-approval/migration compat)', async () => {
    const coding = h.workflowManager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WORKFLOW.name)!;
    const { runId } = seedRunAndTask(h, coding.id, 'resolver probe');
    const POISON = 'https://github.com/example/repo/pull/999';
    h.artifactRepo.upsert({
      id: 'note-poison',
      runId,
      nodeId: 'n',
      artifactType: 'note',
      artifactKey: 'x',
      data: { summary: 'x', pr_url: POISON },
    });
    const profile = new CodingArtifactProfile({ db: h.db, artifactRepo: h.artifactRepo });
    expect(profile.resolvePrimaryLinkUrl(runId)).toBe(POISON);
  });
});
