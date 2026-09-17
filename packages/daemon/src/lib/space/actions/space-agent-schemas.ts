import { z } from 'zod';

export const SubscribeAgentEventSchema = z.object({
  agent_id: z.string().describe('Long-horizon agent ID'),
  topic_pattern: z.string().describe('External event topic glob pattern'),
  label: z.string().optional().describe('Human-readable subscription label'),
});

export const UnsubscribeAgentEventSchema = z.object({
  agent_id: z.string().describe('Long-horizon agent ID'),
  topic_pattern: z.string().describe('External event topic glob pattern'),
  label: z.string().optional().describe('Human-readable subscription label'),
});

export const ListAgentEventSubscriptionsSchema = z.object({
  agent_id: z.string().describe('Long-horizon agent ID'),
});
