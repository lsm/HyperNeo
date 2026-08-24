import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  settled: boolean;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  const guarded: Deferred<T> = {
    promise,
    settled: false,
    resolve: (value: T) => {
      if (guarded.settled) return;
      guarded.settled = true;
      resolve(value);
    },
  };
  return guarded;
}

interface ControlledQuery {
  pendingNexts: Array<Deferred<IteratorResult<unknown>>>;
  prompt: unknown;
}

let spawnedQueries: ControlledQuery[] = [];

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
    createSdkMcpServer: mock((options: { name: string; version?: string; tools?: unknown[] }) => ({
      type: 'sdk' as const,
      name: options.name,
      version: options.version ?? '1.0.0',
      tools: options.tools ?? [],
      instance: new MockMcpServer(),
    })),
    tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({
      name,
      description,
      inputSchema,
      handler,
    }),
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
const { MessageDeliveryRecoverableTurnError, MessageDeliveryTerminalTurnError } = await import(
  '../../../../src/lib/agent/message-delivery'
);
const { deliveryMetrics } = await import('../../../../src/lib/agent/message-delivery-metrics');

import type { MessageHub } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { Database } from '../../../../src/storage/database';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { AgentSession as AgentSessionType } from '../../../../src/lib/agent/agent-session';

type AgentSessionSeams = {
  messageQueue: MessageQueue;
  queryPromise: Promise<void> | null;
};

