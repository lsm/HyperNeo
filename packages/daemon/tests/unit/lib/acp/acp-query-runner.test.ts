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
    ]);
    expect(warnings[0]).toContain("Skipping in-process MCP server 'live'");
  });

  test('runs ACP lifecycle and forwards translated SDK messages', async () => {
    let queryGeneration = 0;
    const yieldedMessage = makeUserMessage('hello');
    const onSent = mock(() => {});
    const startSpy = mock(() => {});
    const stopSpy = mock(() => {});
    const onSDKMessage = mock(async (_message: SDKMessage) => {});
    const onMarkApiSuccess = mock(async () => {});
    const trackAgentProcess = mock(() => {});
    const mockClient = createMockClient();
    const constructorOptions: AcpClientOptions[] = [];

    const messageQueue = {
      isRunning: mock(() => false),
      getGeneration: mock(() => 0),
      start: startSpy,
      stop: stopSpy,
      clear: mock(() => {}),
      size: mock(() => 0),
      messageGenerator: mock(async function* () {
        yield { message: yieldedMessage, onSent };
      }),
    } as unknown as MessageQueue;

    const session: Session = {
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

    const ctx: QueryRunnerContext = {
      session,
      db: {
        saveSDKMessage: mock(() => {}),
        getNodeExecutionRepo: mock(() => ({ getByAgentSessionId: mock(() => null) })),
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
        build: mock(async () => ({ cwd: '/tmp/acp-session', mcpServers: {} })),
        addSessionStateOptions: mock((options: unknown) => options),
      } as unknown as QueryOptionsBuilder,
      askUserQuestionHandler: {
        createCanUseToolCallback: mock(() => async () => true),
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
    await runner.start();
    await ctx.queryPromise;

    expect(startSpy).toHaveBeenCalled();
    expect(constructorOptions[0].command).toBe('mock-acp');
    expect(constructorOptions[0].args).toEqual(['--stdio']);
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
});
