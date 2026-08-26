import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import type { Session } from '@hyperneo/shared';
import type { Provider as ProviderImpl, ProviderAuthStatusInfo } from '@hyperneo/shared/provider';
import superpipe, { type PipelineAPI } from 'superpipe';
import { ErrorCategory } from '../error-manager.ts';
import {
  getProviderService,
  NON_ANTHROPIC_PREFIX_PROVIDER_VARS,
  type OriginalEnvVars,
  type ProviderEnvVars,
  type ProviderService,
} from '../provider-service.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import {
  missingMcpServers,
  resolveSpaceMcpSessionPolicy,
  SPACE_COORDINATOR_REQUIRED_MCP_SERVERS,
  SPACE_WORKFLOW_WORKER_REQUIRED_MCP_SERVERS,
  type SpaceMcpSessionPolicy,
} from '../space/runtime/space-mcp-session-policy.ts';
import type { AgentSession } from './agent-session.ts';
import type { QueryRunnerContext } from './query-runner.ts';
import { refreshQueryEnvFromProcess } from './query-runner.ts';

export interface PrepareQueryRunOptionsCtx {
  queryGeneration: number;
  askUserQuestionHook: HookCallback;
  queryOptions: Options;
  provider: ProviderImpl | undefined;
  providerService: ProviderService;
  providerRegistry: ProviderRegistry;
  originalEnvVars: OriginalEnvVars;
  resolvedProviderId: string;
  superseded: boolean;
  haltAfter?: string;
  modelId: string;
  explicitProviderId?: string;
  providerEnvVars: ProviderEnvVars;
  providerSession: Session;
  extraProviderManagedEnvVars: string[];
  refreshAutoCompactWindow: boolean;
  spacePolicy: SpaceMcpSessionPolicy;
  isWorkflowSubSession: boolean;
  sessionTaskId?: string;
  mcpServerNames: string[];
  isProviderAvailable?: boolean;
  providerAuthStatus?: ProviderAuthStatusInfo | null;
  missingWorkflowServers?: string[];
  runnerCtx: QueryRunnerContext;
}

export function updatePrepareQueryRunOptionsCtx(
  ctx: PrepareQueryRunOptionsCtx,
  updates: Partial<PrepareQueryRunOptionsCtx>
): PrepareQueryRunOptionsCtx {
  return { ...ctx, ...updates };
}

export function isPrepareQueryRunOptionsSuperseded(ctx: PrepareQueryRunOptionsCtx): boolean {
  return ctx.superseded;
}

export function resnapshotAfter(afterAwait: string) {
  return (ctx: PrepareQueryRunOptionsCtx): PrepareQueryRunOptionsCtx => {
    if (
      ctx.runnerCtx.getQueryGeneration() === ctx.queryGeneration &&
      !ctx.runnerCtx.isCleaningUp() &&
      ctx.runnerCtx.stateManager.getState().status !== 'interrupted'
    ) {
      return ctx;
    }
    return updatePrepareQueryRunOptionsCtx(ctx, { superseded: true, haltAfter: afterAwait });
  };
}

export async function loadProviderService(
  ctx: PrepareQueryRunOptionsCtx
): Promise<PrepareQueryRunOptionsCtx> {
  return updatePrepareQueryRunOptionsCtx(ctx, { providerService: getProviderService() });
}

export async function loadProviderRegistry(
  ctx: PrepareQueryRunOptionsCtx
): Promise<PrepareQueryRunOptionsCtx> {
  const { initializeProviders, waitForOptionalProviderRegistration } = await import(
    '../providers/factory.js'
  );
  const providerRegistry = initializeProviders();
  await waitForOptionalProviderRegistration();
  return updatePrepareQueryRunOptionsCtx(ctx, { providerRegistry });
}

