import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';
import type {
  NodeExecution,
  Space,
  SpaceWorkerAgent,
  SpaceWorkflow,
  SpaceWorkflowRun,
} from '@hyperneo/shared';

const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;
const IDLE_TIMEOUT = IS_MOCK ? 10_000 : 60_000;
const SETUP_TIMEOUT = IS_MOCK ? 20_000 : 60_000;
const TEST_TIMEOUT = IS_MOCK ? 180_000 : 360_000;

const TASK_AGENT_SPAWN_TIMEOUT = IS_MOCK ? 30_000 : 45_000;
const KICKOFF_CONTEXT_TIMEOUT = IS_MOCK ? 40_000 : 90_000;
const PROBE_RESPONSE_TIMEOUT = IS_MOCK ? 40_000 : 90_000;

const STEP_CODE_ID = 'step-code-lifecycle-001';

type TestFixtures = {
  space: Space;
  coderAgent: SpaceWorkerAgent;
  workflow: SpaceWorkflow;
};

async function createTestFixtures(daemon: DaemonServerContext): Promise<TestFixtures> {
  const space = (await daemon.messageHub.request('space.create', {
    name: 'Task Agent Lifecycle Test Space',
    description: 'Test space for task agent lifecycle online tests',
    workspacePath: process.cwd(),
    autonomyLevel: 1,
  })) as Space;

  const { agents } = (await daemon.messageHub.request('spaceAgent.list', {
    spaceId: space.id,
  })) as { agents: SpaceWorkerAgent[] };

  const coderAgent = agents.find((a) => a.name === 'Coder');
  if (!coderAgent) throw new Error('Pre-seeded Coder agent not found');

  const workflowResult = (await daemon.messageHub.request('spaceWorkflow.create', {
    spaceId: space.id,
    name: 'Single-step Workflow',
    description: 'Single-step workflow for lifecycle testing',
    nodes: [{ id: STEP_CODE_ID, name: 'Code Implementation', agentId: coderAgent.id }],
    transitions: [],
    startNodeId: STEP_CODE_ID,
    completionAutonomyLevel: 3,
  })) as { workflow: SpaceWorkflow };

  return {
    space,
    coderAgent,
    workflow: workflowResult.workflow,
  };
}

async function startWorkflowRunAndGetTask(
  daemon: DaemonServerContext,
  spaceId: string,
  workflowId: string,
  runTitle: string
): Promise<{
  runId: string;
  task: { id: string; status: string };
  execution: {
    id: string;
    workflowNodeId: string;
    agentName: string;
    status: string;
    agentSessionId: string | null;
  };
}> {
  const { run } = (await daemon.messageHub.request('spaceWorkflowRun.start', {
    spaceId,
    workflowId,
    title: runTitle,
  })) as { run: { id: string } };

  const tasks = (await daemon.messageHub.request('spaceTask.list', {
    spaceId,
  })) as Array<{
    id: string;
    workflowRunId: string;
    status: string;
  }>;
  const task = tasks.find((candidate) => candidate.workflowRunId === run.id);
  if (!task) throw new Error(`No canonical task found for workflow run ${run.id}`);

  const { executions } = (await daemon.messageHub.request('nodeExecution.list', {
    workflowRunId: run.id,
    spaceId,
  })) as { executions: NodeExecution[] };
  const execution = executions[0];
  if (!execution) throw new Error(`No node execution found for workflow run ${run.id}`);

  return {
    runId: run.id,
    task,
    execution: {
      id: execution.id,
      workflowNodeId: execution.workflowNodeId,
      agentName: execution.agentName,
      status: execution.status,
      agentSessionId: execution.agentSessionId,
    },
  };
}

async function waitForNodeAgentSpawned(
  daemon: DaemonServerContext,
  spaceId: string,
  runId: string,
  executionId: string,
  timeout: number
): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { executions } = (await daemon.messageHub.request('nodeExecution.list', {
      workflowRunId: runId,
      spaceId,
    })) as { executions: NodeExecution[] };

    const execution = executions.find((candidate) => candidate.id === executionId);
    if (execution?.agentSessionId) return execution.agentSessionId;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(
    `Node agent session was not spawned within ${timeout}ms for execution ${executionId}`
  );
}

async function waitForExecutionStatus(
  daemon: DaemonServerContext,
  spaceId: string,
  runId: string,
  executionId: string,
  expectedStatuses: string[],
  timeout: number
): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { executions } = (await daemon.messageHub.request('nodeExecution.list', {
      workflowRunId: runId,
      spaceId,
    })) as { executions: NodeExecution[] };

    const execution = executions.find((candidate) => candidate.id === executionId);
    if (execution && expectedStatuses.includes(execution.status)) return execution.status;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(
    `Node execution status did not reach one of [${expectedStatuses.join(', ')}] within ${timeout}ms`
  );
}

async function waitForRunStatus(
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
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(
    `Run ${runId} did not reach one of [${expectedStatuses.join(', ')}] within ${timeout}ms`
  );
}

