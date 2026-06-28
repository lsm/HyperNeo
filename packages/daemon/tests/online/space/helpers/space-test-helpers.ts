/**
 * Shared test helpers for Space online integration tests.
 *
 * These helpers drive the workflow gate machinery directly via RPC without
 * spinning up real LLM agent sessions. This lets gate-open/close and node-
 * activation logic be exercised deterministically and quickly with dev proxy.
 *
 * ## Key helpers
 *
 * - createTestSpace        — create a Space with a deterministic full-cycle test workflow
 * - startWorkflowRun       — start a run and return its ID + initial tasks
 * - writeGateData          — write arbitrary data to a gate (simulates agent write_gate call)
 * - readGateData           — read current gate data for a (runId, gateId) pair
 * - approveGate            — human-approve a gate (writes approved:true + triggers activation)
 * - rejectGate             — human-reject a gate (writes approved:false, run → blocked)
 * - markRunFailed          — mark run as blocked with a specific failureReason
 * - waitForNodeStatus      — poll until a node execution reaches a target status
 * - waitForRunStatus       — poll until the workflow run reaches a target status
 * - getGateArtifacts       — fetch gate artifacts (changed files + diff) for a run
 * - mockAgentDone          — mark a canonical task or node execution as done
 * - restartDaemon          — kill the daemon and restart it with the same workspace/database
 *
 * ## Usage
 *
 *   cd packages/daemon && NEOKAI_USE_DEV_PROXY=1 bun test ./tests/online/space/...
 */

import { createDaemonServer, type DaemonServerContext } from '../../../helpers/daemon-server';
import type {
  NodeExecution,
  NodeExecutionStatus,
  Space,
  SpaceWorkerAgent,
  SpaceWorkflow,
  SpaceWorkflowRun,
  SpaceTask,
  WorkflowRunFailureReason,
} from '@neokai/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestSpaceFixture {
  space: Space;
  /** All agents seeded into the space */
  agents: SpaceWorkerAgent[];
  /** Deterministic full-cycle workflow fixture used by online space tests */
  workflow: SpaceWorkflow;
}

export interface GateDataRecord {
  runId: string;
  gateId: string;
  data: Record<string, unknown>;
  updatedAt: number;
}

export interface GateArtifacts {
  files: Array<{ path: string; additions: number; deletions: number }>;
  totalAdditions: number;
  totalDeletions: number;
  prUrl?: string;
}

type NodeExecutionTask = SpaceTask & {
  workflowNodeId: string;
  agentName: string;
};

type WorkflowNodeInfo = {
  name: string;
  agentCount: number;
};

type NodeExecutionIndexEntry = {
  spaceId: string;
  workflowRunId: string;
  workflowNodeId: string;
  agentName: string;
};

/**
 * In-memory index for projected node-execution “task-like” records.
 *
 * Tests often pass only a task ID into helpers like mockAgentDone().
 * Under the one-task-per-run architecture, node state lives in node_executions,
 * so we keep a lightweight index to resolve execution IDs back to
 * (runId, nodeId, agentName) triples.
 */
const nodeExecutionIndex = new Map<string, NodeExecutionIndexEntry>();

function mapNodeExecutionStatusToTaskStatus(status: NodeExecutionStatus): SpaceTask['status'] {
  switch (status) {
    case 'pending':
      return 'open';
    case 'in_progress':
      return 'in_progress';
    case 'idle':
      return 'done';
    case 'done':
      return 'done';
    case 'blocked':
      return 'blocked';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'open';
  }
}

function isTerminalTaskStatus(status: SpaceTask['status']): boolean {
  return (
    status === 'done' || status === 'blocked' || status === 'cancelled' || status === 'archived'
  );
}

