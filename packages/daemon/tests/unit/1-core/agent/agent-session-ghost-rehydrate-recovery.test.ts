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

const SESSION_ID = 'ghost-rehydrate-session';
const TURN_MESSAGE_UUID = 'turn-msg-d6160db3';

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('ghost sub-session rehydrate recovery (task #1256 incident)', () => {
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

  function seedInterruptedTurnSession(): void {
    const session = createTestSession(SESSION_ID);
    session.workspacePath = workspacePath;
    session.processingState = JSON.stringify({
      status: 'processing',
      messageId: TURN_MESSAGE_UUID,
      phase: 'initializing',
    });
    db.createSession(session);

    db.saveSDKMessage(SESSION_ID, {
      type: 'user',
      uuid: TURN_MESSAGE_UUID,
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'continue the interrupted turn' }],
      },
    } as unknown as SDKMessage);
    db.getDatabase()
      .prepare(
        `UPDATE sdk_messages SET send_status = 'enqueued'
         WHERE session_id = ? AND json_extract(sdk_message, '$.uuid') = ?`
      )
      .run(SESSION_ID, TURN_MESSAGE_UUID);
  }

  function restoreGhostSession(): AgentSessionType {
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
    workspacePath = mkdtempSync(join(tmpdir(), 'ghost-rehydrate-'));
    db = await createTestDb();
    internalEventBus = createDaemonInternalEventBus();
    seedInterruptedTurnSession();
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
    rmSync(workspacePath, { recursive: true, force: true });
  });

  it('starts a fresh SDK query for a ghost session whose restored messageQueue is running with no live query', async () => {
    const agentSession = restoreGhostSession();
    const seams = agentSession as unknown as AgentSessionSeams;

    seams.messageQueue.start();
    expect(seams.messageQueue.isRunning()).toBe(true);
    expect(seams.queryPromise).toBeNull();

    await agentSession.startStreamingQuery();

    await waitFor(() => spawnedQueries.length === 1);
    expect(spawnedQueries.length).toBe(1);
    expect(seams.queryPromise).not.toBeNull();
    expect(seams.messageQueue.isRunning()).toBe(true);
  });

  it('redrives the pending turn message through the fresh query instead of dead-ending on the running queue', async () => {
    const agentSession = restoreGhostSession();
    const seams = agentSession as unknown as AgentSessionSeams;

    seams.messageQueue.start();
    await agentSession.startStreamingQuery();
    await waitFor(() => spawnedQueries.length === 1);

    const replaySettled = agentSession
      .replayPendingMessagesForImmediateMode()
      .catch((error: unknown) => error);

    const promptIterator = (spawnedQueries[0].prompt as AsyncGenerator<unknown>)[
      Symbol.asyncIterator
    ]();
    const first = await promptIterator.next();

    expect(first.done).toBe(false);
    const redriven = first.value as { uuid?: string };
    expect(redriven.uuid).toBe(TURN_MESSAGE_UUID);

    expect(agentSession.getProcessingState().status).toBe('processing');

    seams.messageQueue.stop();
    const second = await promptIterator.next();
    expect(second.done).toBe(true);

    for (const pending of spawnedQueries[0].pendingNexts) {
      pending.resolve({ value: undefined, done: true });
    }
    await seams.queryPromise?.catch(() => {});
    await replaySettled;
    expect(seams.queryPromise).toBeNull();
  });

  it('still skips a second start while the rehydrated query is genuinely live', async () => {
    const agentSession = restoreGhostSession();
    const seams = agentSession as unknown as AgentSessionSeams;

    await agentSession.startStreamingQuery();
    await waitFor(() => spawnedQueries.length === 1);
    expect(seams.queryPromise).not.toBeNull();

    await agentSession.startStreamingQuery();

    expect(spawnedQueries.length).toBe(1);
  });
});
