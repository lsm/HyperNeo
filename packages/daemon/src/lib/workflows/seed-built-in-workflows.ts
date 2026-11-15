import { generateUUID } from '@hyperneo/shared';
import { Logger } from '../logger.ts';
import {
  mergeChannelsFromTemplate,
  mergeHooksFromTemplate,
  mergeNodeStructuralFieldsFromTemplate,
} from './built-in-template-merge.ts';
import { getBuiltInWorkflows } from './built-in-workflows.ts';
import { computeWorkflowHash } from './template-hash.ts';
import type { SpaceWorkflowManager } from './workflow-manager.ts';

const builtInSeederLog = new Logger('seed-built-in-workflows');

export interface SeedBuiltInWorkflowsResult {
  seeded: string[];
  restamped: string[];
  errors: Array<{ name: string; error: string }>;
  skipped: boolean;
}

const RESTAMP_FIELDS = [
  'legacy postApproval(clear)',
  'completionAutonomyLevel',
  'templateHash',
  'nodes(postApproval + toolGuards in-place + missing template nodes)',
  'channels(maxCycles + label in-place on matched channels + missing template channels)',
  'hooks(template hooks)',
] as const;

export function seedBuiltInWorkflows(
  spaceId: string,
  workflowManager: SpaceWorkflowManager,
  hasActiveRuns?: (workflowId: string) => boolean
): SeedBuiltInWorkflowsResult {
  const templates = getBuiltInWorkflows();
  const templatesByName = new Map(templates.map((t) => [t.name, t]));
  const existing = workflowManager.listWorkflows(spaceId);

  const restamped: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  if (existing.length > 0) {
    for (const row of existing) {
      if (!row.templateName) continue;
      const template = templatesByName.get(row.templateName);
      if (!template) continue;
      const rowTags = row.tags ?? [];
      const wantsDefault = (template.tags ?? []).includes('default');
      if (wantsDefault !== rowTags.includes('default')) {
        try {
          workflowManager.stampBuiltInTags(
            row.id,
            wantsDefault ? [...rowTags, 'default'] : rowTags.filter((tag) => tag !== 'default')
          );
        } catch (err) {
          errors.push({
            name: template.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const expectedHash = computeWorkflowHash(template);
      if (row.templateHash === expectedHash) continue;

      if (hasActiveRuns?.(row.id)) {
        builtInSeederLog.info(
          `deferred re-stamp of built-in workflow '${template.name}' (id=${row.id}) ` +
            `in space ${spaceId}: an active workflow run still references it`
        );
        continue;
      }

      try {
        const mergedNodes = mergeNodeStructuralFieldsFromTemplate(row.nodes, template.nodes);
        const mergedChannels = mergeChannelsFromTemplate(
          row.channels,
          template.channels,
          template.nodes,
          row.nodes
        );
        const mergedHooks = mergeHooksFromTemplate(
          template.hooks,
          template.nodes,
          mergedNodes,
          row.hooks
        );
        const writeChannels = JSON.stringify(mergedChannels) !== JSON.stringify(row.channels);

        const mergedHash = computeWorkflowHash({
          ...row,
          nodes: mergedNodes,
          hooks: mergedHooks ?? undefined,
          channels: writeChannels ? mergedChannels : row.channels,
          completionAutonomyLevel: template.completionAutonomyLevel,
          postApproval: undefined,
        });
        const stampedHash = mergedHash === expectedHash ? expectedHash : row.templateHash;

        workflowManager.updateWorkflow(row.id, {
          completionAutonomyLevel: template.completionAutonomyLevel,
          postApproval: null,
          hooks: mergedHooks ?? null,
          nodes: mergedNodes,
          ...(writeChannels ? { channels: mergedChannels } : {}),
          templateHash: stampedHash,
        });
        restamped.push(template.name);
        builtInSeederLog.info(
          `re-stamped built-in workflow '${template.name}' (id=${row.id}) ` +
            `in space ${spaceId}: fields=${RESTAMP_FIELDS.join(',')}`
        );
      } catch (err) {
        errors.push({
          name: template.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const installedTemplateNames = new Set(
    workflowManager
      .listWorkflows(spaceId)
      .map((workflow) => workflow.templateName)
      .filter((name): name is string => !!name)
  );
  const templatesToCreate = templates.filter(
    (template) => !installedTemplateNames.has(template.name)
  );
  if (templatesToCreate.length === 0) {
    return {
      seeded: [],
      restamped,
      errors,
      skipped: restamped.length === 0 && errors.length === 0,
    };
  }

  const seeded: string[] = [];

  for (const template of templatesToCreate) {
    try {
      const nodeIdMap = new Map<string, string>();
      for (const node of template.nodes) {
        nodeIdMap.set(node.id, generateUUID());
      }

      const nodes = template.nodes.map((s) => ({
        id: nodeIdMap.get(s.id)!,
        name: s.name,
        agents: s.agents.map((a) => ({ ...a })),
        ...(s.postApproval ? { postApproval: { ...s.postApproval } } : {}),
        ...(s.transitions && s.transitions.length > 0
          ? { transitions: s.transitions.map((t) => ({ ...t })) }
          : {}),
      }));

      const startNodeId = nodeIdMap.get(template.startNodeId);
      if (!startNodeId) {
        throw new Error(
          `seedBuiltInWorkflows: template '${template.name}' has invalid startNodeId '${template.startNodeId}'.`
        );
      }

      if (!template.endNodeId) {
        throw new Error(
          `seedBuiltInWorkflows: template '${template.name}' is missing required endNodeId.`
        );
      }
      const endNodeId = nodeIdMap.get(template.endNodeId);
      if (!endNodeId) {
        throw new Error(
          `seedBuiltInWorkflows: template '${template.name}' has invalid endNodeId '${template.endNodeId}'.`
        );
      }

      workflowManager.createWorkflow({
        spaceId,
        name: template.name,
        description: template.description,
        nodes,
        startNodeId,
        endNodeId,
        tags: [...template.tags],
        channels: template.channels
          ? template.channels.map((ch) => ({ ...ch, id: ch.id ?? generateUUID() }))
          : undefined,
        hooks: template.hooks ? [...template.hooks] : undefined,
        layout: template.layout
          ? Object.fromEntries(
              Object.entries(template.layout).map(([templateNodeId, position]) => [
                nodeIdMap.get(templateNodeId) ?? templateNodeId,
                position,
              ])
            )
          : undefined,
        completionAutonomyLevel: template.completionAutonomyLevel,
        ...(template.handle ? { handle: template.handle } : {}),
        templateName: template.name,
        templateHash: computeWorkflowHash(template),
      });

      seeded.push(template.name);
    } catch (err) {
      errors.push({
        name: template.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { seeded, restamped, errors, skipped: false };
}
