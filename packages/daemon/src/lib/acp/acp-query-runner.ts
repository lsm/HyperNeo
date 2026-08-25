import type { UUID } from 'crypto';
import { fileURLToPath } from 'node:url';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import {
  generateUUID,
  THINKING_LEVEL_TOKENS,
  type MessageContent,
  type Session,
} from '@hyperneo/shared';
import type {
  AcpConfigOption,
  AcpContentBlock,
  AcpFsReadParams,
  AcpFsReadResult,
  AcpFsWriteParams,
  AcpFsWriteResult,
  AcpMcpServerConfig,
  AcpPermissionRequest,
  AcpPermissionResponseResult,
  AcpTerminalCreateParams,
  AcpTerminalKillParams,
  AcpTerminalOutputParams,
  AcpTerminalReleaseParams,
  AcpTerminalWaitForExitParams,
} from '@hyperneo/shared/acp';
import type { McpServerConfig, SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import { ErrorCategory } from '../error-manager.ts';
import { updateProviderModelsInCache } from '../model-service.ts';
import { getProviderRegistry } from '../providers/factory.ts';
import { getProviderService, getUserConfiguredAnthropicEnv } from '../provider-service.ts';
import { AcpProvider } from '../providers/acp-provider.ts';
import { TRANSIENT_CONNECTION_ERROR_SUBSTRINGS } from '../agent/transient-error-patterns.ts';
import { drainDeliveryWaitersOnTerminalSDKMessage } from '../agent/message-delivery.ts';
import { assessLimitError } from '../agent/limit-error-classifier.ts';
import type { AgentSession } from '../agent/agent-session.ts';
import {
  refreshQueryEnvFromProcess,
  type QueryRunnerContext,
  type TrackedAgentProcess,
} from '../agent/query-runner.ts';
import {
  missingMcpServers,
  resolveSpaceMcpSessionPolicy,
} from '../space/runtime/space-mcp-session-policy.ts';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { AcpClient, type AcpClientOptions } from './acp-client.ts';
import { buildAcpSafeEnv, getAcpCommandIdentityDigest, parseAcpCommand } from './acp-command.ts';
import { getAcpProcessTreeOwner } from './acp-process-tree.ts';
import { AcpQueryAdapter } from './acp-query-adapter.ts';
import {
  isSafeFsSupported,
  readFileWithinWorkspace,
  writeFileWithinWorkspace,
} from './acp-safe-fs.ts';
import { AcpTerminalManager } from './acp-terminal-manager.ts';
import { AcpMcpProxyBridge, shouldProxy } from './mcp-proxy-bridge.ts';

const DEFAULT_STARTUP_TIMEOUT_MS = 15000;
const RETRY_EXIT_TIMEOUT_MS = 5000;
const MAX_FS_READ_BYTES = 4 * 1024 * 1024;
const MAX_POST_ABORT_DRAIN_MESSAGES = 256;
const POST_ABORT_DRAIN_TIMEOUT_MS = 1000;

function getStartupTimeoutMs(): number {
  const raw = process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
  if (!raw) return DEFAULT_STARTUP_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STARTUP_TIMEOUT_MS;
}

function getAcpContextWindow(): number {
  const provider = getProviderRegistry().get('acp');
  return provider instanceof AcpProvider
    ? provider.getContextWindow()
    : AcpProvider.DEFAULT_CONTEXT_WINDOW;
}

function flattenConfigChoices(option: AcpConfigOption): Array<{ name: string; value: string }> {
  return option.options.flatMap((entry) => ('options' in entry ? entry.options : [entry]));
}

function getAcpContextUsageEstimate(session: Session): number | undefined {
  return (session.metadata as { acpContextUsageEstimate?: number } | undefined)
    ?.acpContextUsageEstimate;
}

function selectThoughtLevelValue(option: AcpConfigOption, tokens: number | null): string {
  const choices = flattenConfigChoices(option);
  if (choices.length === 0) return option.currentValue;

  if (!tokens || tokens <= 0) {
    return choices.find(isOffThoughtChoice)?.value ?? choices[0].value;
  }

  const exact = choices.find((choice) => parseThoughtTokenValue(choice) === tokens);
  if (exact) return exact.value;

  const enabledChoices = choices.filter((choice) => !isOffThoughtChoice(choice));
  if (enabledChoices.length === 0) return option.currentValue;

  const sorted = [...enabledChoices].sort(
    (a, b) => (parseThoughtTokenValue(a) ?? 0) - (parseThoughtTokenValue(b) ?? 0)
  );
  const sizedChoices = sorted.filter((choice) => parseThoughtTokenValue(choice) !== undefined);
  if (sizedChoices.length > 0) {
    return (
      sizedChoices.find((choice) => (parseThoughtTokenValue(choice) ?? 0) >= tokens)?.value ??
      sizedChoices.at(-1)!.value
    );
  }

  if (enabledChoices.length === 1) return enabledChoices[0].value;
  if (enabledChoices.length === 2) return enabledChoices[tokens >= 8000 ? 1 : 0].value;

  const index = tokens >= 24000 ? enabledChoices.length - 1 : tokens >= 16000 ? 1 : 0;
  return enabledChoices[Math.min(index, enabledChoices.length - 1)].value;
}

function isOffThoughtChoice(choice: { name: string; value: string }): boolean {
  const text = `${choice.value} ${choice.name}`.toLowerCase();
  return /\b(off|none|disabled|disable|false|0)\b/.test(text);
}

function parseThoughtTokenValue(choice: { name: string; value: string }): number | undefined {
  const text = `${choice.value} ${choice.name}`.toLowerCase();
  const match = text.match(/(?:think)?(\d+)k\b/);
  if (match) return Number(match[1]) * 1000;
  return undefined;
}

export { parseAcpCommand } from './acp-command.ts';

function toAcpPromptContent(message: SDKUserMessage): AcpContentBlock[] {
  const content = message.message.content;
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  return (content as MessageContent[]).flatMap((block: MessageContent): AcpContentBlock[] => {
    if (block.type === 'text') {
      return [{ type: 'text', text: block.text }];
    }

    if (block.type === 'image' && block.source.type === 'base64') {
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
  warn: (message: string) => void = () => {},
  proxyBridge?: AcpMcpProxyBridge
): AcpMcpServerConfig[] {
  return Object.entries(servers ?? {}).flatMap(([name, config]): AcpMcpServerConfig[] => {
    if (!config || typeof config !== 'object') return [];
    const server = config as McpServerConfig & { type?: string; instance?: unknown };

    if (server.type === 'sdk' || server.instance) {
      if (proxyBridge && shouldProxy(name, server)) {
        const tools = proxyBridge.getToolsForServer(name);
        if (tools.length === 0) {
          warn(`Skipping ACP proxy for in-process MCP server '${name}'; no callable tools found.`);
          return [];
        }
        return [
          {
            type: 'stdio',
            name,
            command: process.execPath,
            args: [
              import.meta.url.includes('/$bunfs/root/')
                ? '--hyperneo-acp-mcp-proxy'
                : fileURLToPath(new URL('./mcp-proxy-server.ts', import.meta.url)),
              '--socketPath',
              proxyBridge.socketPath,
              '--serverName',
              name,
              '--token',
              proxyBridge.token,
              '--toolsPath',
              proxyBridge.getToolsPathForServer(name) ?? proxyBridge.toolsPath,
            ],
            env: [],
          },
        ];
      }
      warn(
        proxyBridge
          ? `Skipping in-process MCP server '${name}' for ACP; server is not proxy-enabled.`
          : `Skipping in-process MCP server '${name}' for ACP; no proxy bridge was provided.`
      );
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

function getAcpWorkspacePath(session: Session, queryOptions: Options): string | undefined {
  return queryOptions.cwd ?? session.worktree?.worktreePath ?? session.workspacePath ?? undefined;
}

function normalizeAcpTerminalCreate(params: AcpTerminalCreateParams): AcpTerminalCreateParams {
  if (params.cwd != null || (params.env?.length ?? 0) > 0) {
    throw new Error('ACP terminal cwd and environment overrides are not supported');
  }
  const parsed =
    params.args === undefined
      ? parseAcpCommand(params.command)
      : { command: params.command, args: params.args };
  return {
    ...params,
    command: parsed.command,
    args: parsed.args,
    cwd: undefined,
    env: undefined,
  };
}

async function allowAcpPermissionRequest(
  params: AcpPermissionRequest
): Promise<AcpPermissionResponseResult> {
  const option =
    params.options.find((candidate) => candidate.kind.startsWith('allow')) ?? params.options[0];
  if (!option) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId: option.optionId } };
}

function isAcpToolResultMessage(message: SDKMessage): boolean {
  return message.type === 'user' && (message as SDKUserMessage).parent_tool_use_id != null;
}

function isAcpToolUseMessage(message: SDKMessage): boolean {
  if (message.type !== 'assistant') return false;
  const content = (message as { message?: { content?: unknown } }).message?.content;
  return (
    Array.isArray(content) &&
    content.some((block) => (block as { type?: string } | null)?.type === 'tool_use')
  );
}

function isAcpPostAbortRelevantMessage(message: SDKMessage): boolean {
  return isAcpToolResultMessage(message) || isAcpToolUseMessage(message);
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
      text: `HyperNeo session instructions:\n\n${text}`,
    },
  ];
}

type AcpClientFactory = (options: AcpClientOptions) => AcpClient;

export class AcpQueryRunner {
  private pendingAcpIdentityMetadata = false;

  private _lastConsumedUserMessage: {
    uuid: string;
    content: string | MessageContent[];
  } | null = null;

  get lastConsumedUserMessage() {
    return this._lastConsumedUserMessage;
  }

  resolveRetryUserMessage(
    _userMessageUuid?: string
  ): { uuid: string; content: string | MessageContent[] } | null {
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

  private async runQuery(
    queryGeneration: number,
    isRetry = false,
    recoveryState = { rateLimitCooldownScheduled: false }
  ): Promise<void> {
    const { session, messageQueue, stateManager, errorManager, logger, optionsBuilder } = this.ctx;
    const assertActiveAcpStartup = () => {
      if (
        this.ctx.isCleaningUp() ||
        this.ctx.getQueryGeneration() !== queryGeneration ||
        stateManager.getState().status === 'interrupted'
      ) {
        const error = new Error('ACP query aborted during startup');
        error.name = 'AbortError';
        throw error;
      }
    };
    let client: AcpClient | null = null;
    let queryStartTime = Date.now();
    let startupTimeoutReached = false;
    let createdAcpSessionDuringRun = false;
    let receivedAcpMessageDuringRun = false;
    let restoreMessageEnqueuedHandler: (() => void) | undefined;
    let proxyBridge: AcpMcpProxyBridge | null = null;
    let terminalManager: AcpTerminalManager | null = null;
    let turnCompletedNormally = false;
    let runAbortController: AbortController | null = this.ctx.queryAbortController;

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

      const acpCommand =
        provider instanceof AcpProvider
          ? provider.getAcpCommand()
          : process.env.HYPERNEO_ACP_COMMAND;
      if (!acpCommand) {
        throw new Error('Set HYPERNEO_ACP_COMMAND to enable ACP agents.');
      }
      const { command, args } = parseAcpCommand(acpCommand);
      const commandIdentity = getAcpCommandIdentityDigest(acpCommand);
      const storedIdentity = session.metadata?.acpCommandIdentity;
      if (storedIdentity !== commandIdentity) {
        if (session.acpSessionId && storedIdentity !== undefined) {
          session.acpSessionId = undefined;
          session.metadata = {
            ...session.metadata,
            acpInstructionsSent: undefined,
            acpContextUsageEstimate: undefined,
          };
        }
        session.metadata = {
          ...session.metadata,
          acpCommandIdentity: commandIdentity,
        };
        this.pendingAcpIdentityMetadata = true;
      }
      const preCleanupAuth = {
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
        CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      };
      const providerService = getProviderService();
      this.ctx.originalEnvVars = providerService.applyEnvVarsToProcessForSession({
        ...session,
        config: { ...session.config, provider: 'acp' },
      });

      proxyBridge = new AcpMcpProxyBridge(
        (queryOptions.mcpServers ?? {}) as Record<string, McpServerConfig>
      );
      if (proxyBridge.tools.length > 0) {
        await proxyBridge.start();
      }
      const acpMcpServers = convertMcpServersForAcp(
        queryOptions.mcpServers,
        (message) => logger.warn(message),
        proxyBridge
      );
      const workspace = getAcpWorkspacePath(session, queryOptions);
      const cwd = workspace ?? process.cwd();
      const startupTimeoutMs = getStartupTimeoutMs();
      assertActiveAcpStartup();
      const abortController = new AbortController();
      this.ctx.queryAbortController = abortController;
      runAbortController = abortController;
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
                `(Hint: set HYPERNEO_SDK_STARTUP_TIMEOUT_MS to increase timeout, currently ${startupTimeoutMs}ms)`
            );
            abortController.abort();
            try {
              client?.cancel();
              if (client?.canCloseSession()) {
                client.closeSession().catch(() => {});
              }
            } catch {}
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

      const acpEnv = refreshQueryEnvFromProcess(queryOptions.env, process.env, {
        refreshAutoCompactWindow: true,
        omitProviderManaged: true,
        omitProviderManagedPreserveAuth: true,
      });
      const userEnv = getUserConfiguredAnthropicEnv();
      for (const [key, value] of Object.entries(userEnv)) {
        if (key === 'ANTHROPIC_AUTH_TOKEN' && !value.startsWith('sk-ant-oat')) continue;
        acpEnv[key] = value;
      }
      if (preCleanupAuth.ANTHROPIC_AUTH_TOKEN?.startsWith('sk-ant-oat')) {
        acpEnv.ANTHROPIC_AUTH_TOKEN = preCleanupAuth.ANTHROPIC_AUTH_TOKEN;
      }
      if (preCleanupAuth.CLAUDE_CODE_OAUTH_TOKEN) {
        acpEnv.CLAUDE_CODE_OAUTH_TOKEN = preCleanupAuth.CLAUDE_CODE_OAUTH_TOKEN;
      }

      const processTreeOwner = await getAcpProcessTreeOwner();
      const hostCallbacks = workspace
        ? (() => {
            const manager = new AcpTerminalManager(
              buildAcpSafeEnv(acpEnv),
              workspace,
              processTreeOwner
            );
            terminalManager = manager;
            return {
              onTerminalCreate: async (params: AcpTerminalCreateParams) => {
                const normalized = normalizeAcpTerminalCreate(params);
                if (abortController.signal.aborted) {
                  throw new Error('ACP terminal command cancelled');
                }
                return manager.create(normalized);
              },
              onTerminalOutput: (params: AcpTerminalOutputParams) => manager.output(params),
              onTerminalWaitForExit: (params: AcpTerminalWaitForExitParams) =>
                manager.waitForExit(params),
              onTerminalKill: (params: AcpTerminalKillParams) => manager.kill(params),
              onTerminalRelease: (params: AcpTerminalReleaseParams) => manager.release(params),
              ...(isSafeFsSupported()
                ? {
                    onFsRead: (params: AcpFsReadParams) => this.handleFsRead(params, workspace),
                    onFsWrite: (params: AcpFsWriteParams) =>
                      this.handleFsWrite(params, workspace, abortController.signal),
                  }
                : {}),
            };
          })()
        : {};
      assertActiveAcpStartup();
      client = this.createAcpClient({
        command,
        args,
        cwd,
        env: acpEnv as Record<string, string> | undefined,
        processTreeOwner,
        onProcessSpawn: (proc) =>
          this.ctx.trackAgentProcess(proc as unknown as TrackedAgentProcess),
        onStderr: (data) => logger.warn(`ACP agent stderr: ${data.trimEnd()}`),
        onPermissionRequest: allowAcpPermissionRequest,
        ...hostCallbacks,
      });
      assertActiveAcpStartup();

      if (messageQueue.size() > 0) {
        startStartupTimer(() => false);
      }

      await client.initialize();
      await client.authenticate();
      assertActiveAcpStartup();
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
          this.updateAcpModelCache(result.configOptions, { syncSessionModel: false });
        } catch (loadError) {
          try {
            const result = await client.resumeSession(existingAcpSessionId, cwd, acpMcpServers);
            this.persistAcpSessionId(result.sessionId);
            this.updateAcpModelCache(result.configOptions, { syncSessionModel: false });
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
        this.updateAcpModelCache(result.configOptions, { syncSessionModel: false });
        createdAcpSessionDuringRun = true;
      }
      await this.applyStoredAcpModel(client);
      await this.applyStoredAcpThinkingLevel(client);
      this.updateAcpModelCache(client.getConfigOptions());
      startupHandshakeActive = false;
      restoreMessageEnqueuedHandler?.();
      this.clearStartupTimer();

      await this.ctx.onModelsFetched().catch((error) => {
        logger.warn('Background fetch of models failed:', error);
      });
      assertActiveAcpStartup();

      for await (const { message, onSent } of messageQueue.messageGenerator(session.id, {
        suppressPreYieldCallback: true,
      })) {
        if (abortController.signal.aborted) break;
        if (this.ctx.isLimitRecoveryPending?.()) {
          logger.info(
            'ACP prompt loop: limit recovery engaged; requeueing prompt until the retry.'
          );
          const yieldedUuid = (message as SDKUserMessage).uuid;
          if (yieldedUuid && !messageQueue.requeueYielded(yieldedUuid)) {
            logger.warn(`ACP prompt loop: could not requeue yielded prompt ${yieldedUuid}.`);
          }
          break;
        }

        const queuedMessage = message as SDKUserMessage & { internal?: boolean };
        if (!queuedMessage.internal) {
          await stateManager.setProcessing(message.uuid ?? 'unknown', 'initializing');
          this._lastConsumedUserMessage = {
            uuid: message.uuid ?? '',
            content: (message.message?.content ?? '') as unknown as string | MessageContent[],
          };
        }

        await this.applyStoredAcpThinkingLevel(client);

        const promptContent = prependInstructionsToNextPrompt
          ? [...instructionBlocks, ...toAcpPromptContent(message)]
          : toAcpPromptContent(message);
        const shouldPersistInstructionsSent = prependInstructionsToNextPrompt;
        prependInstructionsToNextPrompt = false;
        let submitted = false;
        let accepted = false;
        const adapter = new AcpQueryAdapter(client, promptContent, {
          contextWindow: getAcpContextWindow(),
          initialUsageEstimate: getAcpContextUsageEstimate(session),
          onContextUsageUpdate: (used) => this.persistAcpContextUsageEstimate(used),
          onConfigOptionsUpdate: (configOptions) => this.updateAcpModelCache(configOptions),
          onSubmitted: () => {
            if (submitted) return;
            const persisted = this.ctx.messageHandler.markMessageSubmitted(message.uuid ?? '');
            if (!persisted) {
              throw new Error('ACP prompt was revoked before submission');
            }
            submitted = true;
            onSent();
          },
          onAccepted: () => {
            this.ctx.messageHandler.markMessageAccepted(message.uuid ?? '');
            accepted = true;
          },
        });
        this.ctx.queryObject = adapter;

        this.ctx.firstMessageReceived = false;
        let promptMessageReceived = false;
        startStartupTimer(() => promptMessageReceived);

        let messageCount = 0;
        try {
          for await (const acpMessage of this.createAbortableQuery(
            adapter,
            abortController.signal
          )) {
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

            const sdkMessage = acpMessage as SDKMessage & { user_message_uuid?: string };
            if (sdkMessage.type === 'result' && !sdkMessage.user_message_uuid) {
              sdkMessage.user_message_uuid = message.uuid;
            }

            try {
              await this.handleSDKMessage(acpMessage as SDKMessage);
            } catch (error) {
              logger.error('Error handling ACP SDK message:', error);
              logger.error('Message type:', (acpMessage as SDKMessage).type);

              if (!this.ctx.isCleaningUp()) {
                const processingState = stateManager.getState();
                await drainDeliveryWaitersOnTerminalSDKMessage(
                  stateManager,
                  acpMessage as SDKMessage
                );

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
        } finally {
          if (!accepted) {
            this.ctx.messageHandler.markACPDeliveryFailed(message.uuid ?? '');
          }
        }
      }

      if (this.ctx.getQueryGeneration() === queryGeneration) {
        messageQueue.stop();
      }
      turnCompletedNormally =
        !runAbortController?.signal.aborted && stateManager.getState().status !== 'interrupted';
    } catch (error) {
      restoreMessageEnqueuedHandler?.();
      terminalManager?.dispose();
      terminalManager = null;
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
        receivedAcpMessageDuringRun,
        async () => {
          await proxyBridge?.close();
          proxyBridge = null;
        },
        recoveryState
      );
    } finally {
      restoreMessageEnqueuedHandler?.();
      terminalManager?.dispose();
      await proxyBridge?.close();
      proxyBridge = null;
      const isStaleQuery = this.ctx.getQueryGeneration() !== queryGeneration;

      if (isStaleQuery && client) {
        try {
          client.close();
        } catch {}
      }
      if (!isStaleQuery) {
        this.clearStartupTimer();

        const abortController = this.ctx.queryAbortController;
        if (abortController) {
          abortController.abort();
          this.ctx.queryAbortController = null;
        }

        const processExitSnapshot = this.ctx.processExitedPromise ?? Promise.resolve();
        this.ctx.resetProcessExitedPromise();
        messageQueue.stop();

        if (this.ctx.queryObject) {
          try {
            this.ctx.queryObject.close();
          } catch {}
          this.ctx.queryObject = null;
        } else {
          client?.close();
        }

        const originalEnvVars = this.ctx.originalEnvVars;
        if (Object.keys(originalEnvVars).length > 0) {
          getProviderService().restoreEnvVars(originalEnvVars);
          this.ctx.originalEnvVars = {};
        }

        if (
          !this.ctx.isCleaningUp() &&
          !recoveryState.rateLimitCooldownScheduled &&
          !(this.ctx.isLimitRecoveryPending?.() ?? false) &&
          stateManager.getState().status !== 'rate_limit_cooldown'
        ) {
          await stateManager.setIdle();
          void processExitSnapshot.then(() => {
            if (
              turnCompletedNormally &&
              !this.ctx.isCleaningUp() &&
              stateManager.getState().status === 'idle' &&
              session.config.queryMode !== 'manual'
            ) {
              this.ctx.internalEventBus.publishAsync('query.trigger', { sessionId: session.id });
            }
          });
        }

        this._lastConsumedUserMessage = null;
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
    receivedAcpMessageDuringRun = false,
    closeProxyBridge: () => Promise<void> = async () => {},
    recoveryState = { rateLimitCooldownScheduled: false }
  ): Promise<void> {
    const { session, messageQueue, stateManager, errorManager, logger } = this.ctx;
    logger.error('ACP query error:', error);

    if (this.ctx.isCleaningUp()) {
      return;
    }

    if (this.ctx.getQueryGeneration() !== queryGeneration) {
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
      await stateManager.setIdle({ suppressDeliveryWaiters: true });

      if (isStartupTimeout && createdAcpSessionDuringRun && !receivedAcpMessageDuringRun) {
        this.clearAcpSessionState();
      }

      const lastMsg = this._lastConsumedUserMessage;
      if (lastMsg && (isStartupTimeout || isTransientConnectionError)) {
        messageQueue.enqueueWithId(lastMsg.uuid, lastMsg.content).catch(() => {});
        this._lastConsumedUserMessage = null;
      }

      if (this.ctx.queryObject) {
        try {
          this.ctx.queryObject.close();
        } catch {}
        this.ctx.queryObject = null;
      } else {
        client?.close();
      }
      await closeProxyBridge();

      const exitPromise = this.ctx.processExitedPromise;
      if (exitPromise) {
        await Promise.race([
          exitPromise,
          new Promise((resolve) => setTimeout(resolve, RETRY_EXIT_TIMEOUT_MS)),
        ]);
        this.ctx.resetProcessExitedPromise();
      }

      return await this.runQuery(queryGeneration, true, recoveryState);
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

      const limitAssessment = assessLimitError({ rawText: errorMessage });
      const rateLimitCooldownScheduled =
        limitAssessment.isLimit &&
        !!(await this.ctx.onRateLimitExhausted?.(errorMessage, this._lastConsumedUserMessage, {
          resetAtMs: limitAssessment.resetAtMs,
          kind: limitAssessment.kind,
          billingTerminal: limitAssessment.billingTerminal,
        }));
      if (rateLimitCooldownScheduled) {
        recoveryState.rateLimitCooldownScheduled = true;
      }
      const userMessage = isStartupTimeout
        ? `The ACP agent failed to start (workspace: ${session.workspacePath ?? 'unbound'}). Check HYPERNEO_ACP_COMMAND and resend your message.`
        : errorMessage.includes('[MCP invariant]')
          ? errorMessage
          : undefined;

      if (!recoveryState.rateLimitCooldownScheduled) {
        const terminalFence = stateManager.beginTerminalIdle();
        try {
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
        } catch (reportError) {
          stateManager.cancelTerminalFence(terminalFence);
          throw reportError;
        }
        await stateManager.setIdle({ fence: terminalFence });
      }
    }
  }

  private async handleFsRead(params: AcpFsReadParams, workspace: string): Promise<AcpFsReadResult> {
    const { workspacePath, segments } = await this.resolveWorkspaceSegments(params.path, workspace);
    return {
      content: await readFileWithinWorkspace(workspacePath, segments, {
        startLine: Math.max(0, (params.line ?? 1) - 1),
        lineLimit: params.limit ?? undefined,
        maxBytes: MAX_FS_READ_BYTES,
      }),
    };
  }

  private async handleFsWrite(
    params: AcpFsWriteParams,
    workspace: string,
    signal: AbortSignal
  ): Promise<AcpFsWriteResult> {
    if (signal.aborted) throw new Error('ACP filesystem write cancelled');
    const { workspacePath, segments } = await this.resolveWorkspaceSegments(params.path, workspace);
    await writeFileWithinWorkspace(workspacePath, segments, params.content, signal);
    return {};
  }

  private async resolveWorkspaceSegments(
    path: string,
    workspace: string
  ): Promise<{ workspacePath: string; segments: string[] }> {
    const { realpath } = await import('node:fs/promises');
    const workspacePath = await realpath(workspace);
    const lexicalWorkspace = resolve(workspace);
    const requestedPath = isAbsolute(path) ? resolve(path) : resolve(lexicalWorkspace, path);
    let relativePath = relative(lexicalWorkspace, requestedPath);
    try {
      this.assertWorkspacePath(requestedPath, lexicalWorkspace, path);
    } catch {
      this.assertWorkspacePath(requestedPath, workspacePath, path);
      relativePath = relative(workspacePath, requestedPath);
    }
    if (!relativePath) throw new Error(`ACP filesystem path must identify a file: ${path}`);
    return { workspacePath, segments: relativePath.split(sep) };
  }

  private assertWorkspacePath(path: string, workspace: string, requestedPath: string): void {
    const relativePath = relative(workspace, path);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`ACP filesystem path escapes workspace: ${requestedPath}`);
    }
  }

  private async handleSDKMessage(message: SDKMessage): Promise<void> {
    await this.ctx.onSDKMessage(message);
    await this.ctx.onMarkApiSuccess(message);
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
      await this.ctx.onMissingWorkflowMcpServers(this.ctx as AgentSession, missing);
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

  private persistAcpSessionId(acpSessionId: string): void {
    const { session, db } = this.ctx;
    if (session.acpSessionId === acpSessionId && !this.pendingAcpIdentityMetadata) return;
    session.acpSessionId = acpSessionId;
    if (this.pendingAcpIdentityMetadata) {
      this.pendingAcpIdentityMetadata = false;
      db.updateSession(session.id, { acpSessionId, metadata: session.metadata });
      return;
    }
    db.updateSession(session.id, { acpSessionId });
  }

  private clearAcpSessionState(): void {
    const { session, db } = this.ctx;
    session.acpSessionId = undefined;
    session.metadata = {
      ...session.metadata,
      acpInstructionsSent: undefined,
      acpContextUsageEstimate: undefined,
    };
    db.updateSession(session.id, {
      acpSessionId: undefined,
      metadata: session.metadata,
    });
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

  private async applyStoredAcpModel(client: AcpClient): Promise<void> {
    const storedModel = this.ctx.session.config.model;
    if (storedModel === 'acp-default') return;

    const modelOption = client.getConfigOptions().find((option) => option.category === 'model');
    if (!modelOption || modelOption.currentValue === storedModel) return;
    if (!flattenConfigChoices(modelOption).some((choice) => choice.value === storedModel)) return;

    const configOptions = await client.setConfigOption(modelOption.id, storedModel);
    this.updateAcpModelCache(configOptions);
  }

  private async applyStoredAcpThinkingLevel(client: AcpClient): Promise<void> {
    const thinkingLevel = this.ctx.session.config.thinkingLevel;
    if (!thinkingLevel) return;

    const option = client
      .getConfigOptions()
      .find((configOption) => configOption.category === 'thought_level');
    if (!option) return;
    const value = selectThoughtLevelValue(option, THINKING_LEVEL_TOKENS[thinkingLevel] ?? null);
    if (option.currentValue === value) return;

    const configOptions = await client.setConfigOption(option.id, value);
    this.updateAcpModelCache(configOptions);
  }

  private persistAcpContextUsageEstimate(used: number): void {
    const { session, db } = this.ctx;
    const metadata = session.metadata as { acpContextUsageEstimate?: number } | undefined;
    if (metadata?.acpContextUsageEstimate === used) return;

    session.metadata = {
      ...session.metadata,
      acpContextUsageEstimate: used,
    } as Session['metadata'];
    db.updateSession(session.id, { metadata: session.metadata });
  }

  private syncAcpSessionModel(configOptions: AcpConfigOption[]): void {
    const modelOption = configOptions.find((option) => option.category === 'model');
    const currentValue = modelOption?.currentValue ?? 'acp-default';
    if (this.ctx.session.config.model === currentValue) return;

    this.ctx.session.config.model = currentValue;
    this.ctx.db.updateSession(this.ctx.session.id, {
      config: {
        model: currentValue,
        provider: 'acp',
      } as Session['config'],
    });
    this.ctx.internalEventBus.publishAsync('session.updated', {
      sessionId: this.ctx.session.id,
      source: 'acp-config-options',
      session: { config: this.ctx.session.config },
    });
  }

  private updateAcpModelCache(
    configOptions: AcpConfigOption[],
    options: { syncSessionModel?: boolean } = {}
  ): void {
    if (options.syncSessionModel !== false) {
      this.syncAcpSessionModel(configOptions);
    }

    const provider = getProviderRegistry().get('acp');
    if (provider instanceof AcpProvider) {
      provider.setConfigOptions(configOptions);
      const providerModels =
        provider.getCachedModels() ??
        AcpProvider.MODELS.map((model) => ({
          ...model,
          contextWindow: provider.getContextWindow(),
        }));
      updateProviderModelsInCache('acp', providerModels);
      this.ctx.internalEventBus.publishAsync('providers.changed', { sessionId: 'global' });
    }
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
    let messageDelivered = false;
    let pendingNext: Promise<IteratorResult<SDKMessage>> | null = null;

    try {
      if (signal.aborted) {
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });

      while (!signal.aborted) {
        pendingNext = iterator.next();
        const result = await Promise.race([pendingNext, abortPromise]);

        if ('aborted' in result) {
          break;
        }

        pendingNext = null;

        if (result.done) {
          break;
        }

        messageDelivered = true;
        yield result.value;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      pendingNext?.catch(() => {});
      if (signal.aborted && messageDelivered) {
        const drainDeadline = { expired: true } as const;
        let clearDrainTimer: (() => void) | undefined;
        const drainTimeout = new Promise<typeof drainDeadline>((resolve) => {
          const timer = setTimeout(() => resolve(drainDeadline), POST_ABORT_DRAIN_TIMEOUT_MS);
          timer.unref?.();
          clearDrainTimer = () => {
            clearTimeout(timer);
            resolve(drainDeadline);
          };
        });
        if (pendingNext) {
          const inFlight = pendingNext;
          inFlight.catch(() => {});
          let result: IteratorResult<SDKMessage> | typeof drainDeadline;
          try {
            result = await Promise.race([inFlight, drainTimeout]);
          } catch {
            result = drainDeadline;
          }
          if (
            !('expired' in result) &&
            !result.done &&
            isAcpPostAbortRelevantMessage(result.value)
          ) {
            yield result.value;
          }
          pendingNext = null;
        }
        for (const msg of queryObj.flushPendingMessages()) {
          yield msg;
        }
        let drained = 0;
        while (drained < MAX_POST_ABORT_DRAIN_MESSAGES) {
          const next = iterator.next();
          next.catch(() => {});
          let result: IteratorResult<SDKMessage> | typeof drainDeadline;
          try {
            result = await Promise.race([next, drainTimeout]);
          } catch {
            break;
          }
          if ('expired' in result) break;
          if (result.done) break;
          drained++;
          if (isAcpPostAbortRelevantMessage(result.value)) {
            yield result.value;
          }
        }
        clearDrainTimer?.();
      }
      if (signal.aborted) {
        try {
          const settled = new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, POST_ABORT_DRAIN_TIMEOUT_MS);
            timer.unref?.();
          });
          await Promise.race([Promise.resolve(iterator.return?.()), settled]);
        } catch {}
      } else {
        try {
          await iterator.return?.();
        } catch {}
      }
    }
  }

  async displayErrorAsAssistantMessage(text: string): Promise<void> {
    const { session, db, messageHub, logger } = this.ctx;

    const assistantMessage = {
      type: 'assistant' as const,
      uuid: generateUUID() as UUID,
      session_id: session.id,
      parent_tool_use_id: null,
      message: {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text, citations: null }],
      },
    } as unknown as SDKMessage;

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
