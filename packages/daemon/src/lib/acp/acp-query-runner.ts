import type { UUID } from 'crypto';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { generateUUID, type MessageContent, type Session } from '@neokai/shared';
import type { AcpContentBlock, AcpMcpServerConfig } from '@neokai/shared/acp';
import type { McpServerConfig, SDKMessage, SDKUserMessage } from '@neokai/shared/sdk';
import { ErrorCategory } from '../error-manager';
import { getProviderService } from '../provider-service';
import { TRANSIENT_CONNECTION_ERROR_SUBSTRINGS } from '../agent/transient-error-patterns';
import type { QueryRunnerContext, TrackedAgentProcess } from '../agent/query-runner';
import { AcpClient, type AcpClientOptions } from './acp-client';
import { AcpQueryAdapter } from './acp-query-adapter';

const DEFAULT_STARTUP_TIMEOUT_MS = 15000;
const RETRY_EXIT_TIMEOUT_MS = 5000;

function getStartupTimeoutMs(): number {
  const raw = process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS;
  if (!raw) return DEFAULT_STARTUP_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STARTUP_TIMEOUT_MS;
}

const STARTUP_TIMEOUT_MS = getStartupTimeoutMs();

export function parseAcpCommand(commandLine: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaping = false;

  for (const char of commandLine.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      continue;
    }

    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      continue;
    }

    if (/\s/.test(char) && !quote) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += '\\';
  if (quote) {
    throw new Error('Invalid NEOKAI_ACP_COMMAND: unmatched quote');
  }
  if (current) tokens.push(current);
  if (tokens.length === 0) {
    throw new Error('Invalid NEOKAI_ACP_COMMAND: command is empty');
  }

  return { command: tokens[0], args: tokens.slice(1) };
}

function toAcpPromptContent(message: SDKUserMessage): AcpContentBlock[] {
  return message.message.content.flatMap((block: MessageContent): AcpContentBlock[] => {
    if (block.type === 'text') {
      return [{ type: 'text', text: block.text }];
    }

    if (block.type === 'image') {
      return [
        {
          type: 'image',
          mimeType: block.source.media_type,
          data: block.source.data,
        },
      ];
    }

    if (block.type === 'tool_result') {
      return [
        {
          type: 'text',
          text: `Tool result for ${block.tool_use_id}:\n${block.content}`,
        },
      ];
    }

    return [{ type: 'text', text: JSON.stringify(block) }];
  });
}

function headersToAcp(
  headers: Record<string, string> | undefined
): { name: string; value: string }[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }));
}

export function convertMcpServersForAcp(
  servers: Options['mcpServers'],
  warn: (message: string) => void = () => {}
): AcpMcpServerConfig[] {
  return Object.entries(servers ?? {}).flatMap(([name, config]): AcpMcpServerConfig[] => {
    if (!config || typeof config !== 'object') return [];
    const server = config as McpServerConfig & { type?: string; instance?: unknown };

    if (server.type === 'sdk' || server.instance) {
      warn(`Skipping in-process MCP server '${name}' for ACP; PR6 will add MCP proxy support.`);
      return [];
    }

    if (!server.type || server.type === 'stdio') {
      if (!('command' in server) || typeof server.command !== 'string') return [];
      return [
        {
          type: 'stdio',
          name,
          command: server.command,
          args: server.args ?? [],
          env: Object.entries(server.env ?? {}).map(([envName, value]) => ({
            name: envName,
            value,
          })),
        },
      ];
    }

    if (server.type === 'http') {
      return [
        {
          type: 'http',
          name,
          url: server.url,
          headers: headersToAcp(server.headers),
        },
      ];
    }

    if (server.type === 'sse') {
      return [
        {
          type: 'sse',
          name,
          url: server.url,
          headers: headersToAcp(server.headers),
        },
      ];
    }

    return [];
  });
}

function getAcpWorkspacePath(session: Session, queryOptions: Options): string {
  return (
    queryOptions.cwd ?? session.worktree?.worktreePath ?? session.workspacePath ?? process.cwd()
  );
}

/**
 * Runs ACP agent sessions with same external lifecycle contract as QueryRunner.
 */
type AcpClientFactory = (options: AcpClientOptions) => AcpClient;

export class AcpQueryRunner {
  private _lastConsumedUserMessage: {
    uuid: string;
    content: string | MessageContent[];
  } | null = null;

