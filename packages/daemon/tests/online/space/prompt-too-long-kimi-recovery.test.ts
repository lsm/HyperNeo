/**
 * Kimi prompt-too-long recovery — online integration test with Dev Proxy.
 *
 * Kimi surfaces context-window overflows as a 400 error that the SDK injects as a
 * user message containing `<local-command-stderr>`. The Space runtime must detect
 * that form and run the same compact-then-continue recovery used for the terminal
 * `result` form.
 *
 * This test exercises the full runtime recovery path against a real daemon and a
 * Dev Proxy-mocked API:
 *   1. Start a Space workflow run with a worker node and let its kickoff turn
 *      finish against the default Dev Proxy catch-all mock.
 *   2. Park the execution as `idle` so the runtime sweep can enter recovery.
 *   3. Inject a Kimi-style user message containing `<local-command-stderr>` via
 *      `test.injectSDKMessage` (the SDK's own 400 path does not wrap mocked
 *      responses in stderr tags, so we inject the persisted form directly).
 *   4. Poll for the persisted stderr SDK message.
 *   5. Poll for the runtime-injected `/compact` user message.
 *   6. Poll for the continue nag injected after the `/compact` turn succeeds
 *      against the catch-all mock.
 *
 * Running:
 *   cd packages/daemon && NEOKAI_USE_DEV_PROXY=1 bun test \
 *     ./tests/online/space/prompt-too-long-kimi-recovery.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { waitForIdle } from '../../helpers/daemon-actions';
import type { NodeExecution, Space, SpaceAgent, SpaceWorkflow } from '@neokai/shared';
import { buildPromptTooLongContinueNag } from '../../../src/lib/space/runtime/prompt-too-long-recovery';

const IS_MOCK = !!process.env.NEOKAI_USE_DEV_PROXY;
const IDLE_TIMEOUT = IS_MOCK ? 20_000 : 60_000;
const SETUP_TIMEOUT = IS_MOCK ? 45_000 : 90_000;
const TEST_TIMEOUT = IS_MOCK ? 180_000 : 300_000;
// Recovery polling must tolerate the 5s tick-loop interval on slower CI runners
// (Linux). Each poll waits for the tick to detect the overflow and inject
// /compact or the continue nag — allow at least two tick periods plus overhead.
const RECOVERY_TIMEOUT = IS_MOCK ? 60_000 : 90_000;

const STEP_CODE_ID = 'step-code-kimi-recovery-001';

type TestFixtures = {
  space: Space;
  coderAgent: SpaceAgent;
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
  })) as { agents: SpaceAgent[] };

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
      } catch {
        // Hub may already be disconnected.
      }
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

    // Let the initial kickoff turn fully complete before injecting the overflow.
    // We must wait for the RESULT message (not just idle) because the
    // task-agent-manager injects the kickoff user message asynchronously after
    // spawning the session — if we inject the stderr before the kickoff is
    // delivered, the kickoff becomes the last SDK message and the tick loop
    // never detects the overflow.
    await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);
    await waitForSdkMessageType(daemon, sessionId, 'result', IDLE_TIMEOUT);

    // Park the execution as idle so the runtime sweep enters recovery.
    await daemon.messageHub.request('nodeExecution.update', {
      id: execution.id,
      spaceId: space.id,
      status: 'idle',
      result: 'Kimi prompt-too-long injected',
    });

    // Simulate the SDK injecting Kimi's 400 as a user message with stderr tags.
    const stderrMessage = `<local-command-stderr>${stderrContent}</local-command-stderr>`;
    await daemon.messageHub.request('test.injectSDKMessage', {
      sessionId,
      message: {
        type: 'user',
        message: { role: 'user', content: stderrMessage },
        parent_tool_use_id: null,
      },
    });

    // Verify the injected overflow message is persisted.
    const persistedStderrText = await waitForSdkMessageText(
      daemon,
      sessionId,
      (text) => text.includes('<local-command-stderr>') && text.includes(stderrContent),
      RECOVERY_TIMEOUT
    );
    expect(persistedStderrText).toContain('<local-command-stderr>');
    expect(persistedStderrText).toContain(stderrContent);

    // Tick loop detects the overflow user message and injects /compact.
    const compactMessage = await waitForUserMessageText(
      daemon,
      sessionId,
      (text) => text === '/compact',
      RECOVERY_TIMEOUT
    );
    expect(compactMessage.text).toBe('/compact');

    // The /compact turn succeeds (catch-all mock), then the continue nag is injected.
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
