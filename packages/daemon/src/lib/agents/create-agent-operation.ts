import type { CreateSpaceLongHorizonAgentParams, SpaceLongHorizonAgent } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { callerAutonomyLevel, displayNameTaken, uniqueAgentHandle } from './agent-identity.ts';
import { validateAgentModel, validateAgentTools } from './agent-validation.ts';
import {
  admitAgentCaller,
  AGENT_MUTATE_POLICY,
  AgentRecordSchema,
  AgentRejectionSchema,
  AgentSettingSourcesSchema,
  AgentSpaceScopeSchema,
  AgentThinkingLevelSchema,
  rejectAgent,
  type AgentOperationDeps,
  type AgentRejection,
} from './operation-contracts.ts';

const inputSchema = AgentSpaceScopeSchema.extend({
  name: z.string().min(1).describe('Agent name, unique within the Space'),
  description: z.string().optional().describe('Agent specialization summary'),
  model: z.string().optional().describe('Model override'),
  thinkingLevel: AgentThinkingLevelSchema.optional().describe('Thinking level override'),
  provider: z.string().optional().describe('Provider override'),
  customPrompt: z.string().nullable().optional().describe('Operator prompt for this agent'),
  tools: z.array(z.string()).optional().describe('Tool allowlist override'),
  settingSources: AgentSettingSourcesSchema.nullable()
    .optional()
    .describe('Settings sources for this agent'),
}).strict();

type Input = z.infer<typeof inputSchema>;
type Result = { agent: SpaceLongHorizonAgent } | AgentRejection;
type Gate = { value: string } | { reason: AgentRejection };

export interface CreateAgentDependencies extends AgentOperationDeps {
  readonly listAgents: (spaceId: string) => SpaceLongHorizonAgent[];
  readonly getAgent: (agentId: string) => SpaceLongHorizonAgent | null;
  readonly createAgent: (params: CreateSpaceLongHorizonAgentParams) => SpaceLongHorizonAgent;
  readonly publishAgentCreated: (agent: SpaceLongHorizonAgent, sessionId: string) => void;
  readonly audit: (
    operationName: string,
    summary: Record<string, unknown>,
    caller: OperationCaller,
    spaceId: string
  ) => void;
}

function nameTaken(name: string): AgentRejection {
  return rejectAgent(
    'invalid_name',
    `Agent name "${name}" is already used by another agent in this space`
  );
}

export function gateAgentName(spaceId: string, input: Input, deps: CreateAgentDependencies): Gate {
  if (input.name.trim() === '') {
    return { reason: rejectAgent('invalid_name', 'Agent name cannot be empty') };
  }
  return displayNameTaken(deps.listAgents(spaceId), input.name)
    ? { reason: nameTaken(input.name) }
    : { value: spaceId };
}

export function gateAgentTools(spaceId: string, input: Input): Gate {
  if (!input.tools) return { value: spaceId };
  const error = validateAgentTools(input.tools);
  return error ? { reason: rejectAgent('invalid_tools', error) } : { value: spaceId };
}

export async function gateAgentModel(spaceId: string, input: Input): Promise<Gate> {
  if (!input.model) return { value: spaceId };
  const error = await validateAgentModel(input.model, input.provider);
  return error ? { reason: rejectAgent('invalid_model', error) } : { value: spaceId };
}

export function persistNewAgent(
  spaceId: string,
  input: Input,
  caller: OperationCaller,
  deps: CreateAgentDependencies
): Result {
  const existing = deps.listAgents(spaceId);
  if (displayNameTaken(existing, input.name)) return nameTaken(input.name);
  const agent = deps.createAgent({
    spaceId,
    handle: uniqueAgentHandle(existing, input.name),
    displayName: input.name,
    instructions: input.customPrompt ?? '',
    description: input.description,
    autonomyLevel: callerAutonomyLevel(caller, spaceId, deps.getAgent),
    model: input.model ?? null,
    thinkingLevel: input.thinkingLevel ?? null,
    provider: input.provider ?? null,
    settingSources: input.settingSources ?? null,
    toolPermissions: input.tools && input.tools.length > 0 ? { tools: input.tools } : {},
  });
  deps.publishAgentCreated(agent, caller.sessionId ?? 'space-agent-tools');
  deps.audit('agent.create', { name: input.name, tools: input.tools }, caller, spaceId);
  return { agent };
}

const CREATE_AGENT_DESCRIPTION =
  'Create a long-horizon agent in a Space with optional model, provider, thinking level, operator prompt, setting sources, and tool allowlist. The handle is slugified from the name and made unique against existing and reserved handles; the new agent inherits the calling agent autonomy level, or none for a human caller. Rejects invalid_name when the name is blank or already used by a non-archived agent in the Space, invalid_tools when a tool is outside the known allowlist, and invalid_model when the model (with its provider) is unrecognized. Human (RPC) callers pass spaceId; agent callers act in their own Space. Admitted for MCP callers whose session is active in the owning Space; a caller with no Space, or one whose session is not active in it, is rejected with agent_denied.';

export function createCreateAgentOperation(deps: CreateAgentDependencies) {
  const access = 'mutate' as const;
  const create = (superpipe({ deps, access })('create-long-horizon-agent') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitAgentCaller, ['input', 'caller', 'deps', 'access'], 'result:outcome')
    .pipe(gateAgentName, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(gateAgentTools, ['outcome', 'input'], 'result:outcome')
    .pipe(gateAgentModel, ['outcome', 'input'], 'result:outcome')
    .pipe(persistNewAgent, ['outcome', 'input', 'caller', 'deps'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
  return defineOperation({
    name: 'agent.create',
    policy: { ...AGENT_MUTATE_POLICY, audit: { selfAudited: true } },
    description: CREATE_AGENT_DESCRIPTION,
    inputSchema,
    resultSchema: z.union([z.object({ agent: AgentRecordSchema }).strict(), AgentRejectionSchema]),
    execute: async (input, caller) => create(input, caller),
  });
}
