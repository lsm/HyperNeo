/**
 * Utility functions for WorkflowNode agent resolution and channel validation.
 *
 * Design principles:
 * - Channels are node-to-node (from/to = WorkflowNode.name), always one-way.
 * - A bidirectional relationship is two separate WorkflowChannel entries.
 * - There is no intermediate "ResolvedChannel" layer — WorkflowChannel is the
 *   routing unit at both the schema and runtime levels.
 * - Gate writer authorization is node-level: any agent in the FROM node may
 *   write to a gate attached to that channel. No slot-label matching needed.
 */

import type {
  SpaceWorkerAgent,
  SpaceTaskStatus,
  SpaceWorkflow,
  WorkflowChannel,
  WorkflowNode,
  WorkflowNodeAgent,
  WorkflowRunStatus,
} from './space.ts';

// ============================================================================
// resolveNodeAgents
// ============================================================================

/**
 * Resolves the concrete agent list for a workflow node.
 *
 * Returns the node's `agents` array directly. Throws when `agents` is empty.
 *
 * @param node - The workflow node to resolve agents for.
 * @returns Non-empty array of `WorkflowNodeAgent` records for this node.
 * @throws {Error} When `agents` is empty or not provided.
 */
export function resolveNodeAgents(node: WorkflowNode): WorkflowNodeAgent[] {
  if (node.agents && node.agents.length > 0) {
    return node.agents;
  }

  // Backward compatibility: if `agentId` shorthand is present on the node object
  // (legacy test code and call-sites), synthesize a single-agent array.
  const legacyRecord = node as unknown as Record<string, unknown>;
  const legacyAgentId = legacyRecord['agentId'] as string | undefined;
  if (legacyAgentId) {
    return [{ agentId: legacyAgentId, name: node.name }];
  }

  throw new Error(
    `WorkflowNode "${node.name}" (id: ${node.id}) has no agents defined. ` +
      'At least one agent must be provided.'
  );
}

// ============================================================================
// Workflow-run execution status helpers
// ============================================================================

