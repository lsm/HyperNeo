import { LH_SPACE_MANAGER_INSTRUCTIONS, NEO_PACK_COMPUTER_USE_WORKER } from '@hyperneo/prompts';
import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import desktopCatalog from '../desktop/tool-catalog.json' with { type: 'json' };
import { OPERATIONS_MCP_SERVER_NAME } from '../mcp/built-in-servers.ts';
import { getPresetAgentTemplates } from './seed-agents.ts';

const LONG_HORIZON_AGENT_TEMPLATES: SpaceLongHorizonAgentTemplate[] = [
  {
    key: 'space-manager.default',
    handle: 'space-manager',
    displayName: 'Space Manager',
    description:
      'Coordinates Space goals, tasks, workers, and workflows; routes work and follows outcomes.',
    instructions: LH_SPACE_MANAGER_INSTRUCTIONS,
    suggestedAutonomyLevel: 3,
    suggestedEventSubscriptions: [],
    reminderDefaults: [
      {
        title: 'Review Space work',
        body: 'Review goals, tasks, worker progress, and blocked work; route the next action or ask a human where required.',
        triggerType: 'cron',
        cronExpression: '0 9 * * 1-5',
        timezone: 'UTC',
      },
    ],
    ownershipPatterns: [
      {
        target: 'goal',
        relationship: 'manager',
        description: 'Keep goal ownership, progress, and task routing current across the Space.',
      },
    ],
    toolPermissions: {},
  },
];

export const WORKER_TEMPLATE_KEY_PREFIX = 'worker.';

export const RETIRED_LONG_HORIZON_TEMPLATE_KEYS = [
  'task-manager.default',
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

export const RELOCATED_FROM_LABEL_PREFIX = 'relocated-from:';

export function isRelocationMarkerLabel(label: string): boolean {
  return label.startsWith(RELOCATED_FROM_LABEL_PREFIX);
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

const DESKTOP_WORKER_TEMPLATE: SpaceLongHorizonAgentTemplate = {
  key: workerTemplateKey('desktop'),
  handle: 'desktop',
  displayName: 'Desktop',
  description: 'Works in the desktop apps approved for its todo.',
  instructions: `Use the desktop tools to act in the approved apps and invoke with message.send to report to Neo. Ask Neo before handling secrets, deleting data, making purchases, sending anything, or answering security and permission prompts. Report UI failures to Neo with the app and what the screen showed. Never work around them with a shell.

Before an action, take a fresh full window snapshot if its target is missing from your newest full snapshot. Put any exact text you will need in your own reply before an action that could remove it from the screen.

${NEO_PACK_COMPUTER_USE_WORKER}`,
  suggestedAutonomyLevel: 1,
  suggestedEventSubscriptions: [],
  reminderDefaults: [],
  ownershipPatterns: [],
  toolPermissions: {
    tools: [
      'invoke',
      ...desktopCatalog.map(({ name }) => `mcp__${OPERATIONS_MCP_SERVER_NAME}__${name}`),
    ],
  },
};

export function getLongHorizonAgentTemplates(): SpaceLongHorizonAgentTemplate[] {
  return structuredClone([
    ...LONG_HORIZON_AGENT_TEMPLATES,
    ...workerPresetTemplates(),
    DESKTOP_WORKER_TEMPLATE,
  ]).map((template) => ({
    ...template,
    labels: template.key.startsWith(WORKER_TEMPLATE_KEY_PREFIX)
      ? [...WORKER_TEMPLATE_LABELS]
      : [...LONG_HORIZON_TEMPLATE_LABELS],
  }));
}

export function getLongHorizonAgentTemplate(
  key: string
): SpaceLongHorizonAgentTemplate | undefined {
  return getLongHorizonAgentTemplates().find((template) => template.key === key);
}
