import { z } from 'zod';
import { defineOperation } from '../registry.ts';
import { LongHorizonAgentSchema } from './agent-schemas.ts';
import type { AgentReader } from './agent-catalog.ts';

export function createAgentGetOperation(getAgent: AgentReader) {
  return defineOperation({
    name: 'agent.get',
    description: 'Get one long-horizon agent by ID. Throws when the agent is absent.',
    inputSchema: z
      .object({
        agentId: z.string().min(1),
      })
      .strict(),
    resultSchema: z.object({
      success: z.literal(true),
      agent: LongHorizonAgentSchema,
    }),
    execute: async (input, caller) => {
      const agent = getAgent(input.agentId, caller);
      if (!agent) throw new Error(`Long-horizon agent not found: ${input.agentId}`);
      return { success: true, agent };
    },
  });
}
