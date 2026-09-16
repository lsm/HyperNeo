import type { NodeExecution, SpaceWorkflow } from '@hyperneo/shared';
import { resolveNodeAgents } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import {
  admitNodeCaller,
  nodeName,
  type NodeMessagingContext,
  type NodeMessagingDependencies,
  type NodeMessagingRuntime,
  NodeContextRejectionSchema,
  resolveNodeContext,
} from './node-messaging-context.ts';

const inputSchema = z.object({}).strict();

type Input = z.infer<typeof inputSchema>;

const CompletionStateSchema = z.object({
  agentName: z.string(),
  taskStatus: z.string(),
  completionSummary: z.string().nullable(),
  completedAt: z.number().nullable(),
});

const PeerSchema = z.object({
  sessionId: z.string().nullable(),
  agentName: z.string(),
  agentId: z.string().nullable(),
  status: z.enum(['active', 'completed', 'failed', 'not_started']),
  nodeName: z.string().nullable(),
  completionState: CompletionStateSchema,
});

const PeersPageSchema = z.object({
  myAgentName: z.string(),
  peers: z.array(PeerSchema),
  nodeCompletionState: z.array(CompletionStateSchema),
  permittedTargets: z.array(z.string()),
  channelTopologyDeclared: z.boolean(),
  message: z.string(),
});

const resultSchema = z.union([PeersPageSchema, NodeContextRejectionSchema]);

type Result = z.infer<typeof resultSchema>;
type Peer = z.infer<typeof PeerSchema>;
type PeerStatus = Peer['status'];

export function selectLatestProgressSummary(
  runtime: NodeMessagingRuntime,
  workflowRunId: string,
  workflowNodeId: string
): string | null {
  if (!runtime.artifactRepo || !workflowRunId) return null;
  const notes = runtime.artifactRepo.listByRun(workflowRunId, {
    nodeId: workflowNodeId,
    artifactType: 'note',
  });
  const pick =
    notes.find((note) => note.artifactKey === 'current') ??
    notes.slice().sort((left, right) => right.updatedAt - left.updatedAt)[0];
  if (!pick) return null;
  const summary = pick.data.text ?? pick.data.summary;
  return typeof summary === 'string' ? summary : null;
}

export function foldMemberStatus(status: NodeExecution['status']): PeerStatus {
  if (status === 'idle') return 'completed';
  return status === 'blocked' || status === 'cancelled' ? 'failed' : 'active';
}

export function foldCrossNodeStatus(status: NodeExecution['status']): PeerStatus {
  return status === 'pending' ? 'not_started' : foldMemberStatus(status);
}

export function selectWithinNodePeers(
  executions: readonly NodeExecution[],
  mySessionId: string,
  latestProgressSummary: string | null
): Peer[] {
  return executions
    .filter(
      (execution) =>
        execution.agentSessionId !== mySessionId &&
        (execution.agentSessionId != null || execution.status === 'idle')
    )
    .map((execution) => ({
      sessionId: execution.agentSessionId ?? null,
      agentName: execution.agentName,
      agentId: execution.agentId ?? null,
      status: foldMemberStatus(execution.status),
      nodeName: null,
      completionState: {
        agentName: execution.agentName,
        taskStatus: execution.status,
        completionSummary: latestProgressSummary ?? execution.result ?? null,
        completedAt: execution.completedAt ?? null,
      },
    }));
}

export function selectTopologyTargets(
  runtime: NodeMessagingRuntime,
  myAgentName: string,
  myNodeName: string | undefined
): string[] {
  return [
    ...new Set([
      ...runtime.channelResolver.getPermittedTargets(myAgentName),
      ...(myNodeName && myNodeName !== myAgentName
        ? runtime.channelResolver.getPermittedTargets(myNodeName)
        : []),
    ]),
  ];
}

function declaredAgentNames(
  workflow: SpaceWorkflow | null,
  targetNodeName: string
): { agentNames: string[]; nodeId: string | undefined } {
  const targetNode = workflow?.nodes.find((node) => node.name === targetNodeName);
  if (!targetNode) return { agentNames: [targetNodeName], nodeId: undefined };
  try {
    return {
      agentNames: resolveNodeAgents(targetNode).map((agent) => agent.name),
      nodeId: targetNode.id,
    };
  } catch {
    return { agentNames: [targetNodeName], nodeId: targetNode.id };
  }
}