function projectNodeExecutionAsTask(
  spaceId: string,
  execution: NodeExecution,
  nodeInfo?: WorkflowNodeInfo
): NodeExecutionTask {
  nodeExecutionIndex.set(execution.id, {
    spaceId,
    workflowRunId: execution.workflowRunId,
    workflowNodeId: execution.workflowNodeId,
    agentName: execution.agentName,
  });

  const derivedTitle = nodeInfo && nodeInfo.agentCount <= 1 ? nodeInfo.name : execution.agentName;

  return {
    id: execution.id,
    spaceId,
    taskNumber: 0,
    title: derivedTitle,
    description: '',
    status: mapNodeExecutionStatusToTaskStatus(execution.status),
    priority: 'normal',
    labels: [],
    dependsOn: [],
    result: execution.result,
    workflowRunId: execution.workflowRunId,
    createdByTaskId: null,
    activeSession: null,
    taskAgentSessionId: execution.agentSessionId,
    createdAt: execution.createdAt,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    archivedAt: null,
    updatedAt: execution.updatedAt,
    workflowNodeId: execution.workflowNodeId,
    agentName: execution.agentName,
  };
}

async function listNodeExecutionsForRun(
  daemon: DaemonServerContext,
  spaceId: string,
  runId: string
): Promise<NodeExecution[]> {
  const { executions } = (await daemon.messageHub.request('nodeExecution.list', {
    workflowRunId: runId,
    spaceId,
  })) as { executions: NodeExecution[] };
  return executions;
}

async function getWorkflowNodeInfoById(
  daemon: DaemonServerContext,
  runId: string
): Promise<Map<string, WorkflowNodeInfo>> {
  const { run } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
    id: runId,
  })) as { run: SpaceWorkflowRun };
  const { workflow } = (await daemon.messageHub.request('spaceWorkflow.get', {
    id: run.workflowId,
  })) as { workflow: SpaceWorkflow };

  const nodeInfoById = new Map<string, WorkflowNodeInfo>();
  for (const node of workflow.nodes) {
    nodeInfoById.set(node.id, {
      name: node.name,
      agentCount: Array.isArray(node.agents) ? node.agents.length : 0,
    });
  }
  return nodeInfoById;
}

async function listNodeTasksForRun(
  daemon: DaemonServerContext,
  spaceId: string,
  runId: string
): Promise<NodeExecutionTask[]> {
  const executions = await listNodeExecutionsForRun(daemon, spaceId, runId);
  let nodeInfoById = new Map<string, WorkflowNodeInfo>();
  try {
    nodeInfoById = await getWorkflowNodeInfoById(daemon, runId);
  } catch {
    // If workflow lookup fails, fall back to agent-name titles.
  }
  return executions.map((execution) =>
    projectNodeExecutionAsTask(spaceId, execution, nodeInfoById.get(execution.workflowNodeId))
  );
}

async function resolveNodeIdByNameOrId(
  daemon: DaemonServerContext,
  runId: string,
  nodeNameOrId: string
): Promise<string | null> {
  const { run } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
    id: runId,
  })) as { run: SpaceWorkflowRun };
  const { workflow } = (await daemon.messageHub.request('spaceWorkflow.get', {
    id: run.workflowId,
  })) as { workflow: SpaceWorkflow };
  return (
    workflow.nodes.find((node) => node.id === nodeNameOrId)?.id ??
    workflow.nodes.find((node) => node.name === nodeNameOrId)?.id ??
    null
  );
}

function matchesNodeTarget(
  task: NodeExecutionTask,
  nodeNameOrId: string,
  resolvedNodeId: string | null
): boolean {
  if (resolvedNodeId && task.workflowNodeId === resolvedNodeId) return true;
  return (
    task.workflowNodeId === nodeNameOrId ||
    task.title === nodeNameOrId ||
    task.agentName === nodeNameOrId
  );
}

