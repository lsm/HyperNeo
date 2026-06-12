import type { UUID } from 'crypto';
import type { CanUseTool, Options } from '@anthropic-ai/claude-agent-sdk';
import { generateUUID, type MessageContent, type Session } from '@neokai/shared';
import type {
  AcpContentBlock,
  AcpMcpServerConfig,
  AcpPermissionRequest,
  AcpPermissionResponseResult,
} from '@neokai/shared/acp';
import type { McpServerConfig, SDKMessage, SDKUserMessage } from '@neokai/shared/sdk';
import { ErrorCategory } from '../error-manager';
import { getProviderService } from '../provider-service';
import { TRANSIENT_CONNECTION_ERROR_SUBSTRINGS } from '../agent/transient-error-patterns';
import type { QueryRunnerContext, TrackedAgentProcess } from '../agent/query-runner';
import {
  missingMcpServers,
  resolveSpaceMcpSessionPolicy,
} from '../space/runtime/space-mcp-session-policy';
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

function validAcpServerUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).toString();
  } catch {
    return null;
  }
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
      const url = validAcpServerUrl(server.url);
      if (!url) return [];
      return [
        {
          type: 'http',
          name,
          url,
          headers: headersToAcp(server.headers),
        },
      ];
    }

    if (server.type === 'sse') {
      const url = validAcpServerUrl(server.url);
      if (!url) return [];
      return [
        {
          type: 'sse',
          name,
          url,
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

function acpPermissionQuestion(params: AcpPermissionRequest): string {
  return params.toolCall.title
    ? `Allow ${params.toolCall.title}?`
    : `Allow ACP tool ${params.toolCall.toolCallId}?`;
}

function acpPermissionQuestionInput(params: AcpPermissionRequest): Record<string, unknown> {
  const question = acpPermissionQuestion(params);
  return {
    questions: [
      {
        question,
        header: 'ACP approval',
        options: params.options.map((option) => ({
          label: option.name,
          description: option.kind.replaceAll('_', ' '),
        })),
        multiSelect: false,
      },
    ],
  };
}

async function handleAcpPermissionRequest(
  params: AcpPermissionRequest,
  canUseTool: CanUseTool
): Promise<AcpPermissionResponseResult> {
  if (params.options.length === 0) {
    return { outcome: { outcome: 'cancelled' } };
  }

  const controller = new AbortController();
  const question = acpPermissionQuestion(params);
  const result = await canUseTool('AskUserQuestion', acpPermissionQuestionInput(params), {
    signal: controller.signal,
    toolUseID: params.toolCall.toolCallId,
    title: question,
    displayName: params.toolCall.title ?? params.toolCall.kind ?? 'ACP tool',
    description: params.toolCall.kind,
  });

  if (result.behavior === 'deny') {
    return { outcome: { outcome: 'cancelled' } };
  }

  const answers = (result.updatedInput as { answers?: Record<string, string> } | undefined)
    ?.answers;
  const selectedName = answers?.[question] ?? Object.values(answers ?? {})[0];
  const selectedOption = params.options.find((option) => option.name === selectedName);

  if (selectedOption) {
    return { outcome: { outcome: 'selected', optionId: selectedOption.optionId } };
  }

  return { outcome: { outcome: 'cancelled' } };
}

function systemPromptText(systemPrompt: Options['systemPrompt']): string[] {
  if (!systemPrompt) return [];
  if (typeof systemPrompt === 'string') return [systemPrompt];
  if (Array.isArray(systemPrompt)) return systemPrompt;
  return [systemPrompt.append].filter((text): text is string => !!text?.trim());
}

function agentPromptText(queryOptions: Options): string[] {
  const agentName = queryOptions.agent;
  if (!agentName || !queryOptions.agents) return [];
  const agent = queryOptions.agents[agentName] as
    | { prompt?: string; description?: string }
    | undefined;
  if (!agent) return [];
  return [
    agent.prompt,
    agent.description ? `Agent: ${agentName}\n${agent.description}` : undefined,
  ].filter((text): text is string => !!text?.trim());
}

function acpInstructionBlocks(queryOptions: Options): AcpContentBlock[] {
  const text = [...systemPromptText(queryOptions.systemPrompt), ...agentPromptText(queryOptions)]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
  if (!text) return [];
  return [
    {
      type: 'text',
      text: `NeoKai session instructions:\n\n${text}`,
    },
  ];
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
    let createdAcpSessionDuringRun = false;
    let receivedAcpMessageDuringRun = false;
    let restoreMessageEnqueuedHandler: (() => void) | undefined;

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

      const canUseTool = this.ctx.askUserQuestionHandler.createCanUseToolCallback();
      optionsBuilder.setCanUseTool(canUseTool);
      let queryOptions = await optionsBuilder.build();
      queryOptions = await this.ensureRequiredMcpServersForAcp(queryOptions);

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
      const startupTimeoutMs = getStartupTimeoutMs();
      const abortController = new AbortController();
      this.ctx.queryAbortController = abortController;
      const instructionBlocks = acpInstructionBlocks(queryOptions);
      const hasInstructionBlocks = instructionBlocks.length > 0;
      const hasPriorAcpTurn = (session.metadata?.messageCount ?? 0) > 0;
      let prependInstructionsToNextPrompt =
        hasInstructionBlocks &&
        !(session.acpSessionId && (session.metadata?.acpInstructionsSent || hasPriorAcpTurn));
      let startupHandshakeActive = true;
      let restoredMessageEnqueuedHandler = false;
      const previousOnMessageEnqueued = messageQueue.onMessageEnqueued;

      const startStartupTimer = (hasFirstMessage: () => boolean) => {
        this.clearStartupTimer();
        startupTimeoutReached = false;
        queryStartTime = Date.now();
        this.ctx.startupTimeoutTimer = setTimeout(() => {
          if (!hasFirstMessage()) {
            startupTimeoutReached = true;
            const elapsed = Date.now() - queryStartTime;
            logger.error(
              `ACP startup timeout: ACP agent did not respond within ${elapsed}ms. ` +
                `Command: ${command}, workspace: ${cwd} ` +
                `(Hint: set NEOKAI_SDK_STARTUP_TIMEOUT_MS to increase timeout, currently ${startupTimeoutMs}ms)`
            );
            abortController.abort();
            this.ctx.queryObject?.close();
            client?.close();
          }
        }, startupTimeoutMs);
      };

      const onMessageEnqueued = (messageId: string, queuedAt: number) => {
        previousOnMessageEnqueued?.(messageId, queuedAt);
        if (!startupHandshakeActive || this.ctx.startupTimeoutTimer) return;
        startStartupTimer(() => false);
      };

      restoreMessageEnqueuedHandler = () => {
        if (restoredMessageEnqueuedHandler) return;
        restoredMessageEnqueuedHandler = true;
        if (messageQueue.onMessageEnqueued === onMessageEnqueued) {
          messageQueue.onMessageEnqueued = previousOnMessageEnqueued;
        }
      };
      messageQueue.onMessageEnqueued = onMessageEnqueued;

      client = this.createAcpClient({
        command,
        args,
        cwd,
        env: queryOptions.env as Record<string, string> | undefined,
        onProcessSpawn: (proc) =>
          this.ctx.trackAgentProcess(proc as unknown as TrackedAgentProcess),
        onStderr: (data) => logger.warn(`ACP agent stderr: ${data.trimEnd()}`),
        onPermissionRequest: (params) => handleAcpPermissionRequest(params, canUseTool),
      });

      if (messageQueue.size() > 0) {
        startStartupTimer(() => false);
      }

      await client.initialize();
      await client.authenticate();
      const existingAcpSessionId = session.acpSessionId;
      if (existingAcpSessionId) {
        if (!client.canLoadSession()) {
          throw new Error(
            `ACP agent cannot resume existing ACP session ${existingAcpSessionId}: ` +
              'agent does not advertise session load/resume capability. ' +
              'Reset Agent to start a new ACP conversation.'
          );
        }

        try {
          const result = await client.loadSession(existingAcpSessionId, cwd, acpMcpServers);
          this.persistAcpSessionId(result.sessionId);
        } catch (loadError) {
          try {
            const result = await client.resumeSession(existingAcpSessionId, cwd, acpMcpServers);
            this.persistAcpSessionId(result.sessionId);
          } catch (resumeError) {
            const loadMessage = loadError instanceof Error ? loadError.message : String(loadError);
            const resumeMessage =
              resumeError instanceof Error ? resumeError.message : String(resumeError);
            throw new Error(
              `Failed to resume ACP session ${existingAcpSessionId}. ` +
                `session/load failed: ${loadMessage}; ` +
                `session/resume failed: ${resumeMessage}. ` +
                'Reset Agent to start a new ACP conversation.'
            );
          }
        }
      } else {
        const result = await client.createSession(cwd, acpMcpServers);
        this.persistAcpSessionId(result.sessionId);
        createdAcpSessionDuringRun = true;
      }
      startupHandshakeActive = false;
      restoreMessageEnqueuedHandler?.();
      this.clearStartupTimer();

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

        const promptContent = prependInstructionsToNextPrompt
          ? [...instructionBlocks, ...toAcpPromptContent(message)]
          : toAcpPromptContent(message);
        const shouldPersistInstructionsSent = prependInstructionsToNextPrompt;
        prependInstructionsToNextPrompt = false;
        const adapter = new AcpQueryAdapter(client, promptContent);
        this.ctx.queryObject = adapter;

        this.ctx.firstMessageReceived = false;
        let promptMessageReceived = false;
        startStartupTimer(() => promptMessageReceived);

        let messageCount = 0;
        for await (const acpMessage of this.createAbortableQuery(adapter, abortController.signal)) {
          if (startupTimeoutReached && messageCount === 0) {
            throw new Error('ACP startup timeout - query aborted');
          }

          messageCount++;
          if (messageCount === 1) {
            promptMessageReceived = true;
            receivedAcpMessageDuringRun = true;
            if (shouldPersistInstructionsSent) {
              this.persistAcpInstructionsSent();
            }
            this.clearStartupTimer();
          }
          this.ctx.firstMessageReceived = true;

          try {
            await this.handleSDKMessage(acpMessage as SDKMessage);
          } catch (error) {
            logger.error('Error handling ACP SDK message:', error);
            logger.error('Message type:', (acpMessage as SDKMessage).type);

            if (!this.ctx.isCleaningUp()) {
              const processingState = stateManager.getState();
              await stateManager.setIdle();

              await errorManager.handleError(
                session.id,
                error as Error,
                ErrorCategory.MESSAGE,
                'Error processing ACP message. The session has been reset.',
                processingState,
                { messageType: (acpMessage as SDKMessage).type, providerId: 'acp' }
              );
            }
          }
        }

        if (startupTimeoutReached && messageCount === 0) {
          throw new Error('ACP startup timeout - query aborted');
        }
      }

      if (this.ctx.getQueryGeneration() === queryGeneration) {
        messageQueue.stop();
      }
    } catch (error) {
      restoreMessageEnqueuedHandler?.();
      const effectiveError =
        startupTimeoutReached && !this.ctx.firstMessageReceived
          ? new Error('ACP startup timeout - query aborted')
          : error;
      await this.handleRunError(
        effectiveError,
        queryGeneration,
        isRetry,
        client,
        createdAcpSessionDuringRun,
        receivedAcpMessageDuringRun
      );
    } finally {
      restoreMessageEnqueuedHandler?.();
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
    isRetry: boolean,
    client?: AcpClient | null,
    createdAcpSessionDuringRun = false,
    receivedAcpMessageDuringRun = false
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

    if (
      (isStartupTimeout || (isTransientConnectionError && !isQueryInterrupted)) &&
      !isRetry &&
      !this.ctx.isCleaningUp()
    ) {
      logger.warn(
        isStartupTimeout
          ? 'Auto-retrying ACP query after startup timeout (1 retry).'
          : 'Auto-retrying ACP query after transient connection error (1 retry).'
      );
      await stateManager.setIdle();

      if (isStartupTimeout && createdAcpSessionDuringRun && !receivedAcpMessageDuringRun) {
        this.persistAcpSessionId(undefined);
      }

      const lastMsg = this._lastConsumedUserMessage;
      if (lastMsg && (isStartupTimeout || isTransientConnectionError)) {
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
      } else {
        client?.close();
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
      const userMessage = isStartupTimeout
        ? `The ACP agent failed to start (workspace: ${session.workspacePath ?? 'unbound'}). Check NEOKAI_ACP_COMMAND and resend your message.`
        : errorMessage.includes('[MCP invariant]')
          ? errorMessage
          : undefined;

      if (!rateLimitCooldownScheduled) {
        await errorManager.handleError(
          session.id,
          error instanceof Error ? error : new Error(errorMessage),
          category,
          userMessage,
          stateManager.getState(),
          {
            errorMessage,
            queueSize: messageQueue.size(),
            providerId: 'acp',
            workspacePath: session.workspacePath ?? undefined,
            startupTimeoutMs: getStartupTimeoutMs(),
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

  private async ensureRequiredMcpServersForAcp(queryOptions: Options): Promise<Options> {
    const { session, logger } = this.ctx;
    const policy = resolveSpaceMcpSessionPolicy(session, {
      nodeExecutionRepo: this.ctx.db.getNodeExecutionRepo(),
      taskRepo: this.ctx.db.getSpaceTaskRepo(),
    });
    if (policy.requiredServers.length === 0) return queryOptions;

    let currentOptions = queryOptions;
    let missing = missingMcpServers(
      currentOptions.mcpServers as Record<string, unknown> | undefined,
      policy.requiredServers
    );

    if (missing.length > 0) {
      logger.error(
        `AcpQueryRunner.start(): session ${session.id} is missing required Space MCP servers. ` +
          `Missing: [${missing.join(', ')}]. ACP cannot proxy in-process SDK MCP servers yet. ` +
          `${JSON.stringify({
            event: 'acp.space.mcp.missing',
            sessionId: session.id,
            spaceId: policy.spaceId,
            sessionType: session.type,
            role: policy.role,
            owner: policy.owner,
            requiredServers: policy.requiredServers,
            missingServers: missing,
            presentServers: Object.keys(currentOptions.mcpServers ?? {}).sort(),
            selfHealAttempted: this.hasSpaceMcpSelfHealCallback(policy),
          })}`
      );

      await this.runSpaceMcpSelfHeal(policy, missing);
      currentOptions = await this.ctx.optionsBuilder.build();
      currentOptions = this.ctx.optionsBuilder.addSessionStateOptions(currentOptions);
      missing = missingMcpServers(
        currentOptions.mcpServers as Record<string, unknown> | undefined,
        policy.requiredServers
      );

      if (missing.length > 0) {
        throw new Error(
          `[MCP invariant] ACP session ${session.id} missing required Space MCP servers: ` +
            `[${missing.join(', ')}]. Refusing to start a degraded Space turn. ` +
            `ACP cannot proxy in-process SDK MCP servers yet.`
        );
      }
    }

    const stillInProcess = policy.requiredServers.filter((serverName) => {
      const server = (currentOptions.mcpServers as Record<string, unknown> | undefined)?.[
        serverName
      ];
      return (
        !!server &&
        typeof server === 'object' &&
        ('instance' in server || (server as { type?: unknown }).type === 'sdk')
      );
    });
    if (stillInProcess.length > 0) {
      throw new Error(
        `[MCP invariant] ACP session ${session.id} requires in-process Space MCP servers ` +
          `[${stillInProcess.join(', ')}], but ACP cannot proxy SDK MCP servers yet. ` +
          `Refusing to start a degraded Space turn.`
      );
    }

    return currentOptions;
  }

  private hasSpaceMcpSelfHealCallback(
    policy: ReturnType<typeof resolveSpaceMcpSessionPolicy>
  ): boolean {
    if (policy.isWorkflowWorker) return !!this.ctx.onMissingWorkflowMcpServers;
    if (policy.attachCoordinatorTools) return !!this.ctx.onMissingSpaceChatMcpServers;
    if (policy.attachGenericSpaceTools || policy.attachLongTermAgentTools) {
      return !!this.ctx.onMissingMemberSpaceMcpServers;
    }
    return false;
  }

  private async runSpaceMcpSelfHeal(
    policy: ReturnType<typeof resolveSpaceMcpSessionPolicy>,
    missing: string[]
  ): Promise<void> {
    if (policy.isWorkflowWorker && this.ctx.onMissingWorkflowMcpServers) {
      await this.ctx.onMissingWorkflowMcpServers(this.ctx.session.id, missing);
      return;
    }
    if (policy.attachCoordinatorTools && this.ctx.onMissingSpaceChatMcpServers) {
      await this.ctx.onMissingSpaceChatMcpServers(this.ctx.session.id, missing);
      return;
    }
    if (
      (policy.attachGenericSpaceTools || policy.attachLongTermAgentTools) &&
      this.ctx.onMissingMemberSpaceMcpServers
    ) {
      await this.ctx.onMissingMemberSpaceMcpServers(this.ctx.session.id, missing);
    }
  }

  private persistAcpSessionId(acpSessionId: string | undefined): void {
    const { session, db } = this.ctx;
    if (session.acpSessionId === acpSessionId) return;
    session.acpSessionId = acpSessionId;
    db.updateSession(session.id, { acpSessionId });
  }

  private persistAcpInstructionsSent(): void {
    const { session, db } = this.ctx;
    if (session.metadata?.acpInstructionsSent) return;
    session.metadata = {
      ...session.metadata,
      acpInstructionsSent: true,
    };
    db.updateSession(session.id, { metadata: session.metadata });
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
    const { session, db, messageHub, logger } = this.ctx;

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

    try {
      db.saveSDKMessage(session.id, assistantMessage);
    } catch (error) {
      logger.warn('Failed to persist ACP assistant error message:', error);
      return;
    }

    messageHub.event(
      'state.sdkMessages.delta',
      { added: [assistantMessage], timestamp: Date.now() },
      { channel: `session:${session.id}` }
    );
  }
}
