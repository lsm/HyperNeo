import type { NodeExecution, WorkflowChannel } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import {
  admitNodeCaller,
  nodeName,
  type NodeMessagingContext,
  type NodeMessagingDependencies,
  NodeContextRejectionSchema,
  resolveNodeContext,
} from './node-messaging-context.ts';

const inputSchema = z.object({}).strict();

type Input = z.infer<typeof inputSchema>;

const PeerStatusSchema = z.enum(['active', 'completed', 'failed']);

const ReachableAgentsSchema = z.object({
  myAgentName: z.string(),
  myNodeName: z.string(),
  withinNodePeers: z.array(z.object({ agentName: z.string(), status: PeerStatusSchema })),
  crossNodeTargets: z.array(z.object({ nodeName: z.string() })),
  reachabilityDeclared: z.boolean(),
  message: z.string(),
});

const resultSchema = z.union([ReachableAgentsSchema, NodeContextRejectionSchema]);

type Result = z.infer<typeof resultSchema>;

type WithinNodePeer = { agentName: string; status: z.infer<typeof PeerStatusSchema> };

export function foldPeerStatus(status: NodeExecution['status']): WithinNodePeer['status'] {
  if (status === 'idle') return 'completed';
  return status === 'blocked' || status === 'cancelled' ? 'failed' : 'active';
}

export function selectWithinNodePeers(
  executions: readonly NodeExecution[],
  mySessionId: string
): WithinNodePeer[] {
  return executions
    .filter((execution) => execution.agentSessionId !== mySessionId)
    .map((execution) => ({
      agentName: execution.agentName,
      status: foldPeerStatus(execution.status),
    }));
}

export function selectCrossNodeTargets(
  channels: readonly WorkflowChannel[],
  myNodeName: string,
  myAgentName: string,
  withinNodeAgentNames: ReadonlySet<string>
): Array<{ nodeName: string }> {
  const seen = new Set<string>();
  const targets: Array<{ nodeName: string }> = [];
  for (const channel of channels) {
    if (channel.from !== myNodeName && channel.from !== myAgentName && channel.from !== '*') {
      continue;
    }
    for (const toNode of Array.isArray(channel.to) ? channel.to : [channel.to]) {
      if (toNode === myNodeName || toNode === myAgentName) continue;
      if (seen.has(toNode) || withinNodeAgentNames.has(toNode)) continue;
      seen.add(toNode);
      targets.push({ nodeName: toNode });
    }
  }
  return targets;
}

export function listNodeReachableAgents(
  context: NodeMessagingContext,
  deps: NodeMessagingDependencies
): Result {
  const { runtime, workflowRunId, workflowNodeId, agentName, sessionId } = context;
  const myNodeName = nodeName(runtime, workflowNodeId) ?? agentName;
  const executions = workflowRunId
    ? deps.nodeExecutionRepo.listByNode(workflowRunId, workflowNodeId)
    : [];
  const withinNodePeers = selectWithinNodePeers(executions, sessionId);
  const declared = runtime.channelResolver.getChannels();
  const channels = declared.length > 0 ? declared : (runtime.workflow?.channels ?? []);
  const reachabilityDeclared = channels.length > 0;
  const crossNodeTargets =
    reachabilityDeclared && myNodeName
      ? selectCrossNodeTargets(
          channels,
          myNodeName,
          agentName,
          new Set([agentName, ...executions.map((execution) => execution.agentName)])
        )
      : [];

  const totalReachable = withinNodePeers.length + crossNodeTargets.length;
  const crossNodeSummary =
    crossNodeTargets.length > 0
      ? ` Cross-node targets: ${crossNodeTargets.map((target) => target.nodeName).join(', ')}.`
      : '';
  return {
    myAgentName: agentName,
    myNodeName,
    withinNodePeers,
    crossNodeTargets,
    reachabilityDeclared,
    message:
      `You can reach ${totalReachable} target(s). ` +
      `Within-node peers: ${withinNodePeers.length > 0 ? withinNodePeers.map((peer) => peer.agentName).join(', ') : 'none'}.` +
      crossNodeSummary,
  };
}

const LIST_REACHABLE_AGENTS_DESCRIPTION =
  'List within-node peers and cross-node targets reachable over declared channels. The calling node-agent session identifies the workflow run and node; only workflow worker sessions are admitted. Rejects not_a_node_agent when the caller is not a live node-agent session and node_caller_denied when the caller is not a workflow worker or belongs to another Space.';

export function createListNodeReachableAgentsOperation(deps: NodeMessagingDependencies) {
  const run = (superpipe({ deps })('list-node-reachable-agents') as PipelineAPI)
    .input(['caller'])
    .pipe(admitNodeCaller, 'caller', 'result:outcome')
    .pipe(resolveNodeContext, ['outcome', 'caller', 'deps'], 'result:outcome')
    .pipe(listNodeReachableAgents, ['outcome', 'deps'], 'outcome')
    .endAsync('outcome') as (caller: OperationCaller) => Promise<Result>;
  return defineOperation({
    name: 'node.reachableAgents.list',
    policy: { safetyClass: 'read', roles: ['workflow_worker'] },
    description: LIST_REACHABLE_AGENTS_DESCRIPTION,
    inputSchema,
    resultSchema,
    execute: (_input: Input, caller) => run(caller),
  });
}