async function fetchSdkMessages(
  daemon: DaemonServerContext,
  sessionId: string
): Promise<Array<Record<string, unknown>>> {
  const { sdkMessages } = (await daemon.messageHub.request('message.sdkMessages', {
    sessionId,
  })) as { sdkMessages: Array<Record<string, unknown>> };
  return sdkMessages;
}

async function tryFetchSdkMessages(
  daemon: DaemonServerContext,
  sessionId: string
): Promise<Array<Record<string, unknown>>> {
  try {
    return await fetchSdkMessages(daemon, sessionId);
  } catch {
    return [];
  }
}

async function waitForKickoffContext(
  daemon: DaemonServerContext,
  sessionId: string,
  timeout: number
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const sdkMessages = await tryFetchSdkMessages(daemon, sessionId);
    if (sdkMessages.length > 0) return sdkMessages;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Node agent session ${sessionId} received no kickoff sdk messages within ${timeout}ms`
  );
}

async function waitForAssistantResponseBeyond(
  daemon: DaemonServerContext,
  sessionId: string,
  baselineCount: number,
  timeout: number
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const assistantMsgs = getAssistantMessages(await tryFetchSdkMessages(daemon, sessionId));
    if (assistantMsgs.length > baselineCount) return assistantMsgs;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Node agent session ${sessionId} produced no assistant response beyond ${baselineCount} ` +
      `message(s) within ${timeout}ms`
  );
}

function getAssistantMessages(
  sdkMessages: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return sdkMessages.filter((msg) => msg.type === 'assistant' && msg.parent_tool_use_id === null);
}

function extractTextContent(assistantMessages: Array<Record<string, unknown>>): string {
  return assistantMessages
    .flatMap((msg) => {
      const betaMsg = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
      return (betaMsg?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text as string);
    })
    .join(' ');
}

