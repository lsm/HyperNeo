import { z } from 'zod';
import { defineOperation } from '../registry.ts';
import {
  AgentStatusSchema,
  CompactLongHorizonAgentSchema,
  compactLongHorizonAgent,
  LongHorizonAgentSchema,
} from './agent-schemas.ts';
import type { AgentListReader } from './agent-catalog.ts';

export function createAgentListOperation(listAgents: AgentListReader) {
  return defineOperation({
    name: 'agent.list',
    description:
      'List long-horizon agents in a space. Returns full agent records by default, or compact summaries when compact is true.',
    inputSchema: z
      .object({
        spaceId: z.string().min(1),
        status: AgentStatusSchema.optional(),
        compact: z.boolean().optional(),
      })
      .strict(),
    resultSchema: z.object({
      success: z.literal(true),
      agents: z.union([z.array(LongHorizonAgentSchema), z.array(CompactLongHorizonAgentSchema)]),
    }),
    execute: async (input, caller) => {
      let agents = listAgents(input.spaceId, caller);
      if (input.status) agents = agents.filter((agent) => agent.status === input.status);
      return {
        success: true,
        agents: input.compact ? agents.map(compactLongHorizonAgent) : agents,
      };
    },
  });
}