export function detectProvider(ctx: PrepareQueryRunOptionsCtx): PrepareQueryRunOptionsCtx {
  const provider = ctx.explicitProviderId
    ? ctx.providerRegistry.detectProviderForModel(ctx.modelId, ctx.explicitProviderId)
    : ctx.providerRegistry.get('anthropic');
  const resolvedProviderId = ctx.explicitProviderId ?? provider?.id ?? 'anthropic';
  const providerSession: Session = {
    ...ctx.runnerCtx.session,
    config: {
      ...ctx.runnerCtx.session.config,
      model: ctx.modelId,
      provider: resolvedProviderId as Session['config']['provider'],
    },
  };
  return updatePrepareQueryRunOptionsCtx(ctx, { provider, resolvedProviderId, providerSession });
}

export async function checkProviderAvailability(
  ctx: PrepareQueryRunOptionsCtx
): Promise<PrepareQueryRunOptionsCtx> {
  if (!ctx.provider || typeof ctx.provider.isAvailable !== 'function') {
    return updatePrepareQueryRunOptionsCtx(ctx, { isProviderAvailable: undefined });
  }
  const isProviderAvailable = await ctx.provider.isAvailable();
  return updatePrepareQueryRunOptionsCtx(ctx, { isProviderAvailable });
}

export async function probeProviderAuthStatus(
  ctx: PrepareQueryRunOptionsCtx
): Promise<PrepareQueryRunOptionsCtx> {
  if (
    !ctx.provider ||
    typeof ctx.provider.getAuthStatus !== 'function' ||
    ctx.isProviderAvailable !== false
  ) {
    return ctx;
  }
  const providerAuthStatus = await ctx.provider.getAuthStatus();
  return updatePrepareQueryRunOptionsCtx(ctx, { providerAuthStatus });
}

export async function throwIfProviderUnavailable(
  ctx: PrepareQueryRunOptionsCtx
): Promise<PrepareQueryRunOptionsCtx> {
  if (ctx.isProviderAvailable !== false || !ctx.provider) {
    return ctx;
  }
  const authStatus = ctx.providerAuthStatus;
  const errorMsg = authStatus?.error || 'Please configure credentials.';
  const authError = new Error(`Provider ${ctx.provider.displayName} is not available. ${errorMsg}`);
  await ctx.runnerCtx.errorManager.handleError(
    ctx.runnerCtx.session.id,
    authError,
    ErrorCategory.PROVIDER_AUTH_ERROR,
    `Provider ${ctx.provider.displayName} is not available. ` +
      'Please configure credentials to continue.',
    ctx.runnerCtx.stateManager.getState(),
    { providerId: ctx.provider.id, providerName: ctx.provider.displayName }
  );
  throw authError;
}

export async function refreshProviderAuthStatus(
  ctx: PrepareQueryRunOptionsCtx
): Promise<PrepareQueryRunOptionsCtx> {
  if (
    !ctx.provider ||
    typeof ctx.provider.getAuthStatus !== 'function' ||
    ctx.isProviderAvailable === false
  ) {
    return ctx;
  }
  const providerAuthStatus = await ctx.provider.getAuthStatus();
  if (providerAuthStatus.needsRefresh) {
    ctx.runnerCtx.logger.warn(
      `Provider ${ctx.provider.displayName} token needs refresh. Attempting to continue.`
    );
  }
  return updatePrepareQueryRunOptionsCtx(ctx, { providerAuthStatus });
}

export async function probeFallbackAuth(
  ctx: PrepareQueryRunOptionsCtx
): Promise<PrepareQueryRunOptionsCtx> {
  if (ctx.provider && typeof ctx.provider.isAvailable === 'function') {
    return ctx;
  }
  const hasAnthropicAuth = !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
  const hasGlmAuth = await ctx.providerService.isGlmAvailable();
  const hasAuth = hasAnthropicAuth || hasGlmAuth;
  if (hasAuth) return ctx;
  const authError = new Error(
    'No authentication configured. Please set up API key for Anthropic or Z.ai.'
  );
  await ctx.runnerCtx.errorManager.handleError(
    ctx.runnerCtx.session.id,
    authError,
    ErrorCategory.AUTHENTICATION,
    undefined,
    ctx.runnerCtx.stateManager.getState()
  );
  throw authError;
}

