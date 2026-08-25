import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface ControlledQuery {
  pendingNexts: Array<Deferred<IteratorResult<unknown>>>;
  prompt: unknown;
}

let spawnedQueries: ControlledQuery[] = [];
let _toolBatch: Array<{ name: string; def: object }> = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => {
  class MockMcpServer {
    readonly _registeredTools: Record<string, object> = {};
    connect(): void {}
    disconnect(): void {}
  }
  return {
    query: (args: { prompt?: unknown }) => {
      const controlled: ControlledQuery = {
        pendingNexts: [],
        prompt: args.prompt,
      };
      spawnedQueries.push(controlled);
      return {
        interrupt: mock(async () => undefined),
        close: () => {},
        [Symbol.asyncIterator]: () => ({
          next: () => {
            const d = defer<IteratorResult<unknown>>();
            controlled.pendingNexts.push(d);
            return d.promise;
          },
          return: async () => ({ value: undefined, done: true }),
        }),
      };
    },
    interrupt: mock(async () => {}),
    supportedModels: mock(async () => {
      throw new Error('SDK unavailable in unit test');
    }),
    createSdkMcpServer: mock((options: { name: string; version?: string; tools?: unknown[] }) => {
      const server = new MockMcpServer();
      for (const { name, def } of _toolBatch) {
        server._registeredTools[name] = def;
      }
      if (Object.keys(server._registeredTools).length === 0 && Array.isArray(options.tools)) {
        for (const t of options.tools) {
          const td = t as { name?: string };
          if (td.name) server._registeredTools[td.name] = t as object;
        }
      }
      _toolBatch = [];
      return {
        type: 'sdk' as const,
        name: options.name,
        version: options.version ?? '1.0.0',
        tools: options.tools ?? [],
        instance: server,
      };
    }),
    tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => {
      const def = { name, description, inputSchema, handler };
      _toolBatch.push({ name, def });
      return def;
    },
  };
});

const { AgentSession } = await import('../../../../src/lib/agent/agent-session');
const { createTestDb, createTestSession } = await import('../../../helpers/database');
const { createDaemonInternalEventBus } = await import('../../../../src/lib/internal-event-bus');
const { getProviderRegistry, resetProviderRegistry } = await import(
  '../../../../src/lib/providers/registry.js'
);
const { resetProviderFactory } = await import('../../../../src/lib/providers/factory.js');
const { AnthropicProvider } = await import('../../../../src/lib/providers/anthropic-provider.js');
const { resetProviderServiceInstance } = await import('../../../../src/lib/provider-service');
const { deliverSpaceAgentMessage } = await import(
  '../../../../src/lib/space/runtime/space-agent-message-delivery'
);
const { AgentMessageRouter } = await import(
  '../../../../src/lib/space/runtime/agent-message-router.ts'
);
const { createMessageDeliveryHandler } = await import(
  '../../../../src/lib/job-handlers/message-delivery.handler'
);
const { MESSAGE_DELIVERY } = await import('../../../../src/lib/job-queue-constants');
const { JobQueueProcessor } = await import('../../../../src/storage/job-queue-processor');

