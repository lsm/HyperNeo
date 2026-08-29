import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  AcpConfigOption,
  MessageContent,
  MessageHub,
  ModelInfo,
  Session,
} from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import type { Database } from '../../../../src/storage/database';
import type { ErrorManager } from '../../../../src/lib/error-manager';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { Logger } from '../../../../src/lib/logger';
import type { QueryOptionsBuilder } from '../../../../src/lib/agent/query-options-builder';
import type { AskUserQuestionHandler } from '../../../../src/lib/agent/ask-user-question-handler';
import type { QueryRunnerContext } from '../../../../src/lib/agent/query-runner';
import { QueryAttemptRegistry } from '../../../../src/lib/agent/query-attempt-token';
import type { AcpClient, AcpClientOptions } from '../../../../src/lib/acp/acp-client';
import { AcpQueryAdapter } from '../../../../src/lib/acp/acp-query-adapter';
import { getAcpCommandIdentityDigest } from '../../../../src/lib/acp/acp-command';
import {
  AcpQueryRunner,
  convertMcpServersForAcp,
  parseAcpCommand,
} from '../../../../src/lib/acp/acp-query-runner';
import { AcpMcpProxyBridge } from '../../../../src/lib/acp/mcp-proxy-bridge';
import { readFileWithinWorkspace } from '../../../../src/lib/acp/acp-safe-fs';
import {
  clearModelsCache,
  getAvailableModels,
  getModelsCache,
  setModelsCache,
} from '../../../../src/lib/model-service';
import { resetProviderFactory } from '../../../../src/lib/providers/factory';
import { getProviderRegistry, resetProviderRegistry } from '../../../../src/lib/providers/registry';
import { AcpProvider } from '../../../../src/lib/providers/acp-provider';
import { providerEnvCoordinator } from '../../../../src/lib/providers/provider-env-enrollment';

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
    canCloseSession: mock(() => false),
    closeSession: mock(async () => {}),
    getSessionId: mock(() => 'acp-session-1'),
    getLastPromptStopReason: mock(() => 'end_turn'),
    getConfigOptions: mock(() => []),
    updateConfigOptions: mock(() => {}),
    setConfigOption: mock(async () => []),
    close: mock(() => {}),
    cancel: mock(() => {}),
  };
}