export async function createWorkspaceDirectory(
  ctx: PrepareQueryRunOptionsCtx
): Promise<PrepareQueryRunOptionsCtx> {
  if (!ctx.runnerCtx.session.workspacePath) return ctx;
  const fs = await import('fs/promises');
  await fs.mkdir(ctx.runnerCtx.session.workspacePath, { recursive: true });
  return ctx;
}

export function configureQueryOptionsBuilder(
  ctx: PrepareQueryRunOptionsCtx
): PrepareQueryRunOptionsCtx {
  ctx.runnerCtx.optionsBuilder.setCanUseTool(
    ctx.runnerCtx.askUserQuestionHandler.createCanUseToolCallback()
  );
  return ctx;
}

export async function buildQueryOptions(
  ctx: PrepareQueryRunOptionsCtx
): Promise<PrepareQueryRunOptionsCtx> {
  const queryOptions = await ctx.runnerCtx.optionsBuilder.build({
    askUserQuestionHook: ctx.askUserQuestionHook,
  });
  return updatePrepareQueryRunOptionsCtx(ctx, { queryOptions });
}

export function configureSessionThinking(
  ctx: PrepareQueryRunOptionsCtx
): PrepareQueryRunOptionsCtx {
  if (!ctx.provider?.setSessionThinkingConfig) return ctx;
  const effectiveThinkingLevel = ctx.runnerCtx.optionsBuilder.getEffectiveThinkingLevel();
  ctx.provider.setSessionThinkingConfig(ctx.runnerCtx.session.id, effectiveThinkingLevel);
  return ctx;
}

export function addSessionStateOptionsAndSnapshotMcp(
  ctx: PrepareQueryRunOptionsCtx
): PrepareQueryRunOptionsCtx {
  let queryOptions = ctx.runnerCtx.optionsBuilder.addSessionStateOptions(ctx.queryOptions);
  const mcpServerNames = Object.keys(queryOptions.mcpServers ?? {}).sort();
  const isWorkflowSubSession = ctx.spacePolicy.isWorkflowWorker;
  const sessionTaskId = ctx.sessionTaskId;
  const snapshotPayload = {
    event: 'query.mcp.snapshot',
    sessionId: ctx.runnerCtx.session.id,
    sessionType: ctx.runnerCtx.session.type,
    role: ctx.spacePolicy.role,
    owner: ctx.spacePolicy.owner,
    ...(ctx.spacePolicy.spaceId ? { spaceId: ctx.spacePolicy.spaceId } : {}),
    ...(sessionTaskId ? { taskId: sessionTaskId } : {}),
    ...(isWorkflowSubSession ? { workflowSubSession: true } : {}),
    mcpServers: mcpServerNames,
  };
  ctx.runnerCtx.logger.info(
    `QueryRunner.start(): session ${ctx.runnerCtx.session.id} mcp servers visible at first turn: ` +
      `[${mcpServerNames.join(', ')}]` +
      (isWorkflowSubSession ? ' (workflow sub-session)' : '') +
      ` ${JSON.stringify(snapshotPayload)}`
  );
  return updatePrepareQueryRunOptionsCtx(ctx, {
    queryOptions,
    mcpServerNames,
    isWorkflowSubSession,
  });
}

export function getLiveSdkMcpServerNames(queryOptions: Pick<Options, 'mcpServers'>): string[] {
  return Object.entries(queryOptions.mcpServers ?? {})
    .filter(([, config]) => {
      const maybeSdk = config as { type?: unknown; instance?: unknown };
      return maybeSdk.type === 'sdk' && !!maybeSdk.instance;
    })
    .map(([name]) => name)
    .sort();
}

