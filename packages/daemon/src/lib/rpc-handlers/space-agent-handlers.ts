import type {
  CreateSpaceAgentTemplateParams,
  MessageHub,
  Session,
  SettingSource,
  SpaceLongHorizonAgent,
  SpaceLongHorizonAgentEventSubscriptionStatus,
  SpaceWorkerAgentPromotionDraft,
  ThinkingLevel,
  UpdateSpaceAgentTemplateParams,
  WorkerAgentModelPoolEntry,
} from '@hyperneo/shared';
import { isKnownToolEntry, isScopedBashToolEntry } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/index.ts';
import type { SpaceWorkflowRepository } from '../../storage/repositories/space-workflow-repository.ts';
import {
  coordinatorLongHorizonAgentId,
  type SpaceLongHorizonAgentRepository,
} from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import { composeLongHorizonSubscriptionPattern } from '../external-events/long-horizon-subscription-pattern.ts';
import { validateGlobPattern, validateSource } from '../external-events/topic-validator.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import {
  decideDefaultAgentUpdateAdmission,
  resolveIsDefaultAgent,
} from '../space/agents/default-agent-policy.ts';
import { getLongHorizonAgentTemplates } from '../space/agents/long-horizon-agent-templates.ts';
import {
  publishUnifiedAgentCreated,
  publishUnifiedAgentDeleted,
  publishUnifiedAgentUpdated,
} from '../space/agents/unified-agent-events.ts';
import { MIGRATED_WORKER_TEMPLATE_KEY } from '../space/agents/worker-long-horizon-mapper.ts';
import {
  validateAgentModel,
  validateAgentModelPool,
  validateSpaceAgentTools,
} from '../space/agents/agent-validation.ts';
import { SpaceAgentTemplateManager } from '../space/managers/space-agent-template-manager.ts';
import { SpaceAgentTemplateReapplyService } from '../space/managers/space-agent-template-reapply-service.ts';
import type { SpaceManager } from '../space/managers/space-manager.ts';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service.ts';
import { getNextRunAt, isValidCronExpression } from '../space/schedule/cron-utils.ts';
import { RESERVED_SPACE_AGENT_HANDLES, slugifyWithinLimit, validateSlug } from '../space/slug.ts';

const PROMOTION_MESSAGE_LIMIT = 24;
const PROMOTION_CONTEXT_CHAR_LIMIT = 6000;

type UnifiedSpaceAgentRuntimeService = Pick<
  SpaceRuntimeService,
  | 'refreshLongHorizonAgentSubscriptions'
  | 'removeLongHorizonAgentSubscriptions'
  | 'refreshLongHorizonSubscription'
  | 'removeLongHorizonSubscription'
  | 'clearLongTermAgentSessionProvider'
>;

interface UnifiedSpaceAgentMethodDeps {
  spaceManager: SpaceManager;
  repo: SpaceLongHorizonAgentRepository;
  templateManager?: SpaceAgentTemplateManager;
  workflowRepo: Pick<SpaceWorkflowRepository, 'getWorkflowsReferencingAgent'>;
  runtimeService?: UnifiedSpaceAgentRuntimeService;
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>;
}

interface UnifiedAgentCreateInput {
  id?: string;
  spaceId: string;
  name?: string;
  handle?: string;
  displayName?: string;
  templateKey?: string | null;
  templateName?: string | null;
  instructions?: string;
  customPrompt?: string | null;
  autonomyLevel?: number | null;
  model?: string | null;
  thinkingLevel?: ThinkingLevel | string | null;
  provider?: string | null;
  settingSources?: SettingSource[] | null;
  toolPermissions?: Record<string, unknown>;
  tools?: string[];
  status?: string;
  description?: string;
  modelPool?: WorkerAgentModelPoolEntry[];
}

interface UnifiedAgentUpdateInput {
  id?: string;
  agentId?: string;
  spaceId?: string;
  handle?: string;
  name?: string;
  displayName?: string;
  templateKey?: string | null;
  templateName?: string | null;
  templateHash?: string | null;
  instructions?: string;
  customPrompt?: string | null;
  autonomyLevel?: number | null;
  model?: string | null;
  thinkingLevel?: ThinkingLevel | string | null;
  provider?: string | null;
  settingSources?: SettingSource[] | null;
  toolPermissions?: Record<string, unknown> | null;
  tools?: string[] | null;
  status?: string;
  description?: string | null;
  modelPool?: WorkerAgentModelPoolEntry[] | null;
}

function clampText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

function clampTextEnd(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `…${value.slice(value.length - limit + 1).trimStart()}`;
}

