import type {
  SpaceAgentAutonomyLevel,
  SpaceAgentTemplate,
  SpaceLongHorizonAgent,
  SpaceLongHorizonAgentTemplate,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { SpaceAgentReminderRepository } from '../../storage/repositories/space-agent-reminder-repository.ts';
import type { SpaceAgentSubscriptionRepository } from '../../storage/repositories/space-agent-subscription-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import { validateSource } from '../external-events/topic-validator.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
} from '../operations/registry.ts';
import { getNextRunAt, isValidCronExpression } from '../schedule/cron-utils.ts';
import { RESERVED_SPACE_AGENT_HANDLES, slugifyWithinLimit } from '../space/slug.ts';
import {
  decideAutonomyAdmission,
  getToolAutonomyRequirement,
  resolveEffectiveAutonomyLevel,
} from '../space/tools/tool-admission-gates.ts';
import type { ToolResult } from '../space/tools/tool-result.ts';
import {
  type AgentTemplateHandlerDeps,
  type CreateAgentFromTemplateArgs,
  type CreateAgentTemplateArgs,
  createAgentFromTemplate,
  createAgentTemplate,
  type DeleteAgentTemplateArgs,
  deleteAgentTemplate,
  listAgentTemplates,
  type UpdateAgentTemplateArgs,
  updateAgentTemplate,
} from './agent-template-impls.ts';
import {
  AGENT_MUTATE_POLICY,
  AGENT_READ_POLICY,
  AGENT_ROLES,
  AgentAutonomyLevelSchema,
  AgentModelPoolEntrySchema,
  type AgentOperationDeps,
  AgentRecordSchema,
  type AgentRejection,
  AgentRejectionSchema,
  AgentSettingSourcesSchema,
  AgentSpaceScopeSchema,
  AgentThinkingLevelSchema,
  admitAgentCaller,
  rejectAgent,
} from './operation-contracts.ts';
import type { SpaceAgentTemplateManager } from './template-manager.ts';

const AGENT_TEMPLATE_DELETE_POLICY = { safetyClass: 'destructive', roles: AGENT_ROLES } as const;

export interface AgentTemplateOperationDependencies extends AgentOperationDeps {
  readonly getDatabase: () => BunDatabase | undefined;
  readonly longHorizonAgentRepo: SpaceLongHorizonAgentRepository;
  readonly templateManager: SpaceAgentTemplateManager;
  readonly subscriptionRepo: Pick<
    SpaceAgentSubscriptionRepository,
    'upsertSubscription' | 'deleteSubscription'
  >;
  readonly reminderRepo: Pick<SpaceAgentReminderRepository, 'createReminder'>;
  readonly refreshSubscription: (
    spaceId: string,
    subscriptionId: string
  ) => { success: boolean; error?: string };
  readonly getSpaceAutonomyLevel: (spaceId: string) => Promise<number>;
  readonly publishAgentCreated: (agent: SpaceLongHorizonAgent, sessionId: string) => void;
  readonly audit: (
    toolName: string,
    paramsSummary: Record<string, unknown>,
    caller: OperationCaller,
    spaceId: string
  ) => void;
}

function failureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function displayNameTakenBy(
  agents: SpaceLongHorizonAgent[],
  name: string,
  excludeId?: string
): boolean {
  const target = name.trim().toLowerCase();
  if (!target) return false;
  return agents.some(
    (agent) =>
      agent.status !== 'archived' &&
      agent.id !== excludeId &&
      (agent.displayName ?? '').trim().toLowerCase() === target
  );
}

