import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type { MessageContent, MessageHub, Session } from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
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
import { AcpMcpProxyBridge } from '../../../../src/lib/acp/mcp-proxy-bridge';
import { resetProviderFactory } from '../../../../src/lib/providers/factory';
import { resetProviderRegistry } from '../../../../src/lib/providers/registry';

function createMockClient() {
  return {
    initialize: mock(async () => ({ protocolVersion: 1, agentCapabilities: {}, agentInfo: {} })),
    authenticate: mock(async () => {}),
    createSession: mock(async () => ({ sessionId: 'acp-session-1', configOptions: [] })),
    loadSession: mock(async (sessionId: string) => ({ sessionId, configOptions: [] })),
    resumeSession: mock(async (sessionId: string) => ({ sessionId, configOptions: [] })),
    canLoadSession: mock(() => false),
    sendPrompt: mock(async function* (
      _prompt: unknown,
      callbacks?: { onSubmitted?: () => void; onAccepted?: () => void }
    ) {
      callbacks?.onSubmitted?.();
      callbacks?.onAccepted?.();
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
    getConfigOptions: mock(() => []),
    updateConfigOptions: mock(() => {}),
    setConfigOption: mock(async () => []),
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

type RunnerFixtureMessage = { message: SDKUserMessage; onSent: () => void };

interface RunnerFixtureOverrides {
  session?: Partial<Session>;
  client?: ReturnType<typeof createMockClient>;
  messages?: SDKUserMessage[];
  messageGenerator?: () => AsyncGenerator<RunnerFixtureMessage>;
  queueSize?: number;
  queryOptions?: {
    cwd?: string;
    mcpServers?: Record<string, unknown>;
    env?: Record<string, string>;
    systemPrompt?: unknown;
    agent?: string;
    agents?: Record<string, unknown>;
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

  const generatorFactory =
    overrides.messageGenerator ??
    async function* () {
      for (const message of yieldedMessages) {
        yield { message, onSent };
      }
    };

  const messageQueue = {
    isRunning: mock(() => false),
    getGeneration: mock(() => 0),
    start: startSpy,
    stop: stopSpy,
    clear: mock(() => {}),
    size: mock(() => overrides.queueSize ?? 0),
    peekNextUserMessageId: mock(() => null),
    hasPendingOrInFlight: mock(() => false),
    enqueueWithId: mock(async () => {}),
    onMessageEnqueued: undefined,
    messageGenerator: mock(generatorFactory),
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

  const sdkRepo = {
    reopenDeliveryByUuid: mock(() => 'reopened-db-id'),
  };

  const ctx: QueryRunnerContext = {
    session,
    db: {
      saveSDKMessage: mock(() => {}),
      updateSession: mock(() => {}),
      getMessageByStatusAndUuid: mock(() => null),
      getSDKMessageRepo: mock(() => sdkRepo),
      getNodeExecutionRepo: mock(() => ({
        getByAgentSessionId: mock(() => null),
        getById: mock(() => null),
      })),
      getSpaceTaskRepo: mock(() => ({ getTask: mock(() => null) })),
    } as unknown as Database,
    messageHub: { event: mock(() => {}) } as unknown as MessageHub,
    internalEventBus: { publish: mock(async () => {}), publishAsync: mock(async () => {}) },
    messageQueue,
    stateManager: {
      getState: mock(() => ({ status: 'idle' })),
      setProcessing: mock(async () => {}),
      beginTerminalIdle: mock(() => {}),
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
    messageHandler: {
      markMessageSubmitted: mock(() => true),
      markMessageAccepted: mock(() => {}),
      markMessageSubmissionFailed: mock(() => {}),
      markACPDeliveryFailed: mock(() => {}),
    } as never,
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
    sdkRepo,
  };
}

/**
 * Pin the shared startup-retry knobs for one test (returning a restore fn).
 * Mirrors the query-runner suites' treatment of PR #2551: base 0 keeps retries
 * near-immediate and cap 1 preserves the single-retry-entry shape the
 * pre-existing startup tests were written for — the daemon defaults would
 * sleep 15 s per retry and allow 5 rounds.
 */
function pinStartupRetryEnv(overrides?: { timeout?: string; base?: string; max?: string }) {
  const saved: Record<string, string | undefined> = {
    HYPERNEO_SDK_STARTUP_TIMEOUT_MS: process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS,
    HYPERNEO_SDK_STARTUP_RETRY_BASE_MS: process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS,
    HYPERNEO_SDK_STARTUP_RETRY_MAX: process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX,
  };
  process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = overrides?.timeout ?? '20';
  process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = overrides?.base ?? '0';
  process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = overrides?.max ?? '1';
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** A client whose prompt never answers — its startup timer always fires. */
function createHangingClient(): ReturnType<typeof createMockClient> {
  const client = createMockClient();
  let releasePrompt: (() => void) | undefined;
  client.close.mockImplementation(() => releasePrompt?.());
  client.sendPrompt.mockImplementation(async function* () {
    await new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
  });
  return client;
}

type WarnCaptureCtx = { logger: { warn: { mock: { calls: unknown[][] } } } };

function warnLines(ctx: WarnCaptureCtx): string[] {
  return ctx.logger.warn.mock.calls.map((args) => args.map(String).join(' '));
}

/** Poll briefly until a warn containing `fragment` has been logged. */
async function waitForWarn(ctx: WarnCaptureCtx, fragment: string): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (warnLines(ctx).some((line) => line.includes(fragment))) return true;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return false;
}

describe('AcpQueryRunner', () => {
  let originalAcpCommand: string | undefined;
  let originalAnthropicAuthToken: string | undefined;
  let originalClaudeCodeOauthToken: string | undefined;

  beforeEach(() => {
    originalAcpCommand = process.env.HYPERNEO_ACP_COMMAND;
    originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    originalClaudeCodeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.HYPERNEO_ACP_COMMAND = 'mock-acp --stdio';
    resetProviderRegistry();
    resetProviderFactory();
  });

  afterEach(() => {
    if (originalAcpCommand === undefined) delete process.env.HYPERNEO_ACP_COMMAND;
    else process.env.HYPERNEO_ACP_COMMAND = originalAcpCommand;
    if (originalAnthropicAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
    if (originalClaudeCodeOauthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeCodeOauthToken;
    resetProviderRegistry();
    resetProviderFactory();
  });

  test('parses ACP command with quoted args', () => {
    expect(parseAcpCommand('claude --acp --name "My Agent"')).toEqual({
      command: 'claude',
      args: ['--acp', '--name', 'My Agent'],
    });
  });

  test('converts process MCP servers and skips unproxied in-process SDK servers', () => {
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

  test('converts Space SDK MCP servers to ACP proxy stdio servers', () => {
    const mcpServers = {
      'space-agent-tools': {
        type: 'sdk',
        name: 'space-agent-tools',
        instance: {
          _registeredTools: {
            create_standalone_task: {
              description: 'Create a task',
              inputSchema: undefined,
              handler: mock(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
            },
          },
        },
      },
    } as never;
    const bridge = new AcpMcpProxyBridge(mcpServers);

    const converted = convertMcpServersForAcp(mcpServers, () => {}, bridge);

    expect(converted).toHaveLength(1);
    expect(converted[0]).toMatchObject({
      type: 'stdio',
      name: 'space-agent-tools',
      command: process.execPath,
    });
    expect(converted[0].args).toContain('--token');
    expect(converted[0].args).toContain('--toolsPath');
    expect(converted[0].args).not.toContain('--tools');
  });

  test('rejects proxy requests with invalid tokens', async () => {
    const mcpServers = {
      'space-agent-tools': {
        type: 'sdk',
        name: 'space-agent-tools',
        instance: {
          _registeredTools: {
            create_standalone_task: {
              description: 'Create a task',
              inputSchema: undefined,
              handler: mock(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
            },
          },
        },
      },
    } as never;
    const bridge = new AcpMcpProxyBridge(mcpServers);

    await expect(
      bridge.handleLineForTest(
        JSON.stringify({
          token: 'wrong',
          serverName: 'space-agent-tools',
          toolName: 'create_standalone_task',
          arguments: {},
        })
      )
    ).rejects.toThrow('Invalid proxy token');
  });

  test('writes per-server tool catalogs for proxy subprocesses', async () => {
    const mcpServers = {
      'node-agent': {
        type: 'sdk',
        name: 'node-agent',
        tools: [
          {
            name: 'send_message',
            description: 'Send message',
            inputSchema: { target: z.string() },
            handler: mock(async () => ({ content: [{ type: 'text', text: 'sent' }] })),
          },
        ],
        instance: { _registeredTools: {} },
      },
      'agent-memory': {
        type: 'sdk',
        name: 'agent-memory',
        tools: [
          {
            name: 'memory.write',
            description: 'Write memory',
            inputSchema: { key: z.string() },
            handler: mock(async () => ({ content: [{ type: 'text', text: 'written' }] })),
          },
        ],
        instance: { _registeredTools: {} },
      },
    } as never;
    const bridge = new AcpMcpProxyBridge(mcpServers);

    await bridge.start();
    try {
      const fs = await import('node:fs/promises');
      const nodeTools = JSON.parse(
        await fs.readFile(bridge.getToolsPathForServer('node-agent'), 'utf8')
      );
      const memoryTools = JSON.parse(
        await fs.readFile(bridge.getToolsPathForServer('agent-memory'), 'utf8')
      );

      expect(nodeTools.map((tool: { name: string }) => tool.name)).toEqual(['send_message']);
      expect(memoryTools.map((tool: { name: string }) => tool.name)).toEqual(['memory.write']);
    } finally {
      await bridge.close();
    }
  });

  test('collects tools from registered MCP callbacks', async () => {
    const callback = mock(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const mcpServers = {
      'space-agent-tools': {
        type: 'sdk',
        name: 'space-agent-tools',
        instance: {
          _registeredTools: {
            create_standalone_task: {
              description: 'Create a task',
              inputSchema: { title: z.string() },
              callback,
            },
          },
        },
      },
    } as never;
    const bridge = new AcpMcpProxyBridge(mcpServers);

    expect(bridge.getToolsForServer('space-agent-tools')).toEqual([
      expect.objectContaining({ name: 'create_standalone_task', description: 'Create a task' }),
    ]);
    await bridge.handleLineForTest(
      JSON.stringify({
        token: bridge.token,
        serverName: 'space-agent-tools',
        toolName: 'create_standalone_task',
        arguments: { title: 'Task' },
      })
    );
    expect(callback).toHaveBeenCalledWith({ title: 'Task' });
  });

  test('collects tools from production tools array fallback', () => {
    const mcpServers = {
      'space-agent-tools': {
        type: 'sdk',
        name: 'space-agent-tools',
        tools: [
          {
            name: 'create_standalone_task',
            description: 'Create a task',
            inputSchema: { title: z.string() },
            handler: mock(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
          },
        ],
        instance: { _registeredTools: {} },
      },
    } as never;
    const bridge = new AcpMcpProxyBridge(mcpServers);

    expect(bridge.getToolsForServer('space-agent-tools')).toEqual([
      expect.objectContaining({ name: 'create_standalone_task', description: 'Create a task' }),
    ]);
  });

  test('wraps raw SDK tool input shapes before schema conversion', () => {
    const mcpServers = {
      'space-agent-tools': {
        type: 'sdk',
        name: 'space-agent-tools',
        instance: {
          _registeredTools: {
            create_standalone_task: {
              description: 'Create a task',
              inputSchema: { title: z.string(), priority: z.enum(['low', 'normal']) },
              handler: mock(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
            },
          },
        },
      },
    } as never;
    const bridge = new AcpMcpProxyBridge(mcpServers);

    const [tool] = bridge.getToolsForServer('space-agent-tools');

    expect(tool.inputSchema).toEqual(
      expect.objectContaining({
        type: 'object',
        required: ['title', 'priority'],
        properties: expect.objectContaining({
          title: expect.objectContaining({ type: 'string' }),
          priority: expect.objectContaining({ enum: ['low', 'normal'] }),
        }),
      })
    );
  });

  test('runs ACP lifecycle with proxied Space MCP servers', async () => {
    const handler = mock(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const { runner, ctx, mockClient } = createRunnerFixture({
      queryOptions: {
        cwd: '/tmp/acp-session',
        mcpServers: {
          'space-agent-tools': {
            type: 'sdk',
            name: 'space-agent-tools',
            instance: {
              _registeredTools: {
                create_standalone_task: {
                  description: 'Create a task',
                  inputSchema: undefined,
                  handler,
                },
              },
            },
          },
        },
      },
    });

    await runner.start();
    await ctx.queryPromise;

    expect(mockClient.createSession.mock.calls[0][1]).toEqual([
      expect.objectContaining({
        type: 'stdio',
        name: 'space-agent-tools',
        command: process.execPath,
      }),
    ]);
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

  test('publishes query.trigger on normal turn completion to replay deferred rows', async () => {
    // The automatic deferred-row replay in SDKMessageHandler.finishTurn is
    // specific to the Claude SDK path; without an equivalent trigger on ACP
    // turn completion, a row persisted as 'deferred' while the ACP node was
    // processing (e.g. an external event in 'defer' mode) is never replayed.
    const { runner, ctx } = createRunnerFixture();
    const publishAsync = ctx.internalEventBus.publishAsync as unknown as ReturnType<typeof mock>;

    await runner.start();
    await ctx.queryPromise;

    expect(publishAsync).toHaveBeenCalledWith('query.trigger', { sessionId: 'session-1' });
  });

  test('does not publish query.trigger after a terminal turn failure', async () => {
    // The replay lives in run()'s finally; after handleRunError handles a
    // terminal failure (auth rejection, provider unavailable, exhausted
    // startup retries), replaying would promote deferred rows to enqueued
    // and immediately drive another turn that is likely to fail too. Deferred
    // rows must stay deferred and available for after recovery.
    const failingClient = createMockClient();
    failingClient.initialize = mock(async () => {
      throw new Error('authentication rejected');
    });
    const { runner, ctx } = createRunnerFixture({ client: failingClient });
    const publishAsync = ctx.internalEventBus.publishAsync as unknown as ReturnType<typeof mock>;

    await runner.start();
    await ctx.queryPromise;

    expect(publishAsync).not.toHaveBeenCalledWith('query.trigger', { sessionId: 'session-1' });
  });

  test('does not publish query.trigger in manual query mode', async () => {
    const { runner, ctx } = createRunnerFixture({
      session: { config: { queryMode: 'manual' } } as Partial<Session>,
    });
    const publishAsync = ctx.internalEventBus.publishAsync as unknown as ReturnType<typeof mock>;

    await runner.start();
    await ctx.queryPromise;

    expect(publishAsync).not.toHaveBeenCalledWith('query.trigger', { sessionId: 'session-1' });
  });

  test('does not publish query.trigger for an interrupted ACP run', async () => {
    // An interrupted ACP turn breaks out of the abortable loop and returns
    // NORMALLY (no catch) — so reaching the end of try is not proof of
    // success. The gate must classify by the live processing state:
    // replaying an interrupted run would restart deferred work the user or
    // teardown just stopped.
    const { runner, ctx } = createRunnerFixture();
    const publishAsync = ctx.internalEventBus.publishAsync as unknown as ReturnType<typeof mock>;
    (ctx.stateManager as unknown as { getState: () => { status: string } }).getState = () => ({
      status: 'interrupted',
    });

    await runner.start();
    await ctx.queryPromise;

    expect(publishAsync).not.toHaveBeenCalledWith('query.trigger', { sessionId: 'session-1' });
  });

  test('does not publish query.trigger when an interrupt starts during cleanup', async () => {
    // The success classification is snapshotted at try-end; an interrupt that
    // starts while the finally block awaits cleanup (proxyBridge.close())
    // must still suppress the replay — checked live at publish time, not
    // just from the stale snapshot.
    const { runner, ctx } = createRunnerFixture();
    const publishAsync = ctx.internalEventBus.publishAsync as unknown as ReturnType<typeof mock>;
    let status = 'processing';
    (ctx.stateManager as unknown as { getState: () => { status: string } }).getState = () => ({
      status,
    });
    // Simulate the interrupt landing mid-cleanup: the finally block stops the
    // message queue before publishing — flip the state there.
    (ctx.messageQueue as unknown as { stop: () => void }).stop = () => {
      status = 'interrupted';
    };

    await runner.start();
    await ctx.queryPromise;

    expect(publishAsync).not.toHaveBeenCalledWith('query.trigger', { sessionId: 'session-1' });
  });

  test('does not publish query.trigger when cleanup starts during the exit wait', async () => {
    // Between the turn-end snapshot and the process-exit resolution, teardown
    // can begin (isCleaningUp flips) — the fire-time recheck must suppress
    // the replay so no delivery jobs are inserted for a dying session.
    let signalProcessExit!: () => void;
    const processExitedPromise = new Promise<void>((resolve) => {
      signalProcessExit = resolve;
    });
    const { runner, ctx } = createRunnerFixture();
    const publishAsync = ctx.internalEventBus.publishAsync as unknown as ReturnType<typeof mock>;
    (ctx as unknown as { processExitedPromise: Promise<void> }).processExitedPromise =
      processExitedPromise;

    await runner.start();
    await ctx.queryPromise;
    (ctx as unknown as { isCleaningUp: () => boolean }).isCleaningUp = () => true;

    signalProcessExit();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(publishAsync).not.toHaveBeenCalledWith('query.trigger', { sessionId: 'session-1' });
  });

  test('does not publish query.trigger when a newer turn started during the exit wait', async () => {
    // Mirrors the interrupt replay path: the exit promise is the OLD child's
    // (up to ~5s under SIGTERM→SIGKILL); a newer turn starting in that window
    // must not have the old deferred rows steered into it — require idle.
    let signalProcessExit!: () => void;
    const processExitedPromise = new Promise<void>((resolve) => {
      signalProcessExit = resolve;
    });
    const { runner, ctx } = createRunnerFixture();
    const publishAsync = ctx.internalEventBus.publishAsync as unknown as ReturnType<typeof mock>;
    (ctx as unknown as { processExitedPromise: Promise<void> }).processExitedPromise =
      processExitedPromise;

    await runner.start();
    await ctx.queryPromise;
    // A newer turn starts while the old child is still exiting.
    (ctx.stateManager as unknown as { getState: () => { status: string } }).getState = () => ({
      status: 'processing',
    });

    signalProcessExit();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(publishAsync).not.toHaveBeenCalledWith('query.trigger', { sessionId: 'session-1' });
  });

  test('aborts ACP submission when remove/defer already revoked the row (#3744696846)', async () => {
    const client = createMockClient();
    let promptBodyRan = false;
    client.sendPrompt = mock(async function* (
      _prompt: unknown,
      callbacks?: { onSubmitted?: () => void; onAccepted?: () => void }
    ) {
      callbacks?.onSubmitted?.();
      promptBodyRan = true;
      yield {
        sessionId: 'acp-session-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'bad' } },
      };
    });
    const { runner, ctx, onSent } = createRunnerFixture({ client });
    (
      ctx.messageHandler as unknown as { markMessageSubmitted: ReturnType<typeof mock> }
    ).markMessageSubmitted = mock(() => false);

    await runner.start();
    await ctx.queryPromise;

    expect(onSent).not.toHaveBeenCalled();
    expect(promptBodyRan).toBe(false);
  });

  test('settles a submitted-but-never-accepted prompt as failed when the run ends (#3743968032)', async () => {
    const client = createMockClient();
    client.sendPrompt = mock(async function* (
      _prompt: unknown,
      callbacks?: { onSubmitted?: () => void; onAccepted?: () => void }
    ) {
      callbacks?.onSubmitted?.();
      // No onAccepted: the run ended (interrupt / adapter close) after the
      // stdin write completed but before any session/update or prompt
      // response arrived. The submitted row must not stay hidden+nonterminal.
      return;
    });
    const { runner, ctx } = createRunnerFixture({ client });

    await runner.start();
    await ctx.queryPromise;

    const handler = ctx.messageHandler as unknown as {
      markMessageSubmitted: ReturnType<typeof mock>;
      markMessageAccepted: ReturnType<typeof mock>;
      markACPDeliveryFailed: ReturnType<typeof mock>;
    };
    expect(handler.markMessageSubmitted).toHaveBeenCalledWith('user-message-1');
    expect(handler.markMessageAccepted).not.toHaveBeenCalled();
    expect(handler.markACPDeliveryFailed).toHaveBeenCalledWith('user-message-1');
  });

  test('preserves env-only Anthropic auth for ACP subprocesses', async () => {
    // Auth tokens are read live from process.env at ACP env build time so that
    // credential discovery (which runs after provider-service module load) still
    // flows into the ACP child env. Base URL / model overrides come from the
    // module-load startup snapshot in provider-service and are covered by the
    // clearProviderRoutingEnvVars tests there.
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oat-acp-token';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'acp-oauth-token';
    const { runner, ctx, constructorOptions } = createRunnerFixture();

    await runner.start();
    await ctx.queryPromise;

    expect(constructorOptions[0].env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-oat-acp-token');
    expect(constructorOptions[0].env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('acp-oauth-token');
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

  test('persists new ACP session ids', async () => {
    const { runner, ctx, mockClient } = createRunnerFixture();

    await runner.start();
    await ctx.queryPromise;

    expect(mockClient.createSession).toHaveBeenCalled();
    expect(ctx.session.acpSessionId).toBe('acp-session-1');
    expect(ctx.db.updateSession).toHaveBeenCalledWith('session-1', {
      acpSessionId: 'acp-session-1',
    });
  });

  test('loads an existing ACP session instead of creating a new one', async () => {
    const client = createMockClient();
    client.canLoadSession.mockImplementation(() => true);
    client.loadSession.mockImplementation(async (sessionId: string) => ({
      sessionId,
      configOptions: [],
    }));
    const { runner, ctx } = createRunnerFixture({
      client,
      session: {
        acpSessionId: 'persisted-acp-session',
        metadata: { messageCount: 2 },
      } as Partial<Session>,
      queryOptions: {
        cwd: '/tmp/acp-session',
        mcpServers: {},
        systemPrompt: { type: 'preset', preset: 'none', append: 'Do not duplicate me' },
      },
    });

    await runner.start();
    await ctx.queryPromise;

    expect(client.loadSession).toHaveBeenCalledWith(
      'persisted-acp-session',
      '/tmp/acp-session',
      []
    );
    expect(client.resumeSession).not.toHaveBeenCalled();
    expect(client.createSession).not.toHaveBeenCalled();
    expect(ctx.db.updateSession).not.toHaveBeenCalledWith('session-1', {
      acpSessionId: expect.any(String),
    });
    expect(client.sendPrompt.mock.calls[0][0]).toEqual([{ type: 'text', text: 'hello' }]);
  });

  test('falls back to resume when ACP session load fails', async () => {
    const client = createMockClient();
    client.canLoadSession.mockImplementation(() => true);
    client.loadSession.mockImplementation(async () => {
      throw new Error('load unavailable');
    });
    client.resumeSession.mockImplementation(async () => ({
      sessionId: 'resumed-acp-session',
      configOptions: [],
    }));
    const { runner, ctx } = createRunnerFixture({
      client,
      session: { acpSessionId: 'persisted-acp-session' } as Partial<Session>,
    });

    await runner.start();
    await ctx.queryPromise;

    expect(client.loadSession).toHaveBeenCalledWith(
      'persisted-acp-session',
      '/tmp/acp-session',
      []
    );
    expect(client.resumeSession).toHaveBeenCalledWith(
      'persisted-acp-session',
      '/tmp/acp-session',
      []
    );
    expect(client.createSession).not.toHaveBeenCalled();
    expect(ctx.session.acpSessionId).toBe('resumed-acp-session');
    expect(ctx.db.updateSession).toHaveBeenCalledWith('session-1', {
      acpSessionId: 'resumed-acp-session',
    });
  });

  test('blocks existing ACP sessions when the agent cannot resume them', async () => {
    const client = createMockClient();
    const { runner, ctx } = createRunnerFixture({
      client,
      session: { acpSessionId: 'persisted-acp-session' } as Partial<Session>,
    });

    await runner.start();
    await ctx.queryPromise;

    expect(client.createSession).not.toHaveBeenCalled();
    expect(client.sendPrompt).not.toHaveBeenCalled();
    expect(ctx.errorManager.handleError).toHaveBeenCalledWith(
      'session-1',
      expect.any(Error),
      'system',
      undefined,
      expect.any(Object),
      expect.objectContaining({ providerId: 'acp' })
    );
  });

  test('prepends HyperNeo session instructions to first ACP prompt', async () => {
    const { runner, ctx, mockClient } = createRunnerFixture({
      queryOptions: {
        cwd: '/tmp/acp-session',
        mcpServers: {},
        systemPrompt: { type: 'preset', preset: 'none', append: 'Follow Space workflow rules.' },
        agent: 'reviewer',
        agents: {
          reviewer: {
            prompt: 'Review code carefully.',
            description: 'Find correctness issues.',
          },
        },
      },
    });

    await runner.start();
    await ctx.queryPromise;

    expect(mockClient.sendPrompt.mock.calls[0][0]).toEqual([
      {
        type: 'text',
        text:
          'HyperNeo session instructions:\n\n' +
          'Follow Space workflow rules.\n\n' +
          'Review code carefully.\n\n' +
          'Agent: reviewer\nFind correctness issues.',
      },
      { type: 'text', text: 'hello' },
    ]);
    expect(ctx.db.updateSession).toHaveBeenCalledWith('session-1', {
      metadata: expect.objectContaining({ acpInstructionsSent: true }),
    });
  });

  test('preserves first-turn instructions after idle ACP resume', async () => {
    const client = createMockClient();
    client.canLoadSession.mockImplementation(() => true);
    const { runner, ctx } = createRunnerFixture({
      client,
      session: { acpSessionId: 'idle-acp-session' } as Partial<Session>,
      queryOptions: {
        cwd: '/tmp/acp-session',
        mcpServers: {},
        systemPrompt: { type: 'preset', preset: 'none', append: 'Follow Space workflow rules.' },
      },
    });

    await runner.start();
    await ctx.queryPromise;

    expect(client.loadSession).toHaveBeenCalledWith('idle-acp-session', '/tmp/acp-session', []);
    expect(client.sendPrompt.mock.calls[0][0]).toEqual([
      {
        type: 'text',
        text: 'HyperNeo session instructions:\n\nFollow Space workflow rules.',
      },
      { type: 'text', text: 'hello' },
    ]);
    expect(ctx.db.updateSession).toHaveBeenCalledWith('session-1', {
      metadata: expect.objectContaining({ acpInstructionsSent: true }),
    });
  });

  test('does not start ACP startup timeout while waiting for a queued prompt', async () => {
    const client = createMockClient();
    let releaseMessage: (() => void) | undefined;
    const { runner, ctx } = createRunnerFixture({
      client,
      messageGenerator: async function* () {
        await new Promise<void>((resolve) => {
          releaseMessage = resolve;
        });
        yield { message: makeUserMessage('hello'), onSent: mock(() => {}) };
      },
    });

    const restoreStartupRetryEnv = pinStartupRetryEnv();
    try {
      await runner.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(ctx.startupTimeoutTimer).toBeNull();
      expect(ctx.errorManager.handleError).not.toHaveBeenCalled();

      releaseMessage?.();
      await ctx.queryPromise;

      expect(client.sendPrompt).toHaveBeenCalled();
    } finally {
      restoreStartupRetryEnv();
    }
  }, 1000);

  test('retries ACP handshake timeout when turn is queued during startup', async () => {
    const firstClient = createMockClient();
    let enqueueDuringStartup: ((messageId: string, queuedAt: number) => void) | undefined;
    let releaseInitialize: (() => void) | undefined;
    firstClient.close.mockImplementation(() => releaseInitialize?.());
    firstClient.initialize.mockImplementation(async () => {
      enqueueDuringStartup?.('user-message-1', Date.now());
      await new Promise<void>((resolve) => {
        releaseInitialize = resolve;
      });
      throw new Error('closed before initialize');
    });
    const secondClient = createMockClient();
    const clients = [firstClient, secondClient];
    const { ctx, messageQueue } = createRunnerFixture({ client: firstClient, queueSize: 0 });
    const previousOnMessageEnqueued = mock(() => {});
    messageQueue.onMessageEnqueued = previousOnMessageEnqueued;
    enqueueDuringStartup = (messageId, queuedAt) => {
      messageQueue.onMessageEnqueued?.(messageId, queuedAt);
    };
    const runner = new AcpQueryRunner(ctx, () => clients.shift() as unknown as AcpClient);

    const restoreStartupRetryEnv = pinStartupRetryEnv();
    try {
      await runner.start();
      await ctx.queryPromise;

      expect(previousOnMessageEnqueued).toHaveBeenCalledWith('user-message-1', expect.any(Number));
      expect(firstClient.close).toHaveBeenCalled();
      expect(secondClient.sendPrompt).toHaveBeenCalled();
      expect(messageQueue.onMessageEnqueued).toBe(previousOnMessageEnqueued);
    } finally {
      restoreStartupRetryEnv();
    }
  }, 1000);

  test('retries ACP handshake timeout while a queued turn is waiting', async () => {
    const firstClient = createMockClient();
    let releaseInitialize: (() => void) | undefined;
    firstClient.close.mockImplementation(() => releaseInitialize?.());
    firstClient.initialize.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseInitialize = resolve;
      });
      throw new Error('closed before initialize');
    });
    const secondClient = createMockClient();
    const clients = [firstClient, secondClient];
    const { ctx } = createRunnerFixture({ client: firstClient, queueSize: 1 });
    const runner = new AcpQueryRunner(ctx, () => clients.shift() as unknown as AcpClient);

    const restoreStartupRetryEnv = pinStartupRetryEnv();
    try {
      await runner.start();
      await ctx.queryPromise;

      expect(firstClient.close).toHaveBeenCalled();
      expect(secondClient.sendPrompt).toHaveBeenCalled();
    } finally {
      restoreStartupRetryEnv();
    }
  }, 1000);

  test('resets ACP startup timeout tracking for each prompt', async () => {
    const firstClient = createMockClient();
    let releaseSecondPrompt: (() => void) | undefined;
    firstClient.close.mockImplementation(() => releaseSecondPrompt?.());
    firstClient.sendPrompt.mockImplementation(async function* () {
      if (firstClient.sendPrompt.mock.calls.length === 1) {
        yield {
          sessionId: 'acp-session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'first response' },
          },
        };
        return;
      }

      await new Promise<void>((resolve) => {
        releaseSecondPrompt = resolve;
      });
    });
    const secondClient = createMockClient();
    secondClient.canLoadSession.mockImplementation(() => true);
    const clients = [firstClient, secondClient];
    const { ctx, messageQueue } = createRunnerFixture({
      client: firstClient,
      messages: [makeUserMessage('first'), makeUserMessage('second')],
    });
    const runner = new AcpQueryRunner(ctx, () => clients.shift() as unknown as AcpClient);

    const restoreStartupRetryEnv = pinStartupRetryEnv();
    try {
      await runner.start();
      await ctx.queryPromise;

      expect(firstClient.close).toHaveBeenCalled();
      expect(messageQueue.enqueueWithId).toHaveBeenCalledWith('user-message-1', [
        { type: 'text', text: 'second' },
      ]);
      expect(secondClient.sendPrompt).toHaveBeenCalled();
      expect(ctx.db.updateSession).not.toHaveBeenCalledWith('session-1', {
        acpSessionId: undefined,
      });
    } finally {
      restoreStartupRetryEnv();
    }
  }, 1000);

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
    secondClient.canLoadSession.mockImplementation(() => true);
    const clients = [firstClient, secondClient];
    const { runner, ctx, messageQueue } = createRunnerFixture({ client: firstClient });
    const constructorOptions: AcpClientOptions[] = [];
    const createClient = mock((options: AcpClientOptions) => {
      constructorOptions.push(options);
      return clients.shift() as unknown as AcpClient;
    });
    const retryRunner = new AcpQueryRunner(ctx, createClient);

    const restoreStartupRetryEnv = pinStartupRetryEnv();
    try {
      await retryRunner.start();
      await ctx.queryPromise;

      expect(createClient).toHaveBeenCalledTimes(2);
      expect(firstClient.close).toHaveBeenCalled();
      expect(messageQueue.enqueueWithId).toHaveBeenCalledWith('user-message-1', [
        { type: 'text', text: 'hello' },
      ]);
      expect(secondClient.sendPrompt).toHaveBeenCalled();
    } finally {
      restoreStartupRetryEnv();
    }
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

  test('proxies ACP Space turns when required in-process MCP servers are present', async () => {
    const { runner, ctx } = createRunnerFixture({
      session: {
        type: 'space_chat',
        context: { spaceId: 'space-1' },
      } as Partial<Session>,
      queryOptions: {
        cwd: '/tmp/acp-session',
        mcpServers: {
          'space-agent-tools': {
            type: 'sdk',
            instance: {
              _registeredTools: {
                create_standalone_task: {
                  description: 'Create a task',
                  inputSchema: undefined,
                  handler: mock(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
                },
              },
            },
          },
        },
      },
    });

    await runner.start();
    await ctx.queryPromise;

    expect(ctx.errorManager.handleError).not.toHaveBeenCalled();
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

  test('does not start terminal fence when ACP rate-limit cooldown is scheduled', async () => {
    const client = createMockClient();
    client.initialize.mockRejectedValue(new Error('429 Too Many Requests'));
    const { ctx } = createRunnerFixture({ client });
    ctx.onRateLimitExhausted = mock(async () => true);
    const runner = new AcpQueryRunner(ctx, () => client as unknown as AcpClient);

    await runner.start();
    await ctx.queryPromise;

    expect(ctx.onRateLimitExhausted).toHaveBeenCalledTimes(1);
    expect(ctx.stateManager.beginTerminalIdle).not.toHaveBeenCalled();
    expect(ctx.errorManager.handleError).not.toHaveBeenCalled();
    expect(ctx.stateManager.setIdle).not.toHaveBeenCalled();
  });

  test('preserves ACP cooldown state through a recursive retry', async () => {
    const firstClient = createMockClient();
    firstClient.initialize.mockRejectedValue(new Error('TypeError: fetch failed'));
    const secondClient = createMockClient();
    secondClient.initialize.mockRejectedValue(new Error('429 Too Many Requests'));
    const clients = [firstClient, secondClient];
    const { ctx } = createRunnerFixture({ client: firstClient });
    ctx.onRateLimitExhausted = mock(async () => true);
    const runner = new AcpQueryRunner(ctx, () => clients.shift() as unknown as AcpClient);

    await runner.start();
    await ctx.queryPromise;

    expect(ctx.onRateLimitExhausted).toHaveBeenCalledTimes(1);
    expect(ctx.stateManager.beginTerminalIdle).not.toHaveBeenCalled();
    expect(ctx.stateManager.setIdle.mock.calls).toEqual([[{ suppressDeliveryWaiters: true }]]);
  });

  test('starts terminal fence before awaiting ACP error publication', async () => {
    const client = createMockClient();
    client.initialize.mockRejectedValue(new Error('401 Unauthorized'));
    const { ctx } = createRunnerFixture({ client });
    let resolveError!: () => void;
    ctx.errorManager.handleError = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveError = resolve;
        })
    );
    const runner = new AcpQueryRunner(ctx, () => client as unknown as AcpClient);

    await runner.start();
    for (
      let attempt = 0;
      attempt < 20 && ctx.errorManager.handleError.mock.calls.length === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(ctx.stateManager.beginTerminalIdle).toHaveBeenCalledTimes(1);
    expect(ctx.stateManager.setIdle).not.toHaveBeenCalled();
    resolveError();
    await ctx.queryPromise;
    expect(ctx.stateManager.setIdle).toHaveBeenCalled();
  });

  test('surfaces provider auth failure without spawning ACP client', async () => {
    delete process.env.HYPERNEO_ACP_COMMAND;
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

describe('AcpQueryRunner startup-timeout bounded retry', () => {
  let originalAcpCommand: string | undefined;

  beforeEach(() => {
    originalAcpCommand = process.env.HYPERNEO_ACP_COMMAND;
    process.env.HYPERNEO_ACP_COMMAND = 'mock-acp --stdio';
    resetProviderRegistry();
    resetProviderFactory();
  });

  afterEach(() => {
    if (originalAcpCommand === undefined) delete process.env.HYPERNEO_ACP_COMMAND;
    else process.env.HYPERNEO_ACP_COMMAND = originalAcpCommand;
    resetProviderRegistry();
    resetProviderFactory();
  });

  test('backs off exponentially and settles failed past the cap', async () => {
    const restoreStartupRetryEnv = pinStartupRetryEnv({ base: '25', max: '2' });
    try {
      const clients = [createHangingClient(), createHangingClient(), createHangingClient()];
      const { ctx, sdkRepo } = createRunnerFixture({ client: clients[0] });
      const createClient = mock(() => clients.shift() as unknown as AcpClient);
      const runner = new AcpQueryRunner(ctx, createClient);

      await runner.start();
      await ctx.queryPromise;

      // The scheduled delays are pinned by the warn lines (1 → base, 2 → 2×base).
      const lines = warnLines(ctx);
      expect(
        lines.some((line) =>
          line.includes('Auto-retrying ACP query after startup timeout (retry 1/2 in 25ms)')
        )
      ).toBe(true);
      expect(lines.some((line) => line.includes('(retry 2/2 in 50ms)'))).toBe(true);
      // Third timeout: budget exhausted → terminal settle, no fourth client.
      expect(lines.some((line) => line.includes('Startup-timeout retry budget exhausted'))).toBe(
        true
      );
      expect(createClient).toHaveBeenCalledTimes(3);
      expect(ctx.errorManager.handleError).toHaveBeenCalledWith(
        'session-1',
        expect.any(Error),
        'timeout',
        expect.stringContaining('ACP agent failed to start'),
        expect.any(Object),
        expect.objectContaining({ providerId: 'acp' })
      );
      // Each retry reopens the fail-ambiguous row so the retried prompt can
      // resubmit under the same uuid (markMessageSubmitted requires an
      // 'enqueued' row).
      expect(sdkRepo.reopenDeliveryByUuid).toHaveBeenCalledWith('session-1', 'user-message-1');
      expect(sdkRepo.reopenDeliveryByUuid).toHaveBeenCalledTimes(2);
    } finally {
      restoreStartupRetryEnv();
    }
  }, 1000);

  test('cancels the retry when a COMPLETED Stop lands during the backoff', async () => {
    const restoreStartupRetryEnv = pinStartupRetryEnv({ base: '60' });
    try {
      const clients = [createHangingClient(), createMockClient()];
      const { ctx, messageQueue } = createRunnerFixture({ client: clients[0] });
      const createClient = mock(() => clients.shift() as unknown as AcpClient);
      const runner = new AcpQueryRunner(ctx, createClient);

      await runner.start();
      expect(await waitForWarn(ctx, 'Auto-retrying ACP query')).toBe(true);

      // A completed Stop: handleInterrupt nulls the controller without
      // touching the generation or queryPromise, and returns the session to
      // idle — none of which the generation/status checks observe. Only the
      // controller-null disjunct catches it.
      ctx.queryAbortController = null;
      await ctx.queryPromise;

      expect(createClient).toHaveBeenCalledTimes(1);
      expect(warnLines(ctx).some((line) => line.includes('Startup-timeout retry cancelled'))).toBe(
        true
      );
      expect(messageQueue.enqueueWithId).not.toHaveBeenCalled();
    } finally {
      restoreStartupRetryEnv();
    }
  }, 1000);

  test('cancels the retry when a lifecycle stop nulls queryPromise during the backoff', async () => {
    const restoreStartupRetryEnv = pinStartupRetryEnv({ base: '60' });
    try {
      const clients = [createHangingClient(), createMockClient()];
      const { ctx } = createRunnerFixture({ client: clients[0] });
      const createClient = mock(() => clients.shift() as unknown as AcpClient);
      const runner = new AcpQueryRunner(ctx, createClient);

      await runner.start();
      const chain = ctx.queryPromise;
      expect(await waitForWarn(ctx, 'Auto-retrying ACP query')).toBe(true);

      // The stall-watchdog reset / lifecycle stop nulls queryPromise without
      // bumping the generation.
      ctx.queryPromise = null;
      await chain;

      expect(createClient).toHaveBeenCalledTimes(1);
      expect(warnLines(ctx).some((line) => line.includes('Startup-timeout retry cancelled'))).toBe(
        true
      );
    } finally {
      restoreStartupRetryEnv();
    }
  }, 1000);

  test('cancels the retry when a replacement query bumps the generation during the backoff', async () => {
    const restoreStartupRetryEnv = pinStartupRetryEnv({ base: '60' });
    try {
      const clients = [createHangingClient(), createMockClient()];
      const { ctx } = createRunnerFixture({ client: clients[0] });
      const createClient = mock(() => clients.shift() as unknown as AcpClient);
      const runner = new AcpQueryRunner(ctx, createClient);

      await runner.start();
      expect(await waitForWarn(ctx, 'Auto-retrying ACP query')).toBe(true);

      ctx.incrementQueryGeneration();
      await ctx.queryPromise;

      expect(createClient).toHaveBeenCalledTimes(1);
      expect(warnLines(ctx).some((line) => line.includes('Startup-timeout retry cancelled'))).toBe(
        true
      );
    } finally {
      restoreStartupRetryEnv();
    }
  }, 1000);

  test('cancels the retry when the session enters cleanup during the backoff', async () => {
    const restoreStartupRetryEnv = pinStartupRetryEnv({ base: '60' });
    try {
      const clients = [createHangingClient(), createMockClient()];
      const { ctx } = createRunnerFixture({ client: clients[0] });
      const createClient = mock(() => clients.shift() as unknown as AcpClient);
      const runner = new AcpQueryRunner(ctx, createClient);

      await runner.start();
      expect(await waitForWarn(ctx, 'Auto-retrying ACP query')).toBe(true);

      ctx.isCleaningUp = () => true;
      await ctx.queryPromise;

      expect(createClient).toHaveBeenCalledTimes(1);
      expect(warnLines(ctx).some((line) => line.includes('Startup-timeout retry cancelled'))).toBe(
        true
      );
    } finally {
      restoreStartupRetryEnv();
    }
  }, 1000);

  test('cancels the retry when the delivery row settles failed during the backoff', async () => {
    const restoreStartupRetryEnv = pinStartupRetryEnv({ base: '60' });
    try {
      const clients = [createHangingClient(), createMockClient()];
      const { ctx } = createRunnerFixture({ client: clients[0] });
      const createClient = mock(() => clients.shift() as unknown as AcpClient);
      const runner = new AcpQueryRunner(ctx, createClient);

      await runner.start();
      expect(await waitForWarn(ctx, 'Auto-retrying ACP query')).toBe(true);

      // The retry branch reopened the row to 'enqueued'; the delivery layer's
      // consumption timeout / dead-letter re-fails it during the window.
      ctx.db.getMessageByStatusAndUuid = mock(() => ({ dbId: 'settled-row' }));
      await ctx.queryPromise;

      expect(createClient).toHaveBeenCalledTimes(1);
      const lines = warnLines(ctx);
      expect(
        lines.some((line) => line.includes('delivery already settled failed during backoff'))
      ).toBe(true);
      expect(lines.some((line) => line.includes('(message user-message-1)'))).toBe(true);
    } finally {
      restoreStartupRetryEnv();
    }
  }, 1000);

  test('keeps charging the same delivery across a fresh start() (in-process redrive)', async () => {
    const restoreStartupRetryEnv = pinStartupRetryEnv({ base: '0', max: '1' });
    try {
      // Resumable clients: chain 1's terminal attempt leaves the created
      // acpSessionId behind (the reset only runs on retry-granted paths), so
      // chain 2 must be able to load it like a real ACP agent would.
      const hanging = () => {
        const client = createHangingClient();
        client.canLoadSession.mockImplementation(() => true);
        return client;
      };
      const clients: Array<ReturnType<typeof createMockClient>> = [hanging(), hanging(), hanging()];
      const { ctx } = createRunnerFixture({ client: clients[0] });
      const createClient = mock(() => clients.shift() as unknown as AcpClient);
      const runner = new AcpQueryRunner(ctx, createClient);

      // Chain 1: timeout → retry 1/1 → timeout → budget exhausted → terminal.
      await runner.start();
      await ctx.queryPromise;
      expect(createClient).toHaveBeenCalledTimes(2);
      expect(ctx.errorManager.handleError).toHaveBeenCalledTimes(1);

      // A delivery-layer redrive of the SAME message starts a fresh chain
      // (new generation, isRetry=false). The instance-level budget must keep
      // counting — otherwise every redrive resets to zero and the herd loop
      // this cap closes becomes unbounded again.
      clients.push(hanging());
      await runner.start();
      await ctx.queryPromise;

      expect(createClient).toHaveBeenCalledTimes(3);
      expect(ctx.errorManager.handleError).toHaveBeenCalledTimes(2);
      expect(
        warnLines(ctx).filter((line) => line.includes('Startup-timeout retry budget exhausted'))
          .length
      ).toBe(2);
    } finally {
      restoreStartupRetryEnv();
    }
  }, 1000);

  test('skips the replay feed when a redrive re-admitted the message during the backoff', async () => {
    const restoreStartupRetryEnv = pinStartupRetryEnv({ base: '60' });
    try {
      const clients = [createHangingClient(), createMockClient()];
      const { ctx, messageQueue } = createRunnerFixture({ client: clients[0] });
      const createClient = mock(() => clients.shift() as unknown as AcpClient);
      const runner = new AcpQueryRunner(ctx, createClient);

      await runner.start();
      expect(await waitForWarn(ctx, 'Auto-retrying ACP query')).toBe(true);

      // The retry branch reopened the durable row ('enqueued' = re-drivable),
      // and the delivery layer redrove it into the queue while we slept.
      (messageQueue.hasPendingOrInFlight as unknown as ReturnType<typeof mock>).mockImplementation(
        (id: string) => id === 'user-message-1'
      );
      await ctx.queryPromise;

      // The retry still ran (the generator consumes the redrive's admission)
      // but our own re-enqueue was suppressed — feeding it too would hand the
      // ACP agent the same prompt twice.
      expect(createClient).toHaveBeenCalledTimes(2);
      expect(messageQueue.enqueueWithId).not.toHaveBeenCalled();
      expect(
        warnLines(ctx).some((line) =>
          line.includes(
            'Startup replay skip: message user-message-1 is already pending or in-flight'
          )
        )
      ).toBe(true);
    } finally {
      restoreStartupRetryEnv();
    }
  }, 1000);

  test('stays processing during the backoff — no idle blip, replay re-enqueued after', async () => {
    const restoreStartupRetryEnv = pinStartupRetryEnv({ base: '40' });
    try {
      const clients = [createHangingClient(), createMockClient()];
      const { ctx, messageQueue } = createRunnerFixture({ client: clients[0] });
      const createClient = mock(() => clients.shift() as unknown as AcpClient);
      const runner = new AcpQueryRunner(ctx, createClient);

      await runner.start();
      expect(await waitForWarn(ctx, 'Auto-retrying ACP query')).toBe(true);

      // Mid-window: the session must never have published idle (an idle blip
      // makes handleInterrupt early-return, silently dropping a Stop).
      expect(ctx.stateManager.setIdle).not.toHaveBeenCalled();
      expect(messageQueue.enqueueWithId).not.toHaveBeenCalled();

      await ctx.queryPromise;

      // The retry ran and completed; every idle publication came from the
      // chain's own completion (no suppressDeliveryWaiters blip).
      expect(createClient).toHaveBeenCalledTimes(2);
      expect(messageQueue.enqueueWithId).toHaveBeenCalledWith('user-message-1', [
        { type: 'text', text: 'hello' },
      ]);
      expect(ctx.stateManager.setIdle).not.toHaveBeenCalledWith({
        suppressDeliveryWaiters: true,
      });
    } finally {
      restoreStartupRetryEnv();
    }
  }, 1000);

  test('stops the queue through the backoff window so mid-backoff steers park', async () => {
    // feedDeliverySteer (agent-session.ts) parks a follow-up only when the
    // 'processing' session's queue is STOPPED; a running queue makes it admit,
    // and the admitted steer would run BEFORE the replayed kickoff it answers
    // (or TTL-reject toward dead-letter). The timeout throw skips the
    // post-loop stop, so the retry branch itself must stop the queue before
    // its first await and restart it after the sleep to feed the replay.
    const restoreStartupRetryEnv = pinStartupRetryEnv({ base: '60' });
    try {
      const clients = [createHangingClient(), createMockClient()];
      const { ctx, messageQueue } = createRunnerFixture({ client: clients[0] });
      const createClient = mock(() => clients.shift() as unknown as AcpClient);
      const runner = new AcpQueryRunner(ctx, createClient);
      // Track running state so the assertions exercise the exact gate
      // feedDeliverySteer keys on — not the fixture's static isRunning=false.
      let running = false;
      const startCalls = mock(() => {
        running = true;
      });
      const stopCalls = mock(() => {
        running = false;
      });
      messageQueue.start = startCalls;
      messageQueue.stop = stopCalls;

      await runner.start();
      expect(await waitForWarn(ctx, 'Auto-retrying ACP query')).toBe(true);

      // Mid-window: the queue must be stopped (the steer-park gate input).
      expect(running).toBe(false);
      expect(stopCalls).toHaveBeenCalledTimes(1);

      await ctx.queryPromise;

      // At wake the restart block ran (start ×2: initial + post-sleep restart)
      // and the replay fed the retry. Four stops, each load-bearing: ours
      // mid-branch (the steer-park window), the retry attempt's post-loop
      // stop, and the retry's + the first attempt's finally cleanups.
      expect(createClient).toHaveBeenCalledTimes(2);
      expect(startCalls).toHaveBeenCalledTimes(2);
      expect(stopCalls).toHaveBeenCalledTimes(4);
      expect(messageQueue.enqueueWithId).toHaveBeenCalledWith('user-message-1', [
        { type: 'text', text: 'hello' },
      ]);
      expect(running).toBe(false);
    } finally {
      restoreStartupRetryEnv();
    }
  }, 1000);
});