function deriveAgentName(session: Session): string {
  const base = (session.title || 'Promoted Agent')
    .replace(/^space chat:?\s*/i, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim();
  return clampText(base || 'Promoted Agent', 64);
}

function extractTools(session: Session): string[] | undefined {
  const preset = session.config.sdkToolsPreset;
  if (Array.isArray(preset)) {
    const tools = preset.filter((tool) => isKnownToolEntry(tool));
    return [...new Set(tools)];
  }

  const disallowedTools =
    session.config.disallowedTools?.filter((tool) => isKnownToolEntry(tool)) ?? [];
  if (disallowedTools.length === 0) return undefined;

  const hasScopedBash = (session.config.allowedTools ?? []).some((tool) =>
    isScopedBashToolEntry(tool)
  );
  const defaultTools = [
    'Read',
    'Write',
    'Edit',
    'MultiEdit',
    ...(hasScopedBash ? [] : ['Bash']),
    'Grep',
    'Glob',
    'WebFetch',
    'WebSearch',
    'NotebookEdit',
    'TodoWrite',
    'AskUserQuestion',
    'EnterPlanMode',
    'ExitPlanMode',
    'Skill',
    'ToolSearch',
  ];
  const preservedAllowedTools =
    session.config.allowedTools?.filter((tool) => isKnownToolEntry(tool)) ?? [];
  const disallowed = new Set(disallowedTools);
  return [...new Set([...defaultTools, ...preservedAllowedTools])].filter(
    (tool) => !disallowed.has(tool)
  );
}

function extractSettingSources(session: Session): SettingSource[] | undefined {
  if (session.config.settingSources !== undefined) return session.config.settingSources;
  const toolSources = session.config.tools?.settingSources;
  return toolSources !== undefined ? toolSources : undefined;
}

function buildPromotionDraft(session: Session, db: Database): SpaceWorkerAgentPromotionDraft {
  const messages = db.getRenderableTextMessages(session.id, PROMOTION_MESSAGE_LIMIT);
  const context = messages.length
    ? messages
        .map((message) => {
          const speaker = message.type === 'assistant' ? 'Assistant' : 'User';
          return `${speaker}: ${message.text}`;
        })
        .join('\n\n---\n\n')
    : 'No renderable chat messages were available. Fill in standing context manually before creating this agent.';
  const standingContext = clampTextEnd(context, PROMOTION_CONTEXT_CHAR_LIMIT);
  const name = deriveAgentName(session);
  const responsibility = `Continue the durable role that emerged in "${session.title || session.id}".`;
  const standingInstructions =
    'Use the standing context below as background, not as a transcript to replay. Keep future work goal-oriented, cite uncertainty, and ask for human input before high-impact actions.';
  const autonomy =
    'Supervised by default: propose actions and wait for explicit approval before destructive, external, or irreversible changes.';
  const managedGoals =
    'Review and narrow this list to the goals this long-horizon agent should own.';
  const managedScopes =
    'Review and narrow this list to repositories, files, systems, or product areas this agent may manage.';
  const reminders =
    'Periodically summarize progress, blockers, decisions, and needed human follow-up.';
  const eventSubscriptions =
    'Review and list events this agent should react to, such as task changes, PR reviews, CI failures, mentions, or scheduled check-ins.';
  const customPrompt = `## Responsibility\n${responsibility}\n\n## Standing Instructions\n${standingInstructions}\n\n## Autonomy\n${autonomy}\n\n## Managed Goals\n${managedGoals}\n\n## Managed Scopes\n${managedScopes}\n\n## Reminders\n${reminders}\n\n## Event Subscriptions\n${eventSubscriptions}\n\n## Standing Context From Promoted Session\n${standingContext}`;

  return {
    sourceSessionId: session.id,
    sourceSessionTitle: session.title || session.id,
    name,
    description: responsibility,
    model: session.config.model,
    thinkingLevel: session.config.thinkingLevel as ThinkingLevel | undefined,
    provider: session.config.provider,
    customPrompt,
    tools: extractTools(session),
    settingSources: extractSettingSources(session),
    profile: {
      responsibility,
      standingInstructions,
      autonomy,
      managedGoals,
      managedScopes,
      reminders,
      eventSubscriptions,
      standingContext,
    },
  };
}

function validateLongHorizonSubscriptionPattern(
  source: string,
  topic: string,
  options: { allowWildcardSource?: boolean } = {}
): string {
  if (source !== '*' || !options.allowWildcardSource) {
    const sourceValidation = validateSource(source);
    if (!sourceValidation.valid) throw new Error(sourceValidation.reason ?? 'invalid source');
  }
  const pattern = composeLongHorizonSubscriptionPattern(source, topic);
  const validation = validateGlobPattern(pattern);
  if (!validation.valid) throw new Error(validation.reason ?? 'invalid pattern');
  return pattern;
}

function ensureUnifiedDisplayNameAvailable(
  deps: UnifiedSpaceAgentMethodDeps,
  spaceId: string,
  displayName: string,
  excludeId?: string
): void {
  const target = displayName.trim().toLowerCase();
  if (!target) return;
  const unifiedConflict = deps.repo
    .listBySpaceId(spaceId)
    .find(
      (a) =>
        a.status !== 'archived' &&
        a.id !== excludeId &&
        (a.displayName ?? '').trim().toLowerCase() === target
    );
  if (unifiedConflict) {
    throw new Error(
      `Agent name "${displayName}" is already used by another unified agent in this space`
    );
  }
}

function validateLongHorizonAgentHandle(
  deps: UnifiedSpaceAgentMethodDeps,
  spaceId: string,
  handle: string,
  excludeId: string,
  rawHandle = handle
): string | null {
  if (rawHandle !== handle) return 'Agent handle must not have leading or trailing whitespace';
  const slugError = validateSlug(handle);
  if (slugError) return `Invalid agent handle: ${slugError}`;
  if (
    RESERVED_SPACE_AGENT_HANDLES.includes(handle as (typeof RESERVED_SPACE_AGENT_HANDLES)[number])
  ) {
    return `Agent handle "${handle}" is reserved`;
  }
  const longHorizonOwner = deps.repo.getByHandle(spaceId, handle);
  if (longHorizonOwner && longHorizonOwner.id !== excludeId) {
    return `An agent with handle "${handle}" already exists in this Space`;
  }
  return null;
}

function reservedLongHorizonHandles(
  deps: UnifiedSpaceAgentMethodDeps,
  spaceId: string,
  excludeId: string
): string[] {
  return [
    ...deps.repo
      .listBySpaceId(spaceId)
      .filter((agent) => agent.id !== excludeId)
      .map((agent) => agent.handle),
    ...RESERVED_SPACE_AGENT_HANDLES,
  ];
}

function resolveLongHorizonAgentCreateHandle(
  deps: UnifiedSpaceAgentMethodDeps,
  spaceId: string,
  agentId: string,
  handle: string
): string {
  const normalized = slugifyWithinLimit(handle, reservedLongHorizonHandles(deps, spaceId, agentId));
  if (normalized !== handle) return normalized;

  const handleError = validateLongHorizonAgentHandle(deps, spaceId, normalized, agentId);
  if (handleError) throw new Error(handleError);
  return normalized;
}

function validateLongHorizonAgentUpdateHandle(
  deps: UnifiedSpaceAgentMethodDeps,
  spaceId: string,
  agentId: string,
  handle: string
): string {
  const trimmed = handle.trim();
  const handleError = validateLongHorizonAgentHandle(deps, spaceId, trimmed, agentId, handle);
  if (handleError) throw new Error(handleError);
  return trimmed;
}

function assertNoDuplicateLongHorizonSubscriptionPattern(
  repo: SpaceLongHorizonAgentRepository,
  agentId: string,
  source: string,
  topic: string,
  pattern: string,
  currentSubscriptionId?: string
): void {
  const duplicate = repo.listSubscriptions(agentId).find((subscription) => {
    if (subscription.id === currentSubscriptionId) return false;
    try {
      return (
        composeLongHorizonSubscriptionPattern(
          subscription.source,
          subscription.topic
        ).toLowerCase() === pattern.toLowerCase()
      );
    } catch {
      return false;
    }
  });
  if (duplicate) {
    throw new Error(
      `Subscription pattern duplicates existing subscription ${duplicate.id}: ${pattern}`
    );
  }
}

function toolPermissionsToolsList(
  toolPermissions: Record<string, unknown> | null | undefined
): string[] | undefined {
  if (!toolPermissions || !Array.isArray(toolPermissions.tools)) return undefined;
  const tools = toolPermissions.tools.filter((tool): tool is string => typeof tool === 'string');
  return tools.length > 0 ? tools : undefined;
}

function buildUnifiedToolPermissions(
  params: UnifiedAgentCreateInput | UnifiedAgentUpdateInput
): Record<string, unknown> | undefined {
  if (params.tools !== undefined) {
    return params.tools && params.tools.length > 0 ? { tools: params.tools } : {};
  }
  if (params.toolPermissions !== undefined) {
    return params.toolPermissions ?? {};
  }
  return undefined;
}

const UNIFIED_AGENT_STATUSES = ['active', 'paused', 'disabled', 'archived'] as const;

function assertUnifiedAgentStatus(status: string | undefined): void {
  if (status === undefined) return;
  if (!(UNIFIED_AGENT_STATUSES as readonly string[]).includes(status)) {
    throw new Error(
      `Invalid agent status: ${status}. Valid statuses: ${UNIFIED_AGENT_STATUSES.join(', ')}`
    );
  }
}

function resolveUnifiedTemplateKey(
  params: UnifiedAgentCreateInput | UnifiedAgentUpdateInput
): string | null | undefined {
  if (params.templateKey !== undefined) return params.templateKey;
  if (params.templateName !== undefined) return params.templateName;
  return undefined;
}

function resolveUnifiedInstructions(
  params: UnifiedAgentCreateInput | UnifiedAgentUpdateInput
): string | undefined {
  if (params.instructions !== undefined) return params.instructions;
  if (params.customPrompt !== undefined) return params.customPrompt ?? '';
  return undefined;
}

interface CreateUnifiedAgentCtx extends UnifiedSpaceAgentMethodDeps {
  params: UnifiedAgentCreateInput;
  agentId: string;
  handle: string;
  displayName: string;
  agent: SpaceLongHorizonAgent | null;
}

async function createAdmitRequestStage(ctx: CreateUnifiedAgentCtx): Promise<CreateUnifiedAgentCtx> {
  const { params } = ctx;
  if (!params.spaceId) throw new Error('spaceId is required');
  const displayName = params.displayName ?? params.name;
  if (!displayName && !params.handle) throw new Error('name is required');
  const space = await ctx.spaceManager.getSpace(params.spaceId);
  if (!space) throw new Error(`Space not found: ${params.spaceId}`);
  return { ...ctx, agentId: params.id ?? '', displayName: displayName ?? '' };
}

function createResolveIdentityStage(ctx: CreateUnifiedAgentCtx): CreateUnifiedAgentCtx {
  const { params, agentId } = ctx;
  const handleSource = params.handle ?? ctx.displayName;
  if (!handleSource) throw new Error('handle is required');
  const handle = params.handle
    ? resolveLongHorizonAgentCreateHandle(ctx, params.spaceId, agentId, params.handle)
    : slugifyWithinLimit(handleSource, reservedLongHorizonHandles(ctx, params.spaceId, agentId));
  const displayName = ctx.displayName || handle;
  if (displayName.trim() === '') {
    throw new Error('displayName cannot be blank');
  }
  ensureUnifiedDisplayNameAvailable(ctx, params.spaceId, displayName, agentId || undefined);
  return { ...ctx, handle, displayName };
}

async function createValidateConfigStage(
  ctx: CreateUnifiedAgentCtx
): Promise<CreateUnifiedAgentCtx> {
  const { params } = ctx;
  const tools = params.tools ?? toolPermissionsToolsList(params.toolPermissions);
  if (tools) {
    const toolError = validateSpaceAgentTools(tools);
    if (toolError) throw new Error(toolError);
  }
  if (params.model) {
    const modelError = await validateAgentModel(params.model, params.provider ?? undefined);
    if (modelError) throw new Error(modelError);
  }
  if (params.modelPool && params.modelPool.length > 0) {
    const poolError = await validateAgentModelPool(params.modelPool);
    if (poolError) throw new Error(poolError);
  }
  return ctx;
}

function createPersistStage(ctx: CreateUnifiedAgentCtx): CreateUnifiedAgentCtx {
  const { params } = ctx;
  const agent = ctx.repo.create({
    id: params.id,
    spaceId: params.spaceId,
    handle: ctx.handle,
    displayName: ctx.displayName,
    templateKey: resolveUnifiedTemplateKey(params) ?? undefined,
    status: params.status as SpaceLongHorizonAgent['status'],
    instructions: resolveUnifiedInstructions(params) ?? '',
    autonomyLevel: params.autonomyLevel as SpaceLongHorizonAgent['autonomyLevel'],
    model: params.model ?? null,
    thinkingLevel: params.thinkingLevel as SpaceLongHorizonAgent['thinkingLevel'],
    provider: params.provider ?? null,
    settingSources: params.settingSources ?? null,
    toolPermissions: buildUnifiedToolPermissions(params) ?? {},
    description: params.description,
    modelPool: params.modelPool,
  });
  return { ...ctx, agent };
}

async function createPublishStage(ctx: CreateUnifiedAgentCtx): Promise<CreateUnifiedAgentCtx> {
  await publishUnifiedAgentCreated(ctx.internalEventBus, ctx.agent!);
  return ctx;
}

const runCreateUnifiedSpaceAgent = (superpipe({})('create-unified-space-agent') as PipelineAPI)
  .input(['ctx'])
  .pipe(createAdmitRequestStage, 'ctx', 'ctx')
  .pipe(createResolveIdentityStage, 'ctx', 'ctx')
  .pipe(createValidateConfigStage, 'ctx', 'ctx')
  .pipe(createPersistStage, 'ctx', 'ctx')
  .pipe(createPublishStage, 'ctx', 'ctx')
  .endAsync('ctx') as (ctx: CreateUnifiedAgentCtx) => Promise<CreateUnifiedAgentCtx>;

function buildUnifiedAgentCreate(
  deps: UnifiedSpaceAgentMethodDeps
): (params: UnifiedAgentCreateInput) => Promise<SpaceLongHorizonAgent> {
  return async (params: UnifiedAgentCreateInput): Promise<SpaceLongHorizonAgent> => {
    const ctx = await runCreateUnifiedSpaceAgent({
      ...deps,
      params,
      agentId: '',
      handle: '',
      displayName: '',
      agent: null,
    });
    return ctx.agent!;
  };
}

interface DeleteUnifiedAgentCtx extends UnifiedSpaceAgentMethodDeps {
  params: { id?: string; agentId?: string; spaceId?: string };
  agentId: string;
  existing: SpaceLongHorizonAgent | null;
  spaceId: string;
}

function deleteResolveTargetStage(ctx: DeleteUnifiedAgentCtx): DeleteUnifiedAgentCtx {
  const agentId = ctx.params.id ?? ctx.params.agentId;
  if (!agentId) throw new Error('id is required');
  const existing = ctx.repo.getById(agentId);
  if (!existing) throw new Error(`Agent not found: ${agentId}`);
  const { spaceId } = existing;
  if (ctx.params.spaceId && spaceId !== ctx.params.spaceId) {
    throw new Error(`Agent ${agentId} does not belong to space ${ctx.params.spaceId}`);
  }
  return { ...ctx, agentId, existing, spaceId };
}

function deleteAuthorizeStage(ctx: DeleteUnifiedAgentCtx): DeleteUnifiedAgentCtx {
  const { agentId, existing, spaceId } = ctx;
  const referencingWorkflows = ctx.workflowRepo.getWorkflowsReferencingAgent(agentId);
  if (referencingWorkflows.length > 0) {
    const displayName = existing?.displayName ?? agentId;
    const workflowNames = referencingWorkflows.map((wf) => wf.name);
    throw new Error(
      `Cannot delete agent "${displayName}" - it is referenced by workflow nodes` +
        workflowNames.map((n) => ` (Workflow: ${n})`).join('')
    );
  }
  const coordinatorId =
    agentId === coordinatorLongHorizonAgentId(spaceId)
      ? agentId
      : (ctx.repo.getCoordinator(spaceId)?.id ?? null);
  if (coordinatorId === agentId) {
    throw new Error('The coordinator agent cannot be deleted');
  }
  return ctx;
}

function deleteApplyStage(ctx: DeleteUnifiedAgentCtx): DeleteUnifiedAgentCtx {
  const { agentId, spaceId } = ctx;
  ctx.repo.delete(agentId);
  ctx.runtimeService?.removeLongHorizonAgentSubscriptions(spaceId, agentId);
  return ctx;
}

async function deletePublishStage(ctx: DeleteUnifiedAgentCtx): Promise<DeleteUnifiedAgentCtx> {
  await publishUnifiedAgentDeleted(ctx.internalEventBus, ctx.spaceId, ctx.agentId);
  return ctx;
}

const runDeleteUnifiedSpaceAgent = (superpipe({})('delete-unified-space-agent') as PipelineAPI)
  .input(['ctx'])
  .pipe(deleteResolveTargetStage, 'ctx', 'ctx')
  .pipe(deleteAuthorizeStage, 'ctx', 'ctx')
  .pipe(deleteApplyStage, 'ctx', 'ctx')
  .pipe(deletePublishStage, 'ctx', 'ctx')
  .endAsync('ctx') as (ctx: DeleteUnifiedAgentCtx) => Promise<DeleteUnifiedAgentCtx>;

interface UpdateUnifiedAgentCtx extends UnifiedSpaceAgentMethodDeps {
  params: UnifiedAgentUpdateInput;
  agentId: string;
  existing: SpaceLongHorizonAgent | null;
  spaceId: string;
  unifiedAfter: SpaceLongHorizonAgent | null;
  agent: SpaceLongHorizonAgent | null;
}

function updateResolveTargetStage(ctx: UpdateUnifiedAgentCtx): UpdateUnifiedAgentCtx {
  const params = ctx.params;
  const agentId = params.id ?? params.agentId;
  if (!agentId) throw new Error('id is required');
  const existing = ctx.repo.getById(agentId);
  if (!existing) throw new Error(`Agent not found: ${agentId}`);
  if (params.spaceId && existing.spaceId !== params.spaceId)
    throw new Error(`Agent ${agentId} does not belong to space ${params.spaceId}`);
  return { ...ctx, agentId, existing, spaceId: existing.spaceId };
}

function updateValidateRequestStage(ctx: UpdateUnifiedAgentCtx): UpdateUnifiedAgentCtx {
  assertUnifiedAgentStatus(ctx.params.status);
  const displayName =
    ctx.params.displayName !== undefined ? ctx.params.displayName : ctx.params.name;
  if (displayName !== undefined && displayName.trim() === '') {
    throw new Error('displayName cannot be blank');
  }
  return ctx;
}

function updateAuthorizeStage(ctx: UpdateUnifiedAgentCtx): UpdateUnifiedAgentCtx {
  if (!ctx.existing) return ctx;
  const decision = decideDefaultAgentUpdateAdmission({
    isDefaultAgent: resolveIsDefaultAgent(ctx.spaceId, ctx.agentId, ctx.repo),
    handleChanged: ctx.params.handle !== undefined && ctx.params.handle !== ctx.existing.handle,
    nextStatus: ctx.params.status,
  });
  if (decision.action === 'reject') throw new Error(decision.message);
  return ctx;
}

async function updateApplyStage(ctx: UpdateUnifiedAgentCtx): Promise<UpdateUnifiedAgentCtx> {
  const { params, agentId, existing } = ctx;
  if (!existing) throw new Error(`Agent not found: ${agentId}`);
  const displayName = params.displayName !== undefined ? params.displayName : params.name;
  const handle =
    params.handle === undefined
      ? undefined
      : validateLongHorizonAgentUpdateHandle(ctx, existing.spaceId, agentId, params.handle);
  const unarchiving =
    existing.status === 'archived' && params.status !== undefined && params.status !== 'archived';
  if (displayName !== undefined || unarchiving) {
    ensureUnifiedDisplayNameAvailable(
      ctx,
      existing.spaceId,
      displayName ?? existing.displayName,
      agentId
    );
  }

  const tools = params.tools ?? toolPermissionsToolsList(params.toolPermissions);
  if (tools) {
    const toolError = validateSpaceAgentTools(tools);
    if (toolError) throw new Error(toolError);
  }
  if (params.model) {
    const provider = params.provider !== undefined ? params.provider : existing.provider;
    const modelError = await validateAgentModel(params.model, provider);
    if (modelError) throw new Error(modelError);
  }
  if (params.modelPool && params.modelPool.length > 0) {
    const poolError = await validateAgentModelPool(params.modelPool);
    if (poolError) throw new Error(poolError);
  }
  if (resolveUnifiedTemplateKey(params) === MIGRATED_WORKER_TEMPLATE_KEY) {
    throw new Error(
      `Template key ${MIGRATED_WORKER_TEMPLATE_KEY} is reserved for migrated worker mirrors`
    );
  }

  const agent = ctx.repo.update(agentId, {
    handle,
    displayName,
    templateKey: resolveUnifiedTemplateKey(params),
    status: params.status as SpaceLongHorizonAgent['status'],
    instructions: resolveUnifiedInstructions(params),
    autonomyLevel: params.autonomyLevel as SpaceLongHorizonAgent['autonomyLevel'],
    model: params.model,
    thinkingLevel: params.thinkingLevel as SpaceLongHorizonAgent['thinkingLevel'],
    provider: params.provider,
    settingSources: params.settingSources,
    toolPermissions: buildUnifiedToolPermissions(params),
    description: params.description,
    modelPool: params.modelPool,
  });
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  if (params.provider === null) {
    await ctx.runtimeService?.clearLongTermAgentSessionProvider(agent.spaceId, agent.id);
  }
  if (ctx.runtimeService) {
    const refresh = ctx.runtimeService.refreshLongHorizonAgentSubscriptions(
      agent.spaceId,
      agent.id
    );
    if (!refresh.success) throw new Error(refresh.error ?? 'Failed to refresh subscriptions');
  }
  return { ...ctx, unifiedAfter: agent, agent };
}

async function updatePublishStage(ctx: UpdateUnifiedAgentCtx): Promise<UpdateUnifiedAgentCtx> {
  if (ctx.unifiedAfter) {
    await publishUnifiedAgentUpdated(ctx.internalEventBus, ctx.unifiedAfter);
  }
  return ctx;
}

const runUpdateUnifiedSpaceAgent = (superpipe({})('update-unified-space-agent') as PipelineAPI)
  .input(['ctx'])
  .pipe(updateResolveTargetStage, 'ctx', 'ctx')
  .pipe(updateValidateRequestStage, 'ctx', 'ctx')
  .pipe(updateAuthorizeStage, 'ctx', 'ctx')
  .pipe(updateApplyStage, 'ctx', 'ctx')
  .pipe(updatePublishStage, 'ctx', 'ctx')
  .endAsync('ctx') as (ctx: UpdateUnifiedAgentCtx) => Promise<UpdateUnifiedAgentCtx>;

export function registerUnifiedSpaceAgentMethods(
  messageHub: MessageHub,
  deps: UnifiedSpaceAgentMethodDeps
): void {
  const method = (name: string): string => `spaceAgent.${name}`;
  const createUnifiedAgent = buildUnifiedAgentCreate(deps);
  const templateManager = deps.templateManager;

  messageHub.onRequest(method('listBuiltInTemplates'), async (data) => {
    const params = data as { spaceId: string };
    if (!params.spaceId) throw new Error('spaceId is required');
    const space = await deps.spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);
    return { templates: getLongHorizonAgentTemplates() };
  });

  if (templateManager) {
    messageHub.onRequest(method('listTemplates'), async () => {
      return { templates: templateManager.list() };
    });

    messageHub.onRequest(method('createTemplate'), async (data) => {
      const params = data as CreateSpaceAgentTemplateParams;
      if (!params.key) throw new Error('key is required');
      if (!params.handle) throw new Error('handle is required');
      const result = await templateManager.create(params);
      if (!result.ok) throw new Error(result.error);
      return { template: result.value };
    });

    messageHub.onRequest(method('updateTemplate'), async (data) => {
      const params = data as { key: string } & UpdateSpaceAgentTemplateParams;
      if (!params.key) throw new Error('key is required');
      const { key, ...updates } = params;
      const result = await templateManager.update(key, updates);
      if (!result.ok) throw new Error(result.error);
      return { template: result.value };
    });

    messageHub.onRequest(method('deleteTemplate'), async (data) => {
      const params = data as { key: string };
      if (!params.key) throw new Error('key is required');
      const result = templateManager.delete(params.key);
      if (!result.ok) throw new Error(result.error);
      return { success: true };
    });
  }

  messageHub.onRequest(method('list'), async (data) => {
    const params = data as { spaceId: string };
    if (!params.spaceId) throw new Error('spaceId is required');
    const space = await deps.spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);
    deps.repo.ensureCoordinator(params.spaceId);
    return { agents: deps.repo.listBySpaceId(params.spaceId) };
  });

  messageHub.onRequest(method('create'), async (data) => {
    const params = data as UnifiedAgentCreateInput;
    const agent = await createUnifiedAgent(params);
    return { agent };
  });

  messageHub.onRequest(method('update'), async (data) => {
    const ctx = await runUpdateUnifiedSpaceAgent({
      ...deps,
      params: data as UnifiedAgentUpdateInput,
      agentId: '',
      existing: null,
      spaceId: '',
      unifiedAfter: null,
      agent: null,
    });
    return { agent: ctx.agent };
  });

  messageHub.onRequest(method('delete'), async (data) => {
    await runDeleteUnifiedSpaceAgent({
      ...deps,
      params: data as { id?: string; agentId?: string; spaceId?: string },
      agentId: '',
      existing: null,
      spaceId: '',
    });
    return { success: true };
  });

  messageHub.onRequest(method('listReminders'), async (data) => {
    const params = data as { agentId: string };
    if (!params.agentId) throw new Error('agentId is required');
    return { reminders: deps.repo.listReminders(params.agentId) };
  });

  messageHub.onRequest(method('listReminderCounts'), async (data) => {
    const params = data as { agentIds: string[] };
    if (!Array.isArray(params.agentIds)) throw new Error('agentIds is required');
    const counts: Record<string, number> = {};
    for (const agentId of params.agentIds) {
      const reminders = deps.repo.listReminders(agentId);
      counts[agentId] = reminders.filter((r) => r.status === 'active').length;
    }
    return { counts };
  });

  messageHub.onRequest(method('createReminder'), async (data) => {
    const params = data as {
      spaceId: string;
      agentId: string;
      title: string;
      body?: string;
      triggerType: 'at' | 'cron';
      runAt?: number | null;
      cronExpression?: string | null;
      timezone?: string;
    };
    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.agentId) throw new Error('agentId is required');
    if (!params.title) throw new Error('title is required');
    if (!params.triggerType) throw new Error('triggerType is required');
    let nextRunAt: number | null = null;
    if (params.triggerType === 'at') {
      if (typeof params.runAt !== 'number') {
        throw new Error('runAt is required for triggerType "at"');
      }
      nextRunAt = params.runAt;
    } else {
      const expression = params.cronExpression;
      if (!expression) throw new Error('cronExpression is required for triggerType "cron"');
      if (!isValidCronExpression(expression)) {
        throw new Error(`Invalid cron expression: ${expression}`);
      }
      const timezone = params.timezone ?? 'UTC';
      const firstRunAt = getNextRunAt(expression, timezone);
      if (firstRunAt === null) {
        throw new Error(`Invalid timezone or cron expression for reminder: ${timezone}`);
      }
      nextRunAt = firstRunAt;
    }
    const reminder = deps.repo.createReminder({
      spaceId: params.spaceId,
      agentId: params.agentId,
      title: params.title,
      body: params.body,
      triggerType: params.triggerType,
      runAt: params.runAt,
      cronExpression: params.cronExpression,
      timezone: params.timezone,
      nextRunAt,
    });
    return { reminder };
  });

  messageHub.onRequest(method('deleteReminder'), async (data) => {
    const params = data as { reminderId: string };
    if (!params.reminderId) throw new Error('reminderId is required');
    const existing = deps.repo.getReminder(params.reminderId);
    if (!existing) throw new Error(`Reminder not found: ${params.reminderId}`);
    deps.repo.deleteReminder(params.reminderId);
    return { success: true };
  });

  messageHub.onRequest(method('listSubscriptions'), async (data) => {
    const params = data as { agentId: string; spaceId?: string };
    if (!params.agentId) throw new Error('agentId is required');
    const agent = deps.repo.getById(params.agentId);
    if (!agent) throw new Error(`Agent not found: ${params.agentId}`);
    if (params.spaceId && agent.spaceId !== params.spaceId) {
      throw new Error(`Agent ${params.agentId} does not belong to space ${params.spaceId}`);
    }
    return { subscriptions: deps.repo.listSubscriptions(params.agentId) };
  });

  messageHub.onRequest(method('createSubscription'), async (data) => {
    const params = data as {
      spaceId: string;
      agentId: string;
      source: string;
      topic: string;
      filter?: Record<string, unknown>;
      status?: SpaceLongHorizonAgentEventSubscriptionStatus;
    };
    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.agentId) throw new Error('agentId is required');
    if (!params.source?.trim()) throw new Error('source is required');
    if (!params.topic?.trim()) throw new Error('topic is required');
    const source = params.source.trim();
    const topic = params.topic.trim();
    const pattern = validateLongHorizonSubscriptionPattern(source, topic);
    assertNoDuplicateLongHorizonSubscriptionPattern(
      deps.repo,
      params.agentId,
      source,
      topic,
      pattern
    );
    const subscription = deps.repo.createSubscription({
      spaceId: params.spaceId,
      agentId: params.agentId,
      source,
      topic,
      filter: params.filter,
      status: params.status,
    });
    const refresh = deps.runtimeService?.refreshLongHorizonSubscription(
      subscription.spaceId,
      subscription.id
    );
    if (refresh && !refresh.success)
      throw new Error(refresh.error ?? 'Failed to refresh subscription');
    return { subscription };
  });

  messageHub.onRequest(method('updateSubscription'), async (data) => {
    const params = data as {
      subscriptionId: string;
      spaceId?: string;
      source?: string;
      topic?: string;
      filter?: Record<string, unknown>;
      status?: SpaceLongHorizonAgentEventSubscriptionStatus;
    };
    if (!params.subscriptionId) throw new Error('subscriptionId is required');
    if (params.source !== undefined && !params.source.trim()) throw new Error('source is required');
    if (params.topic !== undefined && !params.topic.trim()) throw new Error('topic is required');
    const existing = deps.repo.getSubscription(params.subscriptionId);
    if (!existing) throw new Error(`Subscription not found: ${params.subscriptionId}`);
    if (params.spaceId && existing.spaceId !== params.spaceId) {
      throw new Error(
        `Subscription ${params.subscriptionId} does not belong to space ${params.spaceId}`
      );
    }
    const source = params.source?.trim() ?? existing.source;
    const topic = params.topic?.trim() ?? existing.topic;
    const pattern = validateLongHorizonSubscriptionPattern(source, topic, {
      allowWildcardSource: params.source === undefined && params.topic === undefined,
    });
    assertNoDuplicateLongHorizonSubscriptionPattern(
      deps.repo,
      existing.agentId,
      source,
      topic,
      pattern,
      existing.id
    );
    const subscription = deps.repo.updateSubscription(params.subscriptionId, {
      ...(params.source !== undefined ? { source } : {}),
      ...(params.topic !== undefined ? { topic } : {}),
      ...(params.filter !== undefined ? { filter: params.filter } : {}),
      ...(params.status !== undefined ? { status: params.status } : {}),
    });
    if (!subscription) throw new Error(`Subscription not found: ${params.subscriptionId}`);
    const refresh = deps.runtimeService?.refreshLongHorizonSubscription(
      subscription.spaceId,
      subscription.id
    );
    if (refresh && !refresh.success)
      throw new Error(refresh.error ?? 'Failed to refresh subscription');
    return { subscription };
  });

  messageHub.onRequest(method('deleteSubscription'), async (data) => {
    const params = data as { subscriptionId: string; spaceId?: string };
    if (!params.subscriptionId) throw new Error('subscriptionId is required');
    const existing = deps.repo.getSubscription(params.subscriptionId);
    if (!existing) throw new Error(`Subscription not found: ${params.subscriptionId}`);
    if (params.spaceId && existing.spaceId !== params.spaceId) {
      throw new Error(
        `Subscription ${params.subscriptionId} does not belong to space ${params.spaceId}`
      );
    }
    deps.runtimeService?.removeLongHorizonSubscription(existing.spaceId, existing.id);
    deps.repo.deleteSubscription(params.subscriptionId);
    return { success: true };
  });
}

