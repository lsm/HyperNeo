import type {
  DeclarativeToolGuard,
  EventInterest,
  SpaceWorkflow,
  WorkflowNode,
  WorkflowNodeAgentOverride,
} from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import { patchLegacyStableSlotPrompt } from './built-in-legacy-slot-prompts.ts';
import { patchKnownBuiltInPromptDrift } from './built-in-prompt-drift.ts';

const RETIRED_CODER_NO_MERGE_GUARD: DeclarativeToolGuard = {
  matcher: 'Bash',
  pattern:
    '(?:^|[;&|()\\n`])\\s*(?:(?:env\\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\\s;&|()`]+|command)\\s+)*gh[\\s\\\\]+pr[\\s\\\\]+merge\\b',
  decision: 'deny',
  reason:
    'Coder-role agents must not merge PRs. Their job is implementation only; the reviewer handles the merge after approval.',
};

export function mergeNodeStructuralFieldsFromTemplate(
  existingNodes: WorkflowNode[],
  templateNodes: Pick<WorkflowNode, 'id' | 'name' | 'agents' | 'postApproval' | 'transitions'>[]
): WorkflowNode[] {
  const templateNodesByName = new Map(templateNodes.map((node) => [node.name, node]));
  const existingNodeNames = new Set(existingNodes.map((node) => node.name));
  const existingAgentNames = new Set(
    existingNodes.flatMap((node) => node.agents.map((agent) => agent.name).filter(Boolean))
  );
  const missingTemplateNodes = templateNodes
    .filter(
      (node) =>
        !existingNodeNames.has(node.name) &&
        !node.agents.some((agent) => agent.name && existingAgentNames.has(agent.name))
    )
    .map((node) => ({
      ...node,
      id: generateUUID(),
      agents: node.agents.map((agent) => ({ ...agent })),
    }));
  const templateAgentsByKey = new Map<
    string,
    {
      toolGuards: DeclarativeToolGuard[] | undefined;
      resetContextPerTurn: boolean | undefined;
      eventInterests: EventInterest[] | undefined;
      customPrompt?: WorkflowNodeAgentOverride;
    }
  >();
  for (const node of templateNodes) {
    for (const agent of node.agents) {
      templateAgentsByKey.set(`${node.name}::${agent.name}`, {
        toolGuards: agent.toolGuards,
        resetContextPerTurn: agent.resetContextPerTurn,
        eventInterests: agent.eventInterests,
        customPrompt: agent.customPrompt,
      });
    }
  }

  const mergedExistingNodes: WorkflowNode[] = existingNodes.map((node) => {
    const templateNode = templateNodesByName.get(node.name);
    return {
      ...node,
      postApproval: templateNode ? templateNode.postApproval : node.postApproval,
      transitions:
        templateNode?.transitions && templateNode.transitions.length > 0
          ? templateNode.transitions.map((t) => {
              const isNodeTarget = templateNodes.some((n) => n.name === t.target);
              return {
                ...t,
                target: isNodeTarget
                  ? remapTemplateChannelRef(t.target, templateNodes, existingNodes)
                  : t.target === '*'
                    ? '*'
                    : remapTransitionSlotTarget(t.target, templateNodes, existingNodes),
              };
            })
          : node.transitions,
      agents: node.agents.map((agent) => {
        const key = `${node.name}::${agent.name}`;
        const templateAgent = templateAgentsByKey.get(key);
        if (templateAgent === undefined) return agent;
        const existingCustomPrompt = patchKnownBuiltInPromptDrift(
          agent.customPrompt,
          templateAgent.customPrompt
        );
        const legacyPromptValue = patchLegacyStableSlotPrompt(
          existingCustomPrompt?.value,
          templateAgent.customPrompt?.value,
          node.name,
          agent.name
        );
        const finalPrompt =
          legacyPromptValue !== undefined && legacyPromptValue !== existingCustomPrompt?.value
            ? { value: legacyPromptValue }
            : existingCustomPrompt;
        let resolvedToolGuards: DeclarativeToolGuard[] | undefined;
        if (templateAgent.toolGuards !== undefined) {
          resolvedToolGuards = templateAgent.toolGuards;
        } else if (agent.toolGuards?.length) {
          const kept = agent.toolGuards.filter(
            (g) => JSON.stringify(g) !== JSON.stringify(RETIRED_CODER_NO_MERGE_GUARD)
          );
          resolvedToolGuards = kept.length > 0 ? kept : undefined;
        } else {
          resolvedToolGuards = undefined;
        }
        const toolGuardsUnchanged =
          (resolvedToolGuards === undefined && agent.toolGuards === undefined) ||
          (resolvedToolGuards !== undefined &&
            agent.toolGuards !== undefined &&
            JSON.stringify(resolvedToolGuards) === JSON.stringify(agent.toolGuards));
        const templateEventInterests = templateAgent.eventInterests;
        const eventInterestsMatchesTemplate =
          templateEventInterests === undefined
            ? true
            : agent.eventInterests !== undefined &&
              JSON.stringify(agent.eventInterests) === JSON.stringify(templateEventInterests);
        return {
          ...agent,
          ...(toolGuardsUnchanged ? {} : { toolGuards: resolvedToolGuards }),
          ...(templateAgent.resetContextPerTurn === undefined
            ? {}
            : { resetContextPerTurn: templateAgent.resetContextPerTurn }),
          ...(eventInterestsMatchesTemplate ? {} : { eventInterests: templateEventInterests }),
          ...(finalPrompt?.value === agent.customPrompt?.value
            ? {}
            : { customPrompt: finalPrompt }),
        };
      }),
    };
  });

  return [...mergedExistingNodes, ...(missingTemplateNodes as WorkflowNode[])];
}