async function safeFsBackendAvailable(): Promise<boolean> {
  try {
    const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-probe-'));
    try {
      await writeFile(join(root, 'probe.txt'), 'x');
      await readFileWithinWorkspace(root, ['probe.txt'], { maxBytes: 8 });
      return true;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } catch {
    return false;
  }
}

function createHeldPromptClient() {
  let markPromptStarted: (() => void) | undefined;
  let releasePrompt: (() => void) | undefined;
  const promptStarted = new Promise<void>((resolve) => {
    markPromptStarted = resolve;
  });
  const client = createMockClient();
  client.sendPrompt = mock(async function* (
    _prompt: unknown,
    callbacks?: { onSubmitted?: () => void; onAccepted?: () => void }
  ) {
    callbacks?.onSubmitted?.();
    callbacks?.onAccepted?.();
    markPromptStarted?.();
    await new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
  });
  return { client, promptStarted, releasePrompt: () => releasePrompt?.() };
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
    enqueueWithId: mock(async () => {}),
    requeueYielded: mock(() => true),
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

  const ctx: QueryRunnerContext = {
    session,
    db: {
      saveSDKMessage: mock(() => {}),
      updateSession: mock(() => {}),
      getNodeExecutionRepo: mock(() => ({
        getByAgentSessionId: mock(() => null),
        getById: mock(() => null),
      })),
      getSpaceTaskRepo: mock(() => ({ getTask: mock(() => null) })),
    } as unknown as Database,
    messageHub: { event: mock(() => {}) } as unknown as MessageHub,
    internalEventBus: { publishAsync: mock(async () => {}) },
    messageQueue,
    stateManager: {
      getState: mock(() => ({ status: 'idle' })),
      setProcessing: mock(async () => {}),
      beginTerminalIdle: mock(() => {}),
      cancelTerminalIdleArm: mock(() => {}),
      idleOwnerForQuery: mock((queryGeneration: number) => ({ queryGeneration, turnToken: 0 })),
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
    attemptTokens: new QueryAttemptRegistry(),
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

  test('parses ACP commands with shared parser semantics', () => {
    expect(parseAcpCommand('"C:\\Program Files\\agent.exe" --value ""')).toEqual({
      command: 'C:\\Program Files\\agent.exe',
      args: ['--value', ''],
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
    expect(onMarkApiSuccess.mock.calls.some(([, gen]) => gen === 1)).toBe(true);
    expect(stopSpy).toHaveBeenCalled();
  });

  test('stamps ACP results with the submitted prompt uuid so clear correlation works', async () => {
    const { runner, ctx, onSDKMessage } = createRunnerFixture();

    await runner.start();
    await ctx.queryPromise;

    const result = onSDKMessage.mock.calls.find(([message]) => message.type === 'result')?.[0] as
      | (SDKMessage & { user_message_uuid?: string })
      | undefined;
    expect(result).toBeDefined();
    expect(result?.user_message_uuid).toBe('user-message-1');
  });

  test('publishes query.trigger on normal turn completion to replay deferred rows', async () => {
    const { runner, ctx } = createRunnerFixture();
    const publishAsync = ctx.internalEventBus.publishAsync as unknown as ReturnType<typeof mock>;

    await runner.start();
    await ctx.queryPromise;

    expect(publishAsync).toHaveBeenCalledWith('query.trigger', { sessionId: 'session-1' });
  });

  test('requeues the yielded prompt instead of stranding it when limit recovery engages', async () => {
    const requeueYielded = mock(() => true);
    const { runner, ctx, messageQueue, mockClient } = createRunnerFixture();
    (messageQueue as unknown as { requeueYielded: unknown }).requeueYielded = requeueYielded;
    ctx.isLimitRecoveryPending = async () => true;

    await runner.start();
    await ctx.queryPromise;

    expect(mockClient.sendPrompt).not.toHaveBeenCalled();
    expect(requeueYielded).toHaveBeenCalledWith('user-message-1');
  });

  test('does not publish query.trigger after a terminal turn failure', async () => {
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
    const { runner, ctx } = createRunnerFixture();
    const publishAsync = ctx.internalEventBus.publishAsync as unknown as ReturnType<typeof mock>;
    let status = 'processing';
    (ctx.stateManager as unknown as { getState: () => { status: string } }).getState = () => ({
      status,
    });
    (ctx.messageQueue as unknown as { stop: () => void }).stop = () => {
      status = 'interrupted';
    };

    await runner.start();
    await ctx.queryPromise;

    expect(publishAsync).not.toHaveBeenCalledWith('query.trigger', { sessionId: 'session-1' });
  });

  test('does not publish query.trigger when cleanup starts during the exit wait', async () => {
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
    (ctx.stateManager as unknown as { getState: () => { status: string } }).getState = () => ({
      status: 'processing',
    });

    signalProcessExit();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(publishAsync).not.toHaveBeenCalledWith('query.trigger', { sessionId: 'session-1' });
  });

  test('does not publish query.trigger when a replacement advanced the generation during the exit wait', async () => {
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
    (ctx.stateManager as unknown as { getState: () => { status: string } }).getState = () => ({
      status: 'idle',
    });
    ctx.incrementQueryGeneration();

    signalProcessExit();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(publishAsync).not.toHaveBeenCalledWith('query.trigger', { sessionId: 'session-1' });
  });

  test('hands off cleanly when a successor starts during the finalizer idle', async () => {
    const { runner, ctx } = createRunnerFixture();
    (ctx.stateManager as unknown as { setIdle: () => Promise<void> }).setIdle = mock(async () => {
      ctx.incrementQueryGeneration();
    });

    await runner.start();
    await ctx.queryPromise;

    expect(ctx.queryPromise).not.toBeNull();
    expect(
      (runner as unknown as { _lastConsumedUserMessage: { uuid: string } | null })
        ._lastConsumedUserMessage
    ).toBeNull();
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

  describe('attempt-token fencing [B5g]', () => {
    test('enqueue during a stale handshake must not install the stale attempt startup timer', async () => {
      const client = createMockClient();
      let releaseInitialize: (() => void) | undefined;
      client.initialize.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          releaseInitialize = resolve;
        });
        throw new Error('closed before initialize');
      });
      const { ctx, messageQueue } = createRunnerFixture({ client, queueSize: 0 });
      const previousOnMessageEnqueued = mock(() => {});
      messageQueue.onMessageEnqueued = previousOnMessageEnqueued;
      const runner = new AcpQueryRunner(ctx, () => client as unknown as AcpClient);

      const previousTimeout = process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
      process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = '20';
      try {
        await runner.start();
        for (let i = 0; i < 100 && !releaseInitialize; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        ctx.incrementQueryGeneration();
        ctx.attemptTokens.allocate();

        messageQueue.onMessageEnqueued?.('user-message-1', Date.now());
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(ctx.startupTimeoutTimer).toBeNull();
        expect(client.cancel).not.toHaveBeenCalled();
        expect(previousOnMessageEnqueued).toHaveBeenCalledWith(
          'user-message-1',
          expect.any(Number)
        );

        releaseInitialize?.();
        await ctx.queryPromise;

        expect(messageQueue.onMessageEnqueued).toBe(previousOnMessageEnqueued);
        expect(ctx.errorManager.handleError).not.toHaveBeenCalled();
      } finally {
        if (previousTimeout === undefined) delete process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
        else process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = previousTimeout;
      }
    }, 1000);

    test('a stale attempt startup timer must not abort or close after a replacement', async () => {
      const client = createMockClient();
      let releaseInitialize: (() => void) | undefined;
      client.initialize.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          releaseInitialize = resolve;
        });
      });
      const { ctx } = createRunnerFixture({ client, queueSize: 1 });
      const runner = new AcpQueryRunner(ctx, () => client as unknown as AcpClient);

      const previousTimeout = process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
      process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = '20';
      try {
        await runner.start();
        for (let i = 0; i < 100 && !ctx.startupTimeoutTimer; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        expect(ctx.startupTimeoutTimer).not.toBeNull();

        ctx.incrementQueryGeneration();
        ctx.attemptTokens.allocate();
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(client.cancel).not.toHaveBeenCalled();
        expect(client.close).not.toHaveBeenCalled();
        expect(ctx.startupTimeoutTimer).toBeNull();
        expect(ctx.errorManager.handleError).not.toHaveBeenCalled();

        releaseInitialize?.();
        await ctx.queryPromise;
      } finally {
        if (previousTimeout === undefined) delete process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
        else process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = previousTimeout;
      }
    }, 1000);

    test('adapter exit after a replacement must not fail the re-enqueued row', async () => {
      const client = createMockClient();
      let releasePrompt: (() => void) | undefined;
      client.sendPrompt = mock(async function* (
        _prompt: unknown,
        callbacks?: { onSubmitted?: () => void; onAccepted?: () => void }
      ) {
        callbacks?.onSubmitted?.();
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
        yield {
          sessionId: 'acp-session-1',
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: [
              {
                id: 'model',
                name: 'Model',
                type: 'select',
                category: 'model',
                currentValue: 'stale-model',
                options: [],
              },
            ],
          },
        };
      });
      const { ctx } = createRunnerFixture({ client });
      const runner = new AcpQueryRunner(ctx, () => client as unknown as AcpClient);

      await runner.start();
      for (let i = 0; i < 100 && client.sendPrompt.mock.calls.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(client.sendPrompt).toHaveBeenCalled();

      ctx.incrementQueryGeneration();
      ctx.attemptTokens.allocate();

      releasePrompt?.();
      await ctx.queryPromise;

      const handler = ctx.messageHandler as unknown as {
        markMessageSubmitted: ReturnType<typeof mock>;
        markACPDeliveryFailed: ReturnType<typeof mock>;
      };
      expect(handler.markMessageSubmitted).toHaveBeenCalledTimes(1);
      expect(handler.markACPDeliveryFailed).not.toHaveBeenCalled();
      expect(ctx.session.config.model).toBe('acp-default');
    }, 1000);

    test('out-of-band adapter callbacks from a superseded attempt must not transition delivery rows', async () => {
      const client = createMockClient();
      let releasePrompt: (() => void) | undefined;
      let capturedCallbacks: { onSubmitted?: () => void; onAccepted?: () => void } | undefined;
      client.sendPrompt = mock(async function* (
        _prompt: unknown,
        callbacks?: { onSubmitted?: () => void; onAccepted?: () => void }
      ) {
        callbacks?.onSubmitted?.();
        capturedCallbacks = callbacks;
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      });
      const { ctx } = createRunnerFixture({ client });
      const runner = new AcpQueryRunner(ctx, () => client as unknown as AcpClient);

      await runner.start();
      for (let i = 0; i < 100 && !capturedCallbacks; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(capturedCallbacks).toBeDefined();

      ctx.attemptTokens.invalidateCurrent();

      capturedCallbacks?.onSubmitted?.();
      capturedCallbacks?.onAccepted?.();

      const handler = ctx.messageHandler as unknown as {
        markMessageSubmitted: ReturnType<typeof mock>;
        markMessageAccepted: ReturnType<typeof mock>;
        markACPDeliveryFailed: ReturnType<typeof mock>;
      };
      expect(handler.markMessageSubmitted).toHaveBeenCalledTimes(1);
      expect(handler.markMessageAccepted).not.toHaveBeenCalled();

      releasePrompt?.();
      await ctx.queryPromise;

      expect(handler.markACPDeliveryFailed).not.toHaveBeenCalled();
    }, 1000);

    test('a stale prompt-loop break requeues the yielded prompt for the successor', async () => {
      const { runner, ctx, messageQueue, onSent } = createRunnerFixture();
      let releaseSetProcessing: (() => void) | undefined;
      (ctx.stateManager as unknown as { setProcessing: ReturnType<typeof mock> }).setProcessing =
        mock(async () => {
          await new Promise<void>((resolve) => {
            releaseSetProcessing = resolve;
          });
        });

      await runner.start();
      for (let i = 0; i < 100 && !releaseSetProcessing; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      ctx.attemptTokens.invalidateCurrent();

      releaseSetProcessing?.();
      await ctx.queryPromise;

      expect(messageQueue.requeueYielded).toHaveBeenCalledWith('user-message-1');
      expect(onSent).not.toHaveBeenCalled();
    }, 1000);

    test('a stale handshake skips persisting session results after a replacement', async () => {
      const client = createMockClient();
      client.canLoadSession.mockImplementation(() => true);
      let releaseLoad: (() => void) | undefined;
      client.loadSession.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          releaseLoad = resolve;
        });
        return { sessionId: 'acp-session-1', configOptions: [] };
      });
      const { runner, ctx } = createRunnerFixture({
        client,
        session: { acpSessionId: 'preset-acp-session' } as Partial<Session>,
      });

      await runner.start();
      for (let i = 0; i < 100 && !releaseLoad; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      ctx.incrementQueryGeneration();
      ctx.attemptTokens.allocate();

      releaseLoad?.();
      await ctx.queryPromise;

      expect(ctx.session.acpSessionId).toBe('preset-acp-session');
      expect(ctx.db.updateSession).not.toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ acpSessionId: 'acp-session-1' })
      );
      expect(ctx.errorManager.handleError).not.toHaveBeenCalled();
    }, 1000);

    test('a stale out-of-band onSubmitted requeues the unsubmitted prompt', async () => {
      const client = createMockClient();
      let releasePrompt: (() => void) | undefined;
      let capturedCallbacks: { onSubmitted?: () => void; onAccepted?: () => void } | undefined;
      client.sendPrompt = mock(async function* (
        _prompt: unknown,
        callbacks?: { onSubmitted?: () => void; onAccepted?: () => void }
      ) {
        capturedCallbacks = callbacks;
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      });
      const { runner, ctx, messageQueue, onSent } = createRunnerFixture({ client });

      await runner.start();
      for (let i = 0; i < 100 && !capturedCallbacks; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      ctx.attemptTokens.invalidateCurrent();

      capturedCallbacks?.onSubmitted?.();

      const handler = ctx.messageHandler as unknown as {
        markMessageSubmitted: ReturnType<typeof mock>;
      };
      expect(handler.markMessageSubmitted).not.toHaveBeenCalled();
      expect(messageQueue.requeueYielded).toHaveBeenCalledWith('user-message-1');
      expect(onSent).not.toHaveBeenCalled();

      releasePrompt?.();
      await ctx.queryPromise;
    }, 1000);

    test('a stale attempt startup timer must not clear the replacement timer slot', async () => {
      const client = createMockClient();
      let releaseInitialize: (() => void) | undefined;
      client.initialize.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          releaseInitialize = resolve;
        });
      });
      const { ctx } = createRunnerFixture({ client, queueSize: 1 });
      const runner = new AcpQueryRunner(ctx, () => client as unknown as AcpClient);

      const previousTimeout = process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
      process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = '20';
      try {
        await runner.start();
        for (let i = 0; i < 100 && !ctx.startupTimeoutTimer; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }

        ctx.incrementQueryGeneration();
        ctx.attemptTokens.allocate();
        const replacementTimer = setTimeout(() => {}, 60000);
        ctx.startupTimeoutTimer = replacementTimer;

        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(ctx.startupTimeoutTimer).toBe(replacementTimer);

        clearTimeout(replacementTimer);
        ctx.startupTimeoutTimer = null;
        releaseInitialize?.();
        await ctx.queryPromise;
      } finally {
        if (previousTimeout === undefined) delete process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
        else process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = previousTimeout;
      }
    }, 1000);
  });

  test('preserves env-only Anthropic auth for ACP subprocesses', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oat-acp-token';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'acp-oauth-token';
    const { runner, ctx, constructorOptions } = createRunnerFixture();

    await runner.start();
    await ctx.queryPromise;

    expect(constructorOptions[0].env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-oat-acp-token');
    expect(constructorOptions[0].env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('acp-oauth-token');
  });

  test('launches sessions with the provider-configured command over the env command', async () => {
    const provider = new AcpProvider({}, async () => {});
    provider.setAcpCommand('configured-agent --stdio');
    getProviderRegistry().register(provider);
    const { runner, ctx, constructorOptions } = createRunnerFixture();

    await runner.start();
    await ctx.queryPromise;

    expect(process.env.HYPERNEO_ACP_COMMAND).toBe('mock-acp --stdio');
    expect(constructorOptions[0].command).toBe('configured-agent');
    expect(constructorOptions[0].args).toEqual(['--stdio']);
  });

  describe('displayErrorAsAssistantMessage', () => {
    test('returns true and publishes the transcript delta when the persist succeeds', async () => {
      const { runner, ctx } = createRunnerFixture();
      const saveSDKMessage = ctx.db.saveSDKMessage as unknown as ReturnType<typeof mock>;
      const messageHubEvent = (ctx.messageHub as { event: ReturnType<typeof mock> }).event;
      saveSDKMessage.mockImplementation(() => true);

      const published = await runner.displayErrorAsAssistantMessage('ACP notice');

      expect(published).toBe(true);
      expect(messageHubEvent).toHaveBeenCalledWith(
        'state.sdkMessages.delta',
        expect.objectContaining({
          added: [expect.objectContaining({ type: 'assistant', session_id: 'session-1' })],
        }),
        { channel: 'session:session-1' }
      );
    });

    test('returns false and publishes the session.error fallback when the persist fails', async () => {
      const { runner, ctx } = createRunnerFixture();
      const saveSDKMessage = ctx.db.saveSDKMessage as unknown as ReturnType<typeof mock>;
      const publishAsync = ctx.internalEventBus.publishAsync as unknown as ReturnType<typeof mock>;
      const messageHubEvent = (ctx.messageHub as { event: ReturnType<typeof mock> }).event;
      saveSDKMessage.mockImplementation(() => false);

      const published = await runner.displayErrorAsAssistantMessage('Unpersisted ACP notice');

      expect(published).toBe(false);
      expect(publishAsync).toHaveBeenCalledWith('session.error', {
        sessionId: 'session-1',
        error: 'Unpersisted ACP notice',
        details: {
          category: 'system',
          message: 'Unpersisted ACP notice',
          userMessage: 'Unpersisted ACP notice',
        },
      });
      expect(messageHubEvent).not.toHaveBeenCalled();
    });

    test('publishes the session.error fallback when the persist throws', async () => {
      const { runner, ctx } = createRunnerFixture();
      const saveSDKMessage = ctx.db.saveSDKMessage as unknown as ReturnType<typeof mock>;
      const publishAsync = ctx.internalEventBus.publishAsync as unknown as ReturnType<typeof mock>;
      saveSDKMessage.mockImplementation(() => {
        throw new Error('database is closed');
      });

      const published = await runner.displayErrorAsAssistantMessage('Thrown persist notice');

      expect(published).toBe(false);
      expect(publishAsync).toHaveBeenCalledWith('session.error', {
        sessionId: 'session-1',
        error: 'Thrown persist notice',
        details: {
          category: 'system',
          message: 'Thrown persist notice',
          userMessage: 'Thrown persist notice',
        },
      });
    });
  });

  describe('ACP model cache seam', () => {
    const anthropicModel: ModelInfo = {
      id: 'sonnet',
      name: 'Sonnet 4.5',
      alias: 'sonnet',
      family: 'sonnet',
      provider: 'anthropic',
      contextWindow: 200000,
      description: 'Sonnet 4.5',
      releaseDate: '2024-09-29',
      available: true,
    };
    const staleAcpModel: ModelInfo = {
      id: 'stale-acp-model',
      name: 'Stale ACP Model',
      alias: 'stale-acp',
      family: 'acp',
      provider: 'acp',
      contextWindow: 1000,
      description: 'Stale ACP model',
      releaseDate: '2026-01-01',
      available: true,
    };

    beforeEach(() => {
      clearModelsCache();
    });

    afterEach(() => {
      clearModelsCache();
    });

    test('splices discovered ACP models into the global cache, preserving other providers', async () => {
      const provider = new AcpProvider({}, async () => {});
      provider.setAcpCommand('mock-acp --stdio');
      getProviderRegistry().register(provider);

      setModelsCache(
        new Map([['global', [anthropicModel, staleAcpModel]]]),
        Date.now() - 60 * 60 * 1000
      );

      const configOptions: AcpConfigOption[] = [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          category: 'model',
          currentValue: 'devin-default',
          options: [{ name: 'Devin Default', value: 'devin-default' }],
        },
      ];
      const client = createMockClient();
      client.createSession = mock(async () => ({ sessionId: 'acp-session-1', configOptions }));
      client.getConfigOptions = mock(() => configOptions);
      const { runner, ctx } = createRunnerFixture({ client });

      await runner.start();
      await ctx.queryPromise;

      const models = getAvailableModels('global');
      expect(models.filter((m) => m.provider === 'acp').map((m) => m.id)).toEqual([
        'devin-default',
      ]);
      expect(models.filter((m) => m.provider === 'anthropic')).toEqual([anthropicModel]);

      const publishAsync = ctx.internalEventBus.publishAsync as unknown as ReturnType<typeof mock>;
      expect(publishAsync).toHaveBeenCalledWith('providers.changed', { sessionId: 'global' });
    });

    test('publishes the repair trigger without creating a partial entry when the global cache is not initialized', async () => {
      const provider = new AcpProvider({}, async () => {});
      provider.setAcpCommand('mock-acp --stdio');
      getProviderRegistry().register(provider);

      const { runner, ctx } = createRunnerFixture();

      await runner.start();
      await ctx.queryPromise;

      expect(getModelsCache().has('global')).toBe(false);
      const publishAsync = ctx.internalEventBus.publishAsync as unknown as ReturnType<typeof mock>;
      expect(publishAsync).toHaveBeenCalledWith('providers.changed', {
        sessionId: 'global',
      });

      const { refreshModels } = await import('../../../../src/lib/model-service');
      await refreshModels();

      expect(getAvailableModels('global').some((m) => m.provider === 'acp')).toBe(true);
    });
  });

  test('auto-allows ACP permission requests without prompting the user', async () => {
    const { client, promptStarted, releasePrompt } = createHeldPromptClient();
    const { runner, ctx, constructorOptions, canUseTool } = createRunnerFixture({ client });

    await runner.start();
    await promptStarted;

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

    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(canUseTool).not.toHaveBeenCalled();

    releasePrompt();
    await ctx.queryPromise;
  });

  test('cancels ACP permission requests from a superseded query attempt', async () => {
    const { client, promptStarted, releasePrompt } = createHeldPromptClient();
    const { runner, ctx, constructorOptions } = createRunnerFixture({ client });

    await runner.start();
    await promptStarted;

    ctx.attemptTokens.allocate();

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

    expect(result).toEqual({ outcome: { outcome: 'cancelled' } });

    releasePrompt();
    await ctx.queryPromise;
  });

  test('rejects filesystem callbacks that escape the workspace', async () => {
    if (!(await safeFsBackendAvailable())) return;
    const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-escape-'));
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside.txt');
    await mkdir(workspace);
    await writeFile(outside, 'secret');
    const { client, promptStarted, releasePrompt } = createHeldPromptClient();
    const { runner, ctx, constructorOptions } = createRunnerFixture({
      client,
      session: { workspacePath: workspace },
      queryOptions: { cwd: workspace, mcpServers: {} },
    });

    try {
      await runner.start();
      await promptStarted;

      await expect(
        constructorOptions[0].onFsRead?.({
          sessionId: 'acp-session-1',
          path: outside,
        })
      ).rejects.toThrow('escapes workspace');
      await expect(
        constructorOptions[0].onFsRead?.({
          sessionId: 'acp-session-1',
          path: '../outside.txt',
        })
      ).rejects.toThrow('escapes workspace');
      await expect(
        constructorOptions[0].onFsRead?.({
          sessionId: 'acp-session-1',
          path: workspace,
        })
      ).rejects.toThrow('must identify a file');
      await expect(
        constructorOptions[0].onFsWrite?.({
          sessionId: 'acp-session-1',
          path: '../escaped.txt',
          content: 'blocked',
        })
      ).rejects.toThrow('escapes workspace');
      expect(await readFile(outside, 'utf-8')).toBe('secret');
      releasePrompt();
      await ctx.queryPromise;
    } finally {
      releasePrompt();
      await rm(root, { recursive: true, force: true });
    }
  }, 10000);

  test('confines filesystem callbacks to the workspace and honors read ranges', async () => {
    if (!(await safeFsBackendAvailable())) return;
    const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-fs-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'inside.txt'), 'one\ntwo\nthree\nfour');
    const { client, promptStarted, releasePrompt } = createHeldPromptClient();
    const { runner, ctx, constructorOptions } = createRunnerFixture({
      client,
      session: { workspacePath: workspace },
      queryOptions: { cwd: workspace, mcpServers: {} },
    });

    try {
      await runner.start();
      await promptStarted;

      await expect(
        constructorOptions[0].onFsRead?.({
          sessionId: 'acp-session-1',
          path: join(workspace, 'inside.txt'),
          line: 2,
          limit: 2,
        })
      ).resolves.toEqual({ content: 'two\nthree\n' });
      await expect(
        constructorOptions[0].onFsRead?.({
          sessionId: 'acp-session-1',
          path: join(await realpath(workspace), 'inside.txt'),
        })
      ).resolves.toEqual({ content: 'one\ntwo\nthree\nfour' });
      await constructorOptions[0].onFsWrite?.({
        sessionId: 'acp-session-1',
        path: join(workspace, 'nested', 'written.txt'),
        content: 'written',
      });
      expect(await readFile(join(workspace, 'nested', 'written.txt'), 'utf-8')).toBe('written');
      await constructorOptions[0].onFsWrite?.({
        sessionId: 'acp-session-1',
        path: '..hidden/written.txt',
        content: 'hidden',
      });
      expect(await readFile(join(workspace, '..hidden', 'written.txt'), 'utf-8')).toBe('hidden');
      releasePrompt();
      await ctx.queryPromise;
    } finally {
      releasePrompt();
      await rm(root, { recursive: true, force: true });
    }
  }, 10000);

  test('starts workspace-less ACP sessions without host filesystem or terminal callbacks', async () => {
    const { runner, ctx, constructorOptions } = createRunnerFixture({
      session: { workspacePath: undefined },
      queryOptions: { mcpServers: {} },
    });

    await runner.start();
    await ctx.queryPromise;

    expect(constructorOptions).toHaveLength(1);
    expect(constructorOptions[0]).toMatchObject({ cwd: process.cwd() });
    expect(constructorOptions[0].onFsRead).toBeUndefined();
    expect(constructorOptions[0].onFsWrite).toBeUndefined();
    expect(constructorOptions[0].onTerminalCreate).toBeUndefined();
    expect(constructorOptions[0].onTerminalOutput).toBeUndefined();
    expect(constructorOptions[0].onTerminalWaitForExit).toBeUndefined();
    expect(constructorOptions[0].onTerminalKill).toBeUndefined();
    expect(constructorOptions[0].onTerminalRelease).toBeUndefined();
    expect(ctx.errorManager.handleError).not.toHaveBeenCalled();
  });

  test('uses an allowlisted environment for ACP terminal commands', async () => {
    const previousGithubToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'github-secret';
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oat-acp-token';
    const { client, promptStarted, releasePrompt } = createHeldPromptClient();
    const { runner, ctx, constructorOptions } = createRunnerFixture({
      client,
      queryOptions: {
        cwd: '/tmp/acp-session',
        mcpServers: {},
        env: { HTTPS_PROXY: 'http://session-proxy.example:8080' },
      },
    });

    try {
      await runner.start();
      await promptStarted;
      const created = await constructorOptions[0].onTerminalCreate?.({
        sessionId: 'acp-session-1',
        command: process.execPath,
        args: ['-e', 'console.log(JSON.stringify(process.env))'],
      });
      if (!created) throw new Error('ACP terminal was not created');
      await constructorOptions[0].onTerminalWaitForExit?.({
        sessionId: 'acp-session-1',
        terminalId: created.terminalId,
      });
      let terminalEnv: Record<string, string> | undefined;
      const outputDeadline = Date.now() + 5000;
      while (terminalEnv === undefined) {
        const output = await constructorOptions[0].onTerminalOutput?.({
          sessionId: 'acp-session-1',
          terminalId: created.terminalId,
        });
        const text = output?.output.trim() ?? '';
        if (text) {
          terminalEnv = JSON.parse(text) as Record<string, string>;
        } else {
          if (Date.now() > outputDeadline) throw new Error('ACP terminal produced no output');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      expect(terminalEnv.PATH).toBe(process.env.PATH);
      expect(terminalEnv.HTTPS_PROXY).toBe('http://session-proxy.example:8080');
      expect(terminalEnv.GITHUB_TOKEN).toBeUndefined();
      expect(terminalEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    } finally {
      releasePrompt();
      await ctx.queryPromise;
      if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGithubToken;
    }
  }, 20000);

  test('rejects terminal cwd and environment overrides', async () => {
    const { runner, ctx, constructorOptions, canUseTool } = createRunnerFixture();

    await runner.start();
    await ctx.queryPromise;

    await expect(
      constructorOptions[0].onTerminalCreate?.({
        sessionId: 'acp-session-1',
        command: 'git',
        args: ['status'],
        cwd: '/tmp',
      })
    ).rejects.toThrow('ACP terminal cwd and environment overrides are not supported');
    await expect(
      constructorOptions[0].onTerminalCreate?.({
        sessionId: 'acp-session-1',
        command: 'git',
        args: ['status'],
        env: [{ name: 'PATH', value: '/tmp/bin' }],
      })
    ).rejects.toThrow('ACP terminal cwd and environment overrides are not supported');
    expect(canUseTool).not.toHaveBeenCalled();
  });

  test('does not create terminals after the query has aborted', async () => {
    const { client, promptStarted, releasePrompt } = createHeldPromptClient();
    const { runner, ctx, constructorOptions } = createRunnerFixture({ client });

    await runner.start();
    await promptStarted;
    ctx.queryAbortController?.abort();

    await expect(
      constructorOptions[0].onTerminalCreate?.({
        sessionId: 'acp-session-1',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
      })
    ).rejects.toThrow('ACP terminal command cancelled');
    releasePrompt();
    await ctx.queryPromise;
  });

  test('persists new ACP session ids', async () => {
    const { runner, ctx, mockClient } = createRunnerFixture();

    await runner.start();
    await ctx.queryPromise;

    expect(mockClient.createSession).toHaveBeenCalled();
    expect(ctx.session.acpSessionId).toBe('acp-session-1');
    expect(ctx.db.updateSession).toHaveBeenCalledWith('session-1', {
      acpSessionId: 'acp-session-1',
      metadata: expect.objectContaining({
        acpCommandIdentity: getAcpCommandIdentityDigest('mock-acp --stdio'),
      }),
    });
  });

  test('creates a new ACP session when the persisted command identity changes', async () => {
    const client = createMockClient();
    client.canLoadSession.mockImplementation(() => true);
    const { runner, ctx } = createRunnerFixture({
      client,
      session: {
        acpSessionId: 'persisted-acp-session',
        metadata: {
          acpCommandIdentity: getAcpCommandIdentityDigest('other-acp --stdio'),
          acpInstructionsSent: true,
          acpContextUsageEstimate: 12000,
        },
      } as Partial<Session>,
      queryOptions: {
        cwd: '/tmp/acp-session',
        mcpServers: {},
        systemPrompt: { type: 'preset', preset: 'none', append: 'Follow current rules.' },
      },
    });

    await runner.start();
    await ctx.queryPromise;

    expect(client.loadSession).not.toHaveBeenCalled();
    expect(client.resumeSession).not.toHaveBeenCalled();
    expect(client.createSession).toHaveBeenCalledWith('/tmp/acp-session', []);
    expect(ctx.db.updateSession).toHaveBeenCalledWith('session-1', {
      acpSessionId: 'acp-session-1',
      metadata: expect.objectContaining({
        acpCommandIdentity: getAcpCommandIdentityDigest('mock-acp --stdio'),
        acpContextUsageEstimate: undefined,
      }),
    });
    for (const call of ctx.db.updateSession.mock.calls) {
      expect(call[1]).not.toMatchObject({ acpSessionId: undefined });
    }
    expect(ctx.session.metadata.acpInstructionsSent).toBe(true);
    expect(client.sendPrompt.mock.calls[0][0]).toEqual([
      {
        type: 'text',
        text: 'HyperNeo session instructions:\n\nFollow current rules.',
      },
      { type: 'text', text: 'hello' },
    ]);
  });

  test('preserves an existing session whose command identity matches', async () => {
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
        metadata: {
          messageCount: 2,
          acpCommandIdentity: getAcpCommandIdentityDigest('mock-acp --stdio'),
        },
      } as Partial<Session>,
    });

    await runner.start();
    await ctx.queryPromise;

    expect(client.loadSession).toHaveBeenCalledWith(
      'persisted-acp-session',
      '/tmp/acp-session',
      []
    );
    expect(client.createSession).not.toHaveBeenCalled();
    expect(ctx.session.metadata.acpCommandIdentity).toBe(
      getAcpCommandIdentityDigest('mock-acp --stdio')
    );
  });

  test('passes the query generation to onModelsFetched', async () => {
    const { runner, ctx } = createRunnerFixture();

    await runner.start();
    await ctx.queryPromise;

    expect((ctx.onModelsFetched as ReturnType<typeof mock>).mock.calls[0]).toEqual([1]);
  });

  test('aborts the load-session model cache write when the run is superseded mid-handshake', async () => {
    const client = createMockClient();
    client.canLoadSession.mockImplementation(() => true);
    let releaseLoad!: () => void;
    const loadEntered = new Promise<void>((resolve) => {
      client.loadSession.mockImplementation(async () => {
        resolve();
        await new Promise<void>((resolveLoad) => {
          releaseLoad = resolveLoad;
        });
        return { sessionId: 'persisted-acp-session', configOptions: [] };
      });
    });
    const { runner, ctx } = createRunnerFixture({
      client,
      session: {
        acpSessionId: 'persisted-acp-session',
        metadata: {
          acpCommandIdentity: getAcpCommandIdentityDigest('mock-acp --stdio'),
        },
      } as Partial<Session>,
    });

    await runner.start();
    await loadEntered;
    ctx.getQueryGeneration = () => 999;
    releaseLoad();
    await ctx.queryPromise;

    expect(client.resumeSession).not.toHaveBeenCalled();
    for (const call of ctx.db.updateSession.mock.calls) {
      expect(call[1]).not.toMatchObject({ acpSessionId: expect.anything() });
    }
  });

  test('drops config-option updates from a superseded run', async () => {
    const configOptions: AcpConfigOption[] = [
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        options: [{ name: 'Fast', value: 'acp-fast' }],
        currentValue: 'acp-fast',
        category: 'model',
      },
    ];
    const client = createMockClient();
    let releasePrompt!: () => void;
    const promptEntered = new Promise<void>((resolve) => {
      client.sendPrompt = mock(async function* (
        _prompt: unknown,
        callbacks?: { onSubmitted?: () => void; onAccepted?: () => void }
      ) {
        callbacks?.onSubmitted?.();
        callbacks?.onAccepted?.();
        resolve();
        await new Promise<void>((resolveStream) => {
          releasePrompt = resolveStream;
        });
        yield {
          sessionId: 'acp-session-1',
          update: { sessionUpdate: 'config_option_update', configOptions },
        };
      });
    });
    const { runner, ctx } = createRunnerFixture({ client });

    await runner.start();
    await promptEntered;
    ctx.getQueryGeneration = () => 999;
    releasePrompt();
    await ctx.queryPromise;

    expect(client.updateConfigOptions).toHaveBeenCalledWith(configOptions);
    expect(ctx.session.config.model).toBe('acp-default');
    for (const call of ctx.db.updateSession.mock.calls) {
      expect(call[1]).not.toMatchObject({ config: expect.anything() });
    }
  });

  test('aborts the stored-model cache write when the run is superseded mid-apply', async () => {
    const client = createMockClient();
    const modelOption: AcpConfigOption = {
      id: 'model',
      name: 'Model',
      type: 'select',
      options: [{ name: 'Fast', value: 'acp-fast' }],
      currentValue: 'acp-slow',
      category: 'model',
    };
    client.getConfigOptions.mockImplementation(() => [modelOption]);
    let releaseSet!: () => void;
    const setEntered = new Promise<void>((resolve) => {
      client.setConfigOption.mockImplementation(async () => {
        resolve();
        await new Promise<void>((resolveSet) => {
          releaseSet = resolveSet;
        });
        return [{ ...modelOption, currentValue: 'acp-other' }];
      });
    });
    const { runner, ctx } = createRunnerFixture({
      client,
      session: { config: { model: 'acp-fast', provider: 'acp' } } as Partial<Session>,
    });

    await runner.start();
    await setEntered;
    ctx.getQueryGeneration = () => 999;
    releaseSet();
    await ctx.queryPromise;

    expect(client.setConfigOption).toHaveBeenCalled();
    expect(ctx.session.config.model).toBe('acp-fast');
    for (const call of ctx.db.updateSession.mock.calls) {
      expect(call[1]).not.toMatchObject({ config: expect.anything() });
    }
  });

  test('aborts the load-session model cache write when the run controller is aborted mid-handshake', async () => {
    const client = createMockClient();
    client.canLoadSession.mockImplementation(() => true);
    let releaseLoad!: () => void;
    const loadEntered = new Promise<void>((resolve) => {
      client.loadSession.mockImplementation(async () => {
        resolve();
        await new Promise<void>((resolveLoad) => {
          releaseLoad = resolveLoad;
        });
        return { sessionId: 'persisted-acp-session', configOptions: [] };
      });
    });
    const { runner, ctx } = createRunnerFixture({
      client,
      session: {
        acpSessionId: 'persisted-acp-session',
        metadata: {
          acpCommandIdentity: getAcpCommandIdentityDigest('mock-acp --stdio'),
        },
      } as Partial<Session>,
    });

    await runner.start();
    await loadEntered;
    ctx.queryAbortController?.abort();
    ctx.queryAbortController = null;
    releaseLoad();
    await ctx.queryPromise;

    expect(client.resumeSession).not.toHaveBeenCalled();
    for (const call of ctx.db.updateSession.mock.calls) {
      expect(call[1]).not.toMatchObject({ acpSessionId: expect.anything() });
    }
  });

  test('aborts session establishment when interrupted before option building completes', async () => {
    const client = createMockClient();
    const { runner, ctx } = createRunnerFixture({ client });
    let releaseBuild!: () => void;
    const buildEntered = new Promise<void>((resolve) => {
      (ctx.optionsBuilder as unknown as { build: ReturnType<typeof mock> }).build = mock(
        async () => {
          resolve();
          await new Promise<void>((resolveBuild) => {
            releaseBuild = resolveBuild;
          });
          return { cwd: '/tmp/acp-session', mcpServers: {} };
        }
      );
    });

    await runner.start();
    await buildEntered;
    ctx.queryAbortController?.abort();
    ctx.queryAbortController = null;
    releaseBuild();
    await ctx.queryPromise;

    expect(client.initialize).not.toHaveBeenCalled();
    expect(client.sendPrompt).not.toHaveBeenCalled();
    for (const call of ctx.db.updateSession.mock.calls) {
      expect(call[1]).not.toMatchObject({ acpSessionId: expect.anything() });
    }
  });

  test('skips ACP session writes when cleanup starts mid-handshake', async () => {
    const client = createMockClient();
    let releaseCreate!: () => void;
    const createEntered = new Promise<void>((resolve) => {
      client.createSession.mockImplementation(async () => {
        resolve();
        await new Promise<void>((resolveCreate) => {
          releaseCreate = resolveCreate;
        });
        return { sessionId: 'acp-session-1', configOptions: [] };
      });
    });
    const { runner, ctx } = createRunnerFixture({ client });

    await runner.start();
    await createEntered;
    ctx.isCleaningUp = () => true;
    releaseCreate();
    await ctx.queryPromise;

    expect(ctx.session.acpSessionId).toBeUndefined();
    for (const call of ctx.db.updateSession.mock.calls) {
      expect(call[1]).not.toMatchObject({ acpSessionId: expect.anything() });
    }
  });

  test('keeps the old ACP session id when the replacement command fails to start', async () => {
    const client = createMockClient();
    client.initialize.mockImplementation(async () => {
      throw new Error('replacement agent unavailable');
    });
    const { runner, ctx } = createRunnerFixture({
      client,
      session: {
        acpSessionId: 'persisted-acp-session',
        metadata: {
          acpCommandIdentity: getAcpCommandIdentityDigest('other-acp --stdio'),
        },
      } as Partial<Session>,
    });

    await runner.start();
    await ctx.queryPromise;

    for (const call of ctx.db.updateSession.mock.calls) {
      expect(call[1]).not.toMatchObject({ acpSessionId: undefined });
      expect(call[1]).not.toHaveProperty('metadata');
    }
    expect(ctx.session.acpSessionId).toBe(undefined);
    expect(ctx.session.metadata.acpCommandIdentity).toBe(
      getAcpCommandIdentityDigest('mock-acp --stdio')
    );
  });

  test('persists only a digest of the ACP command identity', async () => {
    process.env.HYPERNEO_ACP_COMMAND = 'devin acp --token topsecret';
    const { runner, ctx } = createRunnerFixture();

    await runner.start();
    await ctx.queryPromise;

    const identity = ctx.session.metadata.acpCommandIdentity as string;
    expect(identity).toBe(getAcpCommandIdentityDigest('devin acp --token topsecret'));
    expect(identity).not.toContain('topsecret');
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
      metadata: expect.objectContaining({
        acpCommandIdentity: getAcpCommandIdentityDigest('mock-acp --stdio'),
      }),
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
      expect.objectContaining({ providerId: 'acp' }),
      expect.any(Function)
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

    const previousTimeout = process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
    process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = '20';
    try {
      await runner.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(ctx.startupTimeoutTimer).toBeNull();
      expect(ctx.errorManager.handleError).not.toHaveBeenCalled();

      releaseMessage?.();
      await ctx.queryPromise;

      expect(client.sendPrompt).toHaveBeenCalled();
    } finally {
      if (previousTimeout === undefined) delete process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
      else process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = previousTimeout;
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

    const previousTimeout = process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
    process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = '20';
    try {
      await runner.start();
      await ctx.queryPromise;

      expect(previousOnMessageEnqueued).toHaveBeenCalledWith('user-message-1', expect.any(Number));
      expect(firstClient.close).toHaveBeenCalled();
      expect(secondClient.sendPrompt).toHaveBeenCalled();
      expect(messageQueue.onMessageEnqueued).toBe(previousOnMessageEnqueued);
    } finally {
      if (previousTimeout === undefined) delete process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
      else process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = previousTimeout;
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

    const previousTimeout = process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
    process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = '20';
    try {
      await runner.start();
      await ctx.queryPromise;

      expect(firstClient.close).toHaveBeenCalled();
      expect(secondClient.sendPrompt).toHaveBeenCalled();
    } finally {
      if (previousTimeout === undefined) delete process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
      else process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = previousTimeout;
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

    const previousTimeout = process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
    process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = '20';
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
      if (previousTimeout === undefined) delete process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
      else process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = previousTimeout;
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

    const previousTimeout = process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
    process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = '20';
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
      if (previousTimeout === undefined) delete process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
      else process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = previousTimeout;
    }
  }, 1000);

  describe('startup-timeout watchdog [ACP-P1]', () => {
    let previousStartupTimeout: string | undefined;

    beforeEach(() => {
      previousStartupTimeout = process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
      delete process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
    });

    afterEach(() => {
      if (previousStartupTimeout === undefined) delete process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
      else process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = previousStartupTimeout;
    });

    async function waitFor(ready: () => boolean, spins = 100): Promise<void> {
      for (let i = 0; i < spins && !ready(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }

    function holdInitialize(client: ReturnType<typeof createMockClient>): () => void {
      let releaseInitialize: (() => void) | undefined;
      client.initialize.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          releaseInitialize = resolve;
        });
        return { protocolVersion: 1, agentCapabilities: {}, agentInfo: {} };
      });
      return () => releaseInitialize?.();
    }

    function holdPrompt(client: ReturnType<typeof createMockClient>): () => void {
      let releasePrompt: (() => void) | undefined;
      client.sendPrompt = mock(async function* (
        _prompt: unknown,
        callbacks?: { onSubmitted?: () => void; onAccepted?: () => void }
      ) {
        callbacks?.onSubmitted?.();
        callbacks?.onAccepted?.();
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      });
      client.close.mockImplementation(() => releasePrompt?.());
      return () => releasePrompt?.();
    }

    function timerDelayMs(timer: unknown): number | undefined {
      return (timer as { _idleTimeout?: number } | null)?._idleTimeout;
    }

    test('arms the watchdog with the 15s default and parses env overrides', async () => {
      const cases: Array<[string | undefined, number]> = [
        [undefined, 15000],
        ['2500', 2500],
        ['not-a-number', 15000],
      ];
      for (const [envValue, expectedMs] of cases) {
        if (envValue === undefined) delete process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
        else process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = envValue;

        const client = createMockClient();
        const releaseInitialize = holdInitialize(client);
        const { runner, ctx } = createRunnerFixture({ client, queueSize: 1 });

        await runner.start();
        await waitFor(() => ctx.startupTimeoutTimer !== null, 500);
        expect(ctx.startupTimeoutTimer).not.toBeNull();
        expect(timerDelayMs(ctx.startupTimeoutTimer)).toBe(expectedMs);

        releaseInitialize();
        await ctx.queryPromise;
      }
    }, 5000);

    test('re-arms a fresh watchdog at prompt-send after the queued-kickoff arm', async () => {
      process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = '5000';
      const client = createMockClient();
      const releaseInitialize = holdInitialize(client);
      const releasePrompt = holdPrompt(client);
      const { runner, ctx, messageQueue } = createRunnerFixture({ client, queueSize: 0 });

      await runner.start();
      await waitFor(() => messageQueue.onMessageEnqueued !== undefined, 500);
      expect(ctx.startupTimeoutTimer).toBeNull();

      messageQueue.onMessageEnqueued?.('user-message-1', Date.now());
      await waitFor(() => ctx.startupTimeoutTimer !== null);
      const queuedKickoffTimer = ctx.startupTimeoutTimer;
      expect(queuedKickoffTimer).not.toBeNull();

      releaseInitialize();
      await waitFor(() => client.sendPrompt.mock.calls.length > 0, 500);
      await waitFor(
        () => ctx.startupTimeoutTimer !== null && ctx.startupTimeoutTimer !== queuedKickoffTimer,
        500
      );
      expect(ctx.startupTimeoutTimer).not.toBe(queuedKickoffTimer);

      releasePrompt();
      await ctx.queryPromise;
      expect(ctx.startupTimeoutTimer).toBeNull();
    }, 5000);

    test('disarms the watchdog when the first ACP message arrives', async () => {
      process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = '5000';
      const client = createMockClient();
      let resumedAfterFirstMessage = false;
      client.sendPrompt = mock(async function* () {
        yield {
          sessionId: 'acp-session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'first' },
          },
        };
        resumedAfterFirstMessage = true;
        await new Promise<never>(() => {});
      });
      const { runner, ctx } = createRunnerFixture({ client });
      const loggerError = (ctx.logger as unknown as { error: ReturnType<typeof mock> }).error;

      await runner.start();
      await waitFor(() => resumedAfterFirstMessage && ctx.startupTimeoutTimer === null, 500);
      expect(resumedAfterFirstMessage).toBe(true);
      expect(ctx.startupTimeoutTimer).toBeNull();
      expect(ctx.queryAbortController?.signal.aborted).toBe(false);
      expect(
        loggerError.mock.calls.some(([message]) => String(message).includes('ACP startup timeout'))
      ).toBe(false);
      expect(ctx.errorManager.handleError).not.toHaveBeenCalled();

      ctx.queryAbortController?.abort();
      await ctx.queryPromise;
    }, 5000);

    test('timeout invokes the teardown sequence in order and surfaces the startup-timeout abort', async () => {
      process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = '50';
      const firstClient = createMockClient();
      firstClient.canCloseSession.mockImplementation(() => true);
      const releasePrompt = holdPrompt(firstClient);
      const secondClient = createMockClient();
      secondClient.canLoadSession.mockImplementation(() => true);
      const clients = [firstClient, secondClient];
      const { ctx } = createRunnerFixture({ client: firstClient });
      const runner = new AcpQueryRunner(ctx, () => clients.shift() as unknown as AcpClient);
      const teardownOrder: string[] = [];
      firstClient.cancel.mockImplementation(() => teardownOrder.push('cancel'));
      firstClient.closeSession.mockImplementation(async () => {
        teardownOrder.push('closeSession');
      });
      firstClient.close.mockImplementation(() => {
        teardownOrder.push('client.close');
        releasePrompt();
      });
      const loggerError = (ctx.logger as unknown as { error: ReturnType<typeof mock> }).error;
      const originalAdapterClose = AcpQueryAdapter.prototype.close;
      AcpQueryAdapter.prototype.close = function () {
        teardownOrder.push('queryObject.close');
      };

      try {
        await runner.start();
        const firstController = ctx.queryAbortController;
        firstController?.signal.addEventListener('abort', () => teardownOrder.push('abort'));

        await waitFor(() => firstController?.signal.aborted === true, 500);

        expect(firstController?.signal.aborted).toBe(true);
        expect(teardownOrder.slice(0, 5)).toEqual([
          'abort',
          'cancel',
          'closeSession',
          'queryObject.close',
          'client.close',
        ]);
        const timeoutError = loggerError.mock.calls.find(
          ([label]) => label === 'ACP query error:'
        )?.[1] as Error;
        expect(timeoutError).toBeInstanceOf(Error);
        expect(timeoutError.message).toBe('ACP startup timeout - query aborted');

        await ctx.queryPromise;
        expect(secondClient.sendPrompt).toHaveBeenCalled();
      } finally {
        AcpQueryAdapter.prototype.close = originalAdapterClose;
      }
    }, 5000);

    test('skips session/close on timeout when the agent cannot close sessions', async () => {
      process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = '50';
      const firstClient = createMockClient();
      holdPrompt(firstClient);
      const secondClient = createMockClient();
      secondClient.canLoadSession.mockImplementation(() => true);
      const clients = [firstClient, secondClient];
      const { ctx } = createRunnerFixture({ client: firstClient });
      const runner = new AcpQueryRunner(ctx, () => clients.shift() as unknown as AcpClient);

      await runner.start();
      await waitFor(() => ctx.queryObject !== null);
      await waitFor(() => firstClient.cancel.mock.calls.length > 0, 500);

      expect(firstClient.canCloseSession).toHaveBeenCalled();
      expect(firstClient.closeSession).not.toHaveBeenCalled();
      expect(firstClient.cancel).toHaveBeenCalled();
      expect(firstClient.close).toHaveBeenCalled();

      await ctx.queryPromise;
    }, 5000);

    test('surfaces the pre-prompt startup abort as a named AbortError', async () => {
      const client = createMockClient();
      const releaseInitialize = holdInitialize(client);
      const createClient = mock(() => client as unknown as AcpClient);
      const { ctx } = createRunnerFixture({ client });
      const runner = new AcpQueryRunner(ctx, createClient);
      const loggerError = (ctx.logger as unknown as { error: ReturnType<typeof mock> }).error;

      await runner.start();
      await waitFor(() => client.initialize.mock.calls.length > 0, 500);
      ctx.incrementQueryGeneration();
      releaseInitialize();
      await ctx.queryPromise;

      expect(createClient).toHaveBeenCalledTimes(1);
      expect(ctx.errorManager.handleError).not.toHaveBeenCalled();
      const abortError = loggerError.mock.calls.find(
        ([label]) => label === 'ACP query error:'
      )?.[1] as Error;
      expect(abortError).toBeInstanceOf(Error);
      expect(abortError.name).toBe('AbortError');
      expect(abortError.message).toBe('ACP query aborted during startup');
    }, 5000);

    test('retries a startup timeout once, then surfaces the failed startup', async () => {
      process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = '20';
      const firstClient = createMockClient();
      holdPrompt(firstClient);
      const secondClient = createMockClient();
      secondClient.canLoadSession.mockImplementation(() => true);
      holdPrompt(secondClient);
      const clients = [firstClient, secondClient];
      const { ctx } = createRunnerFixture({ client: firstClient });
      const createClient = mock(() => clients.shift() as unknown as AcpClient);
      const runner = new AcpQueryRunner(ctx, createClient);

      await runner.start();
      await ctx.queryPromise;

      expect(createClient).toHaveBeenCalledTimes(2);
      expect(ctx.errorManager.handleError).toHaveBeenCalledTimes(1);
      expect(ctx.errorManager.handleError).toHaveBeenCalledWith(
        'session-1',
        expect.any(Error),
        'timeout',
        expect.stringContaining('The ACP agent failed to start'),
        expect.any(Object),
        expect.objectContaining({ providerId: 'acp', startupTimeoutMs: 20 }),
        expect.any(Function)
      );
    }, 5000);

    test('clears ACP session state when a startup timeout hits before any message', async () => {
      process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = '20';
      const firstClient = createMockClient();
      holdPrompt(firstClient);
      const secondClient = createMockClient();
      const clients = [firstClient, secondClient];
      const { ctx } = createRunnerFixture({ client: firstClient });
      const runner = new AcpQueryRunner(ctx, () => clients.shift() as unknown as AcpClient);
      const updateSession = ctx.db.updateSession as ReturnType<typeof mock>;

      await runner.start();
      await ctx.queryPromise;

      expect(updateSession).toHaveBeenCalledWith('session-1', {
        acpSessionId: undefined,
        metadata: expect.objectContaining({
          acpInstructionsSent: undefined,
          acpContextUsageEstimate: undefined,
        }),
      });
      expect(secondClient.createSession).toHaveBeenCalled();
      expect(ctx.session.acpSessionId).toBe('acp-session-1');
    }, 5000);

    test('retries transient connection errors once with prompt re-delivery', async () => {
      const firstClient = createMockClient();
      firstClient.sendPrompt = mock(async function* (
        _prompt: unknown,
        callbacks?: { onSubmitted?: () => void; onAccepted?: () => void }
      ) {
        callbacks?.onSubmitted?.();
        callbacks?.onAccepted?.();
        throw new Error('TypeError: fetch failed');
      });
      const secondClient = createMockClient();
      secondClient.canLoadSession.mockImplementation(() => true);
      const clients = [firstClient, secondClient];
      const { ctx, messageQueue } = createRunnerFixture({ client: firstClient });
      const runner = new AcpQueryRunner(ctx, () => clients.shift() as unknown as AcpClient);
      const updateSession = ctx.db.updateSession as ReturnType<typeof mock>;
      const loggerWarn = (ctx.logger as unknown as { warn: ReturnType<typeof mock> }).warn;

      await runner.start();
      await ctx.queryPromise;

      expect(
        loggerWarn.mock.calls.some(([message]) =>
          String(message).includes('Auto-retrying ACP query after transient connection error')
        )
      ).toBe(true);
      expect(messageQueue.enqueueWithId).toHaveBeenCalledWith('user-message-1', [
        { type: 'text', text: 'hello' },
      ]);
      expect(secondClient.sendPrompt).toHaveBeenCalled();
      for (const call of updateSession.mock.calls) {
        expect(call[1]).not.toMatchObject({ acpSessionId: undefined });
      }
    }, 5000);
  });

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
      expect.objectContaining({ providerId: 'acp' }),
      expect.any(Function)
    );
  });

  test('cancels the invocation fence instead of draining when a replacement supersedes the dispatch', async () => {
    const { runner, ctx } = createRunnerFixture({
      onSDKMessage: async () => {
        ctx.incrementQueryGeneration();
        throw new Error('db write failed');
      },
    });

    await runner.start();
    await ctx.queryPromise;

    expect(ctx.errorManager.handleError).not.toHaveBeenCalled();
    expect(ctx.stateManager.setIdle).not.toHaveBeenCalledWith();
    expect(ctx.stateManager.cancelTerminalIdleArm).toHaveBeenCalledWith({
      queryGeneration: 1,
      turnToken: 0,
    });
  });

  test('cancels the invocation fence instead of draining when cleanup is active during dispatch', async () => {
    const { runner, ctx } = createRunnerFixture({
      onSDKMessage: async () => {
        ctx.isCleaningUp = () => true;
        throw new Error('db write failed');
      },
    });

    await runner.start();
    await ctx.queryPromise;

    expect(ctx.errorManager.handleError).not.toHaveBeenCalled();
    expect(ctx.stateManager.setIdle).not.toHaveBeenCalledWith();
    expect(ctx.stateManager.cancelTerminalIdleArm).toHaveBeenCalledWith({
      queryGeneration: 1,
      turnToken: 0,
    });
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

  test('does not arm the terminal fence when superseded before the error route arms', async () => {
    const client = createMockClient();
    client.initialize.mockRejectedValue(new Error('429 Too Many Requests'));
    const { ctx } = createRunnerFixture({ client });
    ctx.onRateLimitExhausted = mock(async () => {
      ctx.incrementQueryGeneration();
      return false;
    });
    const runner = new AcpQueryRunner(ctx, () => client as unknown as AcpClient);

    await runner.start();
    await ctx.queryPromise;

    expect(ctx.stateManager.beginTerminalIdle).not.toHaveBeenCalled();
    expect(ctx.errorManager.handleError).not.toHaveBeenCalled();
    expect(ctx.stateManager.setIdle).not.toHaveBeenCalled();
  });

  test('cancels the terminal arm and skips the idle settle when superseded during error publication', async () => {
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

    expect(ctx.stateManager.beginTerminalIdle).toHaveBeenCalledWith({
      queryGeneration: 1,
      turnToken: 0,
    });
    ctx.incrementQueryGeneration();
    resolveError();
    await ctx.queryPromise;

    expect(ctx.stateManager.cancelTerminalIdleArm).toHaveBeenCalledWith({
      queryGeneration: 1,
      turnToken: 0,
    });
    expect(ctx.stateManager.setIdle).not.toHaveBeenCalled();
  });

  test('cancels the terminal arm and skips the idle settle when cleanup starts during error publication', async () => {
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
    ctx.isCleaningUp = () => true;
    resolveError();
    await ctx.queryPromise;

    expect(ctx.stateManager.cancelTerminalIdleArm).toHaveBeenCalledWith({
      queryGeneration: 1,
      turnToken: 0,
    });
    expect(ctx.stateManager.setIdle).not.toHaveBeenCalled();
  });

  test('cancels the terminal arm when error publication rejects', async () => {
    const client = createMockClient();
    client.initialize.mockRejectedValue(new Error('401 Unauthorized'));
    const { ctx } = createRunnerFixture({ client });
    ctx.errorManager.handleError = mock(async () => {
      throw new Error('publish failed');
    });
    const runner = new AcpQueryRunner(ctx, () => client as unknown as AcpClient);

    runner.start();
    await expect(ctx.queryPromise).rejects.toThrow('publish failed');

    expect(ctx.stateManager.beginTerminalIdle).toHaveBeenCalledTimes(1);
    expect(ctx.stateManager.cancelTerminalIdleArm).toHaveBeenCalledWith({
      queryGeneration: 1,
      turnToken: 0,
    });
  });

  test('passes a publishGuard tied to current query generation and cleanup state', async () => {
    const client = createMockClient();
    client.initialize.mockRejectedValue(new Error('401 Unauthorized'));
    const { ctx } = createRunnerFixture({ client });
    const runner = new AcpQueryRunner(ctx, () => client as unknown as AcpClient);

    runner.start();
    await ctx.queryPromise;

    expect(ctx.errorManager.handleError).toHaveBeenCalledTimes(1);
    const guard = ctx.errorManager.handleError.mock.calls[0][6] as () => boolean;
    expect(typeof guard).toBe('function');
    expect(guard()).toBe(true);

    ctx.incrementQueryGeneration();
    expect(guard()).toBe(false);

    ctx.incrementQueryGeneration = () => 1;
    ctx.isCleaningUp = () => true;
    expect(guard()).toBe(false);
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

  test('closes the ACP client when the query becomes stale during startup', async () => {
    const client = createMockClient();
    let releaseInitialize: (() => void) | undefined;
    let markInitializeStarted: (() => void) | undefined;
    const initializeStarted = new Promise<void>((resolve) => {
      markInitializeStarted = resolve;
    });
    const initializeGate = new Promise<void>((resolve) => {
      releaseInitialize = resolve;
    });
    client.initialize.mockImplementation(async () => {
      markInitializeStarted?.();
      await initializeGate;
      return { protocolVersion: 1, agentCapabilities: {}, agentInfo: {} };
    });
    const { runner, ctx } = createRunnerFixture({ client });

    await runner.start();
    await initializeStarted;
    ctx.incrementQueryGeneration();
    releaseInitialize?.();
    await ctx.queryPromise;

    expect(client.sendPrompt).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
    expect(ctx.errorManager.handleError).not.toHaveBeenCalled();
  });

  test('delivers an interrupted tool call with its synthesized result', async () => {
    const client = createMockClient();
    let releasePrompt: (() => void) | undefined;
    let promptBlockedResolve: (() => void) | undefined;
    const promptBlocked = new Promise<void>((resolve) => {
      promptBlockedResolve = resolve;
    });
    client.sendPrompt.mockImplementation(async function* () {
      yield {
        sessionId: 'acp-session-1',
        update: { sessionUpdate: 'plan', entries: [] },
      };
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
        promptBlockedResolve?.();
      });
      yield {
        sessionId: 'acp-session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-late',
          title: 'Late tool',
          rawInput: {},
        },
      };
    });
    const { runner, ctx, onSDKMessage } = createRunnerFixture({ client });

    await runner.start();
    await promptBlocked;
    ctx.queryAbortController?.abort();
    releasePrompt?.();
    await ctx.queryPromise;

    const hasToolUse = onSDKMessage.mock.calls.some(
      ([message]) =>
        message.type === 'assistant' &&
        (
          (message as { message?: { content?: Array<{ type?: string }> } }).message?.content ?? []
        ).some((block) => block?.type === 'tool_use')
    );
    const hasToolResult = onSDKMessage.mock.calls.some(
      ([message]) =>
        message.type === 'user' && (message as SDKUserMessage).parent_tool_use_id === 'tc-late'
    );
    expect(hasToolUse).toBe(true);
    expect(hasToolResult).toBe(true);
    expect(ctx.errorManager.handleError).not.toHaveBeenCalled();
  }, 1000);

  test('aborts stale ACP startup after cleanup begins', async () => {
    let markBuildStarted: () => void;
    const buildStarted = new Promise<void>((resolve) => {
      markBuildStarted = resolve;
    });
    let releaseBuild: () => void;
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const { runner, ctx, constructorOptions } = createRunnerFixture({
      queryOptions: { cwd: '/tmp/acp-session', mcpServers: {} },
    });
    ctx.optionsBuilder.build = mock(async () => {
      markBuildStarted();
      await buildGate;
      return { cwd: '/tmp/acp-session', mcpServers: {} };
    });

    await runner.start();
    await buildStarted;
    ctx.isCleaningUp = () => true;
    releaseBuild!();
    await ctx.queryPromise;

    expect(constructorOptions).toHaveLength(0);
    expect(ctx.queryAbortController).toBeNull();
  });

  test('delivers pending ACP tool results when abort drops the iterator output', async () => {
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
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-interrupted',
          title: 'Long tool',
          rawInput: {},
        },
      };
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
        promptBlockedResolve?.();
      });
    });
    const { runner, ctx, onSDKMessage } = createRunnerFixture({ client });

    await runner.start();
    await promptBlocked;
    ctx.queryAbortController?.abort();
    releasePrompt?.();
    await ctx.queryPromise;

    expect(
      onSDKMessage.mock.calls.some(
        ([message]) =>
          message.type === 'user' &&
          (message as SDKUserMessage).parent_tool_use_id === 'tc-interrupted'
      )
    ).toBe(true);
    expect(ctx.errorManager.handleError).not.toHaveBeenCalled();
  }, 1000);

  test('does not duplicate tool results completed during abort', async () => {
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
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-interrupted',
          title: 'Long tool',
          rawInput: {},
        },
      };
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
        promptBlockedResolve?.();
      });
      yield {
        sessionId: 'acp-session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-interrupted',
          status: 'completed',
        },
      };
    });
    const { runner, ctx, onSDKMessage } = createRunnerFixture({ client });

    await runner.start();
    await promptBlocked;
    ctx.queryAbortController?.abort();
    releasePrompt?.();
    await ctx.queryPromise;

    const toolResults = onSDKMessage.mock.calls.filter(
      ([message]) =>
        message.type === 'user' &&
        (message as SDKUserMessage).parent_tool_use_id === 'tc-interrupted'
    );
    expect(toolResults.length).toBe(1);
    expect(ctx.errorManager.handleError).not.toHaveBeenCalled();
  }, 1000);

  test('settles the query when the agent stops responding after abort', async () => {
    const client = createMockClient();
    let promptBlockedResolve: (() => void) | undefined;
    const promptBlocked = new Promise<void>((resolve) => {
      promptBlockedResolve = resolve;
    });
    client.sendPrompt.mockImplementation(async function* () {
      yield {
        sessionId: 'acp-session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-interrupted',
          title: 'Long tool',
          rawInput: {},
        },
      };
      promptBlockedResolve?.();
      await new Promise<void>(() => {});
    });
    const { runner, ctx, onSDKMessage } = createRunnerFixture({ client });

    await runner.start();
    await promptBlocked;
    ctx.queryAbortController?.abort();
    await ctx.queryPromise;

    expect(
      onSDKMessage.mock.calls.some(
        ([message]) =>
          message.type === 'user' &&
          (message as SDKUserMessage).parent_tool_use_id === 'tc-interrupted'
      )
    ).toBe(true);
    expect(ctx.errorManager.handleError).not.toHaveBeenCalled();
  }, 5000);

  test('stops draining a continuing producer after abort', async () => {
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
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-interrupted',
          title: 'Long tool',
          rawInput: {},
        },
      };
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
        promptBlockedResolve?.();
      });
      while (true) {
        yield {
          sessionId: 'acp-session-1',
          update: { sessionUpdate: 'plan', entries: [] },
        };
      }
    });
    const { runner, ctx, onSDKMessage } = createRunnerFixture({ client });

    await runner.start();
    await promptBlocked;
    ctx.queryAbortController?.abort();
    releasePrompt?.();
    await ctx.queryPromise;

    expect(
      onSDKMessage.mock.calls.some(
        ([message]) =>
          message.type === 'user' &&
          (message as SDKUserMessage).parent_tool_use_id === 'tc-interrupted'
      )
    ).toBe(true);
    expect(
      onSDKMessage.mock.calls.filter(([message]) => message.type === 'assistant').length
    ).toBeLessThanOrEqual(2);
    expect(onSDKMessage.mock.calls.length).toBeLessThanOrEqual(10);
    expect(ctx.errorManager.handleError).not.toHaveBeenCalled();
  }, 1000);

  test('acquires the provider-env lease with acp.query owner before ambient reads and spawn', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oat-acp-token';
    const { runner, ctx, constructorOptions } = createRunnerFixture();
    let buildRanUnderLease: boolean | undefined;
    ctx.optionsBuilder.build = mock(async () => {
      buildRanUnderLease = providerEnvCoordinator.isLeaseHeld();
      return { cwd: '/tmp/acp-session', mcpServers: {} };
    });

    await runner.start();
    await ctx.queryPromise;

    expect(buildRanUnderLease).toBe(true);
    expect(constructorOptions[0].env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-oat-acp-token');
    expect(ctx.originalEnvVars).toEqual({});
  });

  test('aborts the ACP startup if the query generation is bumped while awaiting build', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oat-acp-token';
    const { runner, ctx, constructorOptions } = createRunnerFixture();
    let releaseBuild: (() => void) | undefined;
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    let buildStartedResolve: (() => void) | undefined;
    const buildStartedPromise = new Promise<void>((resolve) => {
      buildStartedResolve = resolve;
    });

    ctx.optionsBuilder.build = mock(async () => {
      buildStartedResolve?.();
      await buildGate;
      return { cwd: '/tmp/acp-session', mcpServers: {} };
    });

    await runner.start();
    const stalePromise = ctx.queryPromise;
    await buildStartedPromise;
    ctx.incrementQueryGeneration();
    releaseBuild?.();
    await stalePromise;

    expect(constructorOptions).toHaveLength(0);
    expect(ctx.originalEnvVars).toEqual({});
    expect(ctx.queryPromise).toBe(stalePromise);
  });

  test('does not install canUseTool on the options builder (fence lives on onPermissionRequest)', async () => {
    const { client, promptStarted, releasePrompt } = createHeldPromptClient();
    const { runner, ctx } = createRunnerFixture({ client });

    await runner.start();
    await promptStarted;

    const setCanUseTool = ctx.optionsBuilder.setCanUseTool as ReturnType<typeof mock>;
    expect(setCanUseTool).toHaveBeenCalledTimes(0);

    releasePrompt();
    await ctx.queryPromise;
  });
});
