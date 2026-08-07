/**
 * Identity-safe resolution for workflow-graph node clicks.
 *
 * A canvas node click supplies the persisted workflow node ID, the node name,
 * and the declared agent slot names for that node. This module resolves that
 * click to a concrete UI action WITHOUT ever falling back to another node's
 * session — the root cause of the bug where clicking an unstarted downstream
 * node opened a previously-active node's chat.
 *
 * Identity is resolved strictly from the clicked node ID + declared agent slot,
 * cross-checked against two independent runtime sources (the nodeExecutions
 * store and the reactive activity members), plus the task-level post-approval
 * session for spawned merger nodes.
 *
 * The function is pure (no signal/store access) so the branching logic is
 * unit-testable in isolation; SpaceTaskPane wires it to live data.
 */

import type { NodeExecution, SpaceTaskActivityMember } from '@hyperneo/shared';

/** A live, resolvable agent session belonging to the clicked node. */
export interface NodeLiveSession {
  kind: 'live';
  sessionId: string;
  /** Agent slot name (`WorkflowNodeAgent.name`). */
  agentName: string;
  /** node_execution id for routing sends, when known. */
  nodeExecutionId?: string;
  /** Human-readable label for the choice/overlay header. */
  label: string;
}

/** A declared agent slot that has not spawned a session yet. */
export interface NodePendingSlot {
  kind: 'pending';
  agentName: string;
  label: string;
  /** Persisted workflow node ID — carried into activation so the backend
   * targets this exact node when multiple nodes reuse the slot name. */
  nodeId: string;
}

export type NodeChoice = NodeLiveSession | NodePendingSlot;

export type NodeClickOutcome =
  | { type: 'open_session'; session: NodeLiveSession; taskId: string }
  | {
      type: 'activate_slot';
      taskId: string;
      agentName: string;
      /** Persisted workflow node ID for the unstarted slot (see NodePendingSlot). */
      nodeId: string;
    }
  | { type: 'choose'; choices: NodeChoice[] }
  | { type: 'empty'; nodeName: string };

export interface ResolveNodeClickArgs {
  taskId: string;
  nodeId: string;
  nodeName: string;
  /** Declared agent slot names for the clicked node (`WorkflowNodeAgent.name`). */
  agentSlotNames: string[];
  /** Run the task belongs to — scopes the nodeExecutions lookup. */
  workflowRunId: string | null | undefined;
  nodeExecutions: NodeExecution[];
  activityMembers: SpaceTaskActivityMember[];
  /**
   * `task.postApprovalSessionId` — the spawned merger/post-approval session.
   * Merger sessions carry no node_execution row, so their identity lives here.
   */
  postApprovalSessionId?: string | null;
  /**
   * Agent name the workflow's post-approval route targets (e.g. 'merger').
   * Only when the clicked node declares this slot do we open the merger session,
   * tying the persisted session to the correct node.
   */
  postApprovalTargetAgent?: string | null;
  /**
   * Persisted node ID that declares the post-approval target slot — i.e. the
   * node the merger session was spawned for. When provided, the merger session
   * is bound ONLY to this node, so multiple nodes reusing the target slot name
   * can't each open the singular postApprovalSessionId. Falls back to the
   * clicked-node-declares-the-slot check when unknown (older callers).
   */
  postApprovalNodeId?: string | null;
  /** Resolve a human label for an agent slot name. */
  resolveLabel: (agentName: string) => string;
  /** Normalize slot names for comparison. */
  normalizeSlotName?: (name: string) => string;
}

/**
 * Normalize an agent slot name for case/separator-insensitive comparison.
 * Mirrors SpaceTaskPane.normalizeTargetName so canvas-declared slot names and
 * runtime member roles match even when they differ in casing or spacing.
 */
export function normalizeSlotName(name: string): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/(?:\s+agent)+$/, '')
    .replace(/[\s_-]+/g, '');
}

/**
 * Resolve a clicked workflow node to a concrete action.
 *
 * Decision table:
 *   live sessions (node ID + slot match)
 *     ┌──────────┬──────────────────────────────┐
 *     │ exactly 1│ open_session                 │
 *     │   > 1    │ choose (multi-agent node)    │
 *     │   0      │ see unstarted branch below   │
 *     └──────────┴──────────────────────────────┘
 *   unstarted (0 live)
 *     ┌──────────────────┬────────────────────────────┐
 *     │ 0 declared slots │ empty (zero-agent node)    │
 *     │ 1 declared slot  │ activate_slot (own pending)│
 *     │ > 1 declared slot│ choose (which slot to start)│
 *     └──────────────────┴────────────────────────────┘
 *
 * A session qualifies only when BOTH its node ID and its slot name match the
 * clicked node. Members with an unknown node ID are skipped rather than
 * guessed, so rollout-era nullable identity can never fall back to another
 * node's session.
 */