async function findNodeExecutionById(
  daemon: DaemonServerContext,
  spaceId: string,
  executionId: string
): Promise<NodeExecution | null> {
  const indexed = nodeExecutionIndex.get(executionId);
  if (indexed && indexed.spaceId === spaceId) {
    const executions = await listNodeExecutionsForRun(daemon, spaceId, indexed.workflowRunId);
    const match = executions.find((execution) => execution.id === executionId);
    if (match) return match;
  }

  const { runs } = (await daemon.messageHub.request('spaceWorkflowRun.list', {
    spaceId,
  })) as { runs: SpaceWorkflowRun[] };

  for (const run of runs) {
    const executions = await listNodeExecutionsForRun(daemon, spaceId, run.id);
    const match = executions.find((execution) => execution.id === executionId);
    if (match) return match;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Space + workflow setup
// ---------------------------------------------------------------------------

/**
 * Create a Space whose name embeds a unique suffix so tests never collide.
 * space.create auto-seeds preset agents, then this helper creates a deterministic
 * full-cycle workflow fixture tailored for online gate/channel tests.
 */
export async function createTestSpace(daemon: DaemonServerContext): Promise<TestSpaceFixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const space = (await daemon.messageHub.request('space.create', {
    name: `Test Space ${suffix}`,
    description: 'Integration test space — plan-to-approve flow',
    workspacePath: process.cwd(),
    autonomyLevel: 1,
  })) as Space;

  const { agents } = (await daemon.messageHub.request('spaceAgent.list', {
    spaceId: space.id,
  })) as { agents: SpaceWorkerAgent[] };

  const agentByName = new Map(agents.map((agent) => [agent.name, agent.id]));
  const requireAgentId = (name: string): string => {
    const id = agentByName.get(name);
    if (!id) throw new Error(`Pre-seeded agent not found: ${name}`);
    return id;
  };

  const plannerAgentId = requireAgentId('Planner');
  const reviewerAgentId = requireAgentId('Reviewer');
  const coderAgentId = requireAgentId('Coder');
  const qaAgentId = requireAgentId('QA');

  const { workflow } = (await daemon.messageHub.request('spaceWorkflow.create', {
    spaceId: space.id,
    name: 'TEST_FULL_CYCLE_WORKFLOW',
    description: 'Deterministic online-test workflow for gate/channel integration coverage',
    nodes: [
      {
        id: 'planning-node',
        name: 'Planning',
        agents: [{ agentId: plannerAgentId, name: 'planner' }],
      },
      {
        id: 'plan-review-node',
        name: 'Plan Review',
        agents: [{ agentId: reviewerAgentId, name: 'reviewer' }],
      },
      {
        id: 'coding-node',
        name: 'Coding',
        agents: [{ agentId: coderAgentId, name: 'coder' }],
      },
      {
        id: 'code-review-node',
        name: 'Code Review',
        agents: [
          { agentId: reviewerAgentId, name: 'Reviewer 1' },
          { agentId: reviewerAgentId, name: 'Reviewer 2' },
          { agentId: reviewerAgentId, name: 'Reviewer 3' },
        ],
      },
      {
        id: 'qa-node',
        name: 'QA',
        agents: [{ agentId: qaAgentId, name: 'qa' }],
      },
      {
        id: 'done-node',
        name: 'Done',
        agents: [{ agentId: qaAgentId, name: 'done' }],
      },
    ],
    startNodeId: 'planning-node',
    endNodeId: 'done-node',
    gates: [
      {
        id: 'plan-pr-gate',
        description: 'Planning PR URL is available',
        fields: [{ name: 'pr_url', type: 'string', writers: ['*'], check: { op: 'exists' } }],
        resetOnCycle: false,
      },
      {
        id: 'plan-approval-gate',
        description: 'Plan is approved',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: [],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: true,
      },
      {
        id: 'code-pr-gate',
        description: 'Coding PR URL is available for review',
        fields: [{ name: 'pr_url', type: 'string', writers: ['*'], check: { op: 'exists' } }],
        resetOnCycle: false,
      },
      {
        id: 'review-votes-gate',
        description: 'All reviewers approved',
        fields: [
          {
            name: 'votes',
            type: 'map',
            writers: [],
            check: { op: 'count', match: 'approved', min: 3 },
          },
        ],
        resetOnCycle: true,
      },
      {
        id: 'review-reject-gate',
        description: 'Any reviewer rejected',
        fields: [
          {
            name: 'votes',
            type: 'map',
            writers: [],
            check: { op: 'count', match: 'rejected', min: 1 },
          },
        ],
        resetOnCycle: true,
      },
      {
        id: 'qa-result-gate',
        description: 'QA passed',
        fields: [
          {
            name: 'result',
            type: 'string',
            writers: ['qa'],
            check: { op: '==', value: 'passed' },
          },
        ],
        resetOnCycle: true,
      },
      {
        id: 'qa-fail-gate',
        description: 'QA failed and needs fixes',
        fields: [
          {
            name: 'result',
            type: 'string',
            writers: ['qa'],
            check: { op: '==', value: 'failed' },
          },
        ],
        resetOnCycle: true,
      },
    ],
    channels: [
      {
        from: 'Planning',
        to: 'Plan Review',
        gateId: 'plan-pr-gate',
        label: 'Planning → Plan Review',
      },
      {
        from: 'Plan Review',
        to: 'Coding',
        gateId: 'plan-approval-gate',
        label: 'Plan Review → Coding',
      },
      {
        from: 'Coding',
        to: 'Code Review', // fan-out to all agents in the Code Review node
        gateId: 'code-pr-gate',
        label: 'Coding → Code Review',
      },
      {
        from: 'Code Review',
        to: 'QA',
        gateId: 'review-votes-gate',
        label: 'Code Review → QA',
      },
      {
        from: 'Code Review',
        to: 'Coding',
        maxCycles: 5,
        gateId: 'review-reject-gate',
        label: 'Code Review → Coding (rejection loop)',
      },
      {
        from: 'QA',
        to: 'Done',
        gateId: 'qa-result-gate',
        label: 'QA → Done',
      },
      {
        from: 'QA',
        to: 'Coding',
        maxCycles: 5,
        gateId: 'qa-fail-gate',
        label: 'QA → Coding (fix loop)',
      },
    ],
    // Test fixture: supervised tier (level 3) — matches the production CODING_WORKFLOW
    // default so tests exercise the autonomy-gated end-node tool path realistically.
    completionAutonomyLevel: 3,
    tags: ['v2', 'test'],
  })) as { workflow: SpaceWorkflow };

  return { space, agents, workflow };
}

// ---------------------------------------------------------------------------
// Workflow run lifecycle
// ---------------------------------------------------------------------------

/**
 * Start a workflow run and return its ID plus projected node-execution tasks.
 */
export async function startWorkflowRun(
  daemon: DaemonServerContext,
  spaceId: string,
  workflowId: string,
  title: string
): Promise<{ runId: string; tasks: SpaceTask[] }> {
  const { run } = (await daemon.messageHub.request('spaceWorkflowRun.start', {
    spaceId,
    workflowId,
    title,
  })) as { run: SpaceWorkflowRun };

  // Runtime now tracks per-node progress via node_executions (one-task-per-run model).
  // Give the start-node activation a brief window to materialize in very fast CI runs.
  let runTasks = await listNodeTasksForRun(daemon, spaceId, run.id);
  const deadline = Date.now() + 3_000;
  while (runTasks.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    runTasks = await listNodeTasksForRun(daemon, spaceId, run.id);
  }

  return { runId: run.id, tasks: runTasks };
}

// ---------------------------------------------------------------------------
// Gate data helpers
// ---------------------------------------------------------------------------

/**
 * Write (merge) data into a gate's runtime record and trigger channel
 * re-evaluation via spaceWorkflowRun.writeGateData RPC.
 *
 * Simulates what an agent does when it calls the write_gate MCP tool —
 * without requiring a real LLM session.
 */
export async function writeGateData(
  daemon: DaemonServerContext,
  runId: string,
  gateId: string,
  data: Record<string, unknown>
): Promise<GateDataRecord> {
  const result = (await daemon.messageHub.request('spaceWorkflowRun.writeGateData', {
    runId,
    gateId,
    data,
  })) as { gateData: GateDataRecord };
  return result.gateData;
}

/**
 * Read current gate data for a (runId, gateId) pair.
 * Returns null when no data has been written to the gate yet.
 */
export async function readGateData(
  daemon: DaemonServerContext,
  runId: string,
  gateId: string
): Promise<GateDataRecord | null> {
  const { gateData } = (await daemon.messageHub.request('spaceWorkflowRun.listGateData', {
    runId,
  })) as { gateData: GateDataRecord[] };
  return gateData.find((g) => g.gateId === gateId) ?? null;
}

/**
 * Human-approve a gate: writes approved:true and triggers downstream node activation.
 * If the run was previously in blocked+humanRejected, it resumes to in_progress.
 */
export async function approveGate(
  daemon: DaemonServerContext,
  runId: string,
  gateId: string,
  reason?: string
): Promise<{ run: SpaceWorkflowRun; gateData: GateDataRecord }> {
  return (await daemon.messageHub.request('spaceWorkflowRun.approveGate', {
    runId,
    gateId,
    approved: true,
    reason,
  })) as { run: SpaceWorkflowRun; gateData: GateDataRecord };
}

/**
 * Human-reject a gate: writes approved:false and transitions run to blocked
 * with failureReason: 'humanRejected'.
 */
export async function rejectGate(
  daemon: DaemonServerContext,
  runId: string,
  gateId: string,
  reason?: string
): Promise<{ run: SpaceWorkflowRun; gateData: GateDataRecord }> {
  return (await daemon.messageHub.request('spaceWorkflowRun.approveGate', {
    runId,
    gateId,
    approved: false,
    reason,
  })) as { run: SpaceWorkflowRun; gateData: GateDataRecord };
}

// ---------------------------------------------------------------------------
// Status polling helpers
// ---------------------------------------------------------------------------

/**
 * Poll nodeExecution.list until at least one execution for the given node/slot
 * reaches one of the expected task-like statuses.
 *
 * The helper returns projected "task-like" objects for backward-compatible test
 * ergonomics, but the source of truth is node_executions.
 */
export async function waitForNodeStatus(
  daemon: DaemonServerContext,
  spaceId: string,
  runId: string,
  /** Node name (e.g. 'Planning', 'Plan Review', 'Coding'), agent slot name, or node UUID */
  nodeNameOrId: string,
  expectedStatuses: string[],
  timeout: number
): Promise<SpaceTask> {
  let resolvedNodeId: string | null = null;
  try {
    resolvedNodeId = await resolveNodeIdByNameOrId(daemon, runId, nodeNameOrId);
  } catch {
    // If workflow/run lookup fails (e.g. caller passed an agent slot name),
    // fall back to raw name/id matching below.
  }

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const tasks = await listNodeTasksForRun(daemon, spaceId, runId);
    const match = tasks.find(
      (task) =>
        matchesNodeTarget(task, nodeNameOrId, resolvedNodeId) &&
        expectedStatuses.includes(task.status)
    );
    if (match) return match;

    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `Node "${nodeNameOrId}" did not reach status [${expectedStatuses.join(', ')}] within ${timeout}ms`
  );
}

