import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageContent, MessageHub, Session } from '@neokai/shared';
import type { SDKMessage, SDKUserMessage } from '@neokai/shared/sdk';
import type { Database } from '../../../../src/storage/database';
import type { ErrorManager } from '../../../../src/lib/error-manager';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { Logger } from '../../../../src/lib/logger';
import type { QueryOptionsBuilder } from '../../../../src/lib/agent/query-options-builder';
import type { AskUserQuestionHandler } from '../../../../src/lib/agent/ask-user-question-handler';
import type { QueryRunnerContext } from '../../../../src/lib/agent/query-runner';
import type { AcpClient, AcpClientOptions } from '../../../../src/lib/acp/acp-client';
import {
  AcpQueryRunner,
  convertMcpServersForAcp,
  parseAcpCommand,
} from '../../../../src/lib/acp/acp-query-runner';
import { resetProviderFactory } from '../../../../src/lib/providers/factory';
import { resetProviderRegistry } from '../../../../src/lib/providers/registry';

function createMockClient() {
  return {
    initialize: mock(async () => ({ protocolVersion: 1, agentCapabilities: {}, agentInfo: {} })),
    authenticate: mock(async () => {}),
    createSession: mock(async () => ({ sessionId: 'acp-session-1', configOptions: [] })),
    sendPrompt: mock(async function* (_prompt: unknown) {
      yield {
        sessionId: 'acp-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello from acp' },
        },
      };
    }),
    getSessionId: mock(() => 'acp-session-1'),
    getLastPromptStopReason: mock(() => 'end_turn'),
    close: mock(() => {}),
    cancel: mock(() => {}),
  };
}

function makeUserMessage(content: string | MessageContent[]): SDKUserMessage {
  return {
    type: 'user',
    uuid: 'user-message-1' as SDKUserMessage['uuid'],
    session_id: 'session-1',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    },
  };
}

interface RunnerFixtureOverrides {
  session?: Partial<Session>;
  client?: ReturnType<typeof createMockClient>;
  messages?: SDKUserMessage[];
  queryOptions?: {
    cwd?: string;
    mcpServers?: Record<string, unknown>;
    env?: Record<string, string>;
  };
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string }
  ) => Promise<
    | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  >;
  onSDKMessage?: (message: SDKMessage) => Promise<void>;
}

