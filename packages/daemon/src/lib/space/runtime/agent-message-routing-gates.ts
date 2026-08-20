export interface ResolveNodeAgentTargetsInput {
  target: string | string[];
  fromAgentName: string;
  fromNodeName: string;
  peerAgentNames: string[];
  nodeGroups?: Record<string, string[]>;
  declaredAgentNames: Set<string> | string[];
  permittedTargets: string[];
  spaceAgentAvailable: boolean;
  canSend: (fromNode: string, toNode: string) => boolean;
}

export type ResolveNodeAgentTargetsOutcome =
  | { status: 'resolved'; targetAgentNames: string[] }
  | { status: 'noPermittedTargets'; reason: string }
  | { status: 'unknownTarget'; target: string; allTargets: string[]; reason: string }
  | {
      status: 'unauthorized';
      unauthorized: string[];
      permittedTargets: string[];
      reason: string;
    };

export function buildSlotToNodeMap(nodeGroups?: Record<string, string[]>): Map<string, string> {
  const slotToNode = new Map<string, string>();
  if (nodeGroups) {
    for (const [nodeName, slots] of Object.entries(nodeGroups)) {
      for (const slot of slots) {
        slotToNode.set(slot, nodeName);
      }
    }
  }
  return slotToNode;
}

export function buildNodeNameResolver(
  slotToNode: Map<string, string>
): (slotOrNode: string) => string {
  return (slotOrNode) => slotToNode.get(slotOrNode) ?? slotOrNode;
}

export function resolveNodeAgentTargets(
  input: ResolveNodeAgentTargetsInput
): ResolveNodeAgentTargetsOutcome {
  const { target, fromAgentName, fromNodeName, peerAgentNames, permittedTargets } = input;
  const nodeGroups = input.nodeGroups;
  const declaredAgentNames = new Set(input.declaredAgentNames);
  const resolveNodeName = buildNodeNameResolver(buildSlotToNodeMap(nodeGroups));

  let targetAgentNames: string[];

  if (target === '*') {
    if (permittedTargets.length === 0) {
      return {
        status: 'noPermittedTargets',
        reason: `No permitted targets for agent '${fromAgentName}' in the declared channel topology.`,
      };
    }
    targetAgentNames = [...permittedTargets];
  } else if (Array.isArray(target)) {
    targetAgentNames = [...target];
  } else if (target === 'space-agent' && input.spaceAgentAvailable) {
    targetAgentNames = ['space-agent'];
  } else if (peerAgentNames.includes(target)) {
    targetAgentNames = [target];
  } else if (nodeGroups && nodeGroups[target]) {
    targetAgentNames = [...nodeGroups[target]];
  } else if (declaredAgentNames.has(target)) {
    targetAgentNames = [target];
  } else {
    const isTopologyDeclared =
      permittedTargets.includes(target) ||
      permittedTargets.some((n) => resolveNodeName(n) === target);
    if (isTopologyDeclared) {
      targetAgentNames = [target];
    } else {
      const knownAgentNames = [...new Set(peerAgentNames)].sort();
      const nodeNames = nodeGroups ? Object.keys(nodeGroups) : [];
      const allTargets = [
        ...new Set([...knownAgentNames, ...nodeNames, ...declaredAgentNames]),
      ].sort();
      if (input.spaceAgentAvailable) allTargets.push('space-agent');
      return {
        status: 'unknownTarget',
        target,
        allTargets,
        reason:
          `Unknown target '${target}': no agent or node found with this name. ` +
          (allTargets.length > 0
            ? `Reachable targets: ${allTargets.join(', ')}.`
            : 'No reachable targets available.'),
      };
    }
  }

  const topologyTargets = targetAgentNames.filter((r) => r !== 'space-agent');
  const unauthorized = topologyTargets.filter(
    (r) => !input.canSend(fromNodeName, resolveNodeName(r))
  );
  if (unauthorized.length > 0) {
    return {
      status: 'unauthorized',
      unauthorized,
      permittedTargets: [...permittedTargets],
      reason:
        `Channel topology does not permit '${fromAgentName}' to send to: ${unauthorized.join(', ')}. ` +
        `Permitted targets: ${permittedTargets.length > 0 ? permittedTargets.join(', ') : 'none'}.`,
    };
  }

  return { status: 'resolved', targetAgentNames };
}