/**
 * Poll projected node executions until any task-like record exists for the node
 * (i.e. the node has been activated). Useful before calling waitForNodeStatus
 * when you just want to confirm activation happened.
 */
export async function waitForNodeActivated(
  daemon: DaemonServerContext,
  spaceId: string,
  runId: string,
  nodeNameOrId: string,
  timeout: number
): Promise<SpaceTask> {
  return waitForNodeStatus(
    daemon,
    spaceId,
    runId,
    nodeNameOrId,
    ['open', 'in_progress', 'done', 'blocked', 'cancelled', 'archived'],
    timeout
  );
}

/**
 * Poll spaceWorkflowRun.get until the run reaches one of the expected statuses.
 * Returns the final run object.
 */
export async function waitForRunStatus(
  daemon: DaemonServerContext,
  runId: string,
  expectedStatuses: string[],
  timeout: number
): Promise<SpaceWorkflowRun> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    // spaceWorkflowRun.get uses 'id' not 'runId'
    const { run } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
      id: runId,
    })) as { run: SpaceWorkflowRun };

    if (expectedStatuses.includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `Run "${runId}" did not reach status [${expectedStatuses.join(', ')}] within ${timeout}ms`
  );
}

// ---------------------------------------------------------------------------
// Artifact helpers
// ---------------------------------------------------------------------------

