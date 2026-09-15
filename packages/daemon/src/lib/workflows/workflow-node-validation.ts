import type { WorkflowNodeInput } from '@hyperneo/shared';
import type { SpaceAgentTemplateRepository } from '../../storage/repositories/space-agent-template-repository.ts';
import { validateGlobPattern } from '../external-events/topic-validator.ts';
import { Logger } from '../logger.ts';
import { getProviderRegistry, providerMayOfferModel } from '../providers/registry.js';
import { getLongHorizonAgentTemplate } from '../space/agents/long-horizon-agent-templates.ts';
import { MAX_AGENT_SLOT_EVENT_INTERESTS } from '../space/export-format.ts';
import { KNOWN_TOPIC_FROM_SOURCES } from '../space/runtime/parse-pr-url.ts';
import type { SpaceAgentLookup } from './workflow-manager.ts';
import { WorkflowValidationError } from './workflow-validation-error.ts';

const logger = new Logger('SpaceWorkflowManager');

export interface WorkflowNodeAgentRefDeps {
  agentLookup: SpaceAgentLookup | null;
  templateRepo?: SpaceAgentTemplateRepository;
}

const RESERVED_WORKFLOW_AGENT_NAMES = new Set(['task-agent']);

function normalizeWorkflowAgentName(name: string): string {
  return name.trim().toLowerCase();
}

export function isReservedWorkflowAgentName(name: string): boolean {
  return RESERVED_WORKFLOW_AGENT_NAMES.has(normalizeWorkflowAgentName(name));
}