  get lastConsumedUserMessage() {
    return this._lastConsumedUserMessage;
  }

  constructor(
    private ctx: QueryRunnerContext,
    private readonly createAcpClient: AcpClientFactory = (options) => new AcpClient(options)
  ) {}

  async start(): Promise<void> {
    const { messageQueue, logger } = this.ctx;

    if (messageQueue.isRunning()) {
      logger.warn(
        `AcpQueryRunner.start(): messageQueue already running for session ${this.ctx.session.id}, ` +
          `skipping start (generation=${messageQueue.getGeneration()}, ` +
          `queryPromise=${this.ctx.queryPromise ? 'active' : 'null'})`
      );
      return;
    }

    logger.debug(
      `AcpQueryRunner.start(): starting query for session ${this.ctx.session.id} ` +
        `(generation=${messageQueue.getGeneration()})`
    );
    messageQueue.start();

    const currentGeneration = this.ctx.incrementQueryGeneration();
    this.ctx.firstMessageReceived = false;
    this.ctx.queryPromise = this.runQuery(currentGeneration);
  }

  private async runQuery(queryGeneration: number, isRetry = false): Promise<void> {
    const { session, messageQueue, stateManager, errorManager, logger, optionsBuilder } = this.ctx;
    let client: AcpClient | null = null;
    let queryStartTime = Date.now();
    let startupTimeoutReached = false;

    try {
      const { initializeProviders, waitForOptionalProviderRegistration } = await import(
        '../providers/factory.js'
      );
      const providerRegistry = initializeProviders();
      await waitForOptionalProviderRegistration();
      const provider = providerRegistry.detectProviderForModel(session.config.model, 'acp');
      if (!provider) {
        throw new Error("Provider 'acp' is not registered.");
      }
      if (provider.isAvailable && !(await provider.isAvailable())) {
        const authStatus = provider.getAuthStatus ? await provider.getAuthStatus() : null;
        const errorMsg = authStatus?.error || 'Please configure credentials.';
        const authError = new Error(
          `Provider ${provider.displayName} is not available. ${errorMsg}`
        );
        await errorManager.handleError(
          session.id,
          authError,
          ErrorCategory.PROVIDER_AUTH_ERROR,
          `Provider ${provider.displayName} is not available. Please configure credentials to continue.`,
          stateManager.getState(),
          { providerId: provider.id, providerName: provider.displayName }
        );
        throw authError;
      }

      if (session.workspacePath) {
        const fs = await import('fs/promises');
        await fs.mkdir(session.workspacePath, { recursive: true });
      }

      optionsBuilder.setCanUseTool(this.ctx.askUserQuestionHandler.createCanUseToolCallback());
      const queryOptions = await optionsBuilder.build();

      const acpCommand = process.env.NEOKAI_ACP_COMMAND;
      if (!acpCommand) {
        throw new Error('Set NEOKAI_ACP_COMMAND to enable ACP agents.');
      }
      const { command, args } = parseAcpCommand(acpCommand);

      const providerService = getProviderService();
      this.ctx.originalEnvVars = providerService.applyEnvVarsToProcessForSession({
        ...session,
        config: { ...session.config, provider: 'acp' },
      });

      const acpMcpServers = convertMcpServersForAcp(queryOptions.mcpServers, (message) =>
        logger.warn(message)
      );
      const cwd = getAcpWorkspacePath(session, queryOptions);
      const abortController = new AbortController();
      this.ctx.queryAbortController = abortController;

      const startupTimer = setTimeout(() => {
        if (!this.ctx.firstMessageReceived) {
          startupTimeoutReached = true;
          const elapsed = Date.now() - queryStartTime;
          logger.error(
            `ACP startup timeout: ACP agent did not respond within ${elapsed}ms. ` +
              `Command: ${command}, workspace: ${cwd} ` +
              `(Hint: set NEOKAI_SDK_STARTUP_TIMEOUT_MS to increase timeout, currently ${STARTUP_TIMEOUT_MS}ms)`
          );
          abortController.abort();
          this.ctx.queryObject?.close();
          client?.close();
        }
      }, STARTUP_TIMEOUT_MS);
      this.ctx.startupTimeoutTimer = startupTimer;

      client = this.createAcpClient({
        command,
        args,
        cwd,
        env: queryOptions.env as Record<string, string> | undefined,
        onProcessSpawn: (proc) =>
          this.ctx.trackAgentProcess(proc as unknown as TrackedAgentProcess),
        onStderr: (data) => logger.warn(`ACP agent stderr: ${data.trimEnd()}`),
      });

      await client.initialize();
      await client.authenticate();
      await client.createSession(cwd, acpMcpServers);
      this.clearStartupTimer();
      this.ctx.firstMessageReceived = true;

      await this.ctx.onModelsFetched().catch((error) => {
        logger.warn('Background fetch of models failed:', error);
      });

      for await (const { message, onSent } of messageQueue.messageGenerator(session.id)) {
        if (abortController.signal.aborted) break;

        const queuedMessage = message as SDKUserMessage & { internal?: boolean };
        if (!queuedMessage.internal) {
          await stateManager.setProcessing(message.uuid ?? 'unknown', 'initializing');
          this._lastConsumedUserMessage = {
            uuid: message.uuid ?? '',
            content: message.message?.content ?? '',
          };
        }

        onSent();

        const adapter = new AcpQueryAdapter(client, toAcpPromptContent(message));
        this.ctx.queryObject = adapter;

        let messageCount = 0;
        for await (const acpMessage of this.createAbortableQuery(adapter, abortController.signal)) {
          if (startupTimeoutReached && !this.ctx.firstMessageReceived) {
            throw new Error('ACP startup timeout - query aborted');
          }

          messageCount++;
          if (!this.ctx.firstMessageReceived) {
            this.clearStartupTimer();
          }
          this.ctx.firstMessageReceived = true;
          await this.handleSDKMessage(acpMessage as SDKMessage);
        }

        if (startupTimeoutReached && messageCount === 0) {
          throw new Error('ACP startup timeout - query aborted');
        }
      }

      if (this.ctx.getQueryGeneration() === queryGeneration) {
        messageQueue.stop();
      }
    } catch (error) {
      const effectiveError =
        startupTimeoutReached && !this.ctx.firstMessageReceived
          ? new Error('ACP startup timeout - query aborted')
          : error;
      await this.handleRunError(effectiveError, queryGeneration, isRetry);
    } finally {
      const isStaleQuery = this.ctx.getQueryGeneration() !== queryGeneration;

      if (!isStaleQuery) {
        this.clearStartupTimer();

        const abortController = this.ctx.queryAbortController;
        if (abortController) {
          abortController.abort();
          this.ctx.queryAbortController = null;
        }

        this.ctx.resetProcessExitedPromise();
        messageQueue.stop();

        if (this.ctx.queryObject) {
          try {
            this.ctx.queryObject.close();
          } catch {
            // Ignore close errors — subprocess may already be terminated
          }
          this.ctx.queryObject = null;
        } else {
          client?.close();
        }

        const originalEnvVars = this.ctx.originalEnvVars;
        if (Object.keys(originalEnvVars).length > 0) {
          getProviderService().restoreEnvVars(originalEnvVars);
          this.ctx.originalEnvVars = {};
        }

        if (!this.ctx.isCleaningUp()) {
          await stateManager.setIdle();
        }

        this.ctx.queryPromise = null;
      }
    }
  }

