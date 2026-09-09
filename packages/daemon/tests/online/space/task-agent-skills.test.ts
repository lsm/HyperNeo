import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import type { LiveQuerySnapshotEvent, NodeExecution, Space, SpaceWorkflow } from '@hyperneo/shared';

const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;
const SETUP_TIMEOUT = IS_MOCK ? 20_000 : 60_000;
const TEST_TIMEOUT = IS_MOCK ? 30_000 : 120_000;
const TASK_AGENT_SPAWN_TIMEOUT = IS_MOCK ? 15_000 : 45_000;
const RUN_DISPATCH_TIMEOUT = IS_MOCK ? 30_000 : 60_000;

type TestFixtures = {
  space: Space;
  workflow: SpaceWorkflow;
};

async function createTestFixtures(daemon: DaemonServerContext): Promise<TestFixtures> {
  const space = (await daemon.messageHub.request('space.create', {
    name: 'Task Agent Skills Test Space',
    description: 'Test space for skills injection online tests',
    workspacePath: process.cwd(),
    autonomyLevel: 1,
  })) as Space;

  const workflowResult = (await daemon.messageHub.request('spaceWorkflow.create', {
    spaceId: space.id,
    name: 'Single-step Workflow',
    description: 'Single-step workflow for skills test',
    nodes: [
      {
        id: 'step-skills-001',
        name: 'Code Implementation',
        agents: [{ agentId: '', name: 'Code Implementation', templateKey: 'worker.swe' }],
      },
    ],
    transitions: [],
    startNodeId: 'step-skills-001',
    completionAutonomyLevel: 3,
  })) as { workflow: SpaceWorkflow };

  return { space, workflow: workflowResult.workflow };
}