function createRunnerFixture(overrides: RunnerFixtureOverrides = {}) {
  let queryGeneration = 0;
  const yieldedMessages = overrides.messages ?? [makeUserMessage('hello')];
  const onSent = mock(() => {});
  const startSpy = mock(() => {});
  const stopSpy = mock(() => {});
  const onSDKMessage = mock(overrides.onSDKMessage ?? (async (_message: SDKMessage) => {}));
  const onMarkApiSuccess = mock(async () => {});
  const trackAgentProcess = mock(() => {});
  const canUseTool = mock(
    overrides.canUseTool ??
      (async (_toolName, input) => ({ behavior: 'allow' as const, updatedInput: input }))
  );
  const mockClient = overrides.client ?? createMockClient();
  const constructorOptions: AcpClientOptions[] = [];
  const queryOptions = overrides.queryOptions ?? { cwd: '/tmp/acp-session', mcpServers: {} };

  const messageQueue = {
    isRunning: mock(() => false),
    getGeneration: mock(() => 0),
    start: startSpy,
    stop: stopSpy,
    clear: mock(() => {}),
    size: mock(() => 0),
    enqueueWithId: mock(async () => {}),
    messageGenerator: mock(async function* () {
      for (const message of yieldedMessages) {
        yield { message, onSent };
      }
    }),
  } as unknown as MessageQueue;

  const baseSession: Session = {
    id: 'session-1',
    title: 'ACP Session',
    workspacePath: '/tmp/acp-session',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: {
      model: 'acp-default',
      provider: 'acp',
      maxTokens: 8192,
      temperature: 1,
    },
    metadata: {},
  } as Session;
  const session = {
    ...baseSession,
    ...overrides.session,
    config: {
      ...baseSession.config,
      ...overrides.session?.config,
    },
    metadata: overrides.session?.metadata ?? baseSession.metadata,
  } as Session;

  const ctx: QueryRunnerContext = {
    session,
    db: {
      saveSDKMessage: mock(() => {}),
      getNodeExecutionRepo: mock(() => ({
        getByAgentSessionId: mock(() => null),
        getById: mock(() => null),
      })),
      getSpaceTaskRepo: mock(() => ({ getTask: mock(() => null) })),
    } as unknown as Database,
    messageHub: { event: mock(() => {}) } as unknown as MessageHub,
    messageQueue,
    stateManager: {
      getState: mock(() => ({ status: 'idle' })),
      setProcessing: mock(async () => {}),
      setIdle: mock(async () => {}),
    } as unknown as ProcessingStateManager,
    errorManager: { handleError: mock(async () => {}) } as unknown as ErrorManager,
    logger: {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    } as unknown as Logger,
    optionsBuilder: {
      setCanUseTool: mock(() => {}),
      build: mock(async () => queryOptions),
      addSessionStateOptions: mock((options: unknown) => options),
    } as unknown as QueryOptionsBuilder,
    askUserQuestionHandler: {
      createCanUseToolCallback: mock(() => canUseTool),
    } as unknown as AskUserQuestionHandler,
    queryObject: null,
    queryPromise: null,
    queryAbortController: null,
    firstMessageReceived: false,
    startupTimeoutTimer: null,
    originalEnvVars: {},
    processExitedPromise: null,
    resetProcessExitedPromise: mock(() => {}),
    trackAgentProcess,
    snapshotTrackedAgentProcesses: mock(() => []),
    incrementQueryGeneration: () => ++queryGeneration,
    getQueryGeneration: () => queryGeneration,
    isCleaningUp: () => false,
    onSDKMessage,
    onSlashCommandsFetched: mock(async () => {}),
    onModelsFetched: mock(async () => {}),
    onMarkApiSuccess,
  };

  const runner = new AcpQueryRunner(ctx, (options) => {
    constructorOptions.push(options);
    return mockClient as unknown as AcpClient;
  });

  return {
    runner,
    ctx,
    mockClient,
    constructorOptions,
    startSpy,
    stopSpy,
    onSent,
    onSDKMessage,
    onMarkApiSuccess,
    canUseTool,
    messageQueue,
  };
}

