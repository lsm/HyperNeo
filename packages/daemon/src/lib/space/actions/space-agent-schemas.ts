import { z } from 'zod';

export const ThinkingLevelSchema = z.enum(['off', 'think8k', 'think16k', 'think24k', 'think32k']);

export const SettingSourcesSchema = z.array(z.enum(['user', 'project', 'local']));

export const CreateAgentFromTemplateSchema = z.object({
  template_name: z
    .string()
    .describe('Template key: built-in (worker.research, worker.qa, ...) or user-created'),
  name: z
    .string()
    .optional()
    .describe('Optional new agent name; defaults to template name/display name'),
  model: z.string().optional().describe('Model override'),
  provider: z.string().optional().describe('Provider override'),
  thinking_level: ThinkingLevelSchema.optional().describe('Thinking level override'),
});

export const ListAgentTemplatesSchema = z.object({});

export const DeleteAgentTemplateSchema = z.object({
  key: z
    .string()
    .min(1)
    .describe('Key of the user-authored template to delete; built-in keys are rejected'),
  expected_version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Version the caller last saw (from a create/update result or list_agent_templates); the delete fails when the stored version differs. Omit to delete unconditionally.'
    ),
});

export const AgentModelPoolEntrySchema = z.object({
  model: z.string().min(1).describe('Model identifier'),
  provider: z.string().optional().describe('Provider identifier'),
  maxConcurrent: z.number().int().min(1).describe('Maximum concurrent requests'),
  weight: z.number().min(0).describe('Relative routing weight'),
  thinkingLevel: ThinkingLevelSchema.nullish().describe(
    'Thinking level applied when this entry is picked; overrides the agent-level thinking level'
  ),
});

export const CreateAgentTemplateSchema = z.object({
  key: z
    .string()
    .min(1)
    .describe(
      'Unique template key (e.g. reviewer.custom); must not collide with an existing, built-in, or reserved key'
    ),
  handle: z.string().min(1).describe('Handle slug for agents created from this template'),
  display_name: z.string().optional().describe('Display name; defaults to the handle'),
  description: z.string().optional().describe('Short summary of what the template is for'),
  instructions: z
    .string()
    .optional()
    .describe('System prompt for agents created from this template'),
  labels: z.array(z.string()).optional().describe('Open tags used to group templates'),
  suggested_autonomy_level: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
    .optional()
    .describe('Suggested autonomy level 1-5; defaults to 2'),
  model: z.string().nullable().optional().describe('Model override; null to inherit defaults'),
  provider: z
    .string()
    .nullable()
    .optional()
    .describe('Provider override; null to inherit defaults'),
  model_pool: z
    .array(AgentModelPoolEntrySchema)
    .nullable()
    .optional()
    .describe('Weighted model pool; null to inherit defaults'),
  thinking_level: ThinkingLevelSchema.nullable().optional().describe('Thinking level override'),
  setting_sources: SettingSourcesSchema.nullable().optional().describe('Settings sources'),
  tools: z
    .array(z.string())
    .nullable()
    .optional()
    .describe('Tool allowlist; null to inherit defaults'),
  from_agent_id: z
    .string()
    .optional()
    .describe(
      'Derive defaults from this long-horizon agent in the space; caller-supplied fields override'
    ),
});

export const UpdateAgentTemplateSchema = z.object({
  key: z
    .string()
    .min(1)
    .describe('Key of the user-authored template to update; built-in keys are rejected'),
  expected_version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Version the caller last saw (from a prior create/update result); the update fails when the stored version differs. Omit to update against the current stored version.'
    ),
  display_name: z.string().optional().describe('New display name'),
  description: z.string().optional().describe('New short summary of what the template is for'),
  instructions: z
    .string()
    .optional()
    .describe('New system prompt for agents created from this template'),
  labels: z
    .array(z.string())
    .nullable()
    .optional()
    .describe('Open tags replacing the existing labels; null clears them'),
  model: z.string().nullable().optional().describe('Model override; null to inherit defaults'),
  provider: z
    .string()
    .nullable()
    .optional()
    .describe('Provider override; null to inherit defaults'),
  model_pool: z
    .array(AgentModelPoolEntrySchema)
    .nullable()
    .optional()
    .describe('Weighted model pool; null to inherit defaults'),
  thinking_level: ThinkingLevelSchema.nullable().optional().describe('Thinking level override'),
  setting_sources: SettingSourcesSchema.nullable().optional().describe('Settings sources'),
  tools: z
    .array(z.string())
    .nullable()
    .optional()
    .describe('Tool allowlist; null to inherit defaults'),
});

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
