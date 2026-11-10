import { z } from 'zod';

export const AgentReferenceSchema = z.object({
  space: z.string().trim().min(1).describe('Space id, slug or name'),
  agent: z.string().trim().min(1).describe('Agent id, @handle or display name'),
});

export type AgentReference = z.infer<typeof AgentReferenceSchema>;