export function resolveNodeClick(args: ResolveNodeClickArgs): NodeClickOutcome {
  const {
    taskId,
    nodeId,
    nodeName,
    agentSlotNames,
    workflowRunId,
    nodeExecutions,
    activityMembers,
    postApprovalSessionId,
    postApprovalTargetAgent,
    postApprovalNodeId,
    resolveLabel,
  } = args;
  const normalize = args.normalizeSlotName ?? normalizeSlotName;

  // Declared slots for this node, in declaration order — used both as a match
  // set and to order the resulting choices deterministically.
  const slotOrder = new Map<string, number>();
  agentSlotNames.forEach((name, index) => {
    const key = normalize(name);
    if (!slotOrder.has(key)) slotOrder.set(key, index);
  });
  const isDeclaredSlot = (name: string) => slotOrder.has(normalize(name));

  // ---- Collect live sessions for THIS node, deduped by sessionId ----------
  const liveBySession = new Map<string, NodeLiveSession>();

  // Source 1: nodeExecutions store — the authoritative node→session map for
  // the run. One row per (run, nodeId, agentName).
  if (workflowRunId) {
    for (const exec of nodeExecutions) {
      if (exec.workflowRunId !== workflowRunId) continue;
      if (exec.workflowNodeId !== nodeId) continue;
      if (!exec.agentSessionId) continue;
      if (!isDeclaredSlot(exec.agentName)) continue;
      liveBySession.set(exec.agentSessionId, {
        kind: 'live',
        sessionId: exec.agentSessionId,
        agentName: exec.agentName,
        nodeExecutionId: exec.id,
        label: resolveLabel(exec.agentName),
      });
    }
  }

  // Source 2: reactive activity members. These enrich labels and catch a
  // session that is live in memory but not yet reflected in the nodeExecutions
  // store. The node ID must match exactly; a member with no nodeExecution
  // identity cannot be tied to this node and is skipped (no guesswork).
  for (const member of activityMembers) {
    if (member.kind !== 'node_agent' || !member.sessionId) continue;
    const execNodeId = member.nodeExecution?.nodeId;
    if (!execNodeId || execNodeId !== nodeId) continue;
    const slotName = member.nodeExecution?.agentName ?? member.role;
    if (!isDeclaredSlot(slotName)) continue;
    const existing = liveBySession.get(member.sessionId);
    if (existing) {
      // Prefer the activity member's user-facing label when available.
      if (member.label) existing.label = member.label;
      if (member.nodeExecution?.nodeExecutionId && !existing.nodeExecutionId) {
        existing.nodeExecutionId = member.nodeExecution.nodeExecutionId;
      }
    } else {
      liveBySession.set(member.sessionId, {
        kind: 'live',
        sessionId: member.sessionId,
        agentName: slotName,
        nodeExecutionId: member.nodeExecution?.nodeExecutionId,
        label: member.label || resolveLabel(slotName),
      });
    }
  }

  // Source 3: spawned post-approval (merger) session. Merger sessions have no
  // node_execution row, so they never appear in the sources above. The backend
  // stamps their id on task.postApprovalSessionId; we open it only when the
  // clicked node IS the post-approval node. When postApprovalNodeId is known
  // (the node declaring the target slot), require an exact node-ID match so
  // multiple nodes reusing the target slot name can't each open the singular
  // merger session. Fall back to the clicked-node-declares-the-slot check only
  // when the target node ID is unknown.
  if (
    postApprovalSessionId &&
    postApprovalTargetAgent &&
    (postApprovalNodeId ? nodeId === postApprovalNodeId : isDeclaredSlot(postApprovalTargetAgent))
  ) {
    if (!liveBySession.has(postApprovalSessionId)) {
      liveBySession.set(postApprovalSessionId, {
        kind: 'live',
        sessionId: postApprovalSessionId,
        agentName: postApprovalTargetAgent,
        label: resolveLabel(postApprovalTargetAgent) || nodeName,
      });
    }
  }

  const live = [...liveBySession.values()].sort(
    (a, b) =>
      (slotOrder.get(normalize(a.agentName)) ?? 0) - (slotOrder.get(normalize(b.agentName)) ?? 0)
  );

  if (live.length === 1) {
    return { type: 'open_session', session: live[0], taskId };
  }
  if (live.length > 1) {
    return { type: 'choose', choices: live };
  }

  // ---- Unstarted node ----------------------------------------------------
  if (agentSlotNames.length === 0) {
    return { type: 'empty', nodeName };
  }
  if (agentSlotNames.length === 1) {
    return { type: 'activate_slot', taskId, agentName: agentSlotNames[0], nodeId };
  }
  return {
    type: 'choose',
    choices: agentSlotNames.map((name) => ({
      kind: 'pending' as const,
      agentName: name,
      label: resolveLabel(name),
      nodeId,
    })),
  };
}
