import type { OperationRegistrySource } from '../../operations/registry.ts';
import {
  CreateAgentFromTemplateSchema,
  CreateAgentTemplateSchema,
  DeleteAgentTemplateSchema,
  ListAgentEventSubscriptionsSchema,
  ListAgentTemplatesSchema,
  SubscribeAgentEventSchema,
  UnsubscribeAgentEventSchema,
  UpdateAgentTemplateSchema,
} from './space-agent-schemas.ts';
import { SESSION_WRITE_AUTONOMY_LEVEL } from '../tools/tool-admission-gates.ts';
import { createSpaceAgentToolHandlers, type SpaceAgentToolsConfig } from './space-handlers.ts';
import { type ActionDefinition, defineAction } from './registry.ts';

const DESTRUCTIVE_ACTION_AUTONOMY_LEVEL = SESSION_WRITE_AUTONOMY_LEVEL;

export function createSpaceRegistryEntries(
  config: SpaceAgentToolsConfig,
  _operations?: OperationRegistrySource
): ActionDefinition[] {
  const handlers = createSpaceAgentToolHandlers({ ...config, auditLogRepo: undefined });

  if (!config.db) return [];

  return [
    defineAction({
      name: 'create_agent_from_template',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        'Create a long-horizon agent from a long-horizon template key, seeding suggested subscriptions and reminders; returns the created agent.',
      paramsDoc: 'template_name, name?, model?, provider?, thinking_level?',
      paramsSchema: CreateAgentFromTemplateSchema,
      handler: (args) => handlers.create_agent_from_template(args),
    }),
    defineAction({
      name: 'create_agent_template',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        'Create a reusable agent template (prompt, model settings, tool allowlist, labels, suggested autonomy); optional from_agent_id derives defaults from an existing agent; returns the created template.',
      paramsDoc:
        'key, handle, display_name?, description?, instructions?, labels?, suggested_autonomy_level?, model?, provider?, model_pool?, thinking_level?, setting_sources?, tools?, from_agent_id?',
      paramsSchema: CreateAgentTemplateSchema,
      auditRedactKeys: ['instructions', 'description'],
      handler: (args) => handlers.create_agent_template(args),
    }),
    defineAction({
      name: 'update_agent_template',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        'Update a user-authored agent template by key with compare-and-swap versioning; built-in templates are code-defined and rejected; returns the updated template with its new version.',
      paramsDoc:
        'key, expected_version?, display_name?, description?, instructions?, labels?, model?, provider?, model_pool?, thinking_level?, setting_sources?, tools? (null clears)',
      paramsSchema: UpdateAgentTemplateSchema,
      auditRedactKeys: ['instructions', 'description'],
      handler: (args) => handlers.update_agent_template(args),
    }),
    defineAction({
      name: 'list_agent_templates',
      family: 'agents',
      safetyClass: 'read',
      description:
        'List the merged agent template library: built-in templates plus user-authored templates; entries carry labels and a builtin flag.',
      paramsDoc: 'none',
      paramsSchema: ListAgentTemplatesSchema,
      handler: () => handlers.list_agent_templates(),
    }),
    defineAction({
      name: 'delete_agent_template',
      family: 'agents',
      safetyClass: 'destructive',
      description:
        'Permanently delete a user-authored agent template by key; optional CAS version fails the delete on concurrent modification; workflow references do not block deletion — a run that pinned a template snapshot resolves from that copy, while a run without one may fail to activate a later node, and saved workflows still naming the key must be re-pointed or their future runs cannot activate that slot.',
      paramsDoc: 'key, expected_version?',
      paramsSchema: DeleteAgentTemplateSchema,
      autonomyRequirement: DESTRUCTIVE_ACTION_AUTONOMY_LEVEL,
      handler: (args) => handlers.delete_agent_template(args),
    }),
    defineAction({
      name: 'subscribe_agent_event',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        'Record an external-event topic subscription for a long-horizon agent; returns the subscription record.',
      paramsDoc: 'agent_id, topic_pattern (glob), label?',
      paramsSchema: SubscribeAgentEventSchema,
      handler: (args) => handlers.subscribe_agent_event(args),
    }),
    defineAction({
      name: 'unsubscribe_agent_event',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        'Remove an external-event topic subscription from a long-horizon agent; returns success.',
      paramsDoc: 'agent_id, topic_pattern, label?',
      paramsSchema: UnsubscribeAgentEventSchema,
      handler: (args) => handlers.unsubscribe_agent_event(args),
    }),
    defineAction({
      name: 'list_agent_event_subscriptions',
      family: 'agents',
      safetyClass: 'read',
      description:
        'List external-event subscriptions for a long-horizon agent; returns subscription records.',
      paramsDoc: 'agent_id',
      paramsSchema: ListAgentEventSubscriptionsSchema,
      handler: (args) => handlers.list_agent_event_subscriptions(args),
    }),
  ];
}
