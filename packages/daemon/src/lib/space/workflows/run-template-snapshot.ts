import type { SpaceAgentTemplate, SpaceWorkflow, WorkflowTemplateSnapshot } from '@hyperneo/shared';
import type { SpaceAgentTemplateRepository } from '../../../storage/repositories/space-agent-template-repository.ts';
import { getBuiltInSpaceAgentTemplates } from '../managers/space-agent-template-manager.ts';

export type AgentTemplateResolver = (key: string) => SpaceAgentTemplate | null;

export function createAgentTemplateResolver(
  templateRepo?: Pick<SpaceAgentTemplateRepository, 'getByKey'>
): AgentTemplateResolver {
  const builtIns = new Map(
    getBuiltInSpaceAgentTemplates().map((template) => [template.key, template])
  );
  return (key) => builtIns.get(key) ?? templateRepo?.getByKey(key) ?? null;
}

export function toRunTemplateSnapshot(template: SpaceAgentTemplate): WorkflowTemplateSnapshot {
  const snapshot: WorkflowTemplateSnapshot = {
    key: template.key,
    handle: template.handle,
    displayName: template.displayName,
    description: template.description,
    instructions: template.instructions,
    suggestedAutonomyLevel: template.suggestedAutonomyLevel,
    model: template.model,
    provider: template.provider,
    modelPool: template.modelPool,
    thinkingLevel: template.thinkingLevel,
    settingSources: template.settingSources,
    tools: template.tools,
    labels: template.labels,
  };
  return snapshot;
}

export function buildRunTemplateSnapshots(
  workflow: Pick<SpaceWorkflow, 'nodes'>,
  resolveTemplate: AgentTemplateResolver
): Record<string, WorkflowTemplateSnapshot> {
  const snapshots: Record<string, WorkflowTemplateSnapshot> = {};
  for (const node of workflow.nodes) {
    for (const slot of node.agents) {
      const key = slot.templateKey?.trim();
      if (!key || Object.hasOwn(snapshots, key)) continue;
      const template = resolveTemplate(key);
      if (template) snapshots[key] = toRunTemplateSnapshot(template);
    }
  }
  return snapshots;
}

export function withRunTemplateSnapshots(
  workflow: SpaceWorkflow,
  resolveTemplate: AgentTemplateResolver
): SpaceWorkflow {
  const snapshots = buildRunTemplateSnapshots(workflow, resolveTemplate);
  if (Object.keys(snapshots).length === 0) return workflow;
  return { ...workflow, templateSnapshots: snapshots };
}
