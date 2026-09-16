import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import {
  admitAgentCaller,
  AGENT_READ_POLICY,
  AgentRecordSchema,
  AgentRejectionSchema,
  AgentSpaceScopeSchema,
  AgentStatusSchema,
  CompactAgentRecordSchema,
  type AgentOperationDeps,
  type AgentRejection,
} from './operation-contracts.ts';

const inputSchema = AgentSpaceScopeSchema.extend({
  status: AgentStatusSchema.optional().describe('Filter by agent lifecycle status'),
  compact: z.boolean().optional().describe('Return compact agent summaries'),
}).strict();

type Input = z.infer<typeof inputSchema>;
type CompactAgent = z.infer<typeof CompactAgentRecordSchema>;
type Listing = { agents: Array<SpaceLongHorizonAgent | CompactAgent> };
type Result = Listing | AgentRejection;

export interface ListAgentsDependencies extends AgentOperationDeps {
  readonly listAgents: (spaceId: string) => SpaceLongHorizonAgent[];
}

export function compactAgent(agent: SpaceLongHorizonAgent): CompactAgent {
  return {
    id: agent.id,
    handle: agent.handle,
    displayName: agent.displayName,
    status: agent.status,
    model: agent.model,
    provider: agent.provider,
    thinkingLevel: agent.thinkingLevel,
    templateKey: agent.templateKey,
    updatedAt: agent.updatedAt,
  };
}

export function selectAgents(spaceId: string, input: Input, deps: ListAgentsDependencies): Listing {
  const agents = deps
    .listAgents(spaceId)
    .filter((agent) => !input.status || agent.status === input.status);
  return { agents: input.compact ? agents.map(compactAgent) : agents };
}

const LIST_AGENTS_DESCRIPTION =
  'List the long-horizon agents of a Space, newest state first, with lifecycle status, model, provider, and tool permissions. Pass compact to get id/handle/name/status summaries instead of full records, and status to keep only agents in that lifecycle state. Human (RPC) callers pass spaceId; agent callers act in their own Space and are rejected with space_mismatch when they pass a different one. Read access is admitted for ad-hoc members, long-term agents, and read-only sessions; other sessions are rejected with agent_denied.';

export function createListAgentsOperation(deps: ListAgentsDependencies) {
  const access = 'read' as const;
  const list = (superpipe({ deps, access })('list-space-agents') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitAgentCaller, ['input', 'caller', 'deps', 'access'], 'result:outcome')
    .pipe(selectAgents, ['outcome', 'input', 'deps'], 'outcome')
    .end('outcome') as (input: Input, caller: OperationCaller) => Result;
  return defineOperation({
    name: 'agent.list',
    policy: AGENT_READ_POLICY,
    description: LIST_AGENTS_DESCRIPTION,
    inputSchema,
    resultSchema: z.union([
      z
        .object({
          agents: z.array(z.union([AgentRecordSchema, CompactAgentRecordSchema])),
        })
        .strict(),
      AgentRejectionSchema,
    ]),
    execute: async (input, caller) => list(input, caller),
  });
}
