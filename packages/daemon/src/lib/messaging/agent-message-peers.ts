import { Logger } from '../logger.ts';
import type { AgentMessageRouterConfig } from './agent-message-router.ts';

const log = new Logger('agent-message-router');

export function gatherEnrichedPeers(
  config: AgentMessageRouterConfig,
  fromAgentName: string,
  fromSessionId: string,
  fromNodeName: string
): {
  singleNodeByAgentName: Map<string, string>;
  peers: Array<{
    sessionId: string;
    agentName: string;
    workflowNodeId?: string;
    nodeName?: string;
  }>;
} {
  const { nodeExecutionRepo, workflowRunId, workflowNodeNameById, nodeGroups } = config;
  const selfExecution = nodeExecutionRepo
    .listByWorkflowRun(workflowRunId)
    .find((e) => e.agentName === fromAgentName && e.agentSessionId === fromSessionId);
  const singleNodeByAgentName = new Map<string, string>();
  for (const [nodeName, slots] of nodeGroups ? Object.entries(nodeGroups) : []) {
    for (const slot of slots) {
      if (singleNodeByAgentName.has(slot)) {
        singleNodeByAgentName.delete(slot);
      } else {
        singleNodeByAgentName.set(slot, nodeName);
      }
    }
  }
  const peers = nodeExecutionRepo
    .listByWorkflowRun(workflowRunId)
    .filter((e) => e.agentSessionId && e.agentSessionId !== fromSessionId)
    .map((e) => ({
      sessionId: e.agentSessionId!,
      agentName: e.agentName,
      workflowNodeId: e.workflowNodeId,
      nodeName:
        workflowNodeNameById?.[e.workflowNodeId] ??
        (e.workflowNodeId === selfExecution?.workflowNodeId ? fromNodeName : undefined) ??
        singleNodeByAgentName.get(e.agentName) ??
        e.workflowNodeId,
    }));
  return { singleNodeByAgentName, peers };
}

export function gatherPeerSnapshot(
  config: AgentMessageRouterConfig,
  fromAgentName: string,
  fromSessionId: string
): {
  peers: Array<{ sessionId: string; agentName: string; workflowNodeId?: string }>;
  declaredAgentNames: Set<string>;
} {
  const { nodeExecutionRepo, workflowRunId, nodeGroups } = config;
  const allExecutions = nodeExecutionRepo.listByWorkflowRun(workflowRunId);
  const execWithSession = allExecutions.filter(
    (e) => e.agentSessionId && e.agentSessionId !== fromSessionId
  );
  if (execWithSession.length === 0 && allExecutions.length > 0) {
    log.warn(
      `[AgentMessageRouter] nodeExecutionRepo has ${allExecutions.length} execution(s) for run ${workflowRunId} ` +
        `but none have an agentSessionId yet — will attempt activation/queuing.`
    );
  }
  let peers: Array<{ sessionId: string; agentName: string; workflowNodeId?: string }> =
    execWithSession.map((e) => ({
      sessionId: e.agentSessionId!,
      agentName: e.agentName,
      workflowNodeId: e.workflowNodeId,
    }));

  const postApprovalSessionId = config.findPostApprovalSessionId?.();
  const postApprovalTargetAgent = config.findPostApprovalTargetAgentName?.();
  if (
    postApprovalSessionId &&
    postApprovalTargetAgent &&
    postApprovalSessionId !== fromSessionId &&
    postApprovalTargetAgent !== fromAgentName
  ) {
    if (!peers.some((p) => p.sessionId === postApprovalSessionId)) {
      peers = peers.filter(
        (p) => !(p.agentName === postApprovalTargetAgent && p.sessionId !== postApprovalSessionId)
      );
      peers.push({ sessionId: postApprovalSessionId, agentName: postApprovalTargetAgent });
    }
  }

  const declaredAgentNames = new Set(
    allExecutions.filter((e) => e.agentSessionId !== fromSessionId).map((e) => e.agentName)
  );
  if (nodeGroups) {
    for (const slots of Object.values(nodeGroups)) {
      for (const slot of slots) {
        if (slot === fromAgentName) continue;
        declaredAgentNames.add(slot);
      }
    }
  }
  return { peers, declaredAgentNames };
}