export function buildAgentTemplateHandlerDeps(
  deps: AgentTemplateOperationDependencies,
  spaceId: string,
  caller: OperationCaller
): AgentTemplateHandlerDeps {
  const agentsInSpace = () => deps.longHorizonAgentRepo.listBySpaceId(spaceId);

  const getCallingAgentAutonomyLevel = (): SpaceAgentAutonomyLevel | null => {
    if (!caller.agentId) return null;
    const agent = deps.longHorizonAgentRepo.getById(caller.agentId);
    if (agent) return agent.spaceId === spaceId ? (agent.autonomyLevel ?? null) : null;
    return 1;
  };

  const requireSessionWriteAutonomy = async (toolName: string): Promise<void> => {
    const spaceLevel = await deps.getSpaceAutonomyLevel(spaceId);
    const agentLevel = getCallingAgentAutonomyLevel();
    const { level } = resolveEffectiveAutonomyLevel({ spaceLevel, agentLevel });
    const required = getToolAutonomyRequirement(toolName);
    if (required === undefined) return;
    const admission = decideAutonomyAdmission({
      toolName,
      level,
      required,
      agentLevel,
      spaceLevel,
    });
    if (admission.action === 'allow') return;
    if (admission.reason === 'agent_autonomy_ceiling') {
      deps.audit(
        toolName,
        {
          blocked: true,
          reason: admission.reason,
          agentLevel: admission.agentLevel,
          spaceLevel: admission.spaceLevel,
          required: admission.required,
        },
        caller,
        spaceId
      );
    }
    throw new Error(admission.message);
  };

  const uniqueAgentDisplayName = (base: string): string => {
    let candidate = base;
    let counter = 1;
    while (displayNameTakenBy(agentsInSpace(), candidate)) {
      counter += 1;
      candidate = `${base} (${counter})`;
    }
    return candidate;
  };

  const ensureUniqueAgentDisplayName = (name: string, excludeId?: string): void => {
    if (displayNameTakenBy(agentsInSpace(), name, excludeId)) {
      throw new Error(`Agent name "${name}" is already used by another agent in this space`);
    }
  };

  const uniqueLongHorizonAgentHandle = (name: string): string =>
    slugifyWithinLimit(name, [
      ...agentsInSpace().map((agent) => agent.handle),
      ...RESERVED_SPACE_AGENT_HANDLES,
    ]);

  const requireLongHorizonAgentInSpace = (agentId: string): SpaceLongHorizonAgent => {
    const agent = deps.longHorizonAgentRepo.getById(agentId);
    if (!agent || agent.spaceId !== spaceId) {
      throw new Error(`Long-horizon agent not found: ${agentId}`);
    }
    return agent;
  };

  const seedLongHorizonTemplateSubscriptions = (
    agentId: string,
    subscriptions: SpaceLongHorizonAgentTemplate['suggestedEventSubscriptions']
  ): ReturnType<AgentTemplateHandlerDeps['seedLongHorizonTemplateSubscriptions']> => {
    const seeded: Array<{ source: string; topic: string }> = [];
    const skipped: Array<{ source: string; topic: string; reason: string }> = [];
    for (const subscription of subscriptions) {
      const sourceCheck = validateSource(subscription.source);
      if (!sourceCheck.valid) {
        skipped.push({
          source: subscription.source,
          topic: subscription.topic,
          reason: sourceCheck.reason ?? 'invalid source',
        });
        continue;
      }
      let stored: { id: string; source: string; topic: string } | undefined;
      try {
        stored = deps.subscriptionRepo.upsertSubscription({
          spaceId,
          agentId,
          source: subscription.source,
          topic: subscription.topic,
          filter: subscription.filter ?? {},
          status: 'active',
        });
        const refresh = deps.refreshSubscription(spaceId, stored.id);
        if (!refresh.success) {
          deps.subscriptionRepo.deleteSubscription(stored.id);
          skipped.push({
            source: subscription.source,
            topic: subscription.topic,
            reason: refresh.error ?? 'invalid pattern',
          });
          continue;
        }
        seeded.push({ source: stored.source, topic: stored.topic });
      } catch (err) {
        if (stored) {
          try {
            deps.subscriptionRepo.deleteSubscription(stored.id);
          } catch {}
        }
        skipped.push({
          source: subscription.source,
          topic: subscription.topic,
          reason: failureMessage(err),
        });
      }
    }
    return { seeded, skipped };
  };

  const seedLongHorizonTemplateReminders = (
    agentId: string,
    reminders: SpaceLongHorizonAgentTemplate['reminderDefaults']
  ): ReturnType<AgentTemplateHandlerDeps['seedLongHorizonTemplateReminders']> => {
    const seeded: Array<{ title: string }> = [];
    const skipped: Array<{ title: string; reason: string }> = [];
    for (const reminder of reminders) {
      const cronExpression = reminder.cronExpression?.trim() ?? '';
      if (reminder.triggerType === 'cron' && cronExpression === '') {
        skipped.push({ title: reminder.title, reason: 'cron reminder is missing cronExpression' });
        continue;
      }
      if (reminder.triggerType === 'cron' && !isValidCronExpression(cronExpression)) {
        skipped.push({
          title: reminder.title,
          reason: `invalid cron expression "${cronExpression}"`,
        });
        continue;
      }
      try {
        const nextRunAt =
          reminder.triggerType === 'cron' && reminder.cronExpression
            ? getNextRunAt(reminder.cronExpression, reminder.timezone ?? 'UTC')
            : null;
        deps.reminderRepo.createReminder({
          spaceId,
          agentId,
          title: reminder.title,
          body: reminder.body,
          triggerType: reminder.triggerType,
          cronExpression: reminder.cronExpression,
          timezone: reminder.timezone,
          nextRunAt,
          status: 'active',
          createdBySession: caller.sessionId ?? null,
        });
        seeded.push({ title: reminder.title });
      } catch (err) {
        skipped.push({ title: reminder.title, reason: failureMessage(err) });
      }
    }
    return { seeded, skipped };
  };

  return {
    spaceId,
    db: deps.getDatabase(),
    logAudit: (toolName, paramsSummary) => deps.audit(toolName, paramsSummary, caller, spaceId),
    requireTemplateManager: () => deps.templateManager,
    requireLongHorizonAgentRepo: () => deps.longHorizonAgentRepo,
    requireLongHorizonAgentInSpace,
    requireSessionWriteAutonomy,
    getCallingAgentAutonomyLevel,
    ensureUniqueAgentDisplayName,
    uniqueAgentDisplayName,
    uniqueLongHorizonAgentHandle,
    emitLongHorizonAgentCreated: (agent) =>
      deps.publishAgentCreated(agent, caller.sessionId ?? 'space-agent-tools'),
    seedLongHorizonTemplateSubscriptions,
    seedLongHorizonTemplateReminders,
  };
}

