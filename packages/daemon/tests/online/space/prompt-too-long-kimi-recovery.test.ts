import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { waitForIdle } from '../../helpers/daemon-actions';
import type { NodeExecution, Space, SpaceWorkerAgent, SpaceWorkflow } from '@hyperneo/shared';
import { buildPromptTooLongContinueNag } from '../../../src/lib/space/runtime/prompt-too-long-recovery';

const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;
const IDLE_TIMEOUT = IS_MOCK ? 45_000 : 60_000;
const SETUP_TIMEOUT = IS_MOCK ? 45_000 : 90_000;
const TEST_TIMEOUT = IS_MOCK ? 180_000 : 300_000;
const RECOVERY_TIMEOUT = IS_MOCK ? 60_000 : 90_000;

const STEP_CODE_ID = 'step-code-kimi-recovery-001';

type TestFixtures = {
  space: Space;
  coderAgent: SpaceWorkerAgent;
  workflow: SpaceWorkflow;
};

async function createTestFixtures(daemon: DaemonServerContext): Promise<TestFixtures> {
  const space = (await daemon.messageHub.request('space.create', {
    name: 'Kimi prompt-too-long recovery test space',
    description: 'Test space for Kimi prompt-too-long recovery',
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
    name: 'Single-step Kimi recovery workflow',
    description: 'Single-step workflow for Kimi recovery testing',
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

async function startWorkflowRunAndGetExecution(
  daemon: DaemonServerContext,
  spaceId: string,
  workflowId: string,
  runTitle: string
): Promise<{ runId: string; execution: NodeExecution }> {
  const { run } = (await daemon.messageHub.request('spaceWorkflowRun.start', {
    spaceId,
    workflowId,
    title: runTitle,
  })) as { run: { id: string } };

  const { executions } = (await daemon.messageHub.request('nodeExecution.list', {
    workflowRunId: run.id,
    spaceId,
  })) as { executions: NodeExecution[] };
  const execution = executions[0];
  if (!execution) throw new Error(`No node execution found for workflow run ${run.id}`);

  return { runId: run.id, execution };
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

async function waitForSdkMessageText(
  daemon: DaemonServerContext,
  sessionId: string,
  predicate: (text: string) => boolean,
  timeout: number
): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { sdkMessages } = (await daemon.messageHub.request('message.sdkMessages', {
      sessionId,
      limit: 100,
    })) as { sdkMessages: Array<Record<string, unknown>> };

    for (const msg of sdkMessages) {
      const text = extractSdkMessageText(msg);
      if (predicate(text)) return text;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('Timed out waiting for SDK message matching predicate');
}

async function waitForSdkMessageType(
  daemon: DaemonServerContext,
  sessionId: string,
  messageType: string,
  timeout: number
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { sdkMessages } = (await daemon.messageHub.request('message.sdkMessages', {
      sessionId,
      limit: 100,
    })) as { sdkMessages: Array<Record<string, unknown>> };

    if (sdkMessages.some((m) => m.type === messageType)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for SDK message type "${messageType}"`);
}

function extractSdkMessageText(msg: Record<string, unknown>): string {
  const message = msg.message as { content?: unknown } | undefined;
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && 'text' in block) {
          return String((block as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .join('');
  }
  return '';
}

async function waitForUserMessageText(
  daemon: DaemonServerContext,
  sessionId: string,
  predicate: (text: string) => boolean,
  timeout: number
): Promise<{ dbId: string; text: string }> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const status of ['enqueued', 'consumed'] as const) {
      const { messages } = (await daemon.messageHub.request('session.messages.byStatus', {
        sessionId,
        status,
        limit: 50,
      })) as { messages: Array<{ dbId: string; text: string }> };

      const match = messages.find((m) => predicate(m.text));
      if (match) return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for user message matching predicate');
}

describe('Kimi prompt-too-long recovery — online with Dev Proxy', () => {
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

  async function runRecoveryScenario(runTitleSuffix: string, stderrContent: string): Promise<void> {
    const { space, workflow } = await createTestFixtures(daemon);
    const { runId, execution } = await startWorkflowRunAndGetExecution(
      daemon,
      space.id,
      workflow.id,
      `Kimi recovery run — ${runTitleSuffix}`
    );

    const sessionId = await waitForNodeAgentSpawned(
      daemon,
      space.id,
      runId,
      execution.id,
      IS_MOCK ? 30_000 : 45_000
    );
    daemon.trackSession(sessionId);

    await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);
    await waitForSdkMessageType(daemon, sessionId, 'result', IDLE_TIMEOUT);

    await daemon.messageHub.request('nodeExecution.update', {
      id: execution.id,
      spaceId: space.id,
      status: 'idle',
      result: 'Kimi prompt-too-long injected',
    });

    const stderrMessage = `<local-command-stderr>${stderrContent}</local-command-stderr>`;
    await daemon.messageHub.request('test.injectSDKMessage', {
      sessionId,
      message: {
        type: 'user',
        message: { role: 'user', content: stderrMessage },
        parent_tool_use_id: null,
      },
    });

    const persistedStderrText = await waitForSdkMessageText(
      daemon,
      sessionId,
      (text) => text.includes('<local-command-stderr>') && text.includes(stderrContent),
      RECOVERY_TIMEOUT
    );
    expect(persistedStderrText).toContain('<local-command-stderr>');
    expect(persistedStderrText).toContain(stderrContent);

    const compactMessage = await waitForUserMessageText(
      daemon,
      sessionId,
      (text) => text === '/compact',
      RECOVERY_TIMEOUT
    );
    expect(compactMessage.text).toBe('/compact');

    const continueMessage = await waitForUserMessageText(
      daemon,
      sessionId,
      (text) => text === buildPromptTooLongContinueNag(),
      RECOVERY_TIMEOUT
    );
    expect(continueMessage.text).toBe(buildPromptTooLongContinueNag());
  }

  test(
    'detects detailed Kimi overflow and recovers with /compact then continue nag',
    async () => {
      await runRecoveryScenario('detailed', 'Prompt is too long: 205616 tokens > 200000 maximum');
    },
    TEST_TIMEOUT
  );

  test(
    'detects bare Kimi overflow and recovers with /compact then continue nag',
    async () => {
      await runRecoveryScenario('bare', 'Prompt is too long');
    },
    TEST_TIMEOUT
  );
});