/**
 * Fetch gate artifacts (changed files and diff summary) for a workflow run.
 */
export async function getGateArtifacts(
  daemon: DaemonServerContext,
  runId: string
): Promise<GateArtifacts> {
  return (await daemon.messageHub.request('spaceWorkflowRun.getGateArtifacts', {
    runId,
  })) as GateArtifacts;
}

// ---------------------------------------------------------------------------
// Task simulation helpers
// ---------------------------------------------------------------------------

/**
 * Mark an execution as done for integration tests.
 *
 * Supports both:
 * - canonical run tasks (spaceTask.update path)
 * - node execution IDs (nodeExecution.update path)
 */
export async function mockAgentDone(
  daemon: DaemonServerContext,
  spaceId: string,
  taskId: string,
  result?: string
): Promise<SpaceTask> {
  // 1) Canonical task path (one-task-per-run envelope)
  try {
    const current = (await daemon.messageHub.request('spaceTask.get', {
      spaceId,
      taskId,
    })) as SpaceTask;

    if (current?.id === taskId) {
      if (current.status === 'open') {
        await daemon.messageHub.request('spaceTask.update', {
          spaceId,
          taskId,
          status: 'in_progress',
        });
      }

      return (await daemon.messageHub.request('spaceTask.update', {
        spaceId,
        taskId,
        status: 'done',
        result: result ?? 'Mock agent done',
      })) as SpaceTask;
    }
  } catch {
    // Not a canonical task ID — fall through to node execution path.
  }

  // 2) Node execution path (workflow-internal state)
  const execution = await findNodeExecutionById(daemon, spaceId, taskId);
  if (!execution) {
    throw new Error(`mockAgentDone: task/execution not found: ${taskId}`);
  }

  const { execution: updatedExecution } = (await daemon.messageHub.request('nodeExecution.update', {
    id: execution.id,
    spaceId,
    status: 'idle',
    result: result ?? execution.result,
  })) as { execution: NodeExecution };

  return projectNodeExecutionAsTask(spaceId, updatedExecution);
}

