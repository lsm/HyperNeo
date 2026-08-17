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
  getMaxStartupTimeoutRetries,
  getStartupRetryDelayMs,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  /**
   * Consecutive startup-timeout retry budget for the delivery currently being
   * (re)driven, keyed by the delivery's kickoff message uuid — the ACP mirror
   * of QueryRunner._startupTimeoutRetryState (PR #2551). Per-delivery: a
   * different message starts fresh, and any accepted ACP prompt clears it
   * (see the messageCount === 1 branch in runQuery).
   *
   * The state intentionally lives on this long-lived instance — NOT in
   * runQuery's isRetry parameter — so IN-PROCESS redrives of the SAME message
   * (delivery-layer redrive, stale-claim reclaim) keep counting toward the cap
   * instead of resetting to zero on every redrive; that reset is what made the
   * 2026-08-16 restart-recovery herd self-sustaining on the SDK side. Scope:
   * per process only — a daemon restart or an ACP↔non-ACP runner swap
   * (AgentSession.startStreamingQuery recreates the runner) starts from a
   * fresh budget. `key: null` means nothing was consumed AND nothing is
   * pending in the queue — residual null attempts charge the in-flight budget
   * so persistent, unidentified starvation stays bounded
   * (see claimStartupTimeoutRetry).
   */
  private _startupTimeoutRetryState: { key: string | null; retries: number } = {
    key: null,
    retries: 0,
  };

  /**
   * The single prompt staged for the next attempt after a startup-replay
   * admission was TTL-rejected — the ACP mirror of QueryRunner's
   * _pendingStartupReplay (which holds an array because the SDK runner
   * replays kickoff + trailing steers, PR #2499; ACP replays only the one
   * in-flight prompt, see the re-feed in handleRunError). Set by the
   * re-feed's rejection handler, consumed by the next retry round's re-feed,
   * and cleared in start() — a fresh turn owns its own inputs, so a replay
   * staged by a superseded chain must not leak into an unrelated new one.
   */
  private _pendingStartupReplay: {
    uuid: string;
    content: string | MessageContent[];
  } | null = null;

  /**
   * True when the last startup-replay admission was TTL-rejected while its
   * retry attempt was running: the rejection is a startup-timeout-class
   * failure (the agent did not consume the prompt in time), so the catch
   * classifies the attempt's abort as 'ACP startup timeout' and the bounded
   * retry machine claims a budget round instead of silently losing the
   * prompt. Read-once in the catch; mirrors QueryRunner's same-named flag,
   * which its post-loop escape consults.
   */
  private _replayAdmissionRejected = false;

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

    // A fresh turn owns its own inputs — discard any replay staged by a
    // superseded startup-retry chain (its finally may have been skipped as
    // stale) and its classification flag. (Mirrors QueryRunner.start().)
    this._pendingStartupReplay = null;
    this._replayAdmissionRejected = false;

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
    // A fresh attempt owns no in-flight prompt. Clearing here prevents a stale
    // _lastConsumedUserMessage from a PREVIOUS chain (it survives turn
    // completion — only the retry branches null it) from keying this attempt's
    // starved-handshake timeout onto the wrong delivery, or re-feeding a
    // completed prompt. Retry recursions re-set it on the replay's first yield.
    this._lastConsumedUserMessage = null;

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
              // This prompt's delivery started successfully (the ACP agent
              // accepted it) — its startup-timeout backoff budget is spent. A
              // later delivery, or a redrive of this message, must start from
              // a fresh budget, not inherit stale backoff/cap state. (Mirrors
              // the messageCount === 1 branch in QueryRunner.runQuery.)
              this.clearStartupTimeoutRetryBudget();
              // A consumed prompt also retires any replay-rejection flag from
              // an earlier round of this chain — it must not reclassify a
              // later, unrelated failure as a startup timeout.
              this._replayAdmissionRejected = false;
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
      // Read-once: a replay-admission rejection from an earlier round of this
      // chain classifies THIS attempt's pre-first-message failure as a
      // startup timeout (the agent did not consume the re-fed prompt within
      // the admission TTL — a startup-timeout-class failure, mirroring
      // QueryRunner's post-loop escape), but must not outlive the round it
      // belongs to and reclassify a later, unrelated error.
      const replayAdmissionRejected = this._replayAdmissionRejected;
      this._replayAdmissionRejected = false;
      const effectiveError =
        (startupTimeoutReached || replayAdmissionRejected) && !this.ctx.firstMessageReceived
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

    // Auto-retry startup timeouts with per-delivery exponential backoff and a
    // hard attempt cap, mirroring QueryRunner (PR #2551): the user shouldn't
    // have to resend after a transient startup failure, but immediate retries
    // also regenerate the concurrent-start load that causes startup timeouts
    // under a restart-recovery herd, so they back off (base → 2×base → 4×base
    // → …) and stop past the cap, settling the delivery as failed. The budget
    // is keyed by the delivery's kickoff message uuid and survives
    // delivery-layer redrives of the same message; the schedule and cap share
    // the SDK runner's HYPERNEO_SDK_STARTUP_RETRY_BASE_MS /
    // HYPERNEO_SDK_STARTUP_RETRY_MAX knobs so operators have one contract.
    // Skip messageQueue.clear() so the user's pending tail survives for the
    // retry. An interrupt that raced this catch must not respawn:
    // interrupt-handler sets 'interrupted' without bumping the generation, so
    // this entry status guard (not just the generation/isCleaningUp checks
    // above) stops a fresh subprocess spawning on a stopped session; the
    // post-sleep guard re-checks it for interrupts that land DURING the
    // backoff window.
    if (
      isStartupTimeout &&
      !this.ctx.isCleaningUp() &&
      stateManager.getState().status !== 'interrupted'
    ) {
      // Charge this timeout to the delivery's budget BEFORE anything async
      // (the path from the per-prompt throw to here is synchronous): every
      // catch entry must count exactly once even if the retry is later
      // cancelled mid-backoff. The in-flight prompt identifies the delivery
      // across redrives (redrives re-enqueue the durable message under the
      // same uuid). When nothing was consumed yet (handshake starvation),
      // the first message still PENDING in the queue is the delivery being
      // started — key on it so a starved first timeout of a NEW delivery gets
      // a fresh budget (and the settled-failed check below applies) instead
      // of charging whatever delivery timed out before it.
      const deliveryKey =
        this._lastConsumedUserMessage?.uuid ?? messageQueue.peekNextUserMessageId() ?? null;
      const retryNumber = this.claimStartupTimeoutRetry(deliveryKey);

      if (retryNumber === null) {
        logger.warn(
          `Startup-timeout retry budget exhausted for this delivery ` +
            `(${this._startupTimeoutRetryState.retries} consecutive timeout(s), ` +
            `cap ${getMaxStartupTimeoutRetries()}); giving up and surfacing the failure — ` +
            `the delivery layer settles the durable row.`
        );
        // Reset the created-but-never-accepted ACP session id, exactly like a
        // granted retry round does: this chain created the remote session but
        // never got a message through, so keeping the id would steer the next
        // resend into loadSession/resumeSession against a session that never
        // processed anything ("Failed to resume ACP session … Reset Agent")
        // instead of a fresh create. (Mirrors the retry-round reset below.)
        if (createdAcpSessionDuringRun && !receivedAcpMessageDuringRun) {
          this.persistAcpSessionId(undefined);
        }
        // Fall through to the terminal error path below. When a prompt was
        // consumed, the per-prompt finally already marked the kickoff row
        // failed (markACPDeliveryFailed); when the handshake itself starved,
        // the row is still 'enqueued' and a live delivery job owns settling
        // it. Either way handleError surfaces the actionable resend hint.
      } else {
        const maxStartupRetries = getMaxStartupTimeoutRetries();
        const delayMs = getStartupRetryDelayMs(retryNumber);
        logger.warn(
          `Auto-retrying ACP query after startup timeout ` +
            `(retry ${retryNumber}/${maxStartupRetries} in ${delayMs}ms).`
        );
        // Deliberately do NOT call stateManager.setIdle() here (the transient
        // retry below still does — it recurses near-instantly). The startup
        // retry sleeps 15–240 s before respawning; publishing idle for that
        // window would (a) make handleInterrupt early-return on idle, silently
        // dropping a Stop pressed during the backoff, (b) show the session as
        // idle for up to ~4 min per round, and (c) let waitForIdle observers
        // false-pass on the blip. Mirrors QueryRunner: stay 'processing'
        // during backoff — queryPromise is still set, the retry's generator
        // re-asserts 'processing' on its first yield, and the finally sets
        // 'idle' when the chain actually completes.

        // Stop the queue BEFORE the first await of this branch. The timeout
        // throw jumps from inside the prompt loop straight to the catch, so
        // the post-loop stop (runQuery's generation-guarded messageQueue.stop()
        // after the for-await) never ran — and until the queue is stopped, the
        // session looks live to AgentSession.feedDeliverySteer ('processing' +
        // queryPromise set + queue running), which ADMITS a mid-backoff
        // follow-up instead of parking it. An admitted steer would either be
        // consumed by the retry's generator BEFORE the replayed kickoff it
        // answers (also re-keying the retry budget onto the steer), or sit
        // unconsumed until the ~30s admission TTL rejects it and its delivery
        // job churns retries toward dead-letter. With the queue stopped, the
        // steer parks until the turn settles — feedDeliverySteer keys its
        // mid-recovery park on exactly this stopped-queue state. Pending
        // admissions survive the stop; the post-sleep restart below re-runs
        // the queue. (Mirrors QueryRunner, whose post-loop stop runs before
        // the starved throw reaches its catch, plus its post-sleep restart.)
        messageQueue.stop();

        if (createdAcpSessionDuringRun && !receivedAcpMessageDuringRun) {
          this.persistAcpSessionId(undefined);
        }

        // The per-prompt finally terminalized the timed-out row as
        // fail-ambiguous (markACPDeliveryFailed — submitted but never
        // accepted). Reopen it so the retry's resubmission can re-drive the
        // same uuid (enqueued → submitted): without this, markMessageSubmitted
        // finds no 'enqueued' row and aborts the retried prompt as revoked.
        // The reopen ALSO makes the post-backoff settled-failed check below
        // meaningful: the row is 'enqueued' during the window, so a 'failed'
        // read at wake can only mean the delivery layer (consumption timeout /
        // dead-letter) or an interrupt settled it while we slept.
        // Prefer a STAGED replay (set when the previous round's re-feed was
        // admission-TTL-rejected — the entry-null below already cleared
        // _lastConsumedUserMessage for that round); otherwise the prompt this
        // attempt consumed is the replay.
        const retryMessage = this._pendingStartupReplay ?? this._lastConsumedUserMessage;
        if (retryMessage) {
          try {
            const reopenedId = this.ctx.db
              .getSDKMessageRepo()
              .reopenDeliveryByUuid(session.id, retryMessage.uuid);
            if (reopenedId) {
              this.ctx.internalEventBus
                .publish('messages.statusChanged', {
                  sessionId: session.id,
                  messageIds: [reopenedId],
                  status: 'enqueued',
                })
                .catch(() => {});
            }
          } catch (err) {
            logger.warn('Failed to reopen the startup-retry delivery row:', err);
          }
        }

        // Clean-slate teardown: close the dead client/transport, drop the MCP
        // proxy bridge, and wait for the subprocess to exit so the retry's
        // fresh spawn does not collide with workspace locks.
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
          // Clear only if the tracking still belongs to the old subprocess —
          // a concurrent start during the await may have installed the
          // replacement's exit promise. (Mirrors QueryRunner.)
          if (this.ctx.processExitedPromise === exitPromise) {
            this.ctx.resetProcessExitedPromise();
          }
        }

        // Restore provider env vars BEFORE the backoff sleep so process.env
        // is clean during the (potentially minutes-long) wait, and so a
        // cancelled return below cannot skip the restore — the finally block
        // skips cleanup for stale queries. The recursive attempt re-applies
        // fresh provider env. (Mirrors QueryRunner.)
        const envVarsToRestore = this.ctx.originalEnvVars;
        if (Object.keys(envVarsToRestore).length > 0) {
          getProviderService().restoreEnvVars(envVarsToRestore);
          this.ctx.originalEnvVars = {};
        }

        // Exponential backoff before the retry attempt — immediate retries
        // are what make a concurrent-start herd self-sustaining (each retry
        // respawns an ACP subprocess into the very load that timed it out).
        // Sleeps AFTER teardown so the wait is not spent holding a dead
        // subprocess. (Mirrors the provider-retry / startup-retry ordering in
        // QueryRunner.)
        await sleep(delayMs);

        // Cancellation guard at wake (mirrors QueryRunner, incl. its PR #2551
        // P1 thread). This attempt's controller was legitimately ABORTED by
        // the startup timer, but abort() leaves it non-null — null can only
        // mean handleInterrupt (a COMPLETED Stop nulls the controller without
        // touching the generation, queryPromise, or — here — the reopened
        // 'enqueued' row the settled check below reads) or the lifecycle stop
        // (already covered by the queryPromise disjunct). Cancellation
        // signals, all cheap:
        // - ctx.queryPromise === null — stall-watchdog reset / lifecycle
        //   stop gave up on this chain (no generation bump).
        // - ctx.queryAbortController === null — a completed user Stop.
        // - generation supersession / interrupted status / shutdown.
        if (
          this.ctx.isCleaningUp() ||
          this.ctx.queryAbortController === null ||
          this.ctx.queryPromise === null ||
          this.ctx.getQueryGeneration() !== queryGeneration ||
          stateManager.getState().status === 'interrupted'
        ) {
          logger.warn(
            'Startup-timeout retry cancelled: session interrupted/stopped/restarted/reset/cleaning up during backoff.'
          );
          return;
        }

        // Delivery row settled failed during the window: the reopen above
        // left it 'enqueued', so this read can only be true when the
        // delivery layer's consumption timeout / dead-letter — or an
        // interrupt — terminalized it while we slept. Retrying would respawn
        // subprocesses for a delivery the layer already settled; abandon and
        // let the settled state stand. (Mirrors QueryRunner; runs AFTER the
        // cheap disjuncts and reads a single row.)
        if (
          deliveryKey !== null &&
          this.ctx.db.getMessageByStatusAndUuid(session.id, 'failed', deliveryKey)
        ) {
          logger.warn(
            'Startup-timeout retry cancelled: delivery already settled failed during backoff ' +
              `(message ${deliveryKey}).`
          );
          return;
        }

        // The retry branch stopped the queue before its teardown/sleep (see
        // above — the timeout throw skips the post-loop stop), so restart it:
        // the retry's generator exits immediately while the queue is stopped,
        // the replay below would never feed it, and the attempt would time
        // out again at zero messages. A stop by interrupt/shutdown is excluded
        // by the checks above (generation, isCleaningUp) and the status guard
        // below. (Mirrors QueryRunner's post-sleep restart.)
        if (
          !messageQueue.isRunning() &&
          !this.ctx.isCleaningUp() &&
          stateManager.getState().status !== 'interrupted'
        ) {
          messageQueue.start();
        }

        // Re-feed the timed-out prompt AFTER the backoff (not before the
        // teardown) so the replay does not expire in the queue
        // (enqueueWithId has a ~30s TTL) during a long backoff window. ACP
        // replays the single in-flight prompt only — unlike the SDK runner
        // (whose streaming-input generator can hand a silent subprocess the
        // kickoff AND trailing steers, hence PR #2499's multi-message
        // replay), the ACP outer loop awaits each prompt's turn to completion
        // before pulling the next message, so a startup timeout always has
        // exactly one un-consumed prompt. Unlike the SDK runner there is also
        // no startup-gate wait between this enqueue and the generator attach
        // (PR #2552 gates SDK spawns only), so no gate-admission deferral is
        // needed — the enqueue-to-consume gap is the recursion itself.
        if (retryMessage) {
          // Duplicate guard (mirrors the SDK runner's staged-replay guard,
          // narrowed to the queue): the reopen above left the durable row
          // 'enqueued', so a delivery-layer redrive during the backoff window
          // may have re-admitted this same uuid — admitWithId is not
          // idempotent, and feeding it twice would hand the ACP agent the
          // same prompt twice; the retry's generator consumes the existing
          // admission instead. PENDING-ONLY (hasPendingAdmission), not
          // hasPendingOrInFlight: this attempt's own admission lingers in
          // `yielded` when the timed-out prompt's stdin write never fired
          // (onSubmitted never ran, so onSent never settled it), and skipping
          // the re-feed on that stale entry would leave the retry with an
          // empty-but-sized queue — the generator arms the startup timer and
          // blocks in waitForNextMessage (not abort-wakeable): one burned
          // spawn plus a wedged window until the admission TTL / stall
          // watchdog. A FRESH redrive admission sits in `queue`; our own
          // stale entry self-settles at its TTL and duplicates nothing.
          if (messageQueue.hasPendingAdmission(retryMessage.uuid)) {
            logger.warn(
              `Startup replay skip: message ${retryMessage.uuid} is already pending ` +
                '(a redrive re-admitted it); not feeding it twice.'
            );
          } else {
            // Durable + prepend, mirroring the SDK runner's staged-replay
            // flush: durable keeps the entry surviving the queue's
            // claimed/yielded abort states, and prepend keeps the kickoff
            // ahead of anything that slipped into the queue before the
            // backoff stop. The in-queue admission TTL still applies — by
            // design, see the rejection handler below: moving the enqueue
            // past the backoff dodges the SLEEP but not the retry attempt's
            // own pre-consumption window (spawn + initialize + session
            // setup), which can exceed 30 s under a raised
            // HYPERNEO_SDK_STARTUP_TIMEOUT_MS.
            messageQueue
              .enqueueWithId(retryMessage.uuid, retryMessage.content, false, {
                prepend: true,
                durable: true,
              })
              .catch((rejectionError) => {
                // The admission TTL fired: the retry attempt did not consume
                // the replay in time (slow ACP handshake) — a
                // startup-timeout-class failure, so route it into the bounded
                // startup-retry machine rather than silently losing the
                // prompt to the ~3-min stall watchdog: re-stage the message
                // for the next attempt's re-feed and abort this attempt; the
                // catch's replay-rejected classification converts the abort
                // into an 'ACP startup timeout' error so it claims a budget
                // round and backs off before retrying. (Mirrors
                // QueryRunner's flush rejection handler.)
                logger.warn(
                  `Startup replay admission rejected for message ${retryMessage.uuid} ` +
                    `(the ACP agent did not consume it within the admission TTL): ` +
                    `${rejectionError instanceof Error ? rejectionError.message : String(rejectionError)} — ` +
                    'aborting attempt for a bounded startup retry.'
                );
                this._pendingStartupReplay = retryMessage;
                this._replayAdmissionRejected = true;
                // Guarded abort: only the chain's own, still-live controller.
                // The generation check excludes a replacement query that took
                // over while the admission sat unconsumed; the aborted check
                // makes the timer-driven abort of the same attempt a no-op.
                if (
                  this.ctx.getQueryGeneration() === queryGeneration &&
                  this.ctx.queryAbortController &&
                  !this.ctx.queryAbortController.signal.aborted
                ) {
                  this.ctx.queryAbortController.abort();
                }
              });
          }
          // The staged replay is now the queue's admission (or a redrive's) —
          // either way the NEXT round re-derives it from the queue or the
          // rejection handler's re-staging, not from this field. Keeping
          // _lastConsumedUserMessage nulled is what makes the next round's
          // key derive from peek/staging instead of this consumed prompt.
          this._pendingStartupReplay = null;
          this._lastConsumedUserMessage = null;
        }

        // `return await` keeps this chain's finally{} from racing the retry
        // (it runs only after the retry chain completes). isRetry=true also
        // disables the 1-shot transient retry on later attempts — the shared
        // budget bounds TOTAL retries per turn, mirroring QueryRunner.
        return await this.runQuery(queryGeneration, true, recoveryState);
      }
    }

    // Auto-retry once on transient connection errors (mid-stream connection
    // drop that escapes the ACP client's own handling) — near-instant
    // recursion, so the intermediate setIdle (suppressed delivery waiters) is
    // safe here, unlike the startup-timeout backoff above.
    if (isTransientConnectionError && !isQueryInterrupted && !isRetry && !this.ctx.isCleaningUp()) {
      logger.warn('Auto-retrying ACP query after transient connection error (1 retry).');
      await stateManager.setIdle({ suppressDeliveryWaiters: true });

      const lastMsg = this._lastConsumedUserMessage;
      if (lastMsg) {
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

  /**
   * Record one startup timeout against the delivery identified by `deliveryKey`
   * (its kickoff message uuid, or null when nothing was consumed yet) and
   * return the 1-indexed retry number to run — or null when the per-delivery
   * budget is exhausted and the delivery must settle failed instead of
   * looping. (Mirrors QueryRunner.claimStartupTimeoutRetry.)
   */
  private claimStartupTimeoutRetry(deliveryKey: string | null): number | null {
    const state = this._startupTimeoutRetryState;
    if (deliveryKey !== null && state.key !== deliveryKey) {
      // An identified, DIFFERENT delivery — the previous delivery's backoff
      // state must not leak into it.
      this._startupTimeoutRetryState = { key: deliveryKey, retries: 1 };
    } else if (
      deliveryKey === null &&
      state.key !== null &&
      this.ctx.db.getMessageByStatusAndUuid(this.ctx.session.id, 'failed', state.key)
    ) {
      // Unidentified (starved) attempt, but the in-flight budget belongs to a
      // delivery whose durable row has already settled failed — that delivery
      // is over, so this is a NEW starved delivery: fresh budget. Without this
      // guard it would inherit the exhausted count and settle failed with zero
      // retries of its own (or start deep into the backoff schedule).
      this._startupTimeoutRetryState = { key: null, retries: 1 };
    } else {
      // Same delivery, or a starved attempt whose predecessor has NOT settled:
      // charge the in-flight budget. Charging (rather than resetting) keeps a
      // consume/no-consume flap from resetting the budget every other round,
      // which would unbound the loop this cap exists to close.
      state.retries += 1;
    }
    const { retries } = this._startupTimeoutRetryState;
    return retries <= getMaxStartupTimeoutRetries() ? retries : null;
  }

  /** Startup succeeded for the in-flight delivery — clear its backoff budget. */
  private clearStartupTimeoutRetryBudget(): void {
    this._startupTimeoutRetryState = { key: null, retries: 0 };
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