const REQUIRED_SPACE_CHAT_MCP_SERVERS = SPACE_COORDINATOR_REQUIRED_MCP_SERVERS;
const REQUIRED_SPACE_CHAT_COORDINATION_TOOLS = [
  'create_standalone_task',
  'get_task_detail',
  'retry_task',
  'cancel_task',
  'reassign_task',
  'list_workflows',
  'suggest_workflow',
  'get_workflow_detail',
] as const;

export async function ensureSpaceChatMcpInvariant(
  ctx: PrepareQueryRunOptionsCtx
): Promise<Options> {
  const { session, logger } = ctx.runnerCtx;
  if (session.type !== 'space_chat') return ctx.queryOptions;

  const serverNames = Object.keys(ctx.queryOptions.mcpServers ?? {}).sort();
  const missingServers = REQUIRED_SPACE_CHAT_MCP_SERVERS.filter(
    (name) => !serverNames.includes(name)
  );
  if (missingServers.length === 0) return ctx.queryOptions;

  const payload = {
    event: 'space_chat.mcp.missing',
    sessionId: session.id,
    spaceId: session.context?.spaceId,
    sessionType: session.type,
    requiredServers: REQUIRED_SPACE_CHAT_MCP_SERVERS,
    requiredTools: REQUIRED_SPACE_CHAT_COORDINATION_TOOLS,
    missingServers,
    presentServers: serverNames,
    liveSdkServers: getLiveSdkMcpServerNames(ctx.queryOptions),
    selfHealAttempted: !!ctx.runnerCtx.onMissingSpaceChatMcpServers,
  };

  logger.error(
    `QueryRunner.start(): Space chat session ${session.id} is MISSING required MCP servers. ` +
      `Missing: [${missingServers.join(', ')}]. Present: [${serverNames.join(', ')}]. ` +
      `This would remove Space coordination tools after compaction/resume. ${JSON.stringify(payload)}`
  );

  if (ctx.runnerCtx.onMissingSpaceChatMcpServers) {
    await ctx.runnerCtx.onMissingSpaceChatMcpServers(session.id, missingServers);
    const rebuilt = await ctx.runnerCtx.optionsBuilder.build({
      askUserQuestionHook: ctx.askUserQuestionHook,
    });
    const repairedOptions = ctx.runnerCtx.optionsBuilder.addSessionStateOptions(rebuilt);
    const repairedServerNames = Object.keys(repairedOptions.mcpServers ?? {});
    const stillMissing = REQUIRED_SPACE_CHAT_MCP_SERVERS.filter(
      (name) => !repairedServerNames.includes(name)
    );
    if (stillMissing.length > 0) {
      throw new Error(
        `[MCP invariant] Space chat session ${session.id} still missing required MCP servers ` +
          `after self-heal: [${stillMissing.join(', ')}]. Refusing to start a degraded ` +
          `Space Agent turn.`
      );
    }
    return repairedOptions;
  }

  throw new Error(
    `[MCP invariant] Space chat session ${session.id} missing required MCP servers: ` +
      `[${missingServers.join(', ')}]. Refusing to start a degraded Space Agent turn. ` +
      `Expected coordination tools: ${REQUIRED_SPACE_CHAT_COORDINATION_TOOLS.join(', ')}.`
  );
}

export async function ensureSpaceChatMcpInvariantStage(
  ctx: PrepareQueryRunOptionsCtx
): Promise<PrepareQueryRunOptionsCtx> {
  const queryOptions = await ensureSpaceChatMcpInvariant(ctx);
  return updatePrepareQueryRunOptionsCtx(ctx, { queryOptions });
}

