import type { UUID } from 'crypto';
import { fileURLToPath } from 'node:url';
import type { CanUseTool, Options } from '@anthropic-ai/claude-agent-sdk';
import {
  generateUUID,
  THINKING_LEVEL_TOKENS,
  type MessageContent,
  type Session,
} from '@hyperneo/shared';
import type {
  AcpConfigOption,
  AcpContentBlock,
  AcpMcpServerConfig,
  AcpPermissionRequest,
  AcpPermissionResponseResult,
} from '@hyperneo/shared/acp';
import type { McpServerConfig, SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import { ErrorCategory } from '../error-manager';
import { getModelsCache, setModelsCache } from '../model-service';
import { getProviderRegistry } from '../providers/factory';
import { getProviderService, getUserConfiguredAnthropicEnv } from '../provider-service';
import { AcpProvider } from '../providers/acp-provider';
import { TRANSIENT_CONNECTION_ERROR_SUBSTRINGS } from '../agent/transient-error-patterns';
import { drainDeliveryWaitersOnTerminalSDKMessage } from '../agent/message-delivery';
import {
  refreshQueryEnvFromProcess,
  type QueryRunnerContext,
  type TrackedAgentProcess,
} from '../agent/query-runner';
import {
  missingMcpServers,
  resolveSpaceMcpSessionPolicy,
} from '../space/runtime/space-mcp-session-policy';
import { AcpClient, type AcpClientOptions } from './acp-client';
import { AcpQueryAdapter } from './acp-query-adapter';
import { AcpMcpProxyBridge, shouldProxy } from './mcp-proxy-bridge';

// Deliberately NOT synced with the SDK runner's 60s default
// (agent/query-runner.ts): ACP agents are user-configured external processes
// with their own startup profile — no resumed-transcript cold-start herd.
// The shared HYPERNEO_SDK_STARTUP_TIMEOUT_MS override still wins here; see
// .env.example before copying the SDK value.
const DEFAULT_STARTUP_TIMEOUT_MS = 15000;
const RETRY_EXIT_TIMEOUT_MS = 5000;

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
    throw new Error('Invalid HYPERNEO_ACP_COMMAND: unmatched quote');
  }
  if (current) tokens.push(current);
  if (tokens.length === 0) {
    throw new Error('Invalid HYPERNEO_ACP_COMMAND: command is empty');
  }

  return { command: tokens[0], args: tokens.slice(1) };
}

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
    requestId: generateUUID(),
  });

  if (!result || result.behavior === 'deny') {
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
      text: `HyperNeo session instructions:\n\n${text}`,
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

  private async runQuery(
    queryGeneration: number,
    isRetry = false,
    recoveryState = { rateLimitCooldownScheduled: false }
  ): Promise<void> {
    const { session, messageQueue, stateManager, errorManager, logger, optionsBuilder } = this.ctx;
    let client: AcpClient | null = null;
    let queryStartTime = Date.now();
    let startupTimeoutReached = false;
    let createdAcpSessionDuringRun = false;
    let receivedAcpMessageDuringRun = false;
    let restoreMessageEnqueuedHandler: (() => void) | undefined;
    let proxyBridge: AcpMcpProxyBridge | null = null;
    // Set at the end of the try block; the finally-block deferred replay is
    // gated on it so a terminal failure (handleRunError) does not drive the
    // next turn.
    let turnCompletedNormally = false;
    // THIS run's controller, retained when created inside the try. The ctx
    // field cannot be snapshotted up front: it is assigned only at controller
    // creation (a retry would otherwise capture the previous run's), and the
    // finally block aborts (and nulls) it on every non-stale completion — so
    // only the retained reference distinguishes "interrupted during the run"
    // from "aborted during normal cleanup".
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

      const acpCommand = process.env.HYPERNEO_ACP_COMMAND;
      if (!acpCommand) {
        throw new Error('Set HYPERNEO_ACP_COMMAND to enable ACP agents.');
      }
      const { command, args } = parseAcpCommand(acpCommand);
      // Snapshot auth tokens BEFORE provider cleanup — clearProviderRoutingEnvVars()
      // deletes ANTHROPIC_AUTH_TOKEN, and credential discovery populates tokens
      // after provider-service module load, so neither the live env nor the
      // startup snapshot has them by the time we build the ACP child env.
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
      const cwd = getAcpWorkspacePath(session, queryOptions);
      const startupTimeoutMs = getStartupTimeoutMs();
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
      // Restore user-configured Anthropic overrides so an Anthropic-backed ACP
      // agent inherits the real endpoint/model/auth.
      // - Base URL / model / timeout: from the daemon-startup snapshot in
      //   provider-service (frozen at module load), which excludes routing vars
      //   leaked by concurrent bridge provider turns.
      // - Auth tokens: read live from process.env before this ACP env build,
      //   because credential discovery runs after module load. The sk-ant-oat
      //   prefix check excludes non-Anthropic bridge tokens.
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

      client = this.createAcpClient({
        command,
        args,
        cwd,
        env: acpEnv as Record<string, string> | undefined,
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

      for await (const { message, onSent } of messageQueue.messageGenerator(session.id, {
        suppressPreYieldCallback: true,
      })) {
        if (abortController.signal.aborted) break;

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
            // Persist enqueued→submitted first. If this throws, AcpTransport
            // rejects the request and the flag stays false, so the failure path
            // cannot mistakenly settle only a nonexistent submitted row.
            const persisted = this.ctx.messageHandler.markMessageSubmitted(message.uuid ?? '');
            if (!persisted) {
              // remove/defer won after generator yield but before stdin submission.
              // Throw inside AcpTransport's write callback so the request aborts;
              // never acknowledge or execute a successfully revoked prompt.
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

            try {
              await this.handleSDKMessage(acpMessage as SDKMessage);
            } catch (error) {
              logger.error('Error handling ACP SDK message:', error);
              logger.error('Message type:', (acpMessage as SDKMessage).type);

              if (!this.ctx.isCleaningUp()) {
                const processingState = stateManager.getState();
                // Mirrors the non-ACP runner: only publish the terminal idle
                // (draining delivery waiters) when the throwing message ends the
                // turn (the final `result`).
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
          // The prompt reached the ACP subprocess (stdin write completed) but
          // the run ended — interrupt, error, adapter close, or a submission
          // boundary throw — before any acceptance signal. Settle fail-ambiguous
          // so the row is visible-failed and never auto-replayed. Covers BOTH
          // submitted (run ended) and enqueued (transition threw/was revoked),
          // not just the submitted state. See Codex (#3743968032, #3744886836).
          if (!accepted) {
            this.ctx.messageHandler.markACPDeliveryFailed(message.uuid ?? '');
          }
        }
      }

      if (this.ctx.getQueryGeneration() === queryGeneration) {
        messageQueue.stop();
      }
      // The turn consumed its input and ended without reaching the catch —
      // classify completion for the finally-block deferred replay. A single
      // status read is insufficient: an interrupt that completes before this
      // line runs has already returned the session to idle, masquerading as
      // a normal end. The captured abort signal is the durable evidence — an
      // interrupt (user, sibling quiesce, or teardown) aborted it mid-run —
      // and the status check catches an interrupt still in flight.
      turnCompletedNormally =
        !runAbortController?.signal.aborted && stateManager.getState().status !== 'interrupted';
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
        receivedAcpMessageDuringRun,
        async () => {
          await proxyBridge?.close();
          proxyBridge = null;
        },
        recoveryState
      );
    } finally {
      restoreMessageEnqueuedHandler?.();
      await proxyBridge?.close();
      proxyBridge = null;
      const isStaleQuery = this.ctx.getQueryGeneration() !== queryGeneration;

      if (!isStaleQuery) {
        this.clearStartupTimer();

        const abortController = this.ctx.queryAbortController;
        if (abortController) {
          abortController.abort();
          this.ctx.queryAbortController = null;
        }

        // Snapshot BEFORE resetProcessExitedPromise clears it: close() only
        // initiates termination (SIGTERM, up to 5s before SIGKILL), so the
        // deferred replay below must gate on the captured exit promise or
        // the replacement turn can race the exiting child's workspace locks.
        const processExitSnapshot = this.ctx.processExitedPromise ?? Promise.resolve();
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

        if (!this.ctx.isCleaningUp() && !recoveryState.rateLimitCooldownScheduled) {
          await stateManager.setIdle();
          // Drive the deferred queue on ACP turn completion, mirroring
          // SDKMessageHandler.finishTurn: without this, a message persisted as
          // 'deferred' while the ACP node was processing (e.g. an external
          // event in 'defer' mode) is never replayed — the automatic replay is
          // specific to the Claude SDK path. No-op when no deferred rows exist.
          // Gated on the captured process exit AND rechecked at fire time:
          // after a terminal error (handleRunError) or an interrupt that
          // started during cleanup awaits, replaying would restart deferred
          // work that just stopped.
          void processExitSnapshot.then(() => {
            if (
              turnCompletedNormally &&
              // Recheck cleanup at fire time too: teardown can complete its
              // interrupt and return the session to idle while we waited for
              // the process exit — publishing then would promote deferred
              // rows for a session that is being cancelled/shut down.
              !this.ctx.isCleaningUp() &&
              // Require a genuinely idle session, mirroring the interrupt
              // replay path: a newer turn that started during the exit wait
              // (the exit promise is the OLD child's, up to ~5s under
              // SIGTERM→SIGKILL) must not have the old deferred rows steered
              // into it — their replay is left to that turn's completion.
              stateManager.getState().status === 'idle' &&
              session.config.queryMode !== 'manual'
            ) {
              this.ctx.internalEventBus.publishAsync('query.trigger', { sessionId: session.id });
            }
          });
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
    receivedAcpMessageDuringRun = false,
    closeProxyBridge: () => Promise<void> = async () => {},
    recoveryState = { rateLimitCooldownScheduled: false }
  ): Promise<void> {
    const { session, messageQueue, stateManager, errorManager, logger } = this.ctx;
    logger.error('ACP query error:', error);

    if (this.ctx.isCleaningUp()) {
      return;
    }

    // A stale query (a newer query started — e.g. a resetContextPerTurn clear
    // bumped the generation before stop()) must not touch shared state from the
    // catch: no retry, no messageQueue.clear(), no idle, no error surfacing.
    // The error is from the intentional stop; the newer query owns the session.
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

      const is429Error = category === ErrorCategory.RATE_LIMIT;
      const rateLimitCooldownScheduled =
        is429Error &&
        !!(await this.ctx.onRateLimitExhausted?.(errorMessage, this._lastConsumedUserMessage));
      if (rateLimitCooldownScheduled) {
        recoveryState.rateLimitCooldownScheduled = true;
      }
      const userMessage = isStartupTimeout
        ? `The ACP agent failed to start (workspace: ${session.workspacePath ?? 'unbound'}). Check HYPERNEO_ACP_COMMAND and resend your message.`
        : errorMessage.includes('[MCP invariant]')
          ? errorMessage
          : undefined;

      if (!recoveryState.rateLimitCooldownScheduled) {
        // Recovery declined, so this error is terminal. Fence before publishing it.
        stateManager.beginTerminalIdle();
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
      const cache = getModelsCache();
      const providerModels = provider.getCachedModels();
      if (providerModels) {
        const globalModels = cache.get('global') ?? [];
        cache.set('global', [
          ...globalModels.filter((model) => model.provider !== 'acp'),
          ...providerModels,
        ]);
      } else {
        const globalModels = cache.get('global') ?? [];
        cache.set('global', [
          ...globalModels.filter((model) => model.provider !== 'acp'),
          ...AcpProvider.MODELS.map((model) => ({
            ...model,
            contextWindow: provider.getContextWindow(),
          })),
        ]);
      }
      setModelsCache(cache);
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
