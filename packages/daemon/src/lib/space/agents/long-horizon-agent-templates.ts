import { LH_COORDINATOR_INSTRUCTIONS, LH_TASK_MANAGER_INSTRUCTIONS } from '@hyperneo/prompts';
import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { getPresetAgentTemplates } from './seed-agents.ts';

const LONG_HORIZON_AGENT_TEMPLATES: SpaceLongHorizonAgentTemplate[] = [
  {
    key: 'coordinator.default',
    handle: 'coordinator',
    displayName: 'Coordinator',
    description:
      'Orchestrates goals, reminders, reactive subscriptions, and handoffs across the Space.',
    instructions: LH_COORDINATOR_INSTRUCTIONS,
    suggestedAutonomyLevel: 2,
    suggestedEventSubscriptions: [
      {
        source: 'space',
        topic: 'task.*',
        filter: { statuses: ['blocked', 'review', 'done'] },
      },
      {
        source: 'space',
        topic: 'goal.*',
        filter: { statuses: ['active', 'blocked', 'done'] },
      },
    ],
    reminderDefaults: [
      {
        title: 'Review Space plan',
        body: 'Review active goals, blocked work, stale tasks, and needed follow-ups.',
        triggerType: 'cron',
        cronExpression: '0 9 * * 1',
        timezone: 'UTC',
      },
    ],
    ownershipPatterns: [
      {
        target: 'goal',
        relationship: 'manager',
        description: 'Manage cross-cutting recurring goals and delegate execution tasks.',
      },
      {
        target: 'forge_scope',
        relationship: 'watcher',
        description: 'Watch broad Forge scopes for new lessons and proposed work.',
      },
    ],
    toolPermissions: {},
  },
  {
    key: 'task-manager.default',
    handle: 'task-manager',
    displayName: 'Task Manager',
    description:
      'Triages, tracks, and coordinates Space tasks and goals; summarizes state, nags stalled work, and proposes next slices.',
    instructions: LH_TASK_MANAGER_INSTRUCTIONS,
    suggestedAutonomyLevel: 2,
    suggestedEventSubscriptions: [],
    reminderDefaults: [
      {
        title: 'Review stalled work',
        body: 'Review blocked, stale, and review-waiting tasks and goals, nag silent owners, and propose next slices.',
        triggerType: 'cron',
        cronExpression: '0 9 * * 1-5',
        timezone: 'UTC',
      },
    ],
    ownershipPatterns: [
      {
        target: 'goal',
        relationship: 'manager',
        description:
          'Keep goal progress summaries and task pointers current; flag goals drifting from their tasks.',
      },
    ],
    toolPermissions: {},
  },
];

export const WORKER_TEMPLATE_KEY_PREFIX = 'worker.';

export const RETIRED_LONG_HORIZON_TEMPLATE_KEYS = [
  'product-quality-manager.default',
  'release-manager.default',
  'security-auditor.default',
  'marketing.default',
  'sales.default',
  'research.default',
  'family-ops-chores.default',
] as const;

const WORKER_TEMPLATE_LABELS = ['workflow-worker'];
const LONG_HORIZON_TEMPLATE_LABELS = ['long-horizon'];

export function workerTemplateKey(handle: string): string {
  return `${WORKER_TEMPLATE_KEY_PREFIX}${handle}`;
}

const LEGACY_WORKER_TEMPLATE_KEYS: Record<string, string> = {
  'worker.coder': 'worker.swe',
};

export function normalizeLegacyWorkerTemplateKey(key: string): string {
  return LEGACY_WORKER_TEMPLATE_KEYS[key] ?? key;
}

function workerPresetTemplates(): SpaceLongHorizonAgentTemplate[] {
  return getPresetAgentTemplates().map((preset) => ({
    key: workerTemplateKey(preset.handle),
    handle: preset.handle,
    displayName: preset.name,
    description: preset.description,
    instructions: preset.customPrompt,
    suggestedAutonomyLevel: 1,
    suggestedEventSubscriptions: [],
    reminderDefaults: [],
    ownershipPatterns: [],
    toolPermissions: preset.tools.length > 0 ? { tools: [...preset.tools] } : {},
  }));
}

export function getLongHorizonAgentTemplates(): SpaceLongHorizonAgentTemplate[] {
  return structuredClone([...LONG_HORIZON_AGENT_TEMPLATES, ...workerPresetTemplates()]).map(
    (template) => ({
      ...template,
      labels: template.key.startsWith(WORKER_TEMPLATE_KEY_PREFIX)
        ? [...WORKER_TEMPLATE_LABELS]
        : [...LONG_HORIZON_TEMPLATE_LABELS],
    })
  );
}

export function getLongHorizonAgentTemplate(
  key: string
): SpaceLongHorizonAgentTemplate | undefined {
  return getLongHorizonAgentTemplates().find((template) => template.key === key);
}
