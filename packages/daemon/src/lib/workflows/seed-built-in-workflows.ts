import { createHash } from 'node:crypto';
import { CODER_OWNED_MERGE_PROMPT } from '@hyperneo/prompts';
import type { SpaceWorkflow } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import { Logger } from '../logger.ts';
import { patchLegacyStableSlotPrompt } from './built-in-legacy-slot-prompts.ts';
import { patchKnownBuiltInPromptDrift } from './built-in-prompt-drift.ts';
import {
  RETIRED_MERGE_INSTRUCTIONS_SHA256,
  RETIRED_MERGER_RAW_MERGE_GUARD,
  RETIRED_MERGER_SLOT_NAMES,
  RETIRED_POST_APPROVAL_NODE,
  RETIRED_PR_MERGER_SLOT_PROMPT,
  stripRetiredPostApproval,
} from './built-in-retired-post-approval.ts';
import {
  mergeChannelsFromTemplate,
  mergeHooksFromTemplate,
  mergeNodeStructuralFieldsFromTemplate,
} from './built-in-template-merge.ts';
import { getBuiltInWorkflows, LEGACY_CODING_TEMPLATE_IDENTITIES } from './built-in-workflows.ts';
import { CODER_OWNED_MERGE_INSTRUCTIONS } from './post-approval-merge-template.ts';
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
  let existing = workflowManager.listWorkflows(spaceId);
  const identityErrors: Array<{ name: string; error: string }> = [];

  for (const identity of LEGACY_CODING_TEMPLATE_IDENTITIES) {
    const legacyRows = existing.filter((workflow) => workflow.templateName === identity.legacyName);
    if (legacyRows.length === 0) continue;
    const canonicalTemplate = templatesByName.get(identity.name);
    const canonicalIsDefault = (canonicalTemplate?.tags ?? []).includes('default');
    const sorted = [...legacyRows].sort((a, b) => b.createdAt - a.createdAt);
    for (const row of sorted) {
      let migrated: SpaceWorkflow | null = row;
      const rowIsUnmodifiedSeed =
        row.name === identity.legacyName && row.handle === identity.legacyHandle;
      try {
        if (rowIsUnmodifiedSeed) {
          migrated = workflowManager.updateBuiltInIdentity(row.id, {
            name: identity.name,
            handle: identity.handle,
            templateName: identity.name,
          });
        } else {
          migrated = workflowManager.stampBuiltInTemplateName(row.id, identity.name);
        }
      } catch {
        try {
          migrated = workflowManager.stampBuiltInTemplateName(row.id, identity.name);
        } catch (innerErr) {
          migrated = null;
          identityErrors.push({
            name: identity.legacyName,
            error: innerErr instanceof Error ? innerErr.message : String(innerErr),
          });
        }
      }
      if (migrated && !canonicalIsDefault && (migrated.tags ?? []).includes('default')) {
        try {
          workflowManager.stampBuiltInTags(
            row.id,
            migrated.tags!.filter((tag) => tag !== 'default')
          );
        } catch {}
      }
    }
  }
  existing = workflowManager.listWorkflows(spaceId);

  const restamped: string[] = [];
  const errors: Array<{ name: string; error: string }> = [...identityErrors];

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
        const templateNodesByName = new Map(template.nodes.map((node) => [node.name, node]));
        const nodes = row.nodes.map((node) => {
          const templateNode = templateNodesByName.get(node.name);
          const agents = node.agents.map((agent) => {
            const templateAgent = templateNode?.agents.find(
              (candidate) => candidate.name === agent.name
            );
            if (!templateAgent) return agent;
            const driftedPrompt = patchKnownBuiltInPromptDrift(
              agent.customPrompt,
              templateAgent.customPrompt
            );
            const prompt = patchLegacyStableSlotPrompt(
              driftedPrompt?.value,
              templateAgent.customPrompt?.value,
              node.name,
              agent.name
            );
            return prompt === agent.customPrompt?.value
              ? agent
              : { ...agent, customPrompt: prompt === undefined ? undefined : { value: prompt } };
          });
          if (node.name !== RETIRED_POST_APPROVAL_NODE) {
            return JSON.stringify(agents) === JSON.stringify(node.agents)
              ? node
              : { ...node, agents };
          }
          const merger = agents.find((agent) => RETIRED_MERGER_SLOT_NAMES.has(agent.name));
          if (
            !merger ||
            merger.customPrompt?.value !== RETIRED_PR_MERGER_SLOT_PROMPT ||
            merger.model !== undefined ||
            merger.provider !== undefined ||
            merger.thinkingLevel !== undefined ||
            merger.replaceAgentPrompt === true ||
            merger.disabledSkillIds !== undefined ||
            merger.extraMcpServers !== undefined ||
            merger.resetContextPerTurn !== undefined ||
            JSON.stringify(merger.toolGuards) !==
              JSON.stringify([RETIRED_MERGER_RAW_MERGE_GUARD]) ||
            node.postApproval?.targetAgent !== merger.name ||
            typeof node.postApproval.instructions !== 'string' ||
            createHash('sha256').update(node.postApproval.instructions).digest('hex') !==
              RETIRED_MERGE_INSTRUCTIONS_SHA256
          ) {
            return node;
          }
          return {
            ...node,
            agents: agents.map((agent) =>
              agent === merger
                ? {
                    ...agent,
                    customPrompt: { value: CODER_OWNED_MERGE_PROMPT },
                    toolGuards: undefined,
                  }
                : agent
            ),
            postApproval: {
              ...node.postApproval,
              instructions: CODER_OWNED_MERGE_INSTRUCTIONS,
            },
          };
        });
        if (JSON.stringify(nodes) !== JSON.stringify(row.nodes)) {
          workflowManager.updateWorkflow(row.id, { nodes });
        }
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
        const stripped = stripRetiredPostApproval({
          templateName: template.name,
          nodes: mergedNodes,
          channels: mergedChannels,
          hooks: mergedHooks,
        });
        const writeChannels =
          JSON.stringify(mergedChannels) !== JSON.stringify(row.channels) ||
          stripped.channelsChanged;

        const mergedHash = computeWorkflowHash({
          ...row,
          nodes: stripped.nodes,
          hooks: stripped.hooks ?? undefined,
          channels: writeChannels ? stripped.channels : row.channels,
          completionAutonomyLevel: template.completionAutonomyLevel,
          postApproval: undefined,
        });
        const stampedHash = mergedHash === expectedHash ? expectedHash : row.templateHash;

        workflowManager.updateWorkflow(row.id, {
          completionAutonomyLevel: template.completionAutonomyLevel,
          postApproval: null,
          hooks: stripped.hooks ?? null,
          nodes: stripped.nodes,
          ...(writeChannels ? { channels: stripped.channels } : {}),
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
