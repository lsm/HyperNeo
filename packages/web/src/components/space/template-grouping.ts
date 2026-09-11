import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';

export interface AgentTemplateGroup {
  key: 'workflow-worker' | 'long-horizon' | 'custom';
  title: string;
  templates: SpaceLongHorizonAgentTemplate[];
}

export function groupTemplatesByLabel(
  templates: SpaceLongHorizonAgentTemplate[]
): AgentTemplateGroup[] {
  const workflowWorkers: SpaceLongHorizonAgentTemplate[] = [];
  const longHorizon: SpaceLongHorizonAgentTemplate[] = [];
  const custom: SpaceLongHorizonAgentTemplate[] = [];
  for (const template of templates) {
    const labels = template.labels ?? [];
    if (labels.includes('workflow-worker')) workflowWorkers.push(template);
    else if (labels.includes('long-horizon')) longHorizon.push(template);
    else custom.push(template);
  }
  const groups: AgentTemplateGroup[] = [
    { key: 'workflow-worker', title: 'Workflow workers', templates: workflowWorkers },
    { key: 'long-horizon', title: 'Long-horizon', templates: longHorizon },
    { key: 'custom', title: 'Custom', templates: custom },
  ];
  return groups.filter((group) => group.templates.length > 0);
}