/**
 * Mark the end-node execution as idle AND set the canonical task to done.
 *
 * The completion detector requires `task.status` to be terminal — idle node
 * executions alone no longer signal workflow completion. This helper wraps
 * `mockAgentDone` for end-node call sites that expect the run to finish.
 */
export async function mockWorkflowComplete(
  daemon: DaemonServerContext,
  spaceId: string,
  runId: string,
  endNodeExecutionId: string,
  result?: string
): Promise<void> {
  await mockAgentDone(daemon, spaceId, endNodeExecutionId, result);

  // Find and transition the canonical task to done.
  const allTasks = (await daemon.messageHub.request('spaceTask.list', {
    spaceId,
  })) as SpaceTask[];
  const canonicalTask = allTasks.find(
    (t) => t.workflowRunId === runId && t.status !== 'done' && t.status !== 'cancelled'
  );
  if (canonicalTask) {
    if (canonicalTask.status === 'open') {
      await daemon.messageHub.request('spaceTask.update', {
        spaceId,
        taskId: canonicalTask.id,
        status: 'in_progress',
      });
    }
    await daemon.messageHub.request('spaceTask.update', {
      spaceId,
      taskId: canonicalTask.id,
      status: 'done',
      result: result ?? 'Mock workflow complete',
    });
  }
}

/**
 * Find projected task-like node executions for a node/slot in a run.
 *
 * Matching order:
 * 1) Exact node UUID (workflowNodeId)
 * 2) Workflow node name
 * 3) Agent slot name (execution.agentName)
 */
export async function getTasksForNode(
  daemon: DaemonServerContext,
  spaceId: string,
  runId: string,
  nodeNameOrId: string
): Promise<SpaceTask[]> {
  let resolvedNodeId: string | null = null;
  try {
    resolvedNodeId = await resolveNodeIdByNameOrId(daemon, runId, nodeNameOrId);
  } catch {
    // Fallback to raw slot-name/id matching below.
  }

  const tasks = await listNodeTasksForRun(daemon, spaceId, runId);
  return tasks.filter((task) => matchesNodeTarget(task, nodeNameOrId, resolvedNodeId));
}

/**
 * Poll nodeExecution state until a NEW active execution appears for a node.
 *
 * In the one-task-per-run architecture, cyclic re-activation may reuse the same
 * node_execution row (same ID) and flip its status back to active. This helper
 * treats both cases as "new":
 * - a brand-new execution ID not in excludeTaskIds
 * - a previously terminal excluded execution reactivated to open/in_progress
 */
