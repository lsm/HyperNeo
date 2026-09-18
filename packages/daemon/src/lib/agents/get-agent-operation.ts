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
  rejectAgent,
  type AgentOperationDeps,
  type AgentRejection,
} from './operation-contracts.ts';

const inputSchema = AgentSpaceScopeSchema.extend({
  agentId: z.string().min(1).describe('Long-horizon agent ID'),
}).strict();

type Input = z.infer<typeof inputSchema>;
type Result = { agent: SpaceLongHorizonAgent } | AgentRejection;

export interface GetAgentDependencies extends AgentOperationDeps {
  readonly getAgent: (agentId: string) => SpaceLongHorizonAgent | null;
}

export function readAgentInSpace(
  spaceId: string,
  input: Input,
  deps: GetAgentDependencies
): Result {
  const agent = deps.getAgent(input.agentId);
  return agent?.spaceId === spaceId
    ? { agent }
    : rejectAgent('agent_not_found', `Long-horizon agent not found: ${input.agentId}`);
}

const GET_AGENT_DESCRIPTION =
  'Read one long-horizon agent of a Space by its ID and return the full record: lifecycle status, instructions, autonomy level, model, provider, thinking level, setting sources, and tool permissions. Rejects agent_not_found when no such agent exists in the Space, which is also the answer for an agent that lives in another Space. Human (RPC) callers pass spaceId; agent callers act in their own Space. Read access is admitted for any caller scoped to the Space; a caller with no Space is rejected with agent_denied.';

export function createGetAgentOperation(deps: GetAgentDependencies) {
  const access = 'read' as const;
  const read = (superpipe({ deps, access })('get-space-agent') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitAgentCaller, ['input', 'caller', 'deps', 'access'], 'result:outcome')
    .pipe(readAgentInSpace, ['outcome', 'input', 'deps'], 'outcome')
    .end('outcome') as (input: Input, caller: OperationCaller) => Result;
  return defineOperation({
    name: 'agent.get',
    policy: AGENT_READ_POLICY,
    description: GET_AGENT_DESCRIPTION,
    inputSchema,
    resultSchema: z.union([z.object({ agent: AgentRecordSchema }).strict(), AgentRejectionSchema]),
    execute: async (input, caller) => read(input, caller),
  });
}