const WORKFLOW_RUN_EXECUTION_STATUS_LABELS: Record<WorkflowRunStatus | 'failed', string> = {
  pending: 'Queued',
  in_progress: 'Running',
  blocked: 'Waiting',
  done: 'Succeeded',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

/**
 * Returns the user-facing execution-attempt label for a persisted workflow-run
 * status. Persisted values intentionally remain unchanged (`done` still means a
 * succeeded run in storage).
 */
export function getWorkflowRunExecutionStatusLabel(status: WorkflowRunStatus | 'failed'): string {
  return WORKFLOW_RUN_EXECUTION_STATUS_LABELS[status];
}

/** Returns true when a workflow-run execution attempt succeeded. */
export function isWorkflowRunSucceeded(status: WorkflowRunStatus | 'failed'): status is 'done' {
  return status === 'done';
}

/**
 * Returns true when a workflow-run execution attempt is no longer actively
 * running. `blocked` is included because the run is waiting for external
 * intervention before it can continue.
 */
export function isWorkflowRunTerminal(status: WorkflowRunStatus | 'failed'): boolean {
  return status === 'done' || status === 'cancelled' || status === 'blocked' || status === 'failed';
}

/** Returns true when a workflow-run execution attempt is waiting on intervention. */
export function isWorkflowRunWaiting(status: WorkflowRunStatus | 'failed'): status is 'blocked' {
  return status === 'blocked';
}

// ============================================================================
// Space task workflow recovery transitions
// ============================================================================

/**
 * Returns true when a task status change should recover the linked workflow run
 * instead of updating only the task row.
 */
export function isWorkflowRecoveryTransition(
  from: SpaceTaskStatus,
  to: SpaceTaskStatus
): to is 'open' | 'in_progress' {
  return (
    (from === 'done' && to === 'in_progress') ||
    (from === 'blocked' && (to === 'open' || to === 'in_progress')) ||
    (from === 'cancelled' && (to === 'open' || to === 'in_progress'))
  );
}

// ============================================================================
// findNodeByName
// ============================================================================

/**
 * Finds a workflow node by its name. Returns undefined when not found.
 */
export function findNodeByName(nodes: WorkflowNode[], name: string): WorkflowNode | undefined {
  return nodes.find((n) => n.name === name);
}

// ============================================================================
// getChannelFromNode / getChannelToNodes
// ============================================================================

/**
 * Returns all channels whose FROM side matches the given node name.
 */
export function getChannelsFromNode(
  channels: WorkflowChannel[],
  nodeName: string
): WorkflowChannel[] {
  return channels.filter((ch) => ch.from === nodeName || ch.from === '*');
}

/**
 * Returns all channels that go TO the given node name.
 */
export function getChannelsToNode(
  channels: WorkflowChannel[],
  nodeName: string
): WorkflowChannel[] {
  return channels.filter((ch) => {
    const toList = Array.isArray(ch.to) ? ch.to : [ch.to];
    return toList.includes(nodeName) || toList.includes('*');
  });
}

/**
 * Returns the first channel connecting fromNode → toNode (or toNode as an array target).
 */
export function findChannel(
  channels: WorkflowChannel[],
  fromNode: string,
  toNode: string
): WorkflowChannel | undefined {
  return channels.find((ch) => {
    if (ch.from !== fromNode && ch.from !== '*') return false;
    if (ch.to === toNode || ch.to === '*') return true;
    if (Array.isArray(ch.to)) return ch.to.includes(toNode) || ch.to.includes('*');
    return false;
  });
}

// ============================================================================
// validateChannels
// ============================================================================

/**
 * Validates all channel declarations in a workflow.
 *
 * Checks:
 * - All node agents have `agentId` values present in the provided `agents` list.
 * - All `WorkflowNode.name` values are unique within the workflow.
 * - All `WorkflowChannel.id` values are present (required).
 * - `from`/`to` reference valid node names (or the wildcard `'*'`).
 * - Each gate is referenced by at most one channel.
 * - No `'*'` mixed with explicit names in an array `to`.
 *
 * @param workflow - The workflow to validate.
 * @param agents   - All `SpaceWorkerAgent` records in the Space (used to verify agentId existence).
 * @returns Array of human-readable error strings. Empty array means no errors.
 */
export function validateChannels(workflow: SpaceWorkflow, agents: SpaceWorkerAgent[]): string[] {
  const errors: string[] = [];

  const agentIdSet = new Set(agents.map((a) => a.id));
  const knownNodeNames = new Set<string>();
  const seenNodeNames = new Set<string>();

  for (const node of workflow.nodes) {
    // Unique node name check
    if (seenNodeNames.has(node.name)) {
      errors.push(
        `Node name "${node.name}" appears more than once in this workflow. ` +
          'Node names must be unique within a workflow (they are used as channel addressing keys).'
      );
    } else {
      seenNodeNames.add(node.name);
      knownNodeNames.add(node.name);
    }

    let nodeAgents: WorkflowNodeAgent[];
    try {
      nodeAgents = resolveNodeAgents(node);
    } catch (err) {
      errors.push((err as Error).message);
      continue;
    }

    for (const na of nodeAgents) {
      if (!agentIdSet.has(na.agentId)) {
        errors.push(
          `Agent with id "${na.agentId}" in node "${node.name}" not found in space agents.`
        );
      }
    }
  }

  const channels = workflow.channels ?? [];

  // Check each gate is referenced by at most one channel
  const gateChannelCount = new Map<string, number>();
  for (const ch of channels) {
    if (ch.gateId) {
      gateChannelCount.set(ch.gateId, (gateChannelCount.get(ch.gateId) ?? 0) + 1);
    }
  }
  for (const [gateId, count] of gateChannelCount) {
    if (count > 1) {
      errors.push(
        `Gate "${gateId}" is referenced by ${count} channels. Each gate must belong to exactly one channel.`
      );
    }
  }

  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    const loc = `workflow.channels[${i}]`;

    // id is required
    if (!ch.id?.trim()) {
      errors.push(`${loc}: channel is missing a required id.`);
    }

    // from must be a known node name or '*'
    if (ch.from !== '*' && !knownNodeNames.has(ch.from)) {
      errors.push(
        `${loc}.from "${ch.from}" does not match any node name in this workflow. ` +
          `Known nodes: [${[...knownNodeNames].join(', ')}].`
      );
    }

    const toList: string[] = Array.isArray(ch.to) ? ch.to : [ch.to];

    // '*' must not be mixed with explicit names in an array
    if (toList.length > 1 && toList.includes('*')) {
      errors.push(
        `${loc}.to mixes wildcard '*' with explicit names. ` +
          "Use a plain '*' string (not an array) to target all nodes."
      );
    }

    for (const toRef of toList) {
      if (toRef === '*') continue;
      if (!knownNodeNames.has(toRef)) {
        errors.push(
          `${loc}.to "${toRef}" does not match any node name in this workflow. ` +
            `Known nodes: [${[...knownNodeNames].join(', ')}].`
        );
      }
    }
  }

  return errors;
}

// ============================================================================
// Gate writer authorization (node-level)
// ============================================================================

/**
 * Determines whether an agent in `agentNodeName` is authorized to write to a
 * gate field given the gate's `writers` list and the channel the gate belongs to.
 *
 * Authorization rules:
 * - `writers` absent (null/undefined) → authorized iff `agentNodeName === channel.from`
 * - `writers` is empty `[]`           → never authorized (external-only gate)
 * - `writers` includes `'*'`          → always authorized
 * - `writers` includes node names     → authorized iff `agentNodeName` is in the list
 *
 * @param agentNodeName - The name of the node this agent belongs to.
 * @param channel       - The channel the gate is attached to.
 * @param writers       - The `writers` array from the gate field definition.
 */
export function isGateWriterAuthorized(
  agentNodeName: string,
  channel: WorkflowChannel,
  writers: string[]
): boolean {
  if (!writers) {
    // Inferred: FROM node agents can write
    return agentNodeName === channel.from;
  }
  if (writers.length === 0) return false; // external-only gate
  if (writers.includes('*')) return true;
  return writers.includes(agentNodeName);
}