function toolResultPayload(result: ToolResult): Record<string, unknown> {
  const text = result.content.find((block) => block.type === 'text')?.text;
  if (typeof text !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function templateRejection(payload: Record<string, unknown>): AgentRejection {
  return rejectAgent('template_rejected', String(payload.error ?? 'agent template request failed'));
}

export const AgentTemplateRecordSchema = z
  .object({
    key: z.string(),
    handle: z.string(),
    displayName: z.string(),
    description: z.string(),
    instructions: z.string(),
    suggestedAutonomyLevel: AgentAutonomyLevelSchema,
    model: z.string().nullable(),
    provider: z.string().nullable(),
    modelPool: z.array(AgentModelPoolEntrySchema).nullable(),
    thinkingLevel: AgentThinkingLevelSchema.nullable(),
    settingSources: AgentSettingSourcesSchema.nullable(),
    tools: z.array(z.string()).nullable(),
    labels: z.array(z.string()),
    createdAt: z.number(),
    updatedAt: z.number(),
    version: z.number().optional(),
  })
  .strict() satisfies z.ZodType<SpaceAgentTemplate>;

export const AgentTemplateListEntrySchema = z
  .object({
    templateName: z.string(),
    handle: z.string(),
    displayName: z.string(),
    description: z.string(),
    suggestedAutonomyLevel: AgentAutonomyLevelSchema,
    labels: z.array(z.string()),
    builtin: z.boolean(),
    version: z.number().nullable(),
  })
  .strict();

const SeededSubscriptionSchema = z.object({ source: z.string(), topic: z.string() }).strict();
const SkippedSubscriptionSchema = z
  .object({ source: z.string(), topic: z.string(), reason: z.string() })
  .strict();
const SeededReminderSchema = z.object({ title: z.string() }).strict();
const SkippedReminderSchema = z.object({ title: z.string(), reason: z.string() }).strict();

const templateOverrideFields = {
  displayName: z.string().min(1).optional().describe('Display name'),
  description: z.string().optional().describe('Short summary of what the template is for'),
  instructions: z
    .string()
    .optional()
    .describe('System prompt for agents created from this template'),
  model: z.string().nullable().optional().describe('Model override; null to inherit defaults'),
  provider: z
    .string()
    .nullable()
    .optional()
    .describe('Provider override; null to inherit defaults'),
  modelPool: z
    .array(AgentModelPoolEntrySchema)
    .nullable()
    .optional()
    .describe('Weighted model pool; null to inherit defaults'),
  thinkingLevel: AgentThinkingLevelSchema.nullable().optional().describe('Thinking level override'),
  settingSources: AgentSettingSourcesSchema.nullable().optional().describe('Settings sources'),
  tools: z
    .array(z.string())
    .nullable()
    .optional()
    .describe('Tool allowlist; null to inherit defaults'),
};

const createTemplateInputSchema = AgentSpaceScopeSchema.extend({
  key: z
    .string()
    .min(1)
    .describe(
      'Unique template key (e.g. reviewer.custom); must not collide with an existing, built-in, or reserved key'
    ),
  handle: z.string().min(1).describe('Handle slug for agents created from this template'),
  ...templateOverrideFields,
  labels: z.array(z.string()).optional().describe('Open tags used to group templates'),
  suggestedAutonomyLevel: AgentAutonomyLevelSchema.optional().describe(
    'Suggested autonomy level 1-5; defaults to 2'
  ),
  fromAgentId: z
    .string()
    .optional()
    .describe(
      'Derive defaults from this long-horizon agent in the Space; caller-supplied fields override'
    ),
}).strict();

const updateTemplateInputSchema = AgentSpaceScopeSchema.extend({
  key: z
    .string()
    .min(1)
    .describe('Key of the user-authored template to update; built-in keys are rejected'),
  ...templateOverrideFields,
  labels: z
    .array(z.string())
    .nullable()
    .optional()
    .describe('Open tags replacing the existing labels; null clears them'),
  expectedVersion: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Version the caller last saw (from a prior create/update result); the update fails when the stored version differs. Omit to update against the current stored version.'
    ),
}).strict();

const deleteTemplateInputSchema = AgentSpaceScopeSchema.extend({
  key: z
    .string()
    .min(1)
    .describe('Key of the user-authored template to delete; built-in keys are rejected'),
  expectedVersion: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Version the caller last saw (from a create/update result or agentTemplate.list); the delete fails when the stored version differs. Omit to delete unconditionally.'
    ),
}).strict();

