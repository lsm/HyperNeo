import type { SpaceWorkflow } from '@hyperneo/shared';
import { resolveNodeAgents } from '@hyperneo/shared';
import {
  listNodeArtifacts,
  type NodeArtifactContext,
  saveNodeArtifact,
} from '../../artifacts/node-artifacts.ts';
import type { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository.ts';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository.ts';
import { listAuditEntries } from '../../audit/list-audit-entries.ts';
import type { ExternalEventStore } from '../../external-events/external-event-store.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus.ts';
import type { SpaceGoalService } from '../../goals/service.ts';
import type { AgentMessageRouter } from '../../messaging/agent-message-router.ts';
import type { NodeMessagingContext } from '../../messaging/node-messaging-context.ts';
import { deliverNodeAgentMessage } from '../../messaging/node-send-message.ts';
import type { WorkflowArtifactProfile } from '../../workflows/artifact-profile.ts';
import type { ChannelResolver } from '../../messaging/channel-resolver.ts';
import { buildPrEventTopicPattern, parsePrUrl } from '../../github/parse-pr-url.ts';
import type { WorkflowHookEngine } from '../../workflows/hook-engine.ts';
import { wrapHandlerWithHooks } from '../../workflows/hook-engine.ts';
import type {
  CreateStandaloneTaskInput,
  ListArtifactsInput,
  ListAuditEntriesInput,
  ListPeersInput,
  ListSubscriptionsInput,
  SaveArtifactInput,
  SendMessageInput,
  SubscribeExternalEventInput,
  SubscribePrEventsInput,
  UnsubscribeExternalEventInput,
} from './node-agent-schemas.ts';
import type {
  ApproveTaskInput,
  MarkCompleteInput,
  SubmitForApprovalInput,
} from './task-agent-schemas.ts';
import type { ToolResult } from '../tools/tool-result.ts';
import { jsonResult } from '../tools/tool-result.ts';

function decodeToolResultPayload(result: ToolResult): Record<string, unknown> | null {
  try {
    const text = result.content?.[0]?.text;
    if (typeof text === 'string') {
      return JSON.parse(text) as Record<string, unknown>;
    }
  } catch {}
  return null;
}

export type { ToolResult };

export interface NodeAgentToolsConfig {
  mySessionId: string;
  myAgentName: string;
  myAgentNameAliases?: string[];
  taskId: string;
  spaceId: string;
  channelResolver: ChannelResolver;
  workflowRunId: string;
  workflowNodeId: string;
  nodeExecutionRepo: NodeExecutionRepository;
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>;
  agentMessageRouter: AgentMessageRouter;
  workflow: SpaceWorkflow | null;
  goalService?: Pick<SpaceGoalService, 'getGoal' | 'updateGoal'>;
  onApproveTask?: (args: ApproveTaskInput) => Promise<ToolResult>;
  onSubmitForApproval?: (args: SubmitForApprovalInput) => Promise<ToolResult>;
  onMarkComplete?: (args: MarkCompleteInput) => Promise<ToolResult>;
  onCreateStandaloneTask?: (args: CreateStandaloneTaskInput) => Promise<ToolResult>;
  onSubscribeExternalEvent?: (args: SubscribeExternalEventInput) => Promise<ToolResult>;
  onUnsubscribeExternalEvent?: (args: UnsubscribeExternalEventInput) => Promise<ToolResult>;
  onListSubscriptions?: (args: ListSubscriptionsInput) => Promise<ToolResult>;
  replyRoutingLookup?: (agentName?: string | null) => string | null;
  artifactRepo?: WorkflowRunArtifactRepository;
  artifactProfile?: WorkflowArtifactProfile;
  taskRepo?: SpaceTaskRepository;
  auditLogRepo?: McpAuditLogRepository;
  disableAuditLogWrites?: boolean;
  externalEventStore?: ExternalEventStore;
  onRestoreNodeAgent?: (args: { reason?: string }) => Promise<void> | void;
  hookEngine?: WorkflowHookEngine;
}

export function createNodeAgentToolHandlers(config: NodeAgentToolsConfig) {
  const {
    mySessionId,
    myAgentName,
    spaceId,
    channelResolver,
    workflowRunId,
    workflowNodeId,
    nodeExecutionRepo,
    agentMessageRouter,
    workflow,
  } = config;

  function logAudit(
    toolName: string,
    paramsSummary: Record<string, unknown>,
    taskId?: string
  ): void {
    if (config.auditLogRepo && !config.disableAuditLogWrites) {
      try {
        config.auditLogRepo.createEntry({
          agentName: myAgentName,
          sessionId: mySessionId,
          toolName,
          paramsSummary: JSON.stringify(paramsSummary),
          spaceId,
          taskId: taskId ?? config.taskId,
          workflowRunId,
        });
      } catch {}
    }
  }

  const nodeMessagingContext: NodeMessagingContext = {
    sessionId: mySessionId,
    agentName: myAgentName,
    workflowRunId,
    workflowNodeId,
    runtime: {
      spaceId,
      taskId: config.taskId,
      workflow,
      channelResolver,
      agentMessageRouter,
      artifactRepo: config.artifactRepo,
      replyRoutingLookup: config.replyRoutingLookup,
      hookEngine: config.hookEngine,
    },
  };

  const artifactContext: NodeArtifactContext = {
    artifactRepo: config.artifactRepo,
    workflowRunId,
    workflowNodeId,
    logAudit,
  };

  const handlers = {
    async list_peers(_args: ListPeersInput): Promise<ToolResult> {
      const resolver = channelResolver;

      const nodeExecs = workflowRunId
        ? nodeExecutionRepo.listByNode(workflowRunId, workflowNodeId)
        : [];

      let latestProgressSummary: string | null = null;
      if (config.artifactRepo && workflowRunId) {
        const noteArtifacts = config.artifactRepo.listByRun(workflowRunId, {
          nodeId: workflowNodeId,
          artifactType: 'note',
        });
        const pick =
          noteArtifacts.find((a) => a.artifactKey === 'current') ??
          noteArtifacts.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (pick) {
          const s = pick.data.text ?? pick.data.summary;
          latestProgressSummary = typeof s === 'string' ? s : null;
        }
      }

      const withinNodePeers = nodeExecs
        .filter(
          (ne) =>
            ne.agentSessionId !== mySessionId && (ne.agentSessionId != null || ne.status === 'idle')
        )
        .map((ne) => {
          const execStatus = ne.status;
          const memberStatus =
            execStatus === 'idle'
              ? ('completed' as const)
              : execStatus === 'blocked' || execStatus === 'cancelled'
                ? ('failed' as const)
                : ('active' as const);

          const completionSummary = latestProgressSummary ?? ne.result ?? null;

          return {
            sessionId: ne.agentSessionId ?? null,
            agentName: ne.agentName,
            agentId: ne.agentId ?? null,
            status: memberStatus,
            nodeName: null as string | null,
            completionState: {
              agentName: ne.agentName,
              taskStatus: ne.status,
              completionSummary,
              completedAt: ne.completedAt ?? null,
            },
          };
        });

      const nodeCompletionState = nodeExecs.map((ne) => {
        const completionSummary = latestProgressSummary ?? ne.result ?? null;
        return {
          agentName: ne.agentName,
          taskStatus: ne.status,
          completionSummary,
          completedAt: ne.completedAt ?? null,
        };
      });

      const myNodeName = workflow?.nodes.find((n) => n.id === workflowNodeId)?.name;
      const topologyTargetsRaw = [
        ...resolver.getPermittedTargets(myAgentName),
        ...(myNodeName && myNodeName !== myAgentName
          ? resolver.getPermittedTargets(myNodeName)
          : []),
      ];
      const topologyTargets = [...new Set(topologyTargetsRaw)];
      const crossNodePeers: Array<{
        sessionId: string | null;
        agentName: string;
        agentId: string | null;
        status: 'active' | 'completed' | 'failed' | 'not_started';
        nodeName: string | null;
        completionState: {
          agentName: string;
          taskStatus: string;
          completionSummary: string | null;
          completedAt: number | null;
        };
      }> = [];

      if (workflowRunId && topologyTargets.length > 0) {
        const allRunExecs = nodeExecutionRepo.listByWorkflowRun(workflowRunId);
        const execsByNode = new Map<string, typeof allRunExecs>();
        for (const exec of allRunExecs) {
          if (exec.workflowNodeId === workflowNodeId) continue;
          const arr = execsByNode.get(exec.workflowNodeId) ?? [];
          arr.push(exec);
          execsByNode.set(exec.workflowNodeId, arr);
        }

        const seenAgentNames = new Set<string>(withinNodePeers.map((p) => p.agentName));

        for (const targetNodeName of topologyTargets) {
          const targetNode = workflow?.nodes.find((n) => n.name === targetNodeName);
          const targetNodeId = targetNode?.id;
          const targetExecs = targetNodeId ? (execsByNode.get(targetNodeId) ?? []) : [];

          if (targetExecs.length === 0) {
            let agentNames: string[] = [];
            if (targetNode) {
              try {
                agentNames = resolveNodeAgents(targetNode).map((a) => a.name);
              } catch {
                agentNames = [targetNodeName];
              }
            } else {
              agentNames = [targetNodeName];
            }

            for (const agentName of agentNames) {
              if (seenAgentNames.has(agentName)) continue;
              seenAgentNames.add(agentName);
              crossNodePeers.push({
                sessionId: null,
                agentName,
                agentId: null,
                status: 'not_started' as const,
                nodeName: targetNodeName,
                completionState: {
                  agentName,
                  taskStatus: 'not_started',
                  completionSummary: null,
                  completedAt: null,
                },
              });
            }
          } else {
            for (const ne of targetExecs) {
              if (seenAgentNames.has(ne.agentName)) continue;
              seenAgentNames.add(ne.agentName);
              const execStatus = ne.status;
              const memberStatus =
                execStatus === 'idle'
                  ? ('completed' as const)
                  : execStatus === 'blocked' || execStatus === 'cancelled'
                    ? ('failed' as const)
                    : execStatus === 'pending'
                      ? ('not_started' as const)
                      : ('active' as const);
              crossNodePeers.push({
                sessionId: ne.agentSessionId ?? null,
                agentName: ne.agentName,
                agentId: ne.agentId ?? null,
                status: memberStatus,
                nodeName: targetNodeName,
                completionState: {
                  agentName: ne.agentName,
                  taskStatus: ne.status,
                  completionSummary: ne.result ?? null,
                  completedAt: ne.completedAt ?? null,
                },
              });
            }
          }
        }
      }

      const peers = [...withinNodePeers, ...crossNodePeers];
      const permittedTargetSet = new Set<string>([
        ...topologyTargets,
        ...crossNodePeers.map((p) => p.agentName),
      ]);
      const replyToSessionId = config.replyRoutingLookup?.(myAgentName);
      const permittedTargets = replyToSessionId
        ? [...permittedTargetSet, `@session:${replyToSessionId}`]
        : [...permittedTargetSet];
      const channelTopologyDeclared = !resolver.isEmpty();

      return jsonResult({
        success: true,
        myAgentName,
        peers,
        nodeCompletionState,
        permittedTargets,
        channelTopologyDeclared,
        message:
          `Found ${peers.length} peer(s). ` +
          `Permitted direct targets via send_message: ${permittedTargets.join(', ')}.`,
      });
    },

    async send_message(args: SendMessageInput): Promise<ToolResult> {
      return deliverNodeAgentMessage(nodeMessagingContext, nodeExecutionRepo)(args);
    },

    async save_artifact(args: SaveArtifactInput): Promise<ToolResult> {
      return saveNodeArtifact(artifactContext, args);
    },

    async list_artifacts(args: ListArtifactsInput): Promise<ToolResult> {
      return listNodeArtifacts(artifactContext, args);
    },

    async subscribe_pr_events(args: SubscribePrEventsInput): Promise<ToolResult> {
      if (!config.onSubscribeExternalEvent) {
        return jsonResult({
          success: false,
          error: 'External event subscriptions are not available.',
        });
      }
      const prUrl =
        args.prUrl || config.artifactProfile?.resolvePrimaryLinkUrl(workflowRunId) || '';
      const parsed = prUrl ? parsePrUrl(prUrl) : null;
      if (!parsed) {
        return jsonResult({
          success: false,
          error: args.prUrl
            ? `Could not parse GitHub PR URL: ${args.prUrl}`
            : 'No PR URL found for this workflow run. Open a PR first or pass prUrl explicitly.',
        });
      }
      const topicPattern = buildPrEventTopicPattern(parsed);
      const result = await config.onSubscribeExternalEvent({ topicPattern, label: args.label });
      const payload = decodeToolResultPayload(result);
      if (payload?.success) {
        logAudit('subscribe_pr_events', { prUrl, topicPattern, label: args.label });
      }
      return result;
    },

    async list_audit_entries(args: ListAuditEntriesInput): Promise<ToolResult> {
      return listAuditEntries({ auditLogRepo: config.auditLogRepo, spaceId }, args);
    },
  };

  if (config.hookEngine) {
    const meta = {
      sessionId: mySessionId,
      agentName: myAgentName,
      nodeId: workflowNodeId,
      taskId: config.taskId,
    };

    const handlerMap = handlers as unknown as Record<
      string,
      (...args: unknown[]) => Promise<ToolResult>
    >;
    const wrap = <T extends Record<string, unknown>>(
      methodName: string,
      handler: (args: T) => Promise<ToolResult>
    ) => wrapHandlerWithHooks(methodName, handler, config.hookEngine, handlerMap, meta);

    config.hookEngine.scheduleQueuedRetryableActions(handlerMap, meta);

    handlers.send_message = wrap('send_message', handlers.send_message);
    handlers.save_artifact = wrap('save_artifact', handlers.save_artifact);
  }

  return handlers;
}