export function selectCrossNodePeers(
  runtime: NodeMessagingRuntime,
  executionsInRun: readonly NodeExecution[],
  workflowNodeId: string,
  topologyTargets: readonly string[],
  seededAgentNames: readonly string[]
): Peer[] {
  const executionsByNode = new Map<string, NodeExecution[]>();
  for (const execution of executionsInRun) {
    if (execution.workflowNodeId === workflowNodeId) continue;
    const bucket = executionsByNode.get(execution.workflowNodeId) ?? [];
    bucket.push(execution);
    executionsByNode.set(execution.workflowNodeId, bucket);
  }

  const seen = new Set<string>(seededAgentNames);
  const peers: Peer[] = [];
  for (const targetNodeName of topologyTargets) {
    const declared = declaredAgentNames(runtime.workflow, targetNodeName);
    const executions = declared.nodeId ? (executionsByNode.get(declared.nodeId) ?? []) : [];
    if (executions.length === 0) {
      for (const agentName of declared.agentNames) {
        if (seen.has(agentName)) continue;
        seen.add(agentName);
        peers.push({
          sessionId: null,
          agentName,
          agentId: null,
          status: 'not_started',
          nodeName: targetNodeName,
          completionState: {
            agentName,
            taskStatus: 'not_started',
            completionSummary: null,
            completedAt: null,
          },
        });
      }
      continue;
    }
    for (const execution of executions) {
      if (seen.has(execution.agentName)) continue;
      seen.add(execution.agentName);
      peers.push({
        sessionId: execution.agentSessionId ?? null,
        agentName: execution.agentName,
        agentId: execution.agentId ?? null,
        status: foldCrossNodeStatus(execution.status),
        nodeName: targetNodeName,
        completionState: {
          agentName: execution.agentName,
          taskStatus: execution.status,
          completionSummary: execution.result ?? null,
          completedAt: execution.completedAt ?? null,
        },
      });
    }
  }
  return peers;
}

export function listNodePeers(
  context: NodeMessagingContext,
  deps: NodeMessagingDependencies
): Result {
  const { runtime, workflowRunId, workflowNodeId, agentName, sessionId } = context;
  const executions = workflowRunId
    ? deps.nodeExecutionRepo.listByNode(workflowRunId, workflowNodeId)
    : [];
  const latestProgressSummary = selectLatestProgressSummary(runtime, workflowRunId, workflowNodeId);
  const withinNodePeers = selectWithinNodePeers(executions, sessionId, latestProgressSummary);
  const nodeCompletionState = executions.map((execution) => ({
    agentName: execution.agentName,
    taskStatus: execution.status,
    completionSummary: latestProgressSummary ?? execution.result ?? null,
    completedAt: execution.completedAt ?? null,
  }));

  const topologyTargets = selectTopologyTargets(
    runtime,
    agentName,
    nodeName(runtime, workflowNodeId)
  );
  const crossNodePeers =
    workflowRunId && topologyTargets.length > 0
      ? selectCrossNodePeers(
          runtime,
          deps.nodeExecutionRepo.listByWorkflowRun(workflowRunId),
          workflowNodeId,
          topologyTargets,
          withinNodePeers.map((peer) => peer.agentName)
        )
      : [];

  const peers = [...withinNodePeers, ...crossNodePeers];
  const permittedTargetSet = new Set<string>([
    ...topologyTargets,
    ...crossNodePeers.map((peer) => peer.agentName),
  ]);
  const replyToSessionId = runtime.replyRoutingLookup?.(agentName);
  const permittedTargets = replyToSessionId
    ? [...permittedTargetSet, `@session:${replyToSessionId}`]
    : [...permittedTargetSet];

  return {
    myAgentName: agentName,
    peers,
    nodeCompletionState,
    permittedTargets,
    channelTopologyDeclared: !runtime.channelResolver.isEmpty(),
    message:
      `Found ${peers.length} peer(s). ` +
      `Permitted direct targets via send_message: ${permittedTargets.join(', ')}.`,
  };
}

const LIST_PEERS_DESCRIPTION =
  'List node-group peers with statuses, session ids, permitted direct-message targets, and saved output state. The calling node-agent session identifies the workflow run and node; only workflow worker sessions are admitted. Rejects not_a_node_agent when the caller is not a live node-agent session and node_caller_denied when the caller is not a workflow worker or belongs to another Space.';

export function createListNodePeersOperation(deps: NodeMessagingDependencies) {
  const run = (superpipe({ deps })('list-node-peers') as PipelineAPI)
    .input(['caller'])
    .pipe(admitNodeCaller, 'caller', 'result:outcome')
    .pipe(resolveNodeContext, ['outcome', 'caller', 'deps'], 'result:outcome')
    .pipe(listNodePeers, ['outcome', 'deps'], 'outcome')
    .endAsync('outcome') as (caller: OperationCaller) => Promise<Result>;
  return defineOperation({
    name: 'node.peers.list',
    policy: { safetyClass: 'read', roles: ['workflow_worker'] },
    description: LIST_PEERS_DESCRIPTION,
    inputSchema,
    resultSchema,
    execute: (_input: Input, caller) => run(caller),
  });
}
