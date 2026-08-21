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
} from '@hyperneo/shared';

export interface TestSpaceFixture {
  space: Space;
  agents: SpaceWorkerAgent[];
  workflow: SpaceWorkflow;
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
  } catch {}
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
        to: 'Code Review',
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
    completionAutonomyLevel: 3,
    tags: ['v2', 'test'],
  })) as { workflow: SpaceWorkflow };

  return { space, agents, workflow };
}

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

  let runTasks = await listNodeTasksForRun(daemon, spaceId, run.id);
  const deadline = Date.now() + 3_000;
  while (runTasks.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    runTasks = await listNodeTasksForRun(daemon, spaceId, run.id);
  }

  return { runId: run.id, tasks: runTasks };
}

export async function waitForNodeStatus(
  daemon: DaemonServerContext,
  spaceId: string,
  runId: string,
  nodeNameOrId: string,
  expectedStatuses: string[],
  timeout: number
): Promise<SpaceTask> {
  let resolvedNodeId: string | null = null;
  try {
    resolvedNodeId = await resolveNodeIdByNameOrId(daemon, runId, nodeNameOrId);
  } catch {}

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

export async function waitForRunStatus(
  daemon: DaemonServerContext,
  runId: string,
  expectedStatuses: string[],
  timeout: number
): Promise<SpaceWorkflowRun> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
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

export async function mockAgentDone(
  daemon: DaemonServerContext,
  spaceId: string,
  taskId: string,
  result?: string
): Promise<SpaceTask> {
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
  } catch {}

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

export async function mockWorkflowComplete(
  daemon: DaemonServerContext,
  spaceId: string,
  runId: string,
  endNodeExecutionId: string,
  result?: string
): Promise<void> {
  await mockAgentDone(daemon, spaceId, endNodeExecutionId, result);

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

export async function getTasksForNode(
  daemon: DaemonServerContext,
  spaceId: string,
  runId: string,
  nodeNameOrId: string
): Promise<SpaceTask[]> {
  let resolvedNodeId: string | null = null;
  try {
    resolvedNodeId = await resolveNodeIdByNameOrId(daemon, runId, nodeNameOrId);
  } catch {}

  const tasks = await listNodeTasksForRun(daemon, spaceId, runId);
  return tasks.filter((task) => matchesNodeTarget(task, nodeNameOrId, resolvedNodeId));
}

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

export async function getTasksForNodeId(
  daemon: DaemonServerContext,
  spaceId: string,
  runId: string,
  nodeId: string
): Promise<SpaceTask[]> {
  const tasks = await listNodeTasksForRun(daemon, spaceId, runId);
  return tasks.filter((task) => task.workflowNodeId === nodeId);
}

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

export async function restartDaemon(daemon: DaemonServerContext): Promise<DaemonServerContext> {
  const { workspacePath } = daemon;

  if (!workspacePath) {
    throw new Error(
      'restartDaemon: workspacePath not found on daemon context — only works with ' +
        'in-process mode (do not set DAEMON_TEST_SPAWN=true for restart tests)'
    );
  }

  nodeExecutionIndex.clear();

  daemon.kill('SIGTERM');
  await daemon.waitForExit();

  return createDaemonServer({ workspacePath });
}