export async function waitForNewNodeTask(
  daemon: DaemonServerContext,
  spaceId: string,
  runId: string,
  nodeNameOrId: string,
  excludeTaskIds: Set<string>,
  timeout: number
): Promise<SpaceTask> {
  const baselineTasks = await getTasksForNode(daemon, spaceId, runId, nodeNameOrId);
  const baselineById = new Map(
    baselineTasks
      .filter((task) => excludeTaskIds.has(task.id))
      .map((task) => [task.id, { status: task.status, updatedAt: task.updatedAt }])
  );

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const tasks = await getTasksForNode(daemon, spaceId, runId, nodeNameOrId);
    const match = tasks.find((task) => {
      const isActive = task.status === 'open' || task.status === 'in_progress';
      if (!isActive) return false;
      if (!excludeTaskIds.has(task.id)) return true;

      const baseline = baselineById.get(task.id);
      if (!baseline) return false;

      if (isTerminalTaskStatus(baseline.status) && task.updatedAt > baseline.updatedAt) {
        return true;
      }

      // Activation may have happened between the caller's trigger and our first poll.
      // In that case the reused execution is already active in the baseline snapshot.
      return baseline.status === 'open' || baseline.status === 'in_progress';
    });
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `No new active task for node "${nodeNameOrId}" appeared within ${timeout}ms ` +
      `(excluding ${excludeTaskIds.size} known task IDs)`
  );
}

/**
 * Find projected task-like node executions for an exact workflow node UUID.
 */
export async function getTasksForNodeId(
  daemon: DaemonServerContext,
  spaceId: string,
  runId: string,
  nodeId: string
): Promise<SpaceTask[]> {
  const tasks = await listNodeTasksForRun(daemon, spaceId, runId);
  return tasks.filter((task) => task.workflowNodeId === nodeId);
}

// ---------------------------------------------------------------------------
// Failure simulation helpers
// ---------------------------------------------------------------------------

/**
 * Mark a workflow run as blocked with a specific failure reason.
 * Simulates what the Space Agent does when it detects an unrecoverable failure
 * (e.g. agentCrash, maxIterationsReached).
 *
 * Uses the spaceWorkflowRun.markFailed RPC which transitions the run to
 * blocked and sets the failureReason field atomically.
 */
export async function markRunFailed(
  daemon: DaemonServerContext,
  runId: string,
  failureReason: WorkflowRunFailureReason,
  reason?: string
): Promise<{ run: SpaceWorkflowRun }> {
  return (await daemon.messageHub.request('spaceWorkflowRun.markFailed', {
    id: runId,
    failureReason,
    reason,
  })) as { run: SpaceWorkflowRun };
}

// ---------------------------------------------------------------------------
// Daemon restart helper
// ---------------------------------------------------------------------------

/**
 * Restart the daemon with the same workspace directory (and therefore the
 * same SQLite database).  Used by restart-persistence tests to verify that
 * gate data, run state, and task state survive a full daemon restart.
 *
 * **In-process mode only** (default): reads the dbPath from the hidden
 * `daemonContext` property that createInProcessDaemonServer attaches to the
 * returned context.  Does NOT work when DAEMON_TEST_SPAWN=true is set.
 *
 * Steps:
 *  1. Extract the workspace path from the running daemon context.
 *  2. Kill the daemon and wait for clean shutdown.
 *  3. Spin up a new daemon targeting the same workspace / DB file.
 *
 * The caller is responsible for updating any variable holding the old
 * DaemonServerContext reference (e.g. `daemon = await restartDaemon(daemon)`).
 */
export async function restartDaemon(daemon: DaemonServerContext): Promise<DaemonServerContext> {
  const { workspacePath } = daemon;

  if (!workspacePath) {
    throw new Error(
      'restartDaemon: workspacePath not found on daemon context — only works with ' +
        'in-process mode (do not set DAEMON_TEST_SPAWN=true for restart tests)'
    );
  }

  // Clear helper-side node execution cache to avoid leaking stale IDs across restarts.
  nodeExecutionIndex.clear();

  // Gracefully shut down the current daemon
  daemon.kill('SIGTERM');
  await daemon.waitForExit();

  // Start a new daemon with the same workspace so it picks up the existing DB
  return createDaemonServer({ workspacePath });
}
