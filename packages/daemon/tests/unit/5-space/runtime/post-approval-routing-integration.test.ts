/**
 * Integration test for PR 3/5 — built-in workflow + PostApprovalRouter +
 * mark_complete end-to-end, driven through the real
 * `SpaceRuntime.dispatchPostApproval` entry point.
 *
 * This is the §4.6 "full approve → post-approval → mark_complete" coverage
 * the reviewer asked for (`post-approval-routing.test.ts (or equivalent)`).
 * It is an "equivalent" in the form of a runtime-level integration test
 * rather than an online/E2E test because:
 *
 *   - The online test harness (`tests/online/space/`) boots a real daemon
 *     and drives RPC round-trips. That harness is valuable for UI/RPC
 *     contracts but adds process overhead and non-determinism that isn't
 *     needed here — the work under test is 100% daemon-side plumbing.
 *   - Running against the real SpaceTaskRepository + SpaceWorkflowManager
 *     + seedBuiltInWorkflows + SpaceRuntime.dispatchPostApproval +
 *     PostApprovalRouter + createMarkCompleteHandler exercises every
 *     production code path PR 3/5 touches, with a thin TaskAgentManager
 *     stub for the two delegate methods the router already expects to be
 *     injected at runtime.
 *   - Same determinism + speed profile as the rest of `tests/unit/5-space/`;
 *     runs inside the 5-space shard in CI with no extra harness.
 *
 * Shape of the flow under test:
 *
 *     seedBuiltInWorkflows()
 *         └── Coding workflow row with
 *             postApproval.targetAgent = 'merger'
 *     ▼
 *     create workflow run referencing the Coding workflow
 *     create task referencing that run via `workflowRunId`
 *     artifactRepo.upsert(result artifact with data.prUrl) — mirrors what
 *     the end-node reviewer does via save_artifact({ type: 'result',
 *     data: { prUrl } }) immediately before approve_task(). Migration 84
 *     dropped the `pr_url` column from `space_tasks`, so the workflow-run
 *     artifact store is the canonical source for `{{pr_url}}`
 *     interpolation.
 *     ▼
 *     SpaceRuntime.dispatchPostApproval(taskId, 'agent')
 *         ├── transitions → approved (via SpaceTaskManager.setTaskStatus)
 *         ├── scans workflow_run_artifacts for `prUrl`/`pr_url` and
 *         │   threads it into routeContext as `pr_url`
 *         └── PostApprovalRouter.route()
 *             └── mode='spawn', postApprovalSessionId stamped, kickoff
 *                 message contains the real PR URL (no {{pr_url}} literal)
 *     ▼
 *     mark_complete handler (simulates the post-approval sub-session)
 *         └── status approved → done, postApprovalSessionId cleared
 *
 * PLUS:
 *   - no-artifact companion: without a `prUrl`-bearing artifact, the
 *     kickoff leaves `{{pr_url}}` as a literal placeholder (the
 *     conditional spread guards against crashing on missing context).
 *   - no-route companion on Plan & Decompose (no postApproval declared)
 *   - kill-switch contract on `isPostApprovalRoutingEnabled`
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import {
  seedBuiltInWorkflows,
  CODING_WORKFLOW,
  PLAN_AND_DECOMPOSE_WORKFLOW,
  getBuiltInWorkflows,
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import {
  isPostApprovalRoutingEnabled,
  POST_APPROVAL_ROUTING_FLAG_ENV,
} from '../../../../src/lib/space/runtime/post-approval-router.ts';
import { createMarkCompleteHandler } from '../../../../src/lib/space/tools/end-node-handlers.ts';
import type { SpaceTask, SpaceWorkflow } from '@hyperneo/shared';

// ---------------------------------------------------------------------------
// DB + seed helpers
// ---------------------------------------------------------------------------

const SPACE_ID = 'space-par-int';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  // autonomy_level is INTEGER NOT NULL DEFAULT 1 (m84). Set it explicitly to
  // 4 so the `{{autonomy_level}}` token in the merge template interpolates
  // to a real number and the assertions can check the auto-merge-gate text
  // reads correctly. Without this the column defaults to 1 (still valid;
  // tests would still pass on the `not.toContain('{{autonomy_level}}')` check,
  // but asserting the rendered value adds a stronger guarantee).
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, autonomy_level, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', 4, ?, ?)`
  ).run(SPACE_ID, '/tmp/par-int', `Space ${SPACE_ID}`, SPACE_ID, Date.now(), Date.now());
  return db;
}

/**
 * Seed one agent per role referenced by ANY built-in workflow. The seeder
 * pre-validates across all five templates before persisting so even tests
 * that only care about Coding have to satisfy the full role set. Mirrors
 * what the `space.create` RPC handler does in production.
 */
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