const listTemplatesInputSchema = AgentSpaceScopeSchema.strict();

const createFromTemplateInputSchema = AgentSpaceScopeSchema.extend({
  templateName: z
    .string()
    .min(1)
    .describe('Template key: built-in (worker.research, worker.qa, ...) or user-created'),
  name: z
    .string()
    .optional()
    .describe('Optional new agent name; defaults to the template display name'),
  model: z.string().optional().describe('Model override'),
  provider: z.string().optional().describe('Provider override'),
  thinkingLevel: AgentThinkingLevelSchema.optional().describe('Thinking level override'),
}).strict();

type CreateTemplateInput = z.infer<typeof createTemplateInputSchema>;
type UpdateTemplateInput = z.infer<typeof updateTemplateInputSchema>;
type DeleteTemplateInput = z.infer<typeof deleteTemplateInputSchema>;
type ListTemplatesInput = z.infer<typeof listTemplatesInputSchema>;
type CreateFromTemplateInput = z.infer<typeof createFromTemplateInputSchema>;

type TemplateMutationResult = { template: SpaceAgentTemplate } | AgentRejection;
type DeleteTemplateResult = { deleted: string } | AgentRejection;
type ListTemplatesResult =
  | { templates: z.infer<typeof AgentTemplateListEntrySchema>[] }
  | AgentRejection;
type SeededSubscription = { source: string; topic: string };
type SkippedSubscription = { source: string; topic: string; reason: string };
type SeededReminder = { title: string };
type SkippedReminder = { title: string; reason: string };
type CreateFromTemplateResult =
  | {
      agent: SpaceLongHorizonAgent;
      seededSubscriptions: SeededSubscription[];
      skippedSubscriptions: SkippedSubscription[];
      seededReminders: SeededReminder[];
      skippedReminders: SkippedReminder[];
    }
  | AgentRejection;

function createTemplateArgs(input: CreateTemplateInput): CreateAgentTemplateArgs {
  return {
    key: input.key,
    handle: input.handle,
    display_name: input.displayName,
    description: input.description,
    instructions: input.instructions,
    labels: input.labels,
    suggested_autonomy_level: input.suggestedAutonomyLevel,
    model: input.model,
    provider: input.provider,
    model_pool: input.modelPool,
    thinking_level: input.thinkingLevel,
    setting_sources: input.settingSources,
    tools: input.tools,
    from_agent_id: input.fromAgentId,
  };
}

