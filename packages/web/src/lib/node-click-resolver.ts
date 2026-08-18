import type { NodeExecution, SpaceTaskActivityMember } from '@hyperneo/shared';

export interface NodeLiveSession {
  kind: 'live';
  sessionId: string;
  agentName: string;
  nodeExecutionId?: string;
  label: string;
}

export interface NodePendingSlot {
  kind: 'pending';
  agentName: string;
  label: string;
  nodeId: string;
}

export type NodeChoice = NodeLiveSession | NodePendingSlot;

export type NodeClickOutcome =
  | { type: 'open_session'; session: NodeLiveSession; taskId: string }
  | {
      type: 'activate_slot';
      taskId: string;
      agentName: string;
      nodeId: string;
    }
  | { type: 'choose'; choices: NodeChoice[] }
  | { type: 'empty'; nodeName: string };

export interface ResolveNodeClickArgs {
  taskId: string;
  nodeId: string;
  nodeName: string;
  agentSlotNames: string[];
  workflowRunId: string | null | undefined;
  nodeExecutions: NodeExecution[];
  activityMembers: SpaceTaskActivityMember[];
  postApprovalSessionId?: string | null;
  postApprovalTargetAgent?: string | null;
  postApprovalNodeId?: string | null;
  resolveLabel: (agentName: string) => string;
  normalizeSlotName?: (name: string) => string;
}

export function normalizeSlotName(name: string): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/(?:\s+agent)+$/, '')
    .replace(/[\s_-]+/g, '');
}

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

  const slotOrder = new Map<string, number>();
  agentSlotNames.forEach((name, index) => {
    const key = normalize(name);
    if (!slotOrder.has(key)) slotOrder.set(key, index);
  });
  const isDeclaredSlot = (name: string) => slotOrder.has(normalize(name));
  const declaredSlotNamesExact = new Set(agentSlotNames);

  const liveBySession = new Map<string, NodeLiveSession>();
  const sessionByExecId = new Map<string, string | null>();

  if (workflowRunId) {
    for (const exec of nodeExecutions) {
      if (exec.workflowRunId !== workflowRunId) continue;
      if (exec.workflowNodeId !== nodeId) continue;
      if (!declaredSlotNamesExact.has(exec.agentName)) continue;
      if (!exec.agentSessionId || exec.status === 'cancelled' || exec.status === 'pending') {
        if (exec.id) sessionByExecId.set(exec.id, null);
        continue;
      }
      if (exec.id) sessionByExecId.set(exec.id, exec.agentSessionId);
      liveBySession.set(exec.agentSessionId, {
        kind: 'live',
        sessionId: exec.agentSessionId,
        agentName: exec.agentName,
        nodeExecutionId: exec.id,
        label: resolveLabel(exec.agentName),
      });
    }
  }

  for (const member of activityMembers) {
    if (member.kind !== 'node_agent' || !member.sessionId) continue;
    if (member.nodeExecution?.status === 'cancelled' || member.nodeExecution?.status === 'pending')
      continue;
    const execNodeId = member.nodeExecution?.nodeId;
    if (!execNodeId || execNodeId !== nodeId) continue;
    const slotName = member.nodeExecution?.agentName ?? member.role;
    const slotDeclared = member.nodeExecution?.agentName
      ? declaredSlotNamesExact.has(member.nodeExecution.agentName)
      : isDeclaredSlot(slotName);
    if (!slotDeclared) continue;
    const memberExecId = member.nodeExecution?.nodeExecutionId;
    if (memberExecId) {
      const authoritative = sessionByExecId.get(memberExecId);
      if (authoritative !== undefined && authoritative !== member.sessionId) continue;
    }
    const existing = liveBySession.get(member.sessionId);
    if (existing) {
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

  if (
    postApprovalSessionId &&
    postApprovalTargetAgent &&
    (postApprovalNodeId ? nodeId === postApprovalNodeId : isDeclaredSlot(postApprovalTargetAgent))
  ) {
    for (const [sid, entry] of liveBySession) {
      if (sid === postApprovalSessionId) continue;
      if (entry.agentName === postApprovalTargetAgent) {
        liveBySession.delete(sid);
      }
    }
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

  const liveSlotNames = new Set(live.map((s) => s.agentName));
  const unstartedSlots = agentSlotNames.filter((n) => !liveSlotNames.has(n));

  if (live.length === 1 && unstartedSlots.length === 0) {
    return { type: 'open_session', session: live[0], taskId };
  }
  if (live.length > 0) {
    const pendingChoices: NodePendingSlot[] = unstartedSlots.map((name) => ({
      kind: 'pending',
      agentName: name,
      label: resolveLabel(name),
      nodeId,
    }));
    return { type: 'choose', choices: [...live, ...pendingChoices] };
  }

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