export function validateNodes(
  spaceId: string,
  nodes: WorkflowNodeInput[],
  agentRefs: WorkflowNodeAgentRefDeps
): void {
  if (nodes.length === 0) {
    throw new WorkflowValidationError('A workflow must have at least one node');
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const id = nodes[i].id;
    if (id !== undefined && id !== null) {
      if (id.length === 0) {
        throw new WorkflowValidationError(`node[${i}]: id must be a non-empty string`);
      }
      if (id !== id.trim()) {
        throw new WorkflowValidationError(`node[${i}]: id must not have surrounding whitespace`);
      }
    }
    if (!id) continue;
    if (seenIds.has(id)) {
      throw new WorkflowValidationError(`node[${i}]: duplicate node id "${id}"`);
    }
    seenIds.add(id);
    for (let j = 0; j < nodes.length; j++) {
      if (i !== j && nodes[j].name === id) {
        throw new WorkflowValidationError(
          `node[${i}] id "${id}" must not equal node "${nodes[j].name}"'s name — ` +
            'a node id colliding with another node name makes worker-handle resolution ambiguous and can bypass node-name channel authorization'
        );
      }
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    validateNodeAgentRef(agentRefs, spaceId, node, i);
    validateEventInterests(node, i);
    for (let j = 0; j < (node.agents?.length ?? 0); j++) {
      const entry = node.agents[j];
      const trimmedModel = entry.model?.trim() || undefined;
      entry.model = trimmedModel;
      const trimmedProvider = entry.provider?.trim() || undefined;
      entry.provider = trimmedProvider;
      if (!trimmedProvider) continue;
      if (!trimmedModel) {
        throw new WorkflowValidationError(
          `node[${i}].agents[${j}]: provider "${trimmedProvider}" requires a model — ` +
            'pin a provider alongside the model it should serve'
        );
      }
      const provider = getProviderRegistry().get(trimmedProvider);
      if (!provider) {
        throw new WorkflowValidationError(
          `node[${i}].agents[${j}]: provider "${trimmedProvider}" is not registered`
        );
      }
      if (!providerMayOfferModel(provider, trimmedModel)) {
        throw new WorkflowValidationError(
          `node[${i}].agents[${j}]: provider "${trimmedProvider}" does not offer model ` +
            `"${trimmedModel}"`
        );
      }
    }
  }
}

export function validateStableNodeIds(
  workflowId: string,
  existingNodes: Array<{ id: string }>,
  incomingNodes: Array<{ id?: string }>,
  options: { allowStructuralChanges?: boolean } = {}
): void {
  const existingIds = existingNodes.map((node) => node.id);
  const incomingIds = incomingNodes.map((node) => node.id).filter((id): id is string => !!id);
  const allIncomingIdsPresent = incomingIds.length === incomingNodes.length;
  const incomingIdsUnique = new Set(incomingIds).size === incomingIds.length;
  const existingSet = new Set(existingIds);
  const sameSet =
    existingIds.length === incomingNodes.length &&
    allIncomingIdsPresent &&
    new Set(incomingIds).size === existingSet.size &&
    incomingIds.every((id) => existingSet.has(id));

  if (sameSet) return;
  if (options.allowStructuralChanges && allIncomingIdsPresent && incomingIdsUnique) return;

  logger.error(
    `workflow.idChangeRejected: workflowId=${workflowId} ` +
      `existingNodeIds=[${existingIds.join(',')}] incomingNodeIds=[${incomingIds.join(',')}]`
  );
  throw new WorkflowValidationError(
    'Workflow node IDs are stable and cannot be duplicated, regenerated, or omitted during update'
  );
}

export function validateEventInterests(node: WorkflowNodeInput, index: number): void {
  for (let j = 0; j < (node.agents ?? []).length; j++) {
    const entry = node.agents![j];
    const loc = `node[${index}].agents[${j}].eventInterests`;
    const interests = entry.eventInterests ?? [];
    if (interests.length > MAX_AGENT_SLOT_EVENT_INTERESTS) {
      throw new WorkflowValidationError(
        `${loc}: cannot contain more than ${MAX_AGENT_SLOT_EVENT_INTERESTS} entries`
      );
    }
    for (let k = 0; k < interests.length; k++) {
      const interestLoc = `${loc}[${k}]`;
      const rawInterest = interests[k] as {
        topic?: unknown;
        topicFrom?: { source?: unknown; pattern?: unknown } | undefined;
        label?: unknown;
      };
      const hasTopic = rawInterest.topic !== undefined && rawInterest.topic !== null;
      const hasTopicFrom = rawInterest.topicFrom !== undefined && rawInterest.topicFrom !== null;
      if (hasTopic === hasTopicFrom) {
        throw new WorkflowValidationError(
          `${interestLoc}: exactly one of "topic" or "topicFrom" must be set`
        );
      }
      if (hasTopic) {
        if (typeof rawInterest.topic !== 'string') {
          throw new WorkflowValidationError(`${interestLoc}.topic: must be a string`);
        }
        const validation = validateGlobPattern(rawInterest.topic);
        if (!validation.valid) {
          throw new WorkflowValidationError(
            `${interestLoc}.topic: ${validation.reason ?? 'invalid external-event topic pattern'}`
          );
        }
        continue;
      }
      const topicFrom = rawInterest.topicFrom!;
      if (typeof topicFrom.source !== 'string' || !KNOWN_TOPIC_FROM_SOURCES.has(topicFrom.source)) {
        throw new WorkflowValidationError(
          `${interestLoc}.topicFrom.source: unknown source "${String(
            topicFrom.source
          )}"; expected one of ${[...KNOWN_TOPIC_FROM_SOURCES].map((s) => `"${s}"`).join(', ')}`
        );
      }
      if (
        typeof topicFrom.pattern !== 'string' ||
        topicFrom.pattern.length === 0 ||
        topicFrom.pattern !== topicFrom.pattern.trim()
      ) {
        throw new WorkflowValidationError(
          `${interestLoc}.topicFrom.pattern: must be a non-empty string with no surrounding whitespace`
        );
      }
    }
  }
}

export function validateNodeAgentRef(
  agentRefs: WorkflowNodeAgentRefDeps,
  spaceId: string,
  node: WorkflowNodeInput,
  index: number
): void {
  const legacyAgentId = (node as unknown as Record<string, unknown>)['agentId'] as
    | string
    | undefined;
  if ((!node.agents || node.agents.length === 0) && legacyAgentId) {
    node.agents = [{ agentId: legacyAgentId, name: node.name }];
  }

  const hasAgents = node.agents && node.agents.length > 0;

  if (!hasAgents) {
    throw new WorkflowValidationError(`node[${index}]: agents must be a non-empty array`);
  }

  const seenNames = new Set<string>();
  for (let j = 0; j < node.agents.length; j++) {
    const entry = node.agents[j];
    const loc = `node[${index}].agents[${j}]`;
    const hasAgentId = !!entry.agentId?.trim();
    const hasTemplateKey = !!entry.templateKey?.trim();
    if (!hasAgentId && !hasTemplateKey) {
      throw new WorkflowValidationError(
        `${loc}: agentId must reference a SpaceLongHorizonAgent or templateKey must reference an agent template`
      );
    }
    if (!entry.name || !entry.name.trim()) {
      throw new WorkflowValidationError(`${loc}: name must be a non-empty string`);
    }
    if (isReservedWorkflowAgentName(entry.name)) {
      throw new WorkflowValidationError(
        `${loc}: name "${entry.name}" is reserved for a built-in agent`
      );
    }
    if (seenNames.has(entry.name)) {
      throw new WorkflowValidationError(
        `${loc}: duplicate name "${entry.name}" — each agent slot must have a unique name within the node`
      );
    }
    seenNames.add(entry.name);

    if (entry.replaceAgentPrompt === true && !entry.customPrompt?.value?.trim()) {
      logger.warn(
        `${loc}: replaceAgentPrompt is true but customPrompt is empty — ` +
          `this slot will run with only the SDK base contract (the agent's prompt is replaced with nothing).`
      );
    }

    if (entry.resetContextPerTurn !== undefined && typeof entry.resetContextPerTurn !== 'boolean') {
      throw new WorkflowValidationError(`${loc}: resetContextPerTurn must be a boolean`);
    }
  }

  for (let j = 0; j < node.agents.length; j++) {
    const entry = node.agents[j];
    if (entry.templateKey?.trim()) {
      const key = entry.templateKey.trim();
      if (getLongHorizonAgentTemplate(key)) {
        entry.agentId = '';
        continue;
      }
      if (agentRefs.templateRepo?.getOwned(spaceId, key)) continue;
      if (agentRefs.agentLookup && entry.agentId?.trim()) {
        if (agentRefs.agentLookup.getAgentById(spaceId, entry.agentId)) continue;
      }
      throw new WorkflowValidationError(
        `node[${index}].agents[${j}]: templateKey "${key}" does not match any agent template`
      );
    }
    if (agentRefs.agentLookup) {
      const agent = agentRefs.agentLookup.getAgentById(spaceId, entry.agentId);
      if (!agent) {
        throw new WorkflowValidationError(
          `node[${index}].agents[${j}]: agentId "${entry.agentId}" does not match any SpaceLongHorizonAgent in this space`
        );
      }
    }
  }
}