export function detectWorkflowMcpMissing(
  ctx: PrepareQueryRunOptionsCtx
): PrepareQueryRunOptionsCtx {
  if (!ctx.isWorkflowSubSession) return ctx;
  const requiredServers = SPACE_WORKFLOW_WORKER_REQUIRED_MCP_SERVERS;
  const missingWorkflowServers = missingMcpServers(
    ctx.queryOptions.mcpServers as Record<string, unknown> | undefined,
    requiredServers
  );
  if (missingWorkflowServers.length === 0) return ctx;
  const diagnosticPayload = {
    event: 'workflow.mcp.missing',
    sessionId: ctx.runnerCtx.session.id,
    spaceId: ctx.spacePolicy.spaceId,
    sessionType: ctx.runnerCtx.session.type,
    role: ctx.spacePolicy.role,
    owner: ctx.spacePolicy.owner,
    requiredServers,
    missingServers: missingWorkflowServers,
    presentServers: ctx.mcpServerNames,
    liveSdkServers: getLiveSdkMcpServerNames(ctx.queryOptions),
    selfHealAttempted: !!ctx.runnerCtx.onMissingWorkflowMcpServers,
  };
  ctx.runnerCtx.logger.error(
    `QueryRunner.start(): workflow sub-session ${ctx.runnerCtx.session.id} is MISSING ` +
      'required MCP servers. ' +
      `Missing: [${missingWorkflowServers.join(', ')}]. ` +
      `Present: [${ctx.mcpServerNames.join(', ')}]. ` +
      `Live SDK servers: [${diagnosticPayload.liveSdkServers.join(', ')}]. ` +
      `Self-heal attempted: ${diagnosticPayload.selfHealAttempted}. ` +
      'Attempting self-heal via onMissingWorkflowMcpServers callback... ' +
      `${JSON.stringify(diagnosticPayload)}`
  );
  if (!ctx.runnerCtx.onMissingWorkflowMcpServers) {
    throw new Error(
      `[MCP invariant] Workflow sub-session ${ctx.runnerCtx.session.id} is MISSING required ` +
        `MCP servers: [${missingWorkflowServers.join(', ')}]. ` +
        'Refusing to start — fix the injection logic.'
    );
  }
  return updatePrepareQueryRunOptionsCtx(ctx, { missingWorkflowServers });
}