function updateTemplateArgs(input: UpdateTemplateInput): UpdateAgentTemplateArgs {
  return {
    key: input.key,
    expected_version: input.expectedVersion,
    display_name: input.displayName,
    description: input.description,
    instructions: input.instructions,
    labels: input.labels,
    model: input.model,
    provider: input.provider,
    model_pool: input.modelPool,
    thinking_level: input.thinkingLevel,
    setting_sources: input.settingSources,
    tools: input.tools,
  };
}

function deleteTemplateArgs(input: DeleteTemplateInput): DeleteAgentTemplateArgs {
  return { key: input.key, expected_version: input.expectedVersion };
}

function createFromTemplateArgs(input: CreateFromTemplateInput): CreateAgentFromTemplateArgs {
  return {
    template_name: input.templateName,
    name: input.name,
    model: input.model,
    provider: input.provider,
    thinking_level: input.thinkingLevel,
  };
}

export async function runCreateAgentTemplate(
  spaceId: string,
  input: CreateTemplateInput,
  caller: OperationCaller,
  deps: AgentTemplateOperationDependencies
): Promise<TemplateMutationResult> {
  const payload = toolResultPayload(
    await createAgentTemplate(
      buildAgentTemplateHandlerDeps(deps, spaceId, caller),
      createTemplateArgs(input)
    )
  );
  return payload.success === true
    ? { template: payload.template as SpaceAgentTemplate }
    : templateRejection(payload);
}

export async function runUpdateAgentTemplate(
  spaceId: string,
  input: UpdateTemplateInput,
  caller: OperationCaller,
  deps: AgentTemplateOperationDependencies
): Promise<TemplateMutationResult> {
  const payload = toolResultPayload(
    await updateAgentTemplate(
      buildAgentTemplateHandlerDeps(deps, spaceId, caller),
      updateTemplateArgs(input)
    )
  );
  return payload.success === true
    ? { template: payload.template as SpaceAgentTemplate }
    : templateRejection(payload);
}

export async function runDeleteAgentTemplate(
  spaceId: string,
  input: DeleteTemplateInput,
  caller: OperationCaller,
  deps: AgentTemplateOperationDependencies
): Promise<DeleteTemplateResult> {
  const payload = toolResultPayload(
    await deleteAgentTemplate(
      buildAgentTemplateHandlerDeps(deps, spaceId, caller),
      deleteTemplateArgs(input)
    )
  );
  return payload.success === true
    ? { deleted: String(payload.deleted) }
    : templateRejection(payload);
}

export function templateListEntry(
  entry: Record<string, unknown>
): z.infer<typeof AgentTemplateListEntrySchema> {
  return {
    templateName: String(entry.template_name),
    handle: String(entry.handle),
    displayName: String(entry.display_name),
    description: String(entry.description),
    suggestedAutonomyLevel: entry.suggested_autonomy_level as SpaceAgentAutonomyLevel,
    labels: Array.isArray(entry.labels) ? entry.labels.map(String) : [],
    builtin: entry.builtin === true,
    version: typeof entry.version === 'number' ? entry.version : null,
  };
}

export async function runListAgentTemplates(
  spaceId: string,
  _input: ListTemplatesInput,
  caller: OperationCaller,
  deps: AgentTemplateOperationDependencies
): Promise<ListTemplatesResult> {
  const payload = toolResultPayload(
    await listAgentTemplates(buildAgentTemplateHandlerDeps(deps, spaceId, caller))
  );
  if (payload.success !== true) return templateRejection(payload);
  const entries = Array.isArray(payload.long_horizon_templates)
    ? (payload.long_horizon_templates as Array<Record<string, unknown>>)
    : [];
  return { templates: entries.map(templateListEntry) };
}

export async function runCreateAgentFromTemplate(
  spaceId: string,
  input: CreateFromTemplateInput,
  caller: OperationCaller,
  deps: AgentTemplateOperationDependencies
): Promise<CreateFromTemplateResult> {
  const payload = toolResultPayload(
    await createAgentFromTemplate(
      buildAgentTemplateHandlerDeps(deps, spaceId, caller),
      createFromTemplateArgs(input)
    )
  );
  if (payload.success !== true) return templateRejection(payload);
  return {
    agent: payload.agent as SpaceLongHorizonAgent,
    seededSubscriptions: (payload.seeded_subscriptions as SeededSubscription[] | undefined) ?? [],
    skippedSubscriptions:
      (payload.skipped_subscriptions as SkippedSubscription[] | undefined) ?? [],
    seededReminders: (payload.seeded_reminders as SeededReminder[] | undefined) ?? [],
    skippedReminders: (payload.skipped_reminders as SkippedReminder[] | undefined) ?? [],
  };
}

