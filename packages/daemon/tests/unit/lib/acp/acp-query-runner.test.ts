import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageContent, MessageHub, Session } from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import { z } from 'zod';
import type { AcpClient, AcpClientOptions } from '../../../../src/lib/acp/acp-client';
import {
  AcpQueryRunner,
  convertMcpServersForAcp,
  parseAcpCommand,
} from '../../../../src/lib/acp/acp-query-runner';
import { AcpMcpProxyBridge } from '../../../../src/lib/acp/mcp-proxy-bridge';
import type { AskUserQuestionHandler } from '../../../../src/lib/agent/ask-user-question-handler';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { QueryOptionsBuilder } from '../../../../src/lib/agent/query-options-builder';
import type { QueryRunnerContext } from '../../../../src/lib/agent/query-runner';
import type { ErrorManager } from '../../../../src/lib/error-manager';
import type { Logger } from '../../../../src/lib/logger';
import { resetProviderFactory } from '../../../../src/lib/providers/factory';
import { resetProviderRegistry } from '../../../../src/lib/providers/registry';
import type { Database } from '../../../../src/storage/database';

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

function createHeldPromptClient() {
  let markPromptStarted: (() => void) | undefined;
  let releasePrompt: (() => void) | undefined;
  const promptStarted = new Promise<void>((resolve) => {
    markPromptStarted = resolve;
  });
  const promptReleased = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  const client = createMockClient();
  client.sendPrompt = mock(async function* (
    _prompt: unknown,
    callbacks?: { onSubmitted?: () => void; onAccepted?: () => void }
  ) {
    callbacks?.onSubmitted?.();
    callbacks?.onAccepted?.();
    markPromptStarted?.();
    await promptReleased;
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
    expect(runner.lastConsumedUserMessage).toBeNull();
  });

  const bunRuntimeTest = process.versions.bun ? test : test.skip;

  bunRuntimeTest(
    'confines filesystem callbacks to the workspace and honors read ranges',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-fs-'));
      const workspace = join(root, 'workspace');
      const outside = join(root, 'outside.txt');
      await mkdir(workspace);
      await writeFile(join(workspace, 'inside.txt'), 'one\ntwo\nthree\nfour');
      await writeFile(outside, 'secret');
      const { client, promptStarted, releasePrompt } = createHeldPromptClient();
      const { runner, ctx, constructorOptions } = createRunnerFixture({
        client,
        session: { workspacePath: workspace },
        queryOptions: { cwd: workspace, mcpServers: {} },
        canUseTool: async (_toolName, input) => {
          const question = (input.questions as Array<{ question: string }>)[0].question;
          return { behavior: 'allow', updatedInput: { answers: { [question]: 'Allow once' } } };
        },
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
        await expect(
          constructorOptions[0].onFsRead?.({
            sessionId: 'acp-session-1',
            path: outside,
          })
        ).rejects.toThrow('escapes workspace');
        const large = join(workspace, 'large.txt');
        await writeFile(large, 'x'.repeat(4 * 1024 * 1024 + 1));
        await expect(
          constructorOptions[0].onFsRead?.({
            sessionId: 'acp-session-1',
            path: large,
          })
        ).rejects.toThrow('ACP filesystem scan exceeds');
        await expect(
          constructorOptions[0].onFsRead?.({
            sessionId: 'acp-session-1',
            path: large,
            line: 1,
            limit: 0,
          })
        ).resolves.toEqual({ content: '' });
        await expect(
          constructorOptions[0].onFsWrite?.({
            sessionId: 'acp-session-1',
            path: '../escaped.txt',
            content: 'blocked',
          })
        ).rejects.toThrow('escapes workspace');
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

        const link = join(workspace, 'outside-link');
        await symlink(root, link);
        await expect(
          constructorOptions[0].onFsRead?.({
            sessionId: 'acp-session-1',
            path: join(link, 'outside.txt'),
          })
        ).rejects.toThrow('Unable to open ACP filesystem path');

        const danglingTarget = join(root, 'created-through-link.txt');
        const danglingLink = join(workspace, 'dangling-link');
        await symlink(danglingTarget, danglingLink);
        await constructorOptions[0].onFsWrite?.({
          sessionId: 'acp-session-1',
          path: danglingLink,
          content: 'blocked',
        });
        expect(await readFile(danglingLink, 'utf-8')).toBe('blocked');
        await expect(readFile(danglingTarget, 'utf-8')).rejects.toThrow();
        releasePrompt();
        await ctx.queryPromise;
      } finally {
        releasePrompt();
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  test('denies ACP filesystem writes before mutating the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-write-'));
    const workspace = join(root, 'workspace');
    const target = join(workspace, 'denied.txt');
    await mkdir(workspace);
    const { client, promptStarted, releasePrompt } = createHeldPromptClient();
    const { runner, ctx, constructorOptions, canUseTool } = createRunnerFixture({
      client,
      session: { workspacePath: workspace },
      queryOptions: { cwd: workspace, mcpServers: {} },
      canUseTool: async () => ({ behavior: 'deny', message: 'Denied' }),
    });

    try {
      await runner.start();
      await promptStarted;

      await expect(
        constructorOptions[0].onFsWrite?.({
          sessionId: 'acp-session-1',
          path: target,
          content: 'blocked',
        })
      ).rejects.toThrow('ACP filesystem write denied');
      await expect(readFile(target, 'utf-8')).rejects.toThrow();
      expect(canUseTool).toHaveBeenCalledWith(
        'AskUserQuestion',
        expect.objectContaining({
          questions: [
            expect.objectContaining({
              question: `Allow write ${target}?`,
              header: 'ACP approval',
            }),
          ],
        }),
        expect.objectContaining({ displayName: `write ${target}` })
      );
      releasePrompt();
      await ctx.queryPromise;
    } finally {
      releasePrompt();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('cancels a pending ACP filesystem write when the query ends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-write-'));
    const workspace = join(root, 'workspace');
    const target = join(workspace, 'cancelled.txt');
    await mkdir(workspace);
    let approveWrite: (() => void) | undefined;
    const writeApproved = new Promise<void>((resolve) => {
      approveWrite = resolve;
    });
    const { client, promptStarted, releasePrompt } = createHeldPromptClient();
    const { runner, ctx, constructorOptions } = createRunnerFixture({
      client,
      session: { workspacePath: workspace },
      queryOptions: { cwd: workspace, mcpServers: {} },
      canUseTool: async (_toolName, input) => {
        await writeApproved;
        const question = (input.questions as Array<{ question: string }>)[0].question;
        return { behavior: 'allow', updatedInput: { answers: { [question]: 'Allow once' } } };
      },
    });

    try {
      await runner.start();
      await promptStarted;
      const write = constructorOptions[0].onFsWrite?.({
        sessionId: 'acp-session-1',
        path: target,
        content: 'blocked',
      });
      ctx.queryAbortController?.abort();
      approveWrite?.();

      await expect(write).rejects.toThrow('ACP filesystem write cancelled');
      await expect(readFile(target, 'utf-8')).rejects.toThrow();
      releasePrompt();
      await ctx.queryPromise;
    } finally {
      releasePrompt();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('cancels pending terminal approval promptly when the query ends', async () => {
    const terminalApprovalStarted = Promise.withResolvers<void>();
    const terminalApproval = Promise.withResolvers<{
      behavior: 'allow';
      updatedInput: { answers: Record<string, string> };
    }>();
    const { client, promptStarted, releasePrompt } = createHeldPromptClient();
    const { runner, ctx, constructorOptions } = createRunnerFixture({
      client,
      canUseTool: async () => {
        terminalApprovalStarted.resolve();
        return terminalApproval.promise;
      },
    });

    await runner.start();
    await promptStarted;
    const terminal = constructorOptions[0].onTerminalCreate?.({
      sessionId: 'acp-session-1',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    });
    await terminalApprovalStarted.promise;
    ctx.queryAbortController?.abort();

    await expect(terminal).rejects.toThrow('ACP terminal command cancelled');
    releasePrompt();
    await ctx.queryPromise;
  });

  test('cancels pending native permission requests when the query ends', async () => {
    const permissionStarted = Promise.withResolvers<void>();
    const permission = Promise.withResolvers<{
      behavior: 'allow';
      updatedInput: { answers: Record<string, string> };
    }>();
    const { client, promptStarted, releasePrompt } = createHeldPromptClient();
    const { runner, ctx, constructorOptions } = createRunnerFixture({
      client,
      canUseTool: async () => {
        permissionStarted.resolve();
        return permission.promise;
      },
    });

    await runner.start();
    await promptStarted;
    const pending = constructorOptions[0].onPermissionRequest?.({
      sessionId: 'acp-session-1',
      toolCall: {
        toolCallId: 'tool-1',
        title: 'Edit file',
        kind: 'edit',
      },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    });
    await permissionStarted.promise;
    ctx.queryAbortController?.abort();

    await expect(pending).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    releasePrompt();
    await ctx.queryPromise;
  });

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

  test('publishes query.trigger on normal turn completion to replay deferred rows', async () => {
    const { runner, ctx } = createRunnerFixture();
    const publishAsync = ctx.internalEventBus.publishAsync as unknown as ReturnType<typeof mock>;

    await runner.start();
    await ctx.queryPromise;

    expect(publishAsync).toHaveBeenCalledWith('query.trigger', { sessionId: 'session-1' });
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

  test('preserves env-only Anthropic auth for ACP subprocesses', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oat-acp-token';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'acp-oauth-token';
    const { runner, ctx, constructorOptions } = createRunnerFixture();

    await runner.start();
    await ctx.queryPromise;

    expect(constructorOptions[0].env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-oat-acp-token');
    expect(constructorOptions[0].env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('acp-oauth-token');
  });

  test('uses an allowlisted environment for ACP terminal commands', async () => {
    const previousGithubToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'github-secret';
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oat-acp-token';
    let releasePrompt: (() => void) | undefined;
    let markPromptStarted: (() => void) | undefined;
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve;
    });
    const promptReleased = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const client = createMockClient();
    client.sendPrompt = mock(async function* (
      _prompt: unknown,
      callbacks?: { onSubmitted?: () => void; onAccepted?: () => void }
    ) {
      callbacks?.onSubmitted?.();
      callbacks?.onAccepted?.();
      markPromptStarted?.();
      await promptReleased;
      yield {
        sessionId: 'acp-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'done' },
        },
      };
    });
    const { runner, ctx, constructorOptions } = createRunnerFixture({
      client,
      canUseTool: async (_toolName, input) => {
        const question = (input.questions as Array<{ question: string }>)[0].question;
        return { behavior: 'allow', updatedInput: { answers: { [question]: 'Allow once' } } };
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
      const output = await constructorOptions[0].onTerminalOutput?.({
        sessionId: 'acp-session-1',
        terminalId: created.terminalId,
      });
      if (!output) throw new Error('ACP terminal output was not returned');
      const terminalEnv = JSON.parse(output.output.trim()) as Record<string, string>;

      expect(terminalEnv.PATH).toBe(process.env.PATH);
      expect(terminalEnv.GITHUB_TOKEN).toBeUndefined();
      expect(terminalEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    } finally {
      releasePrompt?.();
      await ctx.queryPromise;
      if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGithubToken;
    }
  });

  test('maps ACP permission requests through AskUserQuestion approval callback', async () => {
    const { client, promptStarted, releasePrompt } = createHeldPromptClient();
    const { runner, ctx, constructorOptions, canUseTool } = createRunnerFixture({
      client,
      canUseTool: async (_toolName, _input, _options) => ({
        behavior: 'allow',
        updatedInput: { answers: { 'Allow Edit file?': 'Allow once' } },
      }),
    });

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
        { optionId: 'allow-session', name: 'Allow for session', kind: 'allow_always' },
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
    releasePrompt();
    await ctx.queryPromise;
  });

  test('cancels ACP permission requests denied by the approval callback', async () => {
    const { runner, ctx, constructorOptions } = createRunnerFixture({
      canUseTool: async () => ({ behavior: 'deny', message: 'Denied' }),
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
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    });

    expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  test('cancels empty ACP permission requests without prompting', async () => {
    const { runner, ctx, constructorOptions, canUseTool } = createRunnerFixture();

    await runner.start();
    await ctx.queryPromise;

    const result = await constructorOptions[0].onPermissionRequest?.({
      sessionId: 'acp-session-1',
      toolCall: {
        toolCallId: 'tool-1',
        title: 'Edit file',
        kind: 'edit',
      },
      options: [],
    });

    expect(canUseTool).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  test('prompts before terminal creation', async () => {
    const { runner, ctx, constructorOptions, canUseTool } = createRunnerFixture({
      canUseTool: async (_toolName, input) => {
        const question = (input.questions as Array<{ question: string }>)[0].question;
        return { behavior: 'allow', updatedInput: { answers: { [question]: 'Allow once' } } };
      },
    });

    await runner.start();
    await ctx.queryPromise;

    await expect(
      constructorOptions[0].onTerminalCreate?.({
        sessionId: 'acp-session-1',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
      })
    ).rejects.toThrow('ACP terminal command cancelled');
    expect(canUseTool).toHaveBeenCalledWith(
      'AskUserQuestion',
      expect.objectContaining({
        questions: [
          expect.objectContaining({
            question: `Allow terminal command ${process.execPath} -e 'process.exit(0)'?`,
            header: 'ACP approval',
          }),
        ],
      }),
      expect.objectContaining({
        displayName: `terminal command ${process.execPath} -e 'process.exit(0)'`,
      })
    );
  });

  test('rejects terminal cwd and environment overrides before permission checks', async () => {
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

  test('does not create terminals denied by the permission callback', async () => {
    const { client, promptStarted, releasePrompt } = createHeldPromptClient();
    const { runner, ctx, constructorOptions } = createRunnerFixture({
      client,
      canUseTool: async () => ({ behavior: 'deny', message: 'Denied' }),
    });

    await runner.start();
    await promptStarted;

    await expect(
      constructorOptions[0].onTerminalCreate?.({
        sessionId: 'acp-session-1',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
      })
    ).rejects.toThrow('ACP terminal command denied');
    releasePrompt();
    await ctx.queryPromise;
  });

  test('does not create terminals when the explicit deny option is selected', async () => {
    const { client, promptStarted, releasePrompt } = createHeldPromptClient();
    const { runner, ctx, constructorOptions } = createRunnerFixture({
      client,
      canUseTool: async (_toolName, input) => {
        const question = (input.questions as Array<{ question: string }>)[0].question;
        return { behavior: 'allow', updatedInput: { answers: { [question]: 'Deny' } } };
      },
    });

    await runner.start();
    await promptStarted;

    await expect(
      constructorOptions[0].onTerminalCreate?.({
        sessionId: 'acp-session-1',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
      })
    ).rejects.toThrow('ACP terminal command denied');
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

  test('creates a new ACP session when the persisted command identity changes', async () => {
    const client = createMockClient();
    client.canLoadSession.mockImplementation(() => true);
    const { runner, ctx } = createRunnerFixture({
      client,
      session: {
        acpSessionId: 'persisted-acp-session',
        metadata: {
          acpCommandIdentity: JSON.stringify(['old-acp', '--stdio']),
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
      acpSessionId: undefined,
      metadata: expect.objectContaining({
        acpCommandIdentity: JSON.stringify(['mock-acp', '--stdio']),
        acpContextUsageEstimate: undefined,
      }),
    });
    expect(ctx.session.metadata.acpInstructionsSent).toBe(true);
    expect(client.sendPrompt.mock.calls[0][0]).toEqual([
      {
        type: 'text',
        text: 'HyperNeo session instructions:\n\nFollow current rules.',
      },
      { type: 'text', text: 'hello' },
    ]);
  });

  test('preserves an existing ACP session while adopting a legacy command identity', async () => {
    const client = createMockClient();
    client.canLoadSession.mockImplementation(() => true);
    const { runner, ctx } = createRunnerFixture({
      client,
      session: {
        acpSessionId: 'persisted-acp-session',
        metadata: { messageCount: 2 },
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
    expect(ctx.session.metadata.acpCommandIdentity).toBe(JSON.stringify(['mock-acp', '--stdio']));
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