export async function selfHealWorkflowMcp(
  ctx: PrepareQueryRunOptionsCtx
): Promise<PrepareQueryRunOptionsCtx> {
  if (!ctx.missingWorkflowServers?.length || !ctx.runnerCtx.onMissingWorkflowMcpServers) return ctx;
  try {
    await ctx.runnerCtx.onMissingWorkflowMcpServers(
      ctx.runnerCtx as AgentSession,
      ctx.missingWorkflowServers
    );
    ctx.runnerCtx.logger.info(
      `QueryRunner.start(): self-heal callback completed for session ${ctx.runnerCtx.session.id}.`
    );
  } catch (err) {
    ctx.runnerCtx.logger.error(
      `QueryRunner.start(): self-heal callback FAILED for session ${ctx.runnerCtx.session.id}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        'The session will start without required MCP servers — ' +
        'expect "No such tool available" failures at runtime.'
    );
  }
  return ctx;
}

export function validateWorkflowMcpAfterSelfHeal(
  ctx: PrepareQueryRunOptionsCtx
): PrepareQueryRunOptionsCtx {
  if (!ctx.missingWorkflowServers?.length) return ctx;
  const requiredServers = SPACE_WORKFLOW_WORKER_REQUIRED_MCP_SERVERS;
  const currentMcpServers =
    (ctx.runnerCtx.session.config?.mcpServers as Record<string, unknown> | undefined) ?? {};
  const currentServerNames = Object.keys(currentMcpServers);
  const stillMissing = requiredServers.filter((name) => !currentServerNames.includes(name));
  if (stillMissing.length === 0) return ctx;
  ctx.runnerCtx.logger.error(
    `QueryRunner.start(): workflow sub-session ${ctx.runnerCtx.session.id} servers still ` +
      'missing after self-heal. ' +
      `Still absent: [${stillMissing.join(', ')}]. ` +
      `Present: [${currentServerNames.join(', ')}]. ` +
      `Live SDK servers: [` +
      `${getLiveSdkMcpServerNames({ mcpServers: currentMcpServers } as Options).join(', ')}` +
      `]. Refusing to start.`
  );
  throw new Error(
    `[MCP invariant] Workflow sub-session ${ctx.runnerCtx.session.id} still missing required ` +
      `MCP servers after self-heal: [${stillMissing.join(', ')}]. ` +
      'Refusing to start — fix the injection logic.'
  );
}

export async function rebuildWorkflowQueryOptionsBuild(
  ctx: PrepareQueryRunOptionsCtx
): Promise<PrepareQueryRunOptionsCtx> {
  if (!ctx.missingWorkflowServers?.length) return ctx;
  const queryOptions = await ctx.runnerCtx.optionsBuilder.build({
    askUserQuestionHook: ctx.askUserQuestionHook,
  });
  return updatePrepareQueryRunOptionsCtx(ctx, { queryOptions });
}

export function rebuildWorkflowQueryOptionsFinalize(
  ctx: PrepareQueryRunOptionsCtx
): PrepareQueryRunOptionsCtx {
  if (!ctx.missingWorkflowServers?.length) return ctx;
  const requiredServers = SPACE_WORKFLOW_WORKER_REQUIRED_MCP_SERVERS;
  let queryOptions = ctx.runnerCtx.optionsBuilder.addSessionStateOptions(ctx.queryOptions);
  const repairedServerNames = Object.keys(queryOptions.mcpServers ?? {}).sort();
  ctx.runnerCtx.logger.info(
    `QueryRunner.start(): rebuilt query options after MCP self-heal for session ` +
      `${ctx.runnerCtx.session.id}. ` +
      `Present: [${repairedServerNames.join(', ')}]. ` +
      `${JSON.stringify({
        event: 'workflow.mcp.self_heal.rebuilt_query_options',
        sessionId: ctx.runnerCtx.session.id,
        sessionType: ctx.runnerCtx.session.type,
        requiredServers,
        presentServers: repairedServerNames,
        liveSdkServers: getLiveSdkMcpServerNames(queryOptions),
      })}`
  );
  return updatePrepareQueryRunOptionsCtx(ctx, {
    queryOptions,
    mcpServerNames: repairedServerNames,
  });
}

export async function ensureMemberSpaceMcpInvariant(
  ctx: PrepareQueryRunOptionsCtx
): Promise<Options> {
  const { session, logger } = ctx.runnerCtx;
  const policy = resolveSpaceMcpSessionPolicy(session, {
    nodeExecutionRepo: ctx.runnerCtx.db.getNodeExecutionRepo(),
    taskRepo: ctx.runnerCtx.db.getSpaceTaskRepo(),
  });
  if (!policy.attachGenericSpaceTools && !policy.attachLongTermAgentTools) return ctx.queryOptions;

  const serverNames = Object.keys(ctx.queryOptions.mcpServers ?? {}).sort();
  const missingServers = missingMcpServers(
    ctx.queryOptions.mcpServers as Record<string, unknown> | undefined,
    policy.requiredServers
  );
  if (missingServers.length === 0) return ctx.queryOptions;

  const payload = {
    event: 'member_space.mcp.missing',
    sessionId: session.id,
    spaceId: policy.spaceId,
    sessionType: session.type,
    role: policy.role,
    owner: policy.owner,
    requiredServers: policy.requiredServers,
    missingServers,
    presentServers: serverNames,
    liveSdkServers: getLiveSdkMcpServerNames(ctx.queryOptions),
    selfHealAttempted: !!ctx.runnerCtx.onMissingMemberSpaceMcpServers,
  };

  logger.error(
    `QueryRunner.start(): Space member session ${session.id} is MISSING required MCP servers. ` +
      `Missing: [${missingServers.join(', ')}]. Present: [${serverNames.join(', ')}]. ` +
      `This would remove Space coordination tools after cache eviction / DB reload. ${JSON.stringify(payload)}`
  );

  if (ctx.runnerCtx.onMissingMemberSpaceMcpServers) {
    await ctx.runnerCtx.onMissingMemberSpaceMcpServers(session.id, missingServers);
    const rebuilt = await ctx.runnerCtx.optionsBuilder.build({
      askUserQuestionHook: ctx.askUserQuestionHook,
    });
    const repairedOptions = ctx.runnerCtx.optionsBuilder.addSessionStateOptions(rebuilt);
    const stillMissing = missingMcpServers(
      repairedOptions.mcpServers as Record<string, unknown> | undefined,
      policy.requiredServers
    );
    if (stillMissing.length > 0) {
      throw new Error(
        `[MCP invariant] Space member session ${session.id} still missing required MCP servers ` +
          `after self-heal: [${stillMissing.join(', ')}]. Refusing to start a degraded ` +
          `Space member turn.`
      );
    }
    return repairedOptions;
  }

  throw new Error(
    `[MCP invariant] Space member session ${session.id} missing required MCP servers: ` +
      `[${missingServers.join(', ')}]. Refusing to start a degraded Space member turn.`
  );
}

export async function ensureMemberSpaceMcpInvariantStage(
  ctx: PrepareQueryRunOptionsCtx
): Promise<PrepareQueryRunOptionsCtx> {
  const queryOptions = await ensureMemberSpaceMcpInvariant(ctx);
  return updatePrepareQueryRunOptionsCtx(ctx, { queryOptions });
}

export async function ensureSessionProviderBridgesStage(
  ctx: PrepareQueryRunOptionsCtx
): Promise<PrepareQueryRunOptionsCtx> {
  await ctx.providerService.ensureSessionProviderBridges(ctx.providerSession);
  return ctx;
}

export function readProviderEnv(ctx: PrepareQueryRunOptionsCtx): PrepareQueryRunOptionsCtx {
  const providerEnvVars = ctx.providerService.getProviderEnvVars(ctx.providerSession);
  const extraProviderManagedEnvVars = NON_ANTHROPIC_PREFIX_PROVIDER_VARS.filter(
    (key) => providerEnvVars[key] !== undefined
  );
  return updatePrepareQueryRunOptionsCtx(ctx, { providerEnvVars, extraProviderManagedEnvVars });
}

export function applyProviderEnvToProcess(
  ctx: PrepareQueryRunOptionsCtx
): PrepareQueryRunOptionsCtx {
  const originalEnvVars = ctx.providerService.applyEnvVarsToProcessForSession(ctx.providerSession);
  ctx.runnerCtx.originalEnvVars = originalEnvVars;
  return updatePrepareQueryRunOptionsCtx(ctx, { originalEnvVars });
}

export function copyEnvToQueryOptions(ctx: PrepareQueryRunOptionsCtx): PrepareQueryRunOptionsCtx {
  const queryOptions = ctx.queryOptions;
  queryOptions.env = refreshQueryEnvFromProcess(queryOptions.env, process.env, {
    refreshAutoCompactWindow: ctx.refreshAutoCompactWindow,
    clearProviderManaged: true,
    preserveAnthropicAuthToken: ctx.resolvedProviderId === 'anthropic',
    preserveAnthropicOAuthToken: ctx.resolvedProviderId === 'anthropic',
    skipAmbientAnthropicApiKey: ctx.resolvedProviderId !== 'anthropic',
    extraProviderManagedEnvVars: ctx.extraProviderManagedEnvVars,
  }) as Record<string, string>;
  return updatePrepareQueryRunOptionsCtx(ctx, { queryOptions });
}

export function restoreAndNeutralizeProviderEnv(
  ctx: PrepareQueryRunOptionsCtx
): PrepareQueryRunOptionsCtx {
  if (Object.keys(ctx.originalEnvVars).length > 0) {
    ctx.providerService.restoreEnvVars(ctx.originalEnvVars);
  }
  ctx.runnerCtx.originalEnvVars = {};
  return updatePrepareQueryRunOptionsCtx(ctx, { originalEnvVars: {} });
}

const prepareQueryRunOptionsPipeline = (
  superpipe({ superseded: isPrepareQueryRunOptionsSuperseded })(
    'prepare-query-run-options'
  ) as PipelineAPI
)
  .input(['ctx'])
  .pipe(loadProviderService, 'ctx', 'ctx')
  .pipe(resnapshotAfter('provider-service-load'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .pipe(loadProviderRegistry, 'ctx', 'ctx')
  .pipe(resnapshotAfter('provider-registration'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .pipe(detectProvider, 'ctx', 'ctx')
  .pipe(checkProviderAvailability, 'ctx', 'ctx')
  .pipe(resnapshotAfter('provider-availability'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .pipe(probeProviderAuthStatus, 'ctx', 'ctx')
  .pipe(resnapshotAfter('provider-auth-status'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .pipe(throwIfProviderUnavailable, 'ctx', 'ctx')
  .pipe(refreshProviderAuthStatus, 'ctx', 'ctx')
  .pipe(resnapshotAfter('auth-status-refresh'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .pipe(probeFallbackAuth, 'ctx', 'ctx')
  .pipe(resnapshotAfter('fallback-auth-probe'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .pipe(createWorkspaceDirectory, 'ctx', 'ctx')
  .pipe(resnapshotAfter('workspace-dir'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .pipe(configureQueryOptionsBuilder, 'ctx', 'ctx')
  .pipe(resnapshotAfter('query-options-builder-configure'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .pipe(buildQueryOptions, 'ctx', 'ctx')
  .pipe(resnapshotAfter('query-options-build'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .pipe(configureSessionThinking, 'ctx', 'ctx')
  .pipe(resnapshotAfter('session-thinking-config'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .pipe(addSessionStateOptionsAndSnapshotMcp, 'ctx', 'ctx')
  .pipe(resnapshotAfter('mcp-snapshot'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .pipe(ensureSpaceChatMcpInvariantStage, 'ctx', 'ctx')
  .pipe(resnapshotAfter('space-chat-mcp-invariant'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .pipe(detectWorkflowMcpMissing, 'ctx', 'ctx')
  .pipe(selfHealWorkflowMcp, 'ctx', 'ctx')
  .pipe(resnapshotAfter('workflow-mcp-self-heal'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .pipe(validateWorkflowMcpAfterSelfHeal, 'ctx', 'ctx')
  .pipe(rebuildWorkflowQueryOptionsBuild, 'ctx', 'ctx')
  .pipe(resnapshotAfter('workflow-mcp-rebuild'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .pipe(rebuildWorkflowQueryOptionsFinalize, 'ctx', 'ctx')
  .pipe(ensureMemberSpaceMcpInvariantStage, 'ctx', 'ctx')
  .pipe(resnapshotAfter('member-space-mcp-invariant'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .pipe(ensureSessionProviderBridgesStage, 'ctx', 'ctx')
  .pipe(resnapshotAfter('session-provider-bridges'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .pipe(readProviderEnv, 'ctx', 'ctx')
  .pipe(resnapshotAfter('provider-env-read'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .pipe(applyProviderEnvToProcess, 'ctx', 'ctx')
  .pipe(resnapshotAfter('provider-env-apply'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .pipe(copyEnvToQueryOptions, 'ctx', 'ctx')
  .pipe(resnapshotAfter('query-options-env-copy'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .pipe(restoreAndNeutralizeProviderEnv, 'ctx', 'ctx')
  .pipe(resnapshotAfter('provider-env-restore'), 'ctx', 'ctx')
  .pipe('!superseded', 'ctx')
  .endAsync('ctx') as (ctx: PrepareQueryRunOptionsCtx) => Promise<PrepareQueryRunOptionsCtx>;

export { prepareQueryRunOptionsPipeline };