export function setupSpaceAgentHandlers(
  messageHub: MessageHub,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  spaceManager: SpaceManager,
  db: Database,
  longHorizonAgentRepo: SpaceLongHorizonAgentRepository,
  workflowRepo: Pick<SpaceWorkflowRepository, 'getWorkflowsReferencingAgent'>,
  runtimeService?: UnifiedSpaceAgentRuntimeService,
  templateManager?: SpaceAgentTemplateManager
): void {
  const deps: UnifiedSpaceAgentMethodDeps = {
    spaceManager,
    repo: longHorizonAgentRepo,
    templateManager,
    workflowRepo,
    runtimeService,
    internalEventBus,
  };
  const createUnifiedAgent = buildUnifiedAgentCreate(deps);

  registerUnifiedSpaceAgentMethods(messageHub, deps);

  if (templateManager) {
    const reapplyTemplateService = new SpaceAgentTemplateReapplyService(
      longHorizonAgentRepo,
      templateManager,
      runtimeService,
      internalEventBus
    );

    messageHub.onRequest('spaceAgent.reapplyTemplate', async (data) => {
      const params = data as { agentId?: string; id?: string };
      const agentId = params.agentId ?? params.id;
      if (!agentId) throw new Error('agentId is required');
      const result = await reapplyTemplateService.reapplyTemplate(agentId);
      if (!result.ok) throw new Error(result.error);
      return { agent: result.value };
    });
  }

  messageHub.onRequest('spaceAgent.get', async (data) => {
    const params = data as { id: string };
    if (!params.id) throw new Error('id is required');

    const agent = longHorizonAgentRepo.getById(params.id);
    if (!agent) throw new Error(`Agent not found: ${params.id}`);

    return { agent };
  });

  messageHub.onRequest('spaceAgent.getPromotionDraft', async (data) => {
    const params = data as { spaceId: string; sessionId: string };
    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.sessionId) throw new Error('sessionId is required');

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);

    const session = db.getSession(params.sessionId);
    if (!session) throw new Error(`Session not found: ${params.sessionId}`);
    if (session.context?.spaceId !== params.spaceId) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    if (session.type === 'space_task_agent') {
      throw new Error('Task agent sessions cannot be promoted');
    }

    return { draft: buildPromotionDraft(session, db) };
  });

  messageHub.onRequest('spaceAgent.promoteSession', async (data) => {
    const params = data as UnifiedAgentCreateInput & { sessionId: string };
    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.sessionId) throw new Error('sessionId is required');
    if (!params.name) throw new Error('name is required');

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);

    const session = db.getSession(params.sessionId);
    if (!session) throw new Error(`Session not found: ${params.sessionId}`);
    if (session.context?.spaceId !== params.spaceId) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    if (session.type === 'space_task_agent') {
      throw new Error('Task agent sessions cannot be promoted');
    }

    const agent = await createUnifiedAgent(params);
    return { agent };
  });
}
