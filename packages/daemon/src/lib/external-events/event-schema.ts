import { z } from 'zod';

export const ExternalEventSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  topic: z.string(),
  occurredAt: z.number(),
  ingestedAt: z.number(),
  source: z.string(),
  sourceEventId: z.string().optional(),
  summary: z.string(),
  externalUrl: z.string().optional(),
  payload: z.record(z.string(), z.json()),
  dedupeKey: z.string(),
  urgency: z.enum(['immediate', 'queued']).optional(),
  render: z.string().optional(),
});

export const ExternalEventStateSchema = z.enum(['published', 'delivered', 'failed', 'ignored']);