import type { MessageHub } from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import type { Session } from '@hyperneo/shared';
import type { Database } from '../../../../src/storage/database';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus';
import type { AgentSession as AgentSessionType } from '../../../../src/lib/agent/agent-session';
import type { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import type { SpaceAgentInjectionOutcome } from '../../../../src/lib/space/runtime/space-agent-message-delivery';

const SPACE_ID = 'sp-idle-coordinator';
const SESSION_ID = `space:chat:${SPACE_ID}`;

const messageHub = {
  event: mock(async () => {}),
  onRequest: mock((_method: string, _handler: Function) => () => {}),
  query: mock(async () => ({})),
  command: mock(async () => {}),
} as unknown as MessageHub;

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function admitPromptMessage(query: ControlledQuery, uuid: string): Promise<void> {
  const promptIterator = (query.prompt as AsyncGenerator<unknown, void, unknown>)[
    Symbol.asyncIterator
  ]();
  let pulledUuid: string | undefined;
  for (let pull = 0; pull < 4 && pulledUuid !== uuid; pull++) {
    const pulled = await promptIterator.next();
    if (pulled.done) throw new Error('prompt generator ended before yielding the kickoff');
    pulledUuid = (pulled.value as { uuid?: string }).uuid;
  }
  expect(pulledUuid).toBe(uuid);
  void promptIterator.next();
}

async function completeTurn(
  db: Database,
  agentSession: AgentSessionType,
  uuid: string
): Promise<void> {
  db.getSDKMessageRepo().saveSDKMessage(SESSION_ID, {
    type: 'result',
    uuid: `${uuid}-result`,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    subtype: 'success',
    is_error: false,
  } as unknown as SDKMessage);
  await agentSession.stateManager.setIdle();
}

interface IdleCoordinatorHarness {
  db: Database;
  agentSession: AgentSessionType;
  processor: InstanceType<typeof JobQueueProcessor>;
  escalate: (
    messageId: string,
    text: string,
    depsOverride?: { onConsumed?: () => void }
  ) => Promise<SpaceAgentInjectionOutcome>;
}

async function makeIdleCoordinatorHarness(): Promise<IdleCoordinatorHarness> {
  const db = await createTestDb();
  const workspacePath = mkdtempSync(join(tmpdir(), 'idle-coordinator-'));
  const session = createTestSession(SESSION_ID);
  session.type = 'space_chat';
  session.workspacePath = workspacePath;
  (session as Session & { context?: { spaceId?: string } }).context = { spaceId: SPACE_ID };
  db.createSession(session);

  const internalEventBus: InternalEventBus<DaemonInternalEventMap> = createDaemonInternalEventBus();
  const agentSession = AgentSession.restore(
    SESSION_ID,
    db,
    messageHub,
    internalEventBus,
    async () => 'test-key',
    undefined,
    undefined,
    { autoReplayPendingMessages: false }
  ) as AgentSessionType;
  agentSession.mergeRuntimeMcpServers({
    'space-agent-tools': { type: 'stdio', command: 'stub-space-agent-tools' },
  });

  const jobQueue = db.getJobQueueRepo();
  const processor = new JobQueueProcessor(jobQueue, {
    pollIntervalMs: 10,
    maxConcurrent: 4,
    staleThresholdMs: 5 * 60 * 1000,
  });
  processor.register(
    MESSAGE_DELIVERY,
    createMessageDeliveryHandler({
      jobQueue,
      getSession: () => agentSession,
      getMessageContent: (sessionId, messageUuid) =>
        db.getSDKMessageRepo().getDeliveryContent(sessionId, messageUuid) ?? null,
      isSessionArchived: () => false,
    })
  );
  processor.start();

  const escalate = (messageId: string, text: string, depsOverride?: { onConsumed?: () => void }) =>
    deliverSpaceAgentMessage(
      {
        sdkMessageRepo: db.getSDKMessageRepo(),
        saveUserMessage: (sid, msg, status) => db.saveUserMessage(sid, msg, status),
        publishStatusChanged: async () => {},
        jobQueue,
        stateManager: agentSession.stateManager,
        onConsumed: depsOverride?.onConsumed,
      },
      {
        sessionId: SESSION_ID,
        messageId,
        sdkUserMessage: {
          type: 'user',
          uuid: messageId,
          session_id: SESSION_ID,
          parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'text', text }] },
        } as unknown as SDKUserMessage,
      }
    );

  return {
    db,
    agentSession,
    processor,
    escalate,
  };
}

