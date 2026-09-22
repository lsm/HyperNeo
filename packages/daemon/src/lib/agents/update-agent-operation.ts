import type { SpaceLongHorizonAgent, UpdateSpaceLongHorizonAgentParams } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { displayNameTaken } from './agent-identity.ts';
import { validateAgentModel, validateAgentTools } from './agent-validation.ts';
import {
  admitAgentCaller,
  AGENT_MUTATE_POLICY,
  AgentRecordSchema,
  AgentRejectionSchema,
  AgentSettingSourcesSchema,
  AgentSpaceScopeSchema,
  AgentStatusSchema,
  AgentThinkingLevelSchema,
  rejectAgent,
  type AgentOperationDeps,
  type AgentRejection,
} from './operation-contracts.ts';

const targetSchema = AgentSpaceScopeSchema.extend({
  agentId: z.string().min(1).describe('Long-horizon agent ID'),
});

const inputSchema = targetSchema
  .extend({
    name: z.string().optional().describe('New agent name'),
    status: AgentStatusSchema.optional().describe(
      'Lifecycle status. "paused" parks the agent so it stops being scheduled while keeping its configuration, subscriptions, and reminders; "archived" additionally drops it out of active lookups and frees its display name for reuse; "active" revives a paused or archived agent, subject to the name still being free'
    ),
    description: z.string().nullable().optional().describe('New description'),
    model: z.string().nullable().optional().describe('Model override, or null to clear'),
    thinkingLevel: AgentThinkingLevelSchema.nullable()
      .optional()
      .describe('Thinking level override, or null to clear'),
    provider: z.string().nullable().optional().describe('Provider override, or null to clear'),
    customPrompt: z.string().nullable().optional().describe('Prompt override, or null to clear'),
    tools: z
      .array(z.string())
      .nullable()
      .optional()
      .describe('Tool allowlist override, or null to clear'),
    settingSources: AgentSettingSourcesSchema.nullable()
      .optional()
      .describe('Settings sources override, or null to clear'),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;
type Result = { agent: SpaceLongHorizonAgent } | AgentRejection;
type Gate<T> = { value: T } | { reason: AgentRejection };

export interface UpdateAgentDependencies extends AgentOperationDeps {
  readonly listAgents: (spaceId: string) => SpaceLongHorizonAgent[];
  readonly getAgent: (agentId: string) => SpaceLongHorizonAgent | null;
  readonly updateAgent: (
    agentId: string,
    params: UpdateSpaceLongHorizonAgentParams
  ) => SpaceLongHorizonAgent | null;
  readonly refreshAgentSubscriptions: (
    spaceId: string,
    agentId: string
  ) => { success: boolean; error?: string };
  readonly clearAgentSessionProvider: (spaceId: string, agentId: string) => Promise<void>;
  readonly publishAgentUpdated: (agent: SpaceLongHorizonAgent, sessionId: string) => void;
  readonly audit: (
    operationName: string,
    summary: Record<string, unknown>,
    caller: OperationCaller,
    spaceId: string
  ) => void;
}

export function gateUpdateTarget(
  spaceId: string,
  input: Input,
  deps: UpdateAgentDependencies
): Gate<SpaceLongHorizonAgent> {
  const agent = deps.getAgent(input.agentId);
  return agent?.spaceId === spaceId
    ? { value: agent }
    : { reason: rejectAgent('agent_not_found', `Long-horizon agent not found: ${input.agentId}`) };
}

export function gateUpdateIdentity(
  agent: SpaceLongHorizonAgent,
  input: Input,
  deps: UpdateAgentDependencies
): Gate<SpaceLongHorizonAgent> {
  if (input.name !== undefined && input.name.trim() === '') {
    return { reason: rejectAgent('invalid_name', 'Agent name cannot be empty') };
  }
  const unarchiving =
    agent.status === 'archived' && input.status !== undefined && input.status !== 'archived';
  if (input.name === undefined && !unarchiving) return { value: agent };
  const name = input.name ?? agent.displayName;
  return displayNameTaken(deps.listAgents(agent.spaceId), name, agent.id)
    ? {
        reason: rejectAgent(
          'invalid_name',
          `Agent name "${name}" is already used by another agent in this space`
        ),
      }
    : { value: agent };
}

export function gateUpdateTools(
  agent: SpaceLongHorizonAgent,
  input: Input
): Gate<SpaceLongHorizonAgent> {
  if (!input.tools) return { value: agent };
  const error = validateAgentTools(input.tools);
  return error ? { reason: rejectAgent('invalid_tools', error) } : { value: agent };
}

export async function gateUpdateModel(
  agent: SpaceLongHorizonAgent,
  input: Input
): Promise<Gate<SpaceLongHorizonAgent>> {
  const effectiveModel = input.model === undefined ? agent.model : input.model;
  const effectiveProvider = input.provider === undefined ? agent.provider : input.provider;
  if (!effectiveModel || (input.model === undefined && input.provider === undefined)) {
    return { value: agent };
  }
  const error = await validateAgentModel(effectiveModel, effectiveProvider);
  return error ? { reason: rejectAgent('invalid_model', error) } : { value: agent };
}

export function updateParamsFromInput(input: Input): UpdateSpaceLongHorizonAgentParams {
  return {
    description: input.description,
    modelPool: undefined,
    displayName: input.name,
    status: input.status,
    instructions: input.customPrompt !== undefined ? (input.customPrompt ?? '') : undefined,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    provider: input.provider,
    settingSources: input.settingSources,
    toolPermissions: input.tools === null ? {} : input.tools ? { tools: input.tools } : undefined,
  };
}

export async function applyAgentUpdate(
  existing: SpaceLongHorizonAgent,
  input: Input,
  caller: OperationCaller,
  deps: UpdateAgentDependencies
): Promise<Result> {
  const spaceId = existing.spaceId;
  const agent = deps.updateAgent(input.agentId, updateParamsFromInput(input));
  if (input.provider === null) await deps.clearAgentSessionProvider(spaceId, input.agentId);
  const refresh = deps.refreshAgentSubscriptions(spaceId, input.agentId);
  if (!refresh.success) {
    return rejectAgent(
      'runtime_refresh_failed',
      refresh.error ?? 'Failed to refresh agent event subscriptions'
    );
  }
  if (!agent) {
    return rejectAgent('agent_not_found', `Long-horizon agent not found: ${input.agentId}`);
  }
  deps.publishAgentUpdated(agent, caller.sessionId ?? 'space-agent-tools');
  deps.audit('agent.update', { agentId: input.agentId, status: input.status }, caller, spaceId);
  return { agent };
}

function buildUpdatePipeline(deps: UpdateAgentDependencies) {
  const access = 'mutate' as const;
  return (superpipe({ deps, access })('update-long-horizon-agent') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitAgentCaller, ['input', 'caller', 'deps', 'access'], 'result:outcome')
    .pipe(gateUpdateTarget, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(gateUpdateIdentity, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(gateUpdateTools, ['outcome', 'input'], 'result:outcome')
    .pipe(gateUpdateModel, ['outcome', 'input'], 'result:outcome')
    .pipe(applyAgentUpdate, ['outcome', 'input', 'caller', 'deps'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
}

const resultSchema = z.union([
  z.object({ agent: AgentRecordSchema }).strict(),
  AgentRejectionSchema,
]);

const REJECTION_DOC =
  'Rejects agent_not_found when the agent is absent or belongs to another Space, invalid_name when the new name is blank or already used by a non-archived peer, invalid_tools for a tool outside the known allowlist, invalid_model when the resulting model and provider pair is unrecognized, and runtime_refresh_failed when the stored change landed but its event subscriptions could not be reloaded. Admitted for MCP callers whose session is active in the owning Space; a caller with no Space, or one whose session is not active in it, is rejected with agent_denied.';

const UPDATE_AGENT_DESCRIPTION = `Update a long-horizon agent: name, lifecycle status, description, operator prompt, model, provider, thinking level, setting sources, or tool allowlist. Setting status is how an agent is paused, archived, and revived; see the status field for what each one leaves behind. Fields left out are untouched; null clears a clearable override, and tools set to null clears the allowlist. Clearing the provider also clears it from the agent's live session. Reviving an archived agent re-checks its name against live peers. ${REJECTION_DOC}`;

export function createUpdateAgentOperation(deps: UpdateAgentDependencies) {
  const update = buildUpdatePipeline(deps);
  return defineOperation({
    name: 'agent.update',
    policy: AGENT_MUTATE_POLICY,
    description: UPDATE_AGENT_DESCRIPTION,
    inputSchema,
    resultSchema,
    execute: async (input, caller) => update(input, caller),
  });
}