function nodeReferences(node: WorkflowNode): Set<string> {
  return new Set([
    node.id,
    node.name,
    ...node.agents.flatMap((agent) => [agent.name, agent.agentId, `${node.id}/${agent.name}`]),
  ]);
}

function remapTemplateChannelRef(
  ref: string,
  templateNodes: WorkflowNode[],
  existingNodes: WorkflowNode[]
): string {
  const templateNode = templateNodes.find((node) => nodeReferences(node).has(ref));
  if (!templateNode) return ref;

  const templateNodeIndex = templateNodes.findIndex((node) => node.id === templateNode.id);
  const existingNode =
    existingNodes.find((node) => node.id === templateNode.id) ??
    existingNodes.find((node) => node.name === templateNode.name) ??
    existingNodes.find((node) =>
      templateNode.agents.some((templateAgent) =>
        node.agents.some(
          (agent) =>
            (agent.name && agent.name === templateAgent.name) ||
            (!!agent.templateKey && agent.templateKey === templateAgent.templateKey) ||
            (!!agent.agentId && agent.agentId === templateAgent.agentId)
        )
      )
    ) ??
    (ref === templateNode.name &&
    templateNodeIndex >= 0 &&
    existingNodes.length === templateNodes.length
      ? existingNodes[templateNodeIndex]
      : undefined);
  return existingNode?.name ?? ref;
}

function remapTemplateChannel(
  channel: NonNullable<SpaceWorkflow['channels']>[number],
  templateNodes: WorkflowNode[],
  existingNodes: WorkflowNode[]
): NonNullable<SpaceWorkflow['channels']>[number] {
  const remapRef = (ref: string) => remapTemplateChannelRef(ref, templateNodes, existingNodes);
  return {
    ...channel,
    from: remapRef(channel.from),
    to: Array.isArray(channel.to) ? channel.to.map(remapRef) : remapRef(channel.to),
  };
}

function remapTransitionSlotTarget(
  target: string,
  templateNodes: WorkflowNode[],
  existingNodes: WorkflowNode[]
): string {
  const templateNode = templateNodes.find((n) => n.agents.some((a) => a.name === target));
  if (!templateNode) return target;
  const installedNodeName = remapTemplateChannelRef(
    templateNode.name,
    templateNodes,
    existingNodes
  );
  const installedNode =
    existingNodes.find((n) => n.name === installedNodeName) ??
    existingNodes.find((n) => n.id === templateNode.id);
  if (!installedNode) return target;
  if (installedNode.agents.some((a) => a.name === target)) return target;
  const slotIndex = templateNode.agents.findIndex((a) => a.name === target);
  const installedSlotName = slotIndex >= 0 ? installedNode.agents[slotIndex]?.name : undefined;
  return installedSlotName ?? target;
}

export function mergeChannelsFromTemplate(
  existingChannels: SpaceWorkflow['channels'],
  templateChannels: SpaceWorkflow['channels'],
  templateNodes: WorkflowNode[],
  existingNodes: WorkflowNode[]
): SpaceWorkflow['channels'] {
  if (!templateChannels) return existingChannels;
  const remappedTemplateChannels = templateChannels.map((channel) =>
    remapTemplateChannel(channel, templateNodes, existingNodes)
  );
  if (!existingChannels) return remappedTemplateChannels;

  const channelKey = (channel: NonNullable<SpaceWorkflow['channels']>[number]) => {
    const normalizedTo = Array.isArray(channel.to)
      ? channel.to.length === 1
        ? channel.to[0]
        : [...channel.to].sort()
      : channel.to;
    return JSON.stringify({
      from: channel.from,
      to: normalizedTo,
    });
  };

  const templateChannelByKey = new Map(
    remappedTemplateChannels.map((channel) => [channelKey(channel), channel])
  );

  const mergedExisting = existingChannels.map((channel) => {
    const templateChannel = templateChannelByKey.get(channelKey(channel));
    if (!templateChannel) return channel;
    return {
      ...channel,
      maxCycles: templateChannel.maxCycles,
      label: templateChannel.label,
    };
  });

  const mergedExistingKeys = new Set(mergedExisting.map(channelKey));
  const missingTemplateChannels = remappedTemplateChannels.filter(
    (channel) => !mergedExistingKeys.has(channelKey(channel))
  );

  return [...mergedExisting, ...missingTemplateChannels];
}