  private async handleRunError(
    error: unknown,
    queryGeneration: number,
    isRetry: boolean
  ): Promise<void> {
    const { session, messageQueue, stateManager, errorManager, logger } = this.ctx;
    logger.error('ACP query error:', error);

    if (this.ctx.isCleaningUp()) {
      return;
    }

    const errorMessage = String(error);
    const isAbortError = error instanceof Error && error.name === 'AbortError';
    const isQueryInterrupted =
      isAbortError ||
      stateManager.getState().status === 'interrupted' ||
      this.ctx.queryAbortController?.signal.aborted === true;
    const isStartupTimeout = errorMessage.includes('ACP startup timeout');
    const isTransientConnectionError = TRANSIENT_CONNECTION_ERROR_SUBSTRINGS.some((substr) =>
      errorMessage.includes(substr)
    );

    if ((isStartupTimeout || isTransientConnectionError) && !isQueryInterrupted && !isRetry) {
      logger.warn(
        isStartupTimeout
          ? 'Auto-retrying ACP query after startup timeout (1 retry).'
          : 'Auto-retrying ACP query after transient connection error (1 retry).'
      );
      await stateManager.setIdle();

      const lastMsg = this._lastConsumedUserMessage;
      if (lastMsg && isTransientConnectionError) {
        messageQueue.enqueueWithId(lastMsg.uuid, lastMsg.content).catch(() => {});
        this._lastConsumedUserMessage = null;
      }

      if (this.ctx.queryObject) {
        try {
          this.ctx.queryObject.close();
        } catch {
          // Ignore close errors
        }
        this.ctx.queryObject = null;
      }

      const exitPromise = this.ctx.processExitedPromise;
      if (exitPromise) {
        await Promise.race([
          exitPromise,
          new Promise((resolve) => setTimeout(resolve, RETRY_EXIT_TIMEOUT_MS)),
        ]);
        this.ctx.resetProcessExitedPromise();
      }

      return await this.runQuery(queryGeneration, true);
    }

    messageQueue.clear();

    if (!isAbortError) {
      let category = ErrorCategory.SYSTEM;
      const lowerMessage = errorMessage.toLowerCase();

      if (
        errorMessage.includes('401') ||
        errorMessage.includes('403') ||
        lowerMessage.includes('unauthorized') ||
        lowerMessage.includes('not authenticated')
      ) {
        category = ErrorCategory.PROVIDER_AUTH_ERROR;
      } else if (
        errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('ENOTFOUND') ||
        errorMessage.includes('EHOSTUNREACH') ||
        lowerMessage.includes('service unavailable') ||
        errorMessage.includes('503') ||
        errorMessage.includes('502') ||
        isTransientConnectionError
      ) {
        category = ErrorCategory.PROVIDER_UNAVAILABLE;
      } else if (errorMessage.includes('429') || lowerMessage.includes('rate limit')) {
        category = ErrorCategory.RATE_LIMIT;
      } else if (lowerMessage.includes('timeout')) {
        category = ErrorCategory.TIMEOUT;
      } else if (lowerMessage.includes('permission')) {
        category = ErrorCategory.PERMISSION;
      }

      const is429Error = category === ErrorCategory.RATE_LIMIT;
      const rateLimitCooldownScheduled =
        is429Error &&
        !!(await this.ctx.onRateLimitExhausted?.(errorMessage, this._lastConsumedUserMessage));

      if (!rateLimitCooldownScheduled) {
        await errorManager.handleError(
          session.id,
          error instanceof Error ? error : new Error(errorMessage),
          category,
          isStartupTimeout
            ? `The ACP agent failed to start (workspace: ${session.workspacePath ?? 'unbound'}). Check NEOKAI_ACP_COMMAND and resend your message.`
            : undefined,
          stateManager.getState(),
          {
            errorMessage,
            queueSize: messageQueue.size(),
            providerId: 'acp',
            workspacePath: session.workspacePath ?? undefined,
            startupTimeoutMs: STARTUP_TIMEOUT_MS,
          }
        );
        await stateManager.setIdle();
      }
    }
  }