async function startWorkflowRun(
  daemon: DaemonServerContext,
  spaceId: string,
  workflowId: string,
  title: string
): Promise<{ runId: string; taskId: string; executionId: string }> {
  const created = (await daemon.messageHub.request('spaceTask.create', {
    spaceId,
    title,
    description: '',
    preferredWorkflowId: workflowId,
  })) as { id: string };

  const deadline = Date.now() + RUN_DISPATCH_TIMEOUT;
  let runId: string | null = null;
  while (Date.now() < deadline) {
    const current = (await daemon.messageHub.request('spaceTask.get', {
      spaceId,
      taskId: created.id,
    })) as { workflowRunId?: string | null };
    if (current.workflowRunId) {
      runId = current.workflowRunId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!runId) {
    throw new Error(
      `Task ${created.id} was not attached to a workflow run within ${RUN_DISPATCH_TIMEOUT}ms`
    );
  }

  const { executions } = (await daemon.messageHub.request('nodeExecution.list', {
    workflowRunId: runId,
    spaceId,
  })) as { executions: NodeExecution[] };
  const execution = executions[0];
  if (!execution) throw new Error(`No node execution found for workflow run ${runId}`);

  return { runId, taskId: created.id, executionId: execution.id };
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

type LiveSkillRow = {
  id: string;
  name: string;
  sourceType: string;
  enabled: boolean;
  builtIn: boolean;
};

async function listSkillsViaLiveQuery(daemon: DaemonServerContext): Promise<LiveSkillRow[]> {
  const snapshots: LiveQuerySnapshotEvent[] = [];
  const subscriptionId = `sub-skills-list-${Date.now()}`;
  const unsubscribeEvent = daemon.messageHub.onEvent<LiveQuerySnapshotEvent>(
    'liveQuery.snapshot',
    (ev) => {
      if (ev.subscriptionId === subscriptionId) snapshots.push(ev);
    }
  );

  try {
    const result = (await daemon.messageHub.request('liveQuery.subscribe', {
      queryName: 'skills.list',
      params: [],
      subscriptionId,
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    const deadline = Date.now() + 8_000;
    while (snapshots.length === 0) {
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for skills.list snapshot');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return snapshots[0].rows as LiveSkillRow[];
  } finally {
    unsubscribeEvent();
    await daemon.messageHub.request('liveQuery.unsubscribe', { subscriptionId });
  }
}

describe('Task Agent Skills — Online Tests (G1+G2+G3)', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer();
  }, SETUP_TIMEOUT);

  afterEach(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, SETUP_TIMEOUT);

  test(
    'task agent session is spawned when a globally-enabled mcp_server skill exists',
    async () => {
      const { server: appMcpServer } = (await daemon.messageHub.request('mcp.registry.create', {
        name: 'test-skills-mcp',
        description: 'A test MCP server for skills injection online test',
        sourceType: 'stdio',
        command: 'echo',
        args: ['hello'],
        env: {},
        enabled: true,
      })) as { server: { id: string; name: string; enabled: boolean } };

      expect(appMcpServer.id).toBeDefined();
      expect(appMcpServer.enabled).toBe(true);

      const { skill } = (await daemon.messageHub.request('skill.create', {
        params: {
          name: 'test-skills-mcp',
          displayName: 'Test Skills MCP',
          description: 'Test MCP server skill for skills injection test',
          sourceType: 'mcp_server',
          config: { type: 'mcp_server', appMcpServerId: appMcpServer.id },
          enabled: true,
          validationStatus: 'valid',
        },
      })) as { skill: { id: string; name: string; enabled: boolean; sourceType: string } };

      expect(skill.id).toBeDefined();
      expect(skill.enabled).toBe(true);
      expect(skill.sourceType).toBe('mcp_server');

      const skills = await listSkillsViaLiveQuery(daemon);

      const enabledMcpSkills = skills.filter((s) => s.sourceType === 'mcp_server' && s.enabled);
      expect(enabledMcpSkills.length).toBeGreaterThan(0);

      const ourSkill = skills.find((s) => s.id === skill.id);
      expect(ourSkill).toBeDefined();
      expect(ourSkill!.enabled).toBe(true);

      const { space, workflow } = await createTestFixtures(daemon);

      const { runId, taskId, executionId } = await startWorkflowRun(
        daemon,
        space.id,
        workflow.id,
        'Skills injection test run'
      );

      const nodeAgentSessionId = await waitForNodeAgentSpawned(
        daemon,
        space.id,
        runId,
        executionId,
        TASK_AGENT_SPAWN_TIMEOUT
      );

      daemon.trackSession(nodeAgentSessionId);
      const sessionResult = (await daemon.messageHub.request('session.get', {
        sessionId: nodeAgentSessionId,
      })) as {
        session: { id: string; type: string; config?: { mcpServers?: Record<string, unknown> } };
      };

      expect(sessionResult.session.id).toBe(nodeAgentSessionId);
      expect(sessionResult.session.type).toBe('worker');
      expect(nodeAgentSessionId).toContain(`space:${space.id}`);
      expect(nodeAgentSessionId).toContain(`task:${taskId}`);
      expect(nodeAgentSessionId).toContain(`exec:${executionId}`);

      const mcpServerKeys = Object.keys(sessionResult.session.config?.mcpServers ?? {});
      expect(mcpServerKeys).toContain('node-agent');
      expect(mcpServerKeys).toContain('agent-memory');
      expect(mcpServerKeys).not.toContain('test-skills-mcp');
    },
    TEST_TIMEOUT
  );

  test(
    'skills.list LiveQuery contains the seeded chrome-devtools-mcp skill at daemon startup',
    async () => {
      const skills = await listSkillsViaLiveQuery(daemon);

      const chromeSkill = skills.find((s) => s.name === 'chrome-devtools-mcp');
      expect(chromeSkill).toBeDefined();
      expect(chromeSkill!.sourceType).toBe('mcp_server');
      expect(chromeSkill!.builtIn).toBe(true);
      expect(chromeSkill!.enabled).toBe(false);
    },
    TEST_TIMEOUT
  );

  test(
    'task agent session is spawned after enabling the chrome-devtools-mcp skill globally',
    async () => {
      const skills = await listSkillsViaLiveQuery(daemon);
      const chromeSkill = skills.find((s) => s.name === 'chrome-devtools-mcp');
      expect(chromeSkill).toBeDefined();

      const { skill: updated } = (await daemon.messageHub.request('skill.setEnabled', {
        id: chromeSkill!.id,
        enabled: true,
      })) as { skill: { id: string; enabled: boolean } };
      expect(updated.enabled).toBe(true);

      const { space, workflow } = await createTestFixtures(daemon);
      const { runId, executionId } = await startWorkflowRun(
        daemon,
        space.id,
        workflow.id,
        'Skills enabled test run'
      );

      const nodeAgentSessionId = await waitForNodeAgentSpawned(
        daemon,
        space.id,
        runId,
        executionId,
        TASK_AGENT_SPAWN_TIMEOUT
      );

      daemon.trackSession(nodeAgentSessionId);

      const sessionResult = (await daemon.messageHub.request('session.get', {
        sessionId: nodeAgentSessionId,
      })) as { session: { id: string; type: string } };

      expect(sessionResult.session.id).toBe(nodeAgentSessionId);
      expect(sessionResult.session.type).toBe('worker');
    },
    TEST_TIMEOUT
  );
});