function remapTemplateHookAgentSlots(
  templateSourceNodeName: string,
  existingSourceNodeName: string,
  templateSlots: string[] | undefined,
  templateNodes: WorkflowNode[],
  existingNodes: WorkflowNode[]
): string[] | undefined {
  if (!templateSlots || templateSlots.length === 0) return undefined;

  const templateNode = templateNodes.find((node) => node.name === templateSourceNodeName);
  const existingNode = existingNodes.find((node) => node.name === existingSourceNodeName);
  if (!templateNode || !existingNode) return undefined;

  const existingAgentNames = new Set(
    existingNode.agents.map((agent) => agent.name).filter((name): name is string => !!name)
  );
  const mappedSlots: string[] = [];
  for (const slot of templateSlots) {
    if (existingAgentNames.has(slot)) {
      mappedSlots.push(slot);
      continue;
    }

    const templateSlotIndex = templateNode.agents.findIndex((agent) => agent.name === slot);
    const existingSlotName =
      templateSlotIndex >= 0 ? existingNode.agents[templateSlotIndex]?.name : undefined;
    if (existingSlotName) {
      mappedSlots.push(existingSlotName);
    }
  }

  return mappedSlots.length === templateSlots.length ? mappedSlots : undefined;
}

function remapTemplateHook(
  hook: NonNullable<SpaceWorkflow['hooks']>[number],
  templateNodes: WorkflowNode[],
  existingNodes: WorkflowNode[]
): NonNullable<SpaceWorkflow['hooks']>[number] {
  const remapRef = (ref: string) => remapTemplateChannelRef(ref, templateNodes, existingNodes);
  return {
    ...hook,
    sourceNode: remapRef(hook.sourceNode),
    targetNode: hook.targetNode ? remapRef(hook.targetNode) : hook.targetNode,
    authorizedCallers: hook.authorizedCallers?.map((caller) => {
      const sourceNode = remapRef(caller.sourceNode);
      const agentSlots = remapTemplateHookAgentSlots(
        caller.sourceNode,
        sourceNode,
        caller.agentSlots,
        templateNodes,
        existingNodes
      );
      if (agentSlots) return { ...caller, sourceNode, agentSlots };
      const { agentSlots: _agentSlots, ...callerWithoutSlots } = caller;
      return { ...callerWithoutSlots, sourceNode };
    }),
  };
}

function equivalentGeneratedHook(
  existingHook: NonNullable<SpaceWorkflow['hooks']>[number],
  templateHook: NonNullable<SpaceWorkflow['hooks']>[number]
): boolean {
  return (
    existingHook.method === templateHook.method &&
    existingHook.sourceNode === templateHook.sourceNode &&
    existingHook.targetNode === templateHook.targetNode &&
    existingHook.classification === templateHook.classification &&
    existingHook.validator.kind === 'script' &&
    templateHook.validator.kind === 'script' &&
    existingHook.validator.source === templateHook.validator.source &&
    JSON.stringify(existingHook.authorizedCallers ?? []) ===
      JSON.stringify(templateHook.authorizedCallers ?? [])
  );
}

export function mergeHooksFromTemplate(
  templateHooks: SpaceWorkflow['hooks'],
  templateNodes: WorkflowNode[],
  existingNodes: WorkflowNode[],
  existingHooks?: SpaceWorkflow['hooks']
): SpaceWorkflow['hooks'] {
  const remappedTemplateHooks =
    templateHooks?.map((hook) => remapTemplateHook(hook, templateNodes, existingNodes)) ?? [];
  if (!existingHooks || existingHooks.length === 0) return remappedTemplateHooks;

  const templateHookIds = new Set(remappedTemplateHooks.map((hook) => hook.id));
  const equivalentTemplateHooks = new Set(
    existingHooks
      .filter((existingHook) =>
        remappedTemplateHooks.some((templateHook) =>
          equivalentGeneratedHook(existingHook, templateHook)
        )
      )
      .map((hook) => hook.id)
  );
  return [
    ...existingHooks.filter(
      (hook) => !templateHookIds.has(hook.id) && !equivalentTemplateHooks.has(hook.id)
    ),
    ...remappedTemplateHooks,
  ];
}