describe('AcpQueryRunner', () => {
  let originalAcpCommand: string | undefined;

  beforeEach(() => {
    originalAcpCommand = process.env.NEOKAI_ACP_COMMAND;
    process.env.NEOKAI_ACP_COMMAND = 'mock-acp --stdio';
    resetProviderRegistry();
    resetProviderFactory();
  });

  afterEach(() => {
    if (originalAcpCommand === undefined) delete process.env.NEOKAI_ACP_COMMAND;
    else process.env.NEOKAI_ACP_COMMAND = originalAcpCommand;
    resetProviderRegistry();
    resetProviderFactory();
  });

  test('parses ACP command with quoted args', () => {
    expect(parseAcpCommand('claude --acp --name "My Agent"')).toEqual({
      command: 'claude',
      args: ['--acp', '--name', 'My Agent'],
    });
  });

  test('converts process MCP servers and skips in-process SDK servers', () => {
    const warnings: string[] = [];
    const converted = convertMcpServersForAcp(
      {
        stdio: { type: 'stdio', command: 'node', args: ['server.js'], env: { A: '1' } },
        http: {
          type: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer x' },
        },
        sse: {
          type: 'sse',
          url: 'https://example.test/sse',
          headers: { 'X-Test': '1' },
        },
        invalidHttp: { type: 'http', url: 'not a url' } as never,
        invalidSse: { type: 'sse' } as never,
        live: { type: 'sdk', name: 'live', instance: {} } as never,
      },
      (message) => warnings.push(message)
    );

    expect(converted).toEqual([
      {
        type: 'stdio',
        name: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: [{ name: 'A', value: '1' }],
      },
      {
        type: 'http',
        name: 'http',
        url: 'https://example.test/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer x' }],
      },
      {
        type: 'sse',
        name: 'sse',
        url: 'https://example.test/sse',
        headers: [{ name: 'X-Test', value: '1' }],
      },
    ]);
    expect(warnings[0]).toContain("Skipping in-process MCP server 'live'");
  });

  test('runs ACP lifecycle and forwards translated SDK messages', async () => {
    const {
      runner,
      ctx,
      mockClient,
      constructorOptions,
      startSpy,
      stopSpy,
      onSent,
      onSDKMessage,
      onMarkApiSuccess,
    } = createRunnerFixture();

    await runner.start();
    await ctx.queryPromise;

    expect(startSpy).toHaveBeenCalled();
    expect(constructorOptions[0].command).toBe('mock-acp');
    expect(constructorOptions[0].args).toEqual(['--stdio']);
    expect(typeof constructorOptions[0].onPermissionRequest).toBe('function');
    expect(mockClient.initialize).toHaveBeenCalled();
    expect(mockClient.authenticate).toHaveBeenCalled();
    expect(mockClient.createSession).toHaveBeenCalledWith('/tmp/acp-session', []);
    expect(mockClient.sendPrompt.mock.calls[0][0]).toEqual([{ type: 'text', text: 'hello' }]);
    expect(onSent).toHaveBeenCalled();
    expect(onSDKMessage).toHaveBeenCalled();
    expect(onSDKMessage.mock.calls.some(([message]) => message.type === 'assistant')).toBe(true);
    expect(onSDKMessage.mock.calls.some(([message]) => message.type === 'result')).toBe(true);
    expect(onMarkApiSuccess).toHaveBeenCalled();
    expect(stopSpy).toHaveBeenCalled();
  });

  test('maps ACP permission requests through AskUserQuestion approval callback', async () => {
    const { runner, ctx, constructorOptions, canUseTool } = createRunnerFixture({
      canUseTool: async (_toolName, _input, _options) => ({
        behavior: 'allow',
        updatedInput: { answers: { 'Allow Edit file?': 'Allow once' } },
      }),
    });

    await runner.start();
    await ctx.queryPromise;

    const result = await constructorOptions[0].onPermissionRequest?.({
      sessionId: 'acp-session-1',
      toolCall: {
        toolCallId: 'tool-1',
        title: 'Edit file',
        kind: 'edit',
      },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      ],
    });

    expect(canUseTool).toHaveBeenCalledWith(
      'AskUserQuestion',
      expect.objectContaining({
        questions: [
          expect.objectContaining({
            question: 'Allow Edit file?',
            header: 'ACP approval',
          }),
        ],
      }),
      expect.objectContaining({ toolUseID: 'tool-1' })
    );
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
  });

  test('retries ACP startup timeout even after timeout aborts controller', async () => {
    const firstClient = createMockClient();
    let releasePrompt: (() => void) | undefined;
    firstClient.close.mockImplementation(() => releasePrompt?.());
    firstClient.sendPrompt.mockImplementation(async function* () {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
    });
    const secondClient = createMockClient();
    const clients = [firstClient, secondClient];
    const { runner, ctx, messageQueue } = createRunnerFixture({ client: firstClient });
    const constructorOptions: AcpClientOptions[] = [];
    const createClient = mock((options: AcpClientOptions) => {
      constructorOptions.push(options);
      return clients.shift() as unknown as AcpClient;
    });
    const retryRunner = new AcpQueryRunner(ctx, createClient);

    const previousTimeout = process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS;
    process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS = '20';
    await retryRunner.start();
    await ctx.queryPromise;
    if (previousTimeout === undefined) delete process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS;
    else process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS = previousTimeout;

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(firstClient.close).toHaveBeenCalled();
    expect(messageQueue.enqueueWithId).toHaveBeenCalledWith('user-message-1', [
      { type: 'text', text: 'hello' },
    ]);
    expect(secondClient.sendPrompt).toHaveBeenCalled();
  }, 1000);

  test('handles ACP SDK message errors without killing query loop', async () => {
    let seenAssistant = false;
    const { runner, ctx, onSDKMessage } = createRunnerFixture({
      onSDKMessage: async (message) => {
        if (message.type === 'assistant' && !seenAssistant) {
          seenAssistant = true;
          throw new Error('db write failed');
        }
      },
    });

    await runner.start();
    await ctx.queryPromise;

    expect(onSDKMessage.mock.calls.some(([message]) => message.type === 'result')).toBe(true);
    expect(ctx.errorManager.handleError).toHaveBeenCalledWith(
      'session-1',
      expect.any(Error),
      'message',
      'Error processing ACP message. The session has been reset.',
      expect.any(Object),
      expect.objectContaining({ providerId: 'acp' })
    );
  });

  test('blocks ACP Space turns when required in-process MCP servers are present', async () => {
    const { runner, ctx } = createRunnerFixture({
      session: {
        type: 'space_chat',
        context: { spaceId: 'space-1' },
      } as Partial<Session>,
      queryOptions: {
        cwd: '/tmp/acp-session',
        mcpServers: {
          'space-agent-tools': { type: 'sdk', instance: {} },
        },
      },
    });

    await runner.start();
    await ctx.queryPromise;

    expect(ctx.errorManager.handleError).toHaveBeenCalledWith(
      'session-1',
      expect.any(Error),
      'system',
      expect.stringContaining('ACP cannot proxy SDK MCP servers yet'),
      expect.any(Object),
      expect.objectContaining({ providerId: 'acp' })
    );
  });

  test('closes local client when retry happens before queryObject exists', async () => {
    const firstClient = createMockClient();
    firstClient.initialize.mockImplementation(async () => {
      throw new Error('TypeError: fetch failed');
    });
    const secondClient = createMockClient();
    const clients = [firstClient, secondClient];
    const { ctx } = createRunnerFixture({ client: firstClient });
    const runner = new AcpQueryRunner(ctx, () => clients.shift() as unknown as AcpClient);

    await runner.start();
    await ctx.queryPromise;

    expect(firstClient.close).toHaveBeenCalled();
    expect(secondClient.sendPrompt).toHaveBeenCalled();
  });

  test('surfaces provider auth failure without spawning ACP client', async () => {
    delete process.env.NEOKAI_ACP_COMMAND;
    resetProviderRegistry();
    resetProviderFactory();
    const createClient = mock(() => createMockClient() as unknown as AcpClient);
    const { ctx } = createRunnerFixture();
    const runner = new AcpQueryRunner(ctx, createClient);

    await runner.start();
    await ctx.queryPromise;

    expect(createClient).not.toHaveBeenCalled();
    expect(ctx.errorManager.handleError).toHaveBeenCalledWith(
      'session-1',
      expect.any(Error),
      'provider_auth_error',
      expect.stringContaining('Provider ACP Agent is not available'),
      expect.any(Object),
      expect.objectContaining({ providerId: 'acp' })
    );
  });

  test('stops iteration without error when abort signal fires', async () => {
    const client = createMockClient();
    let releasePrompt: (() => void) | undefined;
    let promptBlockedResolve: (() => void) | undefined;
    const promptBlocked = new Promise<void>((resolve) => {
      promptBlockedResolve = resolve;
    });
    client.sendPrompt.mockImplementation(async function* () {
      yield {
        sessionId: 'acp-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'before abort' },
        },
      };
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
        promptBlockedResolve?.();
      });
    });
    const { runner, ctx } = createRunnerFixture({ client });

    await runner.start();
    await promptBlocked;
    ctx.queryAbortController?.abort();
    releasePrompt?.();
    await ctx.queryPromise;

    expect(client.sendPrompt).toHaveBeenCalled();
    expect(ctx.errorManager.handleError).not.toHaveBeenCalled();
  }, 1000);
});