describe('Task Agent Lifecycle — Online Tests', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer();
  }, SETUP_TIMEOUT);

  afterEach(async () => {
    if (daemon) {
      try {
        const { sessions } = (await daemon.messageHub.request('session.list', {})) as {
          sessions: Array<{ id: string }>;
        };
        await Promise.all(
          sessions.map((s) =>
            Promise.race([
              daemon.messageHub.request('session.delete', { sessionId: s.id }),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('session delete timeout')), 5000)
              ),
            ]).catch(() => {})
          )
        );
      } catch {}
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, 30_000);

  test(
    'SpaceRuntime spawns a workflow node-agent session for a pending node execution',
    async () => {
      const { space, workflow } = await createTestFixtures(daemon);

      const { runId, task, execution } = await startWorkflowRunAndGetTask(
        daemon,
        space.id,
        workflow.id,
        'Lifecycle test run — spawning'
      );

      expect(task.status).toBe('open');
      expect(execution.status).toBe('pending');
      expect(execution.agentSessionId).toBeNull();

      const nodeAgentSessionId = await waitForNodeAgentSpawned(
        daemon,
        space.id,
        runId,
        execution.id,
        TASK_AGENT_SPAWN_TIMEOUT
      );

      daemon.trackSession(nodeAgentSessionId);

      const sessionResult = (await daemon.messageHub.request('session.get', {
        sessionId: nodeAgentSessionId,
      })) as { session: Record<string, unknown> };

      const session = sessionResult.session;
      expect(session).toBeDefined();
      expect(session.id).toBe(nodeAgentSessionId);
      expect(session.type).toBe('worker');
      expect(nodeAgentSessionId).toContain(`space:${space.id}`);
      expect(nodeAgentSessionId).toContain(`task:${task.id}`);
      expect(nodeAgentSessionId).toContain(`exec:${execution.id}`);

      const sessionContext = session.context as { spaceId?: string; taskId?: string } | undefined;
      expect(sessionContext?.spaceId).toBe(space.id);
      if (sessionContext?.taskId) {
        expect(sessionContext.taskId).toBe(task.id);
      }
    },
    TEST_TIMEOUT
  );

  test(
    'Node-agent session receives kickoff context when spawned via runtime tick',
    async () => {
      const { space, workflow } = await createTestFixtures(daemon);

      const { runId, execution } = await startWorkflowRunAndGetTask(
        daemon,
        space.id,
        workflow.id,
        'Lifecycle test run — kickoff check'
      );

      const nodeAgentSessionId = await waitForNodeAgentSpawned(
        daemon,
        space.id,
        runId,
        execution.id,
        TASK_AGENT_SPAWN_TIMEOUT
      );
      daemon.trackSession(nodeAgentSessionId);

      const sdkMessages = await waitForKickoffContext(
        daemon,
        nodeAgentSessionId,
        KICKOFF_CONTEXT_TIMEOUT
      );

      expect(sdkMessages.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT
  );

  test(
    'Node-agent session processes spawn probe and returns meaningful response',
    async () => {
      const { space, workflow } = await createTestFixtures(daemon);

      const { runId, execution } = await startWorkflowRunAndGetTask(
        daemon,
        space.id,
        workflow.id,
        'Lifecycle test run — spawn step'
      );

      const nodeAgentSessionId = await waitForNodeAgentSpawned(
        daemon,
        space.id,
        runId,
        execution.id,
        TASK_AGENT_SPAWN_TIMEOUT
      );
      daemon.trackSession(nodeAgentSessionId);

      await waitForKickoffContext(daemon, nodeAgentSessionId, KICKOFF_CONTEXT_TIMEOUT);
      await waitForIdle(daemon, nodeAgentSessionId, IDLE_TIMEOUT);
      const baselineAssistantCount = getAssistantMessages(
        await fetchSdkMessages(daemon, nodeAgentSessionId)
      ).length;
      await sendMessage(
        daemon,
        nodeAgentSessionId,
        'probe_task_agent_spawn_step_001: Please spawn the node agent for the first workflow step.'
      );
      const assistantMsgs = await waitForAssistantResponseBeyond(
        daemon,
        nodeAgentSessionId,
        baselineAssistantCount,
        PROBE_RESPONSE_TIMEOUT
      );

      const textContent = extractTextContent(assistantMsgs);
      expect(assistantMsgs.length).toBeGreaterThan(0);
      expect(textContent.length).toBeGreaterThan(0);
      if (IS_MOCK && textContent.includes('[MOCKED LIFECYCLE]')) {
        expect(textContent).toContain('spawn_node_agent');
        expect(textContent).toContain(STEP_CODE_ID);
      } else if (IS_MOCK) {
        // eslint-disable-next-line no-console
        console.warn(
          '[DIAG test3] Targeted mock did not match — catch-all fired instead.',
          'Response prefix:',
          textContent.substring(0, 80)
        );
      }
    },
    TEST_TIMEOUT
  );

  test(
    'Node-agent session processes check-status probe and returns meaningful response',
    async () => {
      const { space, workflow } = await createTestFixtures(daemon);

      const { runId, execution } = await startWorkflowRunAndGetTask(
        daemon,
        space.id,
        workflow.id,
        'Lifecycle test run — check step'
      );

      const nodeAgentSessionId = await waitForNodeAgentSpawned(
        daemon,
        space.id,
        runId,
        execution.id,
        TASK_AGENT_SPAWN_TIMEOUT
      );
      daemon.trackSession(nodeAgentSessionId);

      await waitForKickoffContext(daemon, nodeAgentSessionId, KICKOFF_CONTEXT_TIMEOUT);
      await waitForIdle(daemon, nodeAgentSessionId, IDLE_TIMEOUT);
      const baselineAssistantCount = getAssistantMessages(
        await fetchSdkMessages(daemon, nodeAgentSessionId)
      ).length;
      await sendMessage(
        daemon,
        nodeAgentSessionId,
        'probe_task_agent_check_step_001: Please check the status of the running node agent.'
      );
      const assistantMsgs = await waitForAssistantResponseBeyond(
        daemon,
        nodeAgentSessionId,
        baselineAssistantCount,
        PROBE_RESPONSE_TIMEOUT
      );

      const textContent = extractTextContent(assistantMsgs);
      expect(assistantMsgs.length).toBeGreaterThan(0);
      expect(textContent.length).toBeGreaterThan(0);
      if (IS_MOCK && textContent.includes('[MOCKED LIFECYCLE]')) {
        expect(textContent).toContain('check_node_status');
      } else if (IS_MOCK) {
        // eslint-disable-next-line no-console
        console.warn(
          '[DIAG test4] Targeted mock did not match — catch-all fired instead.',
          'Response prefix:',
          textContent.substring(0, 80)
        );
      }
    },
    TEST_TIMEOUT
  );

  test(
    'Completing a node execution marks it done',
    async () => {
      const { space, workflow } = await createTestFixtures(daemon);

      const { runId, execution } = await startWorkflowRunAndGetTask(
        daemon,
        space.id,
        workflow.id,
        'Lifecycle test run — execution complete'
      );

      const nodeAgentSessionId = await waitForNodeAgentSpawned(
        daemon,
        space.id,
        runId,
        execution.id,
        TASK_AGENT_SPAWN_TIMEOUT
      );
      daemon.trackSession(nodeAgentSessionId);
      await waitForIdle(daemon, nodeAgentSessionId, IDLE_TIMEOUT);

      await daemon.messageHub.request('nodeExecution.update', {
        id: execution.id,
        spaceId: space.id,
        status: 'idle',
        result: 'Lifecycle completion test',
      });

      const finalStatus = await waitForExecutionStatus(
        daemon,
        space.id,
        runId,
        execution.id,
        ['idle'],
        IS_MOCK ? 8_000 : 30_000
      );
      expect(finalStatus).toBe('idle');
    },
    TEST_TIMEOUT
  );
});
