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
  const collected = new Map<string, WorkflowTemplateSnapshot>();
  for (const node of workflow.nodes) {
    for (const slot of node.agents) {
      const key = slot.templateKey?.trim();
      if (!key || collected.has(key)) continue;
      const template = resolveTemplate(key);
      if (template) collected.set(key, toRunTemplateSnapshot(template));
    }
  }
  const snapshots: Record<string, WorkflowTemplateSnapshot> = Object.create(null);
  for (const [key, snapshot] of collected) snapshots[key] = snapshot;
  return snapshots;
}

export function runTemplateSnapshotRecord(
  workflow: Pick<SpaceWorkflow, 'templateSnapshots'> | null | undefined,
  run: { definitionVersion: string | null } | null | undefined
): Record<string, WorkflowTemplateSnapshot> | null {
  if (!run?.definitionVersion) return null;
  return workflow?.templateSnapshots ?? null;
}

export function runTemplateResolves(
  workflow: Pick<SpaceWorkflow, 'templateSnapshots'> | null | undefined,
  run: { definitionVersion: string | null } | null | undefined,
  key: string,
  resolveLive: (key: string) => boolean
): boolean {
  const trimmed = key.trim();
  if (!trimmed) return false;
  const snapshots = runTemplateSnapshotRecord(workflow, run);
  if (!snapshots) return resolveLive(trimmed);
  return Object.hasOwn(snapshots, trimmed);
}

export function workflowReferencesTemplates(workflow: Pick<SpaceWorkflow, 'nodes'>): boolean {
  return workflow.nodes.some((node) => node.agents.some((slot) => !!slot.templateKey?.trim()));
}

export function withRunTemplateSnapshots(
  workflow: SpaceWorkflow,
  resolveTemplate: AgentTemplateResolver
): SpaceWorkflow {
  const snapshots = buildRunTemplateSnapshots(workflow, resolveTemplate);
  if (Object.keys(snapshots).length === 0 && !workflowReferencesTemplates(workflow)) {
    return workflow;
  }
  return { ...workflow, templateSnapshots: snapshots };
}
