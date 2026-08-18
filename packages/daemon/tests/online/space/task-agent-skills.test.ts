import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import type { NodeExecution, Space, SpaceWorkerAgent, SpaceWorkflow } from '@hyperneo/shared';

const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;
const SETUP_TIMEOUT = IS_MOCK ? 20_000 : 60_000;
const TEST_TIMEOUT = IS_MOCK ? 30_000 : 120_000;
const TASK_AGENT_SPAWN_TIMEOUT = IS_MOCK ? 15_000 : 45_000;

type TestFixtures = {
  space: Space;
  coderAgent: SpaceWorkerAgent;
  workflow: SpaceWorkflow;
};

async function createTestFixtures(daemon: DaemonServerContext): Promise<TestFixtures> {
  const space = (await daemon.messageHub.request('space.create', {
    name: 'Task Agent Skills Test Space',
    description: 'Test space for skills injection online tests',
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
    description: 'Single-step workflow for skills test',
    nodes: [{ id: 'step-skills-001', name: 'Code Implementation', agentId: coderAgent.id }],
    transitions: [],
    startNodeId: 'step-skills-001',
    completionAutonomyLevel: 3,
  })) as { workflow: SpaceWorkflow };

  return { space, coderAgent, workflow: workflowResult.workflow };
}

async function startWorkflowRun(
  daemon: DaemonServerContext,
  spaceId: string,
  workflowId: string,
  title: string
): Promise<{ runId: string; taskId: string; executionId: string }> {
  const { run } = (await daemon.messageHub.request('spaceWorkflowRun.start', {
    spaceId,
    workflowId,
    title,
  })) as { run: { id: string } };

  const tasks = (await daemon.messageHub.request('spaceTask.list', {
    spaceId,
  })) as Array<{ id: string; workflowRunId: string; status: string }>;
  const task = tasks.find((candidate) => candidate.workflowRunId === run.id);
  if (!task) throw new Error(`No canonical task found for workflow run ${run.id}`);

  const { executions } = (await daemon.messageHub.request('nodeExecution.list', {
    workflowRunId: run.id,
    spaceId,
  })) as { executions: NodeExecution[] };
  const execution = executions[0];
  if (!execution) throw new Error(`No node execution found for workflow run ${run.id}`);

  return { runId: run.id, taskId: task.id, executionId: execution.id };
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

      const { skills } = (await daemon.messageHub.request('skill.list', {})) as {
        skills: Array<{
          id: string;
          name: string;
          enabled: boolean;
          sourceType: string;
        }>;
      };

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
    'skill.list contains the seeded chrome-devtools-mcp skill at daemon startup',
    async () => {
      const { skills } = (await daemon.messageHub.request('skill.list', {})) as {
        skills: Array<{
          id: string;
          name: string;
          sourceType: string;
          enabled: boolean;
          builtIn: boolean;
        }>;
      };

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
      const { skills } = (await daemon.messageHub.request('skill.list', {})) as {
        skills: Array<{
          id: string;
          name: string;
          enabled: boolean;
          sourceType: string;
        }>;
      };
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
