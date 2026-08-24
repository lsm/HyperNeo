import { formatAddress, type ParsedAddress } from '../../../../../messaging/src/address.ts';

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

export interface AgentMessageResult {
  success: boolean | 'partial';
  delivered: Array<{ agentName: string; sessionId: string }>;
  failed: Array<{ agentName: string; sessionId: string; error: string }>;
  reason?: string;
  unauthorizedAgentNames?: string[];
  permittedTargets?: string[];
  notFoundAgentNames?: string[];
  queued?: Array<{ agentName: string; messageId: string }>;
  rateLimited?: boolean;
  retryAfterMs?: number;
}

export interface FoldAgentMessageResultInput {
  delivered: Array<{ agentName: string; sessionId: string }>;
  queued: Array<{ agentName: string; messageId: string }>;
  failed: Array<{ agentName: string; sessionId: string; error: string }>;
  notFound: string[];
}

export function foldAgentMessageResult(input: FoldAgentMessageResultInput): AgentMessageResult {
  const { delivered, queued, failed, notFound } = input;
  if (notFound.length > 0 && delivered.length === 0 && failed.length === 0) {
    return {
      success: false,
      delivered: [],
      failed: [],
      reason:
        `Could not deliver message to target agent(s): ${notFound.join(', ')}. ` +
        `The target is declared but no live session received the message.`,
      queued: queued.length > 0 ? queued : undefined,
      notFoundAgentNames: notFound,
    };
  }
  if (delivered.length === 0 && queued.length === 0 && failed.length > 0) {
    return {
      success: false,
      delivered,
      failed,
      notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
    };
  }
  return {
    success: failed.length > 0 ? 'partial' : true,
    delivered,
    failed,
    queued: queued.length > 0 ? queued : undefined,
    notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
  };
}

export interface DeclaredOrActivatedInput {
  activatedTargets: ReadonlySet<string>;
  declaredAgentNames: ReadonlySet<string> | string[];
  permittedTargets: string[];
  resolveNodeName: (slotOrNode: string) => string;
}

export type NodeTargetDeliveryDecision =
  | 'deliverToSpaceAgent'
  | 'injectLiveSessions'
  | 'queueForActivation'
  | 'activatedWithoutQueue'
  | 'notFound';

export interface NodeTargetDeliverySnapshot extends DeclaredOrActivatedInput {
  isSpaceAgent: boolean;
  hasLiveSessions: boolean;
  queueCapable: boolean;
}

export function isDeclaredOrActivatedTarget(
  agentName: string,
  input: DeclaredOrActivatedInput
): boolean {
  return (
    input.activatedTargets.has(agentName) ||
    new Set(input.declaredAgentNames).has(agentName) ||
    input.permittedTargets.some(
      (n) =>
        n === agentName ||
        input.resolveNodeName(n) === agentName ||
        n === input.resolveNodeName(agentName)
    )
  );
}

export function decideNodeTargetDelivery(
  agentName: string,
  snapshot: NodeTargetDeliverySnapshot
): NodeTargetDeliveryDecision {
  if (snapshot.isSpaceAgent) return 'deliverToSpaceAgent';
  if (snapshot.hasLiveSessions) return 'injectLiveSessions';
  if (isDeclaredOrActivatedTarget(agentName, snapshot) && snapshot.queueCapable) {
    return 'queueForActivation';
  }
  if (snapshot.activatedTargets.has(agentName)) return 'activatedWithoutQueue';
  return 'notFound';
}

export interface GenericAddressRoutingConfig {
  spaceAgentAvailable: boolean;
  messagingFacadeAvailable: boolean;
  replyToSessionId: string | null;
  workflowRunId: string;
}

export type GenericAddressRoutingDecision =
  | { action: 'deliverToCoordinator' }
  | { action: 'deliverToSession'; sessionId: string; replyAuthorized: true }
  | { action: 'failSessionUnauthorized'; target: string }
  | { action: 'deliverViaMessagingFacade' }
  | { action: 'failUnsupported'; target: string }
  | { action: 'deliverToWorker'; nodeName: string; agentName: string }
  | { action: 'failInvalidWorker'; target: string; reason: string }
  | { action: 'failUnsupportedKind'; target: string }
  | { action: 'notFound'; target: string };

export function decideGenericAddressRouting(
  address: ParsedAddress,
  config: GenericAddressRoutingConfig
): GenericAddressRoutingDecision {
  const target = formatAddress(address);
  if (address.kind === 'handle' && address.handle === 'coordinator') {
    return config.spaceAgentAvailable
      ? { action: 'deliverToCoordinator' }
      : { action: 'notFound', target };
  }
  if (address.kind === 'session') {
    if (!config.spaceAgentAvailable) return { action: 'notFound', target };
    if (config.replyToSessionId === null || address.sessionId !== config.replyToSessionId) {
      return { action: 'failSessionUnauthorized', target };
    }
    return { action: 'deliverToSession', sessionId: address.sessionId, replyAuthorized: true };
  }
  if (address.kind === 'handle' || address.kind === 'role') {
    return config.messagingFacadeAvailable
      ? { action: 'deliverViaMessagingFacade' }
      : { action: 'failUnsupported', target };
  }
  if (address.kind !== 'worker') {
    return { action: 'failUnsupportedKind', target };
  }
  const runId = address.workflowRunId ?? config.workflowRunId;
  if (runId !== config.workflowRunId) {
    return { action: 'notFound', target };
  }
  try {
    const nodeName = decodeURIComponent(address.nodeId);
    const agentName = address.agentName ? decodeURIComponent(address.agentName) : null;
    if (!agentName) {
      return { action: 'notFound', target };
    }
    return { action: 'deliverToWorker', nodeName, agentName };
  } catch (err) {
    return {
      action: 'failInvalidWorker',
      target,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
