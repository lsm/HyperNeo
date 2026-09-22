import type { EnsureAgentSessionOutcome } from '../session/ensure-agent-session.ts';
import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { longTermAgentSessionId } from '../space/long-term-agent-session.ts';
import {
  admitAgentCaller,
  AGENT_MUTATE_POLICY,
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
type LocatedAgent = { spaceId: string; agent: SpaceLongHorizonAgent };
type Result = { sessionId: string } | AgentRejection;

export interface EnsureAgentSessionDependencies extends AgentOperationDeps {
  readonly getAgent: (agentId: string) => SpaceLongHorizonAgent | null;
  readonly ensureAgentSession: (
    spaceId: string,
    agentId: string
  ) => Promise<EnsureAgentSessionOutcome>;
}

export function locateAgentForSession(
  spaceId: string,
  input: Input,
  deps: EnsureAgentSessionDependencies
): { value: LocatedAgent } | { reason: AgentRejection } {
  const agent = deps.getAgent(input.agentId);
  return agent?.spaceId === spaceId
    ? { value: { spaceId, agent } }
    : { reason: rejectAgent('agent_not_found', `Long-horizon agent not found: ${input.agentId}`) };
}

export async function provisionAgentSession(
  located: LocatedAgent,
  deps: EnsureAgentSessionDependencies
): Promise<Result> {
  const ensured = await deps.ensureAgentSession(located.spaceId, located.agent.id);
  return typeof ensured === 'string'
    ? rejectAgent(
        ensured === 'agent_missing' ? 'agent_not_found' : 'session_unavailable',
        `No session could be started for agent ${located.agent.id}: ${ensured}.`
      )
    : { sessionId: longTermAgentSessionId(located.spaceId, located.agent.id) };
}

const ENSURE_AGENT_SESSION_DESCRIPTION =
  'Return the chat session of a long-horizon agent, creating it first when the agent has never run. A long-horizon agent keeps one durable session whose id is derived from the Space and the agent, so repeated calls return the same id and an agent that already has a session is left untouched. Rejects agent_not_found for an agent of another Space, and session_unavailable when the runtime declines to start one — a paused, stopped, or archived Space, or an agent that is not active. Human (RPC) callers pass spaceId; agent callers act in their own Space.';

export function createEnsureAgentSessionOperation(deps: EnsureAgentSessionDependencies) {
  const access = 'mutate' as const;
  const ensure = (superpipe({ deps, access })('ensure-space-agent-session') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitAgentCaller, ['input', 'caller', 'deps', 'access'], 'result:outcome')
    .pipe(locateAgentForSession, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(provisionAgentSession, ['outcome', 'deps'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
  return defineOperation({
    name: 'agent.session.ensure',
    policy: AGENT_MUTATE_POLICY,
    description: ENSURE_AGENT_SESSION_DESCRIPTION,
    inputSchema,
    resultSchema: z.union([z.object({ sessionId: z.string() }).strict(), AgentRejectionSchema]),
    execute: (input, caller) => ensure(input, caller),
  });
}
