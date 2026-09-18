import type { SpaceWorkflow } from '@hyperneo/shared';
import { z } from 'zod';
import type { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository.ts';
import type { WorkflowRunArtifactRepository } from '../../storage/repositories/workflow-run-artifact-repository.ts';
import type { HookEngine } from '../hooks/hook-engine.ts';
import type { OperationCaller } from '../operations/registry.ts';
import type { AgentMessageRouter } from './agent-message-router.ts';
import type { ChannelResolver } from './channel-resolver.ts';

export interface NodeMessagingRuntime {
  readonly spaceId: string;
  readonly taskId: string;
  readonly workflow: SpaceWorkflow | null;
  readonly channelResolver: ChannelResolver;
  readonly agentMessageRouter: Pick<AgentMessageRouter, 'deliverMessage'>;
  readonly artifactRepo?: Pick<WorkflowRunArtifactRepository, 'listByRun'>;
  readonly replyRoutingLookup?: (agentName?: string | null) => string | null;
  readonly hookEngine?: HookEngine;
}

export type NodeMessagingRuntimeLookup = (sessionId: string) => NodeMessagingRuntime | null;

export interface NodeMessagingSessionRow {
  readonly status: string;
}

export interface NodeMessagingDependencies {
  readonly nodeExecutionRepo: Pick<
    NodeExecutionRepository,
    'getByAgentSessionId' | 'listByNode' | 'listByWorkflowRun'
  >;
  readonly runtimeForSession: NodeMessagingRuntimeLookup;
  readonly getSession?: (sessionId: string) => NodeMessagingSessionRow | null;
}

export const NODE_CONTEXT_REJECTIONS = ['not_a_node_agent', 'node_caller_denied'] as const;

export const NodeContextRejectionSchema = z.enum(NODE_CONTEXT_REJECTIONS);

export type NodeContextRejection = (typeof NODE_CONTEXT_REJECTIONS)[number];

export interface NodeMessagingContext {
  readonly sessionId: string;
  readonly agentName: string;
  readonly workflowRunId: string;
  readonly workflowNodeId: string;
  readonly runtime: NodeMessagingRuntime;
}

export function admitNodeCaller(
  caller: OperationCaller
): { value: string } | { reason: NodeContextRejection } {
  if (caller.source === 'mcp' && caller.role !== 'workflow_worker') {
    return { reason: 'node_caller_denied' };
  }
  return caller.sessionId ? { value: caller.sessionId } : { reason: 'not_a_node_agent' };
}

export function resolveNodeContext(
  sessionId: string,
  caller: OperationCaller,
  deps: NodeMessagingDependencies
): { value: NodeMessagingContext } | { reason: NodeContextRejection } {
  const execution = deps.nodeExecutionRepo.getByAgentSessionId(sessionId);
  if (!execution) return { reason: 'not_a_node_agent' };
  const runtime = deps.runtimeForSession(sessionId);
  if (!runtime) return { reason: 'not_a_node_agent' };
  if (caller.spaceId !== undefined && caller.spaceId !== runtime.spaceId) {
    return { reason: 'node_caller_denied' };
  }
  return {
    value: {
      sessionId,
      agentName: execution.agentName,
      workflowRunId: execution.workflowRunId,
      workflowNodeId: execution.workflowNodeId,
      runtime,
    },
  };
}

export function requireActiveNodeSession(
  context: NodeMessagingContext,
  caller: OperationCaller,
  deps: NodeMessagingDependencies
): { value: NodeMessagingContext } | { reason: NodeContextRejection } {
  if (caller.source !== 'mcp') return { value: context };
  const session = deps.getSession?.(context.sessionId) ?? null;
  return session?.status === 'active' ? { value: context } : { reason: 'node_caller_denied' };
}

export function nodeName(
  runtime: NodeMessagingRuntime,
  workflowNodeId: string
): string | undefined {
  return runtime.workflow?.nodes.find((node) => node.id === workflowNodeId)?.name;
}
