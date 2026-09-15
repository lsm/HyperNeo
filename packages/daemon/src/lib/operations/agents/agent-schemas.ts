import { z } from 'zod';
import type { SpaceLongHorizonAgent } from '@hyperneo/shared';

export const AgentStatusSchema = z.enum(['active', 'paused', 'disabled', 'archived']);

export const ThinkingLevelSchema = z.enum(['off', 'think8k', 'think16k', 'think24k', 'think32k']);

export const SettingSourcesSchema = z.array(z.enum(['user', 'project', 'local']));

export const AgentModelPoolEntrySchema = z.object({
  model: z.string().min(1),
  provider: z.string().optional(),
  maxConcurrent: z.number().int().min(1),
  weight: z.number().min(0),
  thinkingLevel: ThinkingLevelSchema.nullish(),
});

export const LongHorizonAgentSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  handle: z.string(),
  displayName: z.string(),
  templateKey: z.string().nullable(),
  status: AgentStatusSchema,
  sessionId: z.string().nullable(),
  instructions: z.string(),
  autonomyLevel: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
    .nullable(),
  model: z.string().nullable(),
  thinkingLevel: ThinkingLevelSchema.nullable(),
  provider: z.string().nullable(),
  settingSources: SettingSourcesSchema.nullable(),
  toolPermissions: z.record(z.string(), z.unknown()),
  modelPool: z.array(AgentModelPoolEntrySchema).optional(),
  description: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
}) satisfies z.ZodType<SpaceLongHorizonAgent>;

export function compactLongHorizonAgent(agent: {
  id: string;
  handle: string;
  displayName: string;
  status: 'active' | 'paused' | 'disabled' | 'archived';
  model: string | null;
  provider: string | null;
  thinkingLevel: string | null;
  templateKey: string | null;
  updatedAt: number;
}) {
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

export const CompactLongHorizonAgentSchema: z.ZodType<ReturnType<typeof compactLongHorizonAgent>> =
  z.object({
    id: z.string(),
    handle: z.string(),
    displayName: z.string(),
    status: AgentStatusSchema,
    model: z.string().nullable(),
    provider: z.string().nullable(),
    thinkingLevel: z.string().nullable(),
    templateKey: z.string().nullable(),
    updatedAt: z.number(),
  });