describe('idle coordinator message consumption (issue #2963)', () => {
  let savedV2Flag: string | undefined;
  let savedApiKey: string | undefined;
  let harnesses: IdleCoordinatorHarness[];
  let workspaces: string[];

  beforeEach(async () => {
    savedV2Flag = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    savedApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '1';
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';

    resetProviderRegistry();
    resetProviderFactory();
    resetProviderServiceInstance();
    const anthropicProvider = new AnthropicProvider(process.env);
    anthropicProvider.setCredentials({ type: 'api_key', apiKey: 'sk-test-key' });
    getProviderRegistry().register(anthropicProvider);

    spawnedQueries = [];
    harnesses = [];
    workspaces = [];
  });

  afterEach(async () => {
    if (savedV2Flag === undefined) {
      delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    } else {
      process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = savedV2Flag;
    }
    if (savedApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = savedApiKey;
    }
    for (const query of spawnedQueries) {
      for (const pending of query.pendingNexts) {
        pending.resolve({ value: undefined, done: true });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const harness of harnesses) {
      await harness.processor.stop();
      try {
        harness.db.close();
      } catch {}
    }
    for (const workspace of workspaces) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  function track(
    harness: IdleCoordinatorHarness,
    workspacePath: string | null
  ): IdleCoordinatorHarness {
    harnesses.push(harness);
    if (workspacePath) workspaces.push(workspacePath);
    return harness;
  }

  it('wakes an idle coordinator session: escalation drives a turn and is consumed', async () => {
    const harness = await makeIdleCoordinatorHarness();
    track(harness, harness.agentSession.getSessionData().workspacePath);
    const { db, agentSession } = harness;
    expect(agentSession.getProcessingState().status).toBe('idle');

    const delivered = harness.escalate('msg-wake-1', 'Blocked on base-OID rule; need judgment');
    await waitFor(() => spawnedQueries.length > 0);
    expect(agentSession.getProcessingState().status).not.toBe('idle');

    await admitPromptMessage(spawnedQueries[0], 'msg-wake-1');
    const outcome = await delivered;
    expect(outcome).toEqual({ state: 'delivered', messageId: 'msg-wake-1' });
    expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, 'msg-wake-1')?.sendStatus).toBe(
      'consumed'
    );

    await completeTurn(db, agentSession, 'msg-wake-1');
  });

  describe('when the idle coordinator does not consume within the window', () => {
    let savedTimeout: string | undefined;

    beforeAll(() => {
      savedTimeout = process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
      process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = '300';
    });

    afterAll(() => {
      if (savedTimeout === undefined) {
        delete process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
      } else {
        process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = savedTimeout;
      }
    });

    it('acks queued instead of timing out, keeps the row pending, and consumes it on activation', async () => {
      const harness = await makeIdleCoordinatorHarness();
      track(harness, harness.agentSession.getSessionData().workspacePath);
      const { db, agentSession } = harness;

      const outcome = await harness.escalate('msg-queued-1', 'escalation while coordinator idle');
      expect(outcome).toEqual({ state: 'queued', messageId: 'msg-queued-1' });
      expect(
        db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, 'msg-queued-1')?.sendStatus
      ).toBe('enqueued');

      await waitFor(() => spawnedQueries.length > 0);
      await admitPromptMessage(spawnedQueries[0], 'msg-queued-1');
      await waitFor(
        () =>
          db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, 'msg-queued-1')?.sendStatus ===
          'consumed'
      );
      await completeTurn(db, agentSession, 'msg-queued-1');
    });

    it('reports a truthful queued ack to the escalating worker via send_message routing', async () => {
      const harness = await makeIdleCoordinatorHarness();
      track(harness, harness.agentSession.getSessionData().workspacePath);
      const { db, agentSession, escalate } = harness;

      const router = new AgentMessageRouter({
        nodeExecutionRepo: {
          listByWorkflowRun: () => [],
        } as unknown as NodeExecutionRepository,
        workflowRunId: 'run-idle-coordinator',
        workflowChannels: [],
        messageInjector: async () => {},
        spaceId: SPACE_ID,
        spaceAgentInjector: async (_spaceId, message, _replyTo, explicitMessageId) =>
          escalate(explicitMessageId ?? `msg-router-${Date.now()}`, message),
      });

      const result = await router.deliverMessage({
        fromAgentName: 'coder',
        fromSessionId: 'sess-coder',
        target: 'space-agent',
        message: 'Blocked-task escalation: strict base-OID rule withheld mark_complete',
      });

      expect(result.success).toBe(true);
      expect(result.delivered).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.queued).toHaveLength(1);
      expect(result.queued?.[0].agentName).toBe('space-agent');
      const queuedMessageId = result.queued?.[0].messageId as string;
      expect(typeof queuedMessageId).toBe('string');
      expect(
        db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, queuedMessageId)?.sendStatus
      ).toBe('enqueued');

      await waitFor(() => spawnedQueries.length > 0);
      await admitPromptMessage(spawnedQueries[0], queuedMessageId);
      await waitFor(
        () =>
          db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, queuedMessageId)?.sendStatus ===
          'consumed'
      );
      await completeTurn(db, agentSession, queuedMessageId);
    });

    it('propagates failure when the delivery job dead-letters during the window', async () => {
      const harness = await makeIdleCoordinatorHarness();
      track(harness, harness.agentSession.getSessionData().workspacePath);
      const { db } = harness;

      const pending = harness.escalate('msg-dead-1', 'escalation that dead-letters');
      await waitFor(
        () => db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, 'msg-dead-1') !== null
      );
      db.getSDKMessageRepo().markDeliveryFailedByUuid(SESSION_ID, 'msg-dead-1');

      const outcome = await pending;
      expect(outcome.state).toBe('failed');
      if (outcome.state === 'failed') {
        expect(outcome.error).toContain('dead-lettered');
      }
      expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, 'msg-dead-1')?.sendStatus).toBe(
        'failed'
      );
    });

    it('settles a queued escalation through the delayed-consumption hook', async () => {
      const harness = await makeIdleCoordinatorHarness();
      track(harness, harness.agentSession.getSessionData().workspacePath);
      const { db, agentSession } = harness;
      let settled = false;

      const outcome = await harness.escalate('msg-late-1', 'escalation consumed after ack', {
        onConsumed: () => {
          settled = true;
        },
      });
      expect(outcome).toEqual({ state: 'queued', messageId: 'msg-late-1' });
      expect(settled).toBe(false);

      await waitFor(() => spawnedQueries.length > 0);
      await admitPromptMessage(spawnedQueries[0], 'msg-late-1');
      await waitFor(() => settled);
      await completeTurn(db, agentSession, 'msg-late-1');
    });
  });
});