  private async handleSDKMessage(message: SDKMessage): Promise<void> {
    await this.ctx.onSDKMessage(message);
    await this.ctx.onMarkApiSuccess();
  }

  private clearStartupTimer(): void {
    const timer = this.ctx.startupTimeoutTimer;
    if (timer) {
      clearTimeout(timer);
      this.ctx.startupTimeoutTimer = null;
    }
  }

  private async *createAbortableQuery(
    queryObj: AcpQueryAdapter,
    signal: AbortSignal
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const iterator = queryObj[Symbol.asyncIterator]();
    const abortResult = { aborted: true } as const;
    let resolveAbort!: (value: typeof abortResult) => void;
    const abortPromise = new Promise<typeof abortResult>((resolve) => {
      resolveAbort = resolve;
    });
    const onAbort = () => resolveAbort(abortResult);

    try {
      if (signal.aborted) {
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });

      while (!signal.aborted) {
        const result = await Promise.race([iterator.next(), abortPromise]);

        if ('aborted' in result || signal.aborted) {
          break;
        }

        if (result.done) {
          break;
        }

        yield result.value;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      try {
        await iterator.return?.();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async displayErrorAsAssistantMessage(text: string): Promise<void> {
    const { session, db, messageHub } = this.ctx;

    const assistantMessage: SDKMessage = {
      type: 'assistant' as const,
      uuid: generateUUID() as UUID,
      session_id: session.id,
      parent_tool_use_id: null,
      message: {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text }],
      },
    };

    db.saveSDKMessage(session.id, assistantMessage);

    messageHub.event(
      'state.sdkMessages.delta',
      { added: [assistantMessage], timestamp: Date.now() },
      { channel: `session:${session.id}` }
    );
  }
}