// ---------------------------------------------------------------------------
// SpaceRuntime test harness — wires the same dependencies the daemon does,
// with stubbed TaskAgentManager delegates so we can observe spawn kickoffs
// without needing a real Claude SDK session.
// ---------------------------------------------------------------------------

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
    onTaskUpdated: async ({ task }) => {
      emitted.push({ taskId: task.id, status: task.status });
    },
    // Stub the three TaskAgentManager delegates PostApprovalRouter consumes:
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

/**
 * Seed a workflow run for a given workflow and attach a task to it. Returns
 * the run ID so tests can drop artifacts into it.
 */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
    // Pull the seeded Coding workflow — its Post-Approval (merger) node carries
    // postApproval.targetAgent='merger' (the PR Merger runs the merge) and an
    // interpolated template. Approval is a task-level event now: the route lives
    // on the merger node, not the end (Review) node, and the router fans out to
    // whichever node declares it.
    const coding = h.workflowManager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WORKFLOW.name);
    expect(coding).toBeDefined();
    const codingPostApprovalNode = coding!.nodes.find((node) => node.postApproval);
    expect(codingPostApprovalNode?.postApproval?.targetAgent).toBe('merger');
    expect(codingPostApprovalNode?.postApproval?.instructions).toContain('{{pr_url}}');

    // -----------------------------------------------------------------
    // Seed a workflow run + task, then persist a `result` artifact with
    // `data.prUrl` — this mirrors exactly what the end-node reviewer does
    // via `save_artifact({ type: 'result', data: { prUrl } })` right
    // before calling `approve_task()`. Migration 84 dropped the
    // `pr_url` column from `space_tasks`, so the artifact store is the
    // canonical source `dispatchPostApproval` reads from.
    // -----------------------------------------------------------------
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

    // -----------------------------------------------------------------
    // Drive the full production path: dispatchPostApproval scans the
    // artifact store for a `prUrl`/`pr_url`, transitions to approved,
    // then routes via PostApprovalRouter.
    // -----------------------------------------------------------------
    const result = await h.runtime.dispatchPostApproval(taskId, 'agent');

    // Reviewer is a node-agent target → spawn mode fires.
    expect(result.mode).toBe('spawn');
    if (result.mode !== 'spawn') throw new Error('unreachable'); // narrow

    // Stub received the spawn request with the interpolated template —
    // critically `{{pr_url}}` must be replaced with the real URL. Before
    // the fix, neither `task.prUrl` (the column was dropped in m84) nor
    // the artifact-store path was wired, so the literal `{{pr_url}}`
    // survived all the way to the sub-session kickoff.
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].taskId).toBe(taskId);
    expect(h.spawned[0].targetAgent).toBe('merger');
    expect(h.spawned[0].kickoffMessage).toContain(PR_URL);
    expect(h.spawned[0].kickoffMessage).not.toContain('{{pr_url}}');
    // All merge-template tokens MUST interpolate — historically the
    // routeContext carried camelCase keys that didn't match the snake_case
    // template tokens, so placeholders survived all the way to kickoff.
    expect(h.spawned[0].kickoffMessage).not.toContain('{{autonomy_level}}');
    expect(h.spawned[0].kickoffMessage).not.toContain('{{approval_source}}');
    // `{{reviewer_name}}` was collapsed to the static label
    // `[end-node reviewer]` in PR 3/5; nothing in dispatchPostApproval
    // populates routeContext.reviewer_name yet.
    expect(h.spawned[0].kickoffMessage).not.toContain('{{reviewer_name}}');
    expect(h.spawned[0].kickoffMessage).toContain('[end-node reviewer]');
    expect(h.spawned[0].kickoffMessage).toContain('Approval source: agent');
    expect(h.spawned[0].kickoffMessage).toContain('mark_complete');

    // dispatchPostApproval stamped the session on the task.
    const mid = h.taskRepo.getTask(taskId)!;
    expect(mid.status).toBe('approved'); // NOT done yet — sub-session owns the close.
    expect(mid.postApprovalSessionId).toBe(result.postApprovalSessionId);
    expect(mid.postApprovalStartedAt).toBe(result.postApprovalStartedAt);

    // -----------------------------------------------------------------
    // mark_complete is the tool the reviewer sub-session calls when
    // it's done merging. Invoke the handler directly to prove the
    // approved → done transition.
    // -----------------------------------------------------------------
    const markComplete = createMarkCompleteHandler({
      taskId,
      spaceId: SPACE_ID,
      taskRepo: h.taskRepo,
      taskManager: h.taskManager,
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

  test('dispatchPostApproval prefers the most recent prUrl-bearing artifact', async () => {
    // Locks in the reverse-chronological scan in `dispatchPostApproval`.
    // A typical review cycle writes multiple `result` artifacts — e.g. one
    // per changes-requested round, plus the final approval round. The
    // router must surface the last one so callers re-opening a task after
    // a rebase / force-push don't spawn against a stale URL.
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
    // Bump clock forward so listByRun's ASC order places this one last.
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
    expect(h.spawned[0].kickoffMessage).toContain(LATER_URL);
    expect(h.spawned[0].kickoffMessage).not.toContain(EARLIER_URL);
  });

  test('dispatchPostApproval accepts snake_case `pr_url` in artifact data', async () => {
    // The router tolerates both camelCase (`prUrl`) — what the reviewer
    // prompt writes via save_artifact — and snake_case (`pr_url`) — what
    // the send_message data payload uses — so audit artifacts authored
    // under either convention resolve correctly. This guards against a
    // future prompt edit accidentally writing `pr_url` and silently
    // falling through to the literal-placeholder branch.
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
    // Negative companion: when no artifact carries a prUrl (buggy workflow,
    // or non-PR-producing task), the router should still spawn — just
    // without interpolation. This locks in that the routeContext spread
    // is conditional (`resolvedPrUrl ? …`) so we don't poison the context
    // with an `undefined` key that causes a crash downstream.
    const coding = h.workflowManager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WORKFLOW.name)!;
    const { taskId } = seedRunAndTask(h, coding.id, 'No PR yet');

    const result = await h.runtime.dispatchPostApproval(taskId, 'agent');
    expect(result.mode).toBe('spawn');

    expect(h.spawned).toHaveLength(1);
    // No pr_url was persisted → template placeholder remains literal.
    expect(h.spawned[0].kickoffMessage).toContain('{{pr_url}}');
  });

  test('approved task with NO postApproval → dispatchPostApproval closes directly (Plan & Decompose path)', async () => {
    // Plan-and-Decompose is deliberately left without a postApproval route in
    // PR 3/5 — its end-node is the Task Agent itself, so there is no PR to
    // merge and no reviewer to dispatch to. This test locks that in against
    // the real dispatchPostApproval entry point.
    const planDecompose = h.workflowManager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name);
    expect(planDecompose).toBeDefined();
    expect(planDecompose!.postApproval).toBeUndefined();
    expect(planDecompose!.nodes.some((node) => node.postApproval)).toBe(false);

    const { taskId } = seedRunAndTask(h, planDecompose!.id, 'Plan the work');

    const result = await h.runtime.dispatchPostApproval(taskId, 'human');

    expect(result.mode).toBe('no-route');
    expect(h.spawned).toHaveLength(0);
    expect(h.taskRepo.getTask(taskId)!.status).toBe('done');
  });

  test('kill-switch: HYPERNEO_TASK_AGENT_POST_APPROVAL_ROUTING=0 disables routing at the call site', () => {
    // The router itself does not consult the flag (its callers do — see the
    // doc comment at the top of post-approval-router.ts). PR 4/5 deleted the
    // legacy completion-actions pipeline, so the flag's only remaining
    // consumer is the SpaceRuntime feature-gating (any future fallback path
    // would also branch on this helper). The parsing contract is what's
    // asserted here.
    expect(isPostApprovalRoutingEnabled({ [POST_APPROVAL_ROUTING_FLAG_ENV]: '0' })).toBe(false);
    expect(isPostApprovalRoutingEnabled({ [POST_APPROVAL_ROUTING_FLAG_ENV]: 'false' })).toBe(false);
    expect(isPostApprovalRoutingEnabled({ [POST_APPROVAL_ROUTING_FLAG_ENV]: 'off' })).toBe(false);
    // Default ON (PR 3/5 flip): unset / truthy values enable routing.
    expect(isPostApprovalRoutingEnabled({})).toBe(true);
    expect(isPostApprovalRoutingEnabled({ [POST_APPROVAL_ROUTING_FLAG_ENV]: '1' })).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Layer B — pending-completion cleanup invariant on a dispatch failure.
  // Reproduces the throw path observed on task #847: the spawner aborts (SDK
  // "user interrupted") AFTER the review → approved status commit landed.
  // dispatchPostApproval propagates the throw (the RPC handler catches it —
  // see space-task-handlers.test.ts Layer C), but the `finally` around
  // `router.route()` MUST have cleared the pending-completion fields first,
  // otherwise the stale approval banner lingers on the approved task.
  // ---------------------------------------------------------------------------

  test('Layer B: clears pending-completion fields even when the spawner throws after the status commit', async () => {
    h = buildHarness({ spawnerThrows: true });
    const coding = h.workflowManager
      .listWorkflows(SPACE_ID)
      .find((w) => w.name === CODING_WORKFLOW.name);
    expect(coding).toBeDefined();

    const { taskId } = seedRunAndTask(h, coding!.id, 'Throw-path task', '');
    // Move to review with pending-completion fields, mirroring submit_for_approval.
    h.taskRepo.updateTask(taskId, {
      status: 'review',
      pendingCheckpointType: 'task_completion',
      pendingCompletionSubmittedByNodeId: null,
      pendingCompletionSubmittedAt: Date.now(),
      pendingCompletionReason: 'ready',
    });

    // The Coding end node carries postApproval.targetAgent='merger', so the
    // router takes the spawn branch and the failing spawner throws. The throw
    // propagates out of dispatchPostApproval (Layer C catches it upstream).
    await expect(h.runtime.dispatchPostApproval(taskId, 'human')).rejects.toThrow(
      'user interrupted'
    );

    const final = h.taskRepo.getTask(taskId);
    // Status commit happened before the throw.
    expect(final?.status).toBe('approved');
    expect(final?.postApprovalSessionId).toBeNull();
    expect(h.spawned).toHaveLength(0);
    // The Layer B `finally` cleared all four pending-completion fields — the
    // router's own cleanup write (post-spawn) never ran because the spawner
    // threw first, so without the structural guarantee these would still be set.
    expect(final?.pendingCheckpointType).toBeNull();
    expect(final?.pendingCompletionSubmittedByNodeId).toBeNull();
    expect(final?.pendingCompletionSubmittedAt).toBeNull();
    expect(final?.pendingCompletionReason).toBeNull();
  });
});