const SCOPE_DOC =
  'Human (RPC) callers pass spaceId; agent callers act in their own Space and are rejected with space_mismatch when they pass a different one. Impl-level failures (duplicate key, built-in key, concurrent version change, unknown template) are rejected with template_rejected.';

const CREATE_TEMPLATE_DESCRIPTION = `Create a user-authored agent template in a Space from a key, handle, and optional display name, description, instructions, labels, suggested autonomy level, model, provider, model pool, thinking level, setting sources, and tool allowlist, returning the stored template with its version. Pass fromAgentId to derive defaults from an existing long-horizon agent in the Space; caller-supplied fields override the derived ones. ${SCOPE_DOC} Admitted for MCP callers whose session is active in the owning Space.`;

const UPDATE_TEMPLATE_DESCRIPTION = `Update a user-authored agent template by key with compare-and-swap versioning: pass expectedVersion from a prior create/update result and the update fails when the stored version differs; omit it to update against the current stored version. Nullable fields (model, provider, modelPool, thinkingLevel, settingSources, tools, labels) accept null to inherit defaults or clear them. Built-in templates are rejected. ${SCOPE_DOC} Admitted for MCP callers whose session is active in the owning Space.`;

const DELETE_TEMPLATE_DESCRIPTION = `Delete a user-authored agent template by key with compare-and-swap versioning: pass expectedVersion from a create/update result or agentTemplate.list and the delete fails when the stored version differs; omit it to delete unconditionally. Built-in templates are rejected. Deleting a template does not touch agents already created from it. ${SCOPE_DOC} Requires space autonomy level 4 or an agent ceiling at that level; admitted for MCP callers whose session is active in the owning Space.`;

const LIST_TEMPLATES_DESCRIPTION = `List the agent templates available in a Space: built-in long-horizon templates plus user-authored ones, each with key (templateName), handle, display name, description, suggested autonomy level, labels, whether it is built-in, and its owned version when the Space has one. Reserved auto-created handles are hidden. ${SCOPE_DOC} Read access is admitted for any caller scoped to the Space.`;

const CREATE_FROM_TEMPLATE_DESCRIPTION = `Create a long-horizon agent in a Space from a template named by templateName (built-in keys like worker.research or user-authored keys), with optional name, model, provider, and thinking level overrides; overrides are validated before the agent is stored. The suggested event subscriptions and reminder defaults of the template are seeded for the new agent and reported as seededSubscriptions, skippedSubscriptions, seededReminders, and skippedReminders. The suggested autonomy level applies, capped by the calling agent own level. ${SCOPE_DOC} Admitted for MCP callers whose session is active in the owning Space.`;

export function createCreateAgentTemplateOperation(deps: AgentTemplateOperationDependencies) {
  const access = 'mutate' as const;
  const create = (superpipe({ deps, access })('agent-template-create') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitAgentCaller, ['input', 'caller', 'deps', 'access'], 'result:outcome')
    .pipe(runCreateAgentTemplate, ['outcome', 'input', 'caller', 'deps'], 'outcome')
    .endAsync('outcome') as (
    input: CreateTemplateInput,
    caller: OperationCaller
  ) => Promise<TemplateMutationResult>;
  return defineOperation({
    name: 'agentTemplate.create',
    policy: AGENT_MUTATE_POLICY,
    description: CREATE_TEMPLATE_DESCRIPTION,
    inputSchema: createTemplateInputSchema,
    resultSchema: z.union([
      z.object({ template: AgentTemplateRecordSchema }).strict(),
      AgentRejectionSchema,
    ]),
    execute: async (input, caller) => create(input, caller),
  });
}