const SESSION_ID = 'delivery-livelock-session';
const WEDGE_UUID = 'msg-wedge-01b27ec0';

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('delivery retry livelock convergence (task #1256 incident)', () => {
  let db: Database;
  let internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  let workspacePath: string;
  let savedV2Flag: string | undefined;
  let savedApiKey: string | undefined;

  const messageHub = {
    event: mock(async () => {}),
    onRequest: mock((_method: string, _handler: Function) => () => {}),
    query: mock(async () => ({})),
    command: mock(async () => {}),
  } as unknown as MessageHub;

  function seedSession(): void {
    const session = createTestSession(SESSION_ID);
    session.workspacePath = workspacePath;
    db.createSession(session);
    db.getSDKMessageRepo().saveUserMessage(
      SESSION_ID,
      {
        type: 'user',
        uuid: WEDGE_UUID,
        message: { role: 'user', content: 'go' },
      } as unknown as SDKMessage,
      'enqueued'
    );
  }

  function seedEnqueuedMessage(uuid: string, text: string): void {
    db.getSDKMessageRepo().saveUserMessage(
      SESSION_ID,
      {
        type: 'user',
        uuid,
        message: { role: 'user', content: text },
      } as unknown as SDKMessage,
      'enqueued'
    );
  }

  function restoreSession(): AgentSessionType {
    return AgentSession.restore(
      SESSION_ID,
      db,
      messageHub,
      internalEventBus,
      async () => 'test-key',
      undefined,
      undefined,
      { autoReplayPendingMessages: false }
    ) as AgentSessionType;
  }

  async function runWedgeAttempt(agentSession: AgentSessionType, uuid: string): Promise<unknown> {
    const settled = agentSession
      .driveDeliveryTurn(uuid, 'go', null, false, () => true)
      .catch((error: unknown) => error);
    const spawnedBefore = spawnedQueries.length;
    await Promise.race([
      waitFor(() => spawnedQueries.length > spawnedBefore),
      settled.then(() => undefined),
    ]);
    if (spawnedQueries.length > spawnedBefore) {
      const query = spawnedQueries[spawnedQueries.length - 1];
      for (const pending of query.pendingNexts) {
        pending.resolve({ value: undefined, done: true });
      }
    }
    return settled;
  }

  async function runHappyAttempt(
    agentSession: AgentSessionType,
    uuid: string,
    alreadyConsumed = false
  ): Promise<unknown> {
    const drive = agentSession.driveDeliveryTurn(uuid, 'go', null, alreadyConsumed, () => true);
    const spawnedBefore = spawnedQueries.length;
    await waitFor(() => spawnedQueries.length > spawnedBefore);
    if (!alreadyConsumed) {
      const query = spawnedQueries[spawnedQueries.length - 1];
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    db.getSDKMessageRepo().saveSDKMessage(SESSION_ID, {
      type: 'result',
      uuid: `${uuid}-result`,
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      subtype: 'success',
      is_error: false,
    } as unknown as SDKMessage);
    await agentSession.stateManager.setIdle();
    return drive;
  }

  beforeEach(async () => {
    savedV2Flag = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    savedApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';

    resetProviderRegistry();
    resetProviderFactory();
    resetProviderServiceInstance();
    const anthropicProvider = new AnthropicProvider(process.env);
    anthropicProvider.setCredentials({ type: 'api_key', apiKey: 'sk-test-key' });
    getProviderRegistry().register(anthropicProvider);

    spawnedQueries = [];
    workspacePath = mkdtempSync(join(tmpdir(), 'delivery-livelock-'));
    db = await createTestDb();
    internalEventBus = createDaemonInternalEventBus();
    seedSession();
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
    try {
      db?.close();
    } catch {}
    rmSync(workspacePath, { recursive: true, force: true });
  });

  it('terminalizes after consecutive zero-progress query deaths instead of livelocking, then delivers a new message', async () => {
    const agentSession = restoreSession();
    const seams = agentSession as unknown as AgentSessionSeams;
    const wedgesBefore = deliveryMetrics.snapshot().zeroProgressWedges;

    await agentSession.stateManager.setProcessing(WEDGE_UUID);
    expect(agentSession.getProcessingState().status).toBe('processing');

    const first = (await runWedgeAttempt(agentSession, WEDGE_UUID)) as Error;
    expect(first).toBeInstanceOf(MessageDeliveryRecoverableTurnError);
    expect(first.message).toBe('Turn ended without a response');

    const second = (await runWedgeAttempt(agentSession, WEDGE_UUID)) as Error;
    expect(second).toBeInstanceOf(MessageDeliveryRecoverableTurnError);

    const third = (await runWedgeAttempt(agentSession, WEDGE_UUID)) as Error;
    expect(third).toBeInstanceOf(MessageDeliveryTerminalTurnError);
    expect(third.message).toContain('zero SDK progress');

    expect(agentSession.getProcessingState().status).toBe('idle');
    expect(seams.messageQueue.isRunning()).toBe(false);
    expect(deliveryMetrics.snapshot().zeroProgressWedges).toBe(wedgesBefore + 1);

    const nextUuid = 'msg-after-wedge';
    seedEnqueuedMessage(nextUuid, 'go again');
    const outcome = await runHappyAttempt(agentSession, nextUuid);
    expect(outcome).toEqual({ outcome: 'completed' });
    expect(agentSession.getProcessingState().status).toBe('idle');
  });

  it('resets the zero-progress budget after an attempt with real SDK progress', async () => {
    const agentSession = restoreSession();

    const first = (await runWedgeAttempt(agentSession, WEDGE_UUID)) as Error;
    expect(first).toBeInstanceOf(MessageDeliveryRecoverableTurnError);

    const second = (await runWedgeAttempt(agentSession, WEDGE_UUID)) as Error;
    expect(second).toBeInstanceOf(MessageDeliveryRecoverableTurnError);

    const nextUuid = 'msg-progress-reset';
    seedEnqueuedMessage(nextUuid, 'go');
    expect(await runHappyAttempt(agentSession, nextUuid)).toEqual({ outcome: 'completed' });
    for (const pending of spawnedQueries[spawnedQueries.length - 1].pendingNexts) {
      pending.resolve({ value: undefined, done: true });
    }
    await agentSession.resetQuery({ restartQuery: false });

    const postProgressUuid = 'msg-post-progress';
    seedEnqueuedMessage(postProgressUuid, 'go');
    const third = (await runWedgeAttempt(agentSession, postProgressUuid)) as Error;
    expect(third).toBeInstanceOf(MessageDeliveryRecoverableTurnError);

    const fourth = (await runWedgeAttempt(agentSession, postProgressUuid)) as Error;
    expect(fourth).toBeInstanceOf(MessageDeliveryRecoverableTurnError);
    expect(fourth).not.toBeInstanceOf(MessageDeliveryTerminalTurnError);
  });

  it('requeues a yielded kickoff when its query dies before the SDK confirms the send', async () => {
    const agentSession = restoreSession();
    const seams = agentSession as unknown as AgentSessionSeams;

    const drive = agentSession.driveDeliveryTurn(WEDGE_UUID, 'go', null, false, () => true);
    const spawnedBefore = spawnedQueries.length;
    await waitFor(() => spawnedQueries.length > spawnedBefore);
    const query = spawnedQueries[spawnedQueries.length - 1];
    const promptIterator = (query.prompt as AsyncGenerator<unknown, void, unknown>)[
      Symbol.asyncIterator
    ]();
    const pulled = await promptIterator.next();
    expect((pulled.value as { uuid?: string }).uuid).toBe(WEDGE_UUID);
    for (const pending of query.pendingNexts) {
      pending.resolve({ value: undefined, done: true });
    }
    const failure = (await drive.catch((error: unknown) => error)) as Error;
    expect(failure).toBeInstanceOf(MessageDeliveryRecoverableTurnError);
    expect(seams.messageQueue.hasPendingOrClaimed(WEDGE_UUID)).toBe(true);
    expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, WEDGE_UUID)).toMatchObject({
      sendStatus: 'enqueued',
    });

    expect(await runHappyAttempt(agentSession, WEDGE_UUID)).toEqual({ outcome: 'completed' });
  });

  it('never spends the zero-progress budget on already-consumed turn reclaims', async () => {
    const agentSession = restoreSession();
    db.getSDKMessageRepo().markDeliveryConsumedByUuid(SESSION_ID, WEDGE_UUID);

    for (let attempt = 0; attempt < 4; attempt++) {
      let signalQueryReady!: () => void;
      const queryReady = new Promise<void>((resolve) => {
        signalQueryReady = resolve;
      });
      const observer = {
        reportStage: (stage: string) => {
          if (stage === 'query_ready') signalQueryReady();
        },
      };
      await agentSession.stateManager.setProcessing(WEDGE_UUID);
      const drive = agentSession
        .driveDeliveryTurn(WEDGE_UUID, 'go', null, true, () => true, undefined, undefined, observer)
        .catch((error: unknown) => error);
      await queryReady;
      await new Promise((resolve) => setTimeout(resolve, 10));
      await agentSession.stateManager.setIdle();
      const result = (await drive) as Error;
      expect(result).toBeInstanceOf(MessageDeliveryRecoverableTurnError);
      expect(result).not.toBeInstanceOf(MessageDeliveryTerminalTurnError);
    }
  });

  it('clearStuckProcessingState resets a matching zombie processing state with no live query', async () => {
    const agentSession = restoreSession();
    const seams = agentSession as unknown as AgentSessionSeams;

    seams.queryPromise = Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await agentSession.stateManager.setProcessing(WEDGE_UUID);

    expect(await agentSession.clearStuckProcessingState(WEDGE_UUID)).toBe(true);
    expect(agentSession.getProcessingState().status).toBe('idle');
  });

  it('clearStuckProcessingState refuses to reset while a live query owns the turn', async () => {
    const agentSession = restoreSession();
    const seams = agentSession as unknown as AgentSessionSeams;

    seams.queryPromise = new Promise<void>(() => {});
    await agentSession.stateManager.setProcessing(WEDGE_UUID);

    expect(await agentSession.clearStuckProcessingState(WEDGE_UUID)).toBe(false);
    expect(agentSession.getProcessingState().status).toBe('processing');
  });

  it('clearStuckProcessingState ignores a processing state owned by a different message', async () => {
    const agentSession = restoreSession();
    const seams = agentSession as unknown as AgentSessionSeams;

    seams.queryPromise = Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await agentSession.stateManager.setProcessing('msg-someone-else');

    expect(await agentSession.clearStuckProcessingState(WEDGE_UUID)).toBe(false);
    expect(agentSession.getProcessingState().status).toBe('processing');
    expect(agentSession.getProcessingState()).toMatchObject({ messageId: 'msg-someone-else' });
  });
});
