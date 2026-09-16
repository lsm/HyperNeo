import type { SpaceWorkflowSummary } from '@hyperneo/shared';
import { z } from 'zod';

export const AutonomyLevelSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

export const WorkflowSummarySchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()),
  templateName: z.string().optional(),
  disabled: z.boolean().optional(),
  handle: z.string().optional(),
  nodeCount: z.number(),
  completionAutonomyLevel: AutonomyLevelSchema,
  templateHash: z.string().nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
}) satisfies z.ZodType<SpaceWorkflowSummary>;