export function createUpdateAgentTemplateOperation(deps: AgentTemplateOperationDependencies) {
  const access = 'mutate' as const;
  const update = (superpipe({ deps, access })('agent-template-update') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitAgentCaller, ['input', 'caller', 'deps', 'access'], 'result:outcome')
    .pipe(runUpdateAgentTemplate, ['outcome', 'input', 'caller', 'deps'], 'outcome')
    .endAsync('outcome') as (
    input: UpdateTemplateInput,
    caller: OperationCaller
  ) => Promise<TemplateMutationResult>;
  return defineOperation({
    name: 'agentTemplate.update',
    policy: AGENT_MUTATE_POLICY,
    description: UPDATE_TEMPLATE_DESCRIPTION,
    inputSchema: updateTemplateInputSchema,
    resultSchema: z.union([
      z.object({ template: AgentTemplateRecordSchema }).strict(),
      AgentRejectionSchema,
    ]),
    execute: async (input, caller) => update(input, caller),
  });
}

export function createDeleteAgentTemplateOperation(deps: AgentTemplateOperationDependencies) {
  const access = 'mutate' as const;
  const remove = (superpipe({ deps, access })('agent-template-delete') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitAgentCaller, ['input', 'caller', 'deps', 'access'], 'result:outcome')
    .pipe(runDeleteAgentTemplate, ['outcome', 'input', 'caller', 'deps'], 'outcome')
    .endAsync('outcome') as (
    input: DeleteTemplateInput,
    caller: OperationCaller
  ) => Promise<DeleteTemplateResult>;
  return defineOperation({
    name: 'agentTemplate.delete',
    policy: AGENT_TEMPLATE_DELETE_POLICY,
    description: DELETE_TEMPLATE_DESCRIPTION,
    inputSchema: deleteTemplateInputSchema,
    resultSchema: z.union([z.object({ deleted: z.string() }).strict(), AgentRejectionSchema]),
    execute: async (input, caller) => remove(input, caller),
  });
}

export function createListAgentTemplatesOperation(deps: AgentTemplateOperationDependencies) {
  const access = 'read' as const;
  const list = (superpipe({ deps, access })('agent-template-list') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitAgentCaller, ['input', 'caller', 'deps', 'access'], 'result:outcome')
    .pipe(runListAgentTemplates, ['outcome', 'input', 'caller', 'deps'], 'outcome')
    .endAsync('outcome') as (
    input: ListTemplatesInput,
    caller: OperationCaller
  ) => Promise<ListTemplatesResult>;
  return defineOperation({
    name: 'agentTemplate.list',
    policy: AGENT_READ_POLICY,
    description: LIST_TEMPLATES_DESCRIPTION,
    inputSchema: listTemplatesInputSchema,
    resultSchema: z.union([
      z.object({ templates: z.array(AgentTemplateListEntrySchema) }).strict(),
      AgentRejectionSchema,
    ]),
    execute: async (input, caller) => list(input, caller),
  });
}

export function createCreateAgentFromTemplateOperation(deps: AgentTemplateOperationDependencies) {
  const access = 'mutate' as const;
  const create = (superpipe({ deps, access })('agent-create-from-template') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitAgentCaller, ['input', 'caller', 'deps', 'access'], 'result:outcome')
    .pipe(runCreateAgentFromTemplate, ['outcome', 'input', 'caller', 'deps'], 'outcome')
    .endAsync('outcome') as (
    input: CreateFromTemplateInput,
    caller: OperationCaller
  ) => Promise<CreateFromTemplateResult>;
  return defineOperation({
    name: 'agent.createFromTemplate',
    policy: AGENT_MUTATE_POLICY,
    description: CREATE_FROM_TEMPLATE_DESCRIPTION,
    inputSchema: createFromTemplateInputSchema,
    resultSchema: z.union([
      z
        .object({
          agent: AgentRecordSchema,
          seededSubscriptions: z.array(SeededSubscriptionSchema),
          skippedSubscriptions: z.array(SkippedSubscriptionSchema),
          seededReminders: z.array(SeededReminderSchema),
          skippedReminders: z.array(SkippedReminderSchema),
        })
        .strict(),
      AgentRejectionSchema,
    ]),
    execute: async (input, caller) => create(input, caller),
  });
}

export function createAgentTemplateOperations(
  deps: AgentTemplateOperationDependencies
): OperationDefinition[] {
  return [
    createListAgentTemplatesOperation(deps),
    createCreateAgentTemplateOperation(deps),
    createUpdateAgentTemplateOperation(deps),
    createDeleteAgentTemplateOperation(deps),
    createCreateAgentFromTemplateOperation(deps),
  ];
}
