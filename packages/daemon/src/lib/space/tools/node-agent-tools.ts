import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus.ts';
import {
  ApproveTaskSchema,
  SubmitForApprovalSchema,
  MarkCompleteSchema,
} from './task-agent-tool-schemas.ts';
import type {
  ApproveTaskInput,
  SubmitForApprovalInput,
  MarkCompleteInput,
} from './task-agent-tool-schemas.ts';
import { Logger } from '../../logger.ts';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository.ts';
import { ChannelResolver } from '../runtime/channel-resolver.ts';
import type { AgentMessageRouter } from '../runtime/agent-message-router.ts';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository.ts';
import type { SpaceWorkflow } from '@hyperneo/shared';
import {
  ARTIFACT_SHAPES,
  deriveArtifactKey,
  normalizeLinkData,
  resolveNodeAgents,
  validateArtifactShape,
} from '@hyperneo/shared';
import { jsonResult } from './tool-result.ts';
import type { ToolResult } from './tool-result.ts';
import { instrumentTypedTelemetryAtMcpBoundary } from './mcp-typed-telemetry-boundary.ts';
import {
  ListPeersSchema,
  SendMessageSchema,
  SaveArtifactSchema,
  CreateStandaloneTaskSchema,
  ListArtifactsSchema,
  ListReachableAgentsSchema,
  ListChannelsSchema,
  RestoreNodeAgentSchema,
  ListTasksSchema,
  GetTaskSchema,
  ListAuditEntriesSchema,
  PublishTaskSchema,
  ArchiveTaskSchema,
  SubscribeExternalEventSchema,
  UnsubscribeExternalEventSchema,
  SubscribePrEventsSchema,
  GetExternalEventSchema,
  ListDeliveriesSchema,
  ListSubscriptionsSchema,
} from './node-agent-tool-schemas.ts';
import type {
  ListPeersInput,
  SendMessageInput,
  SaveArtifactInput,
  CreateStandaloneTaskInput,
  ListArtifactsInput,
  ListReachableAgentsInput,
  ListChannelsInput,
  RestoreNodeAgentInput,
  ListTasksInput,
  GetTaskInput,
  ListAuditEntriesInput,
  PublishTaskInput,
  ArchiveTaskInput,
  SubscribeExternalEventInput,
  UnsubscribeExternalEventInput,
  SubscribePrEventsInput,
  GetExternalEventInput,
  ListDeliveriesInput,
  ListSubscriptionsInput,
} from './node-agent-tool-schemas.ts';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import type { SpaceTask } from '@hyperneo/shared';
import type { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import type { ExternalEventStore } from '../../external-events/external-event-store.ts';
import { translateLegacyNodeTargets } from '../messaging-adapter.ts';
import { buildPrEventTopicPattern, parsePrUrl } from '../runtime/parse-pr-url.ts';
import type { WorkflowArtifactProfile } from '../runtime/artifact-profile.ts';
import type { WorkflowHookEngine } from '../runtime/workflow-hook-engine.ts';
import { wrapHandlerWithHooks } from '../runtime/workflow-hook-engine.ts';

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

const log = new Logger('node-agent-tools');

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
  onApproveTask?: (args: ApproveTaskInput) => Promise<ToolResult>;
  onSubmitForApproval?: (args: SubmitForApprovalInput) => Promise<ToolResult>;
  onMarkComplete?: (args: MarkCompleteInput) => Promise<ToolResult>;
  onCreateStandaloneTask?: (args: CreateStandaloneTaskInput) => Promise<ToolResult>;
  onSubscribeExternalEvent?: (args: SubscribeExternalEventInput) => Promise<ToolResult>;
  onUnsubscribeExternalEvent?: (args: UnsubscribeExternalEventInput) => Promise<ToolResult>;
  onListSubscriptions?: (args: ListSubscriptionsInput) => Promise<ToolResult>;
  onPublishTask?: (args: PublishTaskInput) => Promise<ToolResult>;
  onArchiveTask?: (args: ArchiveTaskInput) => Promise<ToolResult>;
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
      const permittedTargets = [...permittedTargetSet, 'space-agent'];
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
          `Permitted direct targets via send_message: ${permittedTargets.join(', ')}. ` +
          `Use "space-agent" to escalate blockers or request human/space-level judgment.`,
      });
    },

    async send_message(args: SendMessageInput): Promise<ToolResult> {
      const { target, message, data } = args;
      let translatedTargets: string[] = [];
      if (workflow) {
        try {
          translatedTargets = translateLegacyNodeTargets(target, {
            spaceId,
            workflowRunId,
            workflowNodeId,
            agentName: myAgentName,
            workflow,
            actors: nodeExecutionRepo.listByWorkflowRun(workflowRunId).map((execution) => ({
              actorId: `worker:${[workflowRunId, execution.workflowNodeId, execution.agentName].map(encodeURIComponent).join(':')}`,
              kind: 'worker' as const,
              spaceId,
              status: execution.agentSessionId ? ('active' as const) : ('inactive' as const),
            })),
            replyRoutingLookup: config.replyRoutingLookup,
          });
        } catch (err) {
          return jsonResult({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const routedTarget =
        translatedTargets.length > 0
          ? translatedTargets.length === 1
            ? translatedTargets[0]
            : translatedTargets
          : target;
      const result = await agentMessageRouter.deliverMessage({
        fromAgentName: myAgentName,
        fromSessionId: mySessionId,
        target: routedTarget,
        message,
        data,
      });

      if (!result.success) {
        const reason = result.reason ?? 'Message delivery failed.';
        return jsonResult({
          success: false,
          error: reason,
          delivered: result.delivered.length > 0 ? result.delivered : undefined,
          failed: result.failed.length > 0 ? result.failed : undefined,
          queued: result.queued,
          unauthorizedAgentNames: result.unauthorizedAgentNames,
          permittedTargets: result.permittedTargets,
          notFoundAgentNames: result.notFoundAgentNames,
        });
      }

      if (result.success === 'partial') {
        const summaryParts: string[] = [];
        if (result.delivered.length > 0) {
          summaryParts.push(
            `delivered to ${result.delivered.length} peer(s): ` +
              result.delivered.map((t) => t.agentName).join(', ')
          );
        }
        if (result.queued && result.queued.length > 0) {
          summaryParts.push(
            `queued for ${result.queued.length} peer(s): ` +
              result.queued.map((t) => t.agentName).join(', ')
          );
        }
        if (result.failed.length > 0) {
          summaryParts.push(`failed for ${result.failed.length} peer(s)`);
        }
        if (result.notFoundAgentNames && result.notFoundAgentNames.length > 0) {
          summaryParts.push(`not found: ${result.notFoundAgentNames.join(', ')}`);
        }
        return jsonResult({
          success: 'partial',
          delivered: result.delivered,
          failed: result.failed,
          queued: result.queued,
          notFoundAgentNames: result.notFoundAgentNames,
          ...(result.unauthorizedAgentNames
            ? { unauthorizedAgentNames: result.unauthorizedAgentNames }
            : {}),
          ...(result.permittedTargets ? { permittedTargets: result.permittedTargets } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
          message:
            `Message ${summaryParts.join('; ')}.` +
            (result.reason ? ` Reason: ${result.reason}` : ''),
        });
      }

      const summaryParts: string[] = [];
      if (result.delivered.length > 0) {
        summaryParts.push(
          `delivered to ${result.delivered.length} peer(s): ` +
            result.delivered.map((t) => `${t.agentName} (${t.sessionId})`).join(', ')
        );
      }
      if (result.queued && result.queued.length > 0) {
        summaryParts.push(
          `queued for delivery to ${result.queued.length} peer(s): ` +
            result.queued.map((t) => t.agentName).join(', ')
        );
      }

      return jsonResult({
        success: true,
        delivered: result.delivered,
        queued: result.queued,
        notFoundAgentNames: result.notFoundAgentNames,
        message: summaryParts.length > 0 ? `Message ${summaryParts.join('; ')}.` : 'No action.',
      });
    },

    async list_reachable_agents(_args: ListReachableAgentsInput): Promise<ToolResult> {
      const myNode = workflow?.nodes.find((n) => n.id === workflowNodeId);
      const myNodeName = myNode?.name ?? myAgentName;

      const nodeExecs = workflowRunId
        ? nodeExecutionRepo.listByNode(workflowRunId, workflowNodeId)
        : [];
      const withinNodePeers = nodeExecs
        .filter((e) => e.agentSessionId !== mySessionId)
        .map((e) => {
          const ts = e.status;
          return {
            agentName: e.agentName,
            status:
              ts === 'idle'
                ? ('completed' as const)
                : ts === 'blocked' || ts === 'cancelled'
                  ? ('failed' as const)
                  : ('active' as const),
          };
        });

      const channels =
        channelResolver.getChannels().length > 0
          ? channelResolver.getChannels()
          : (workflow?.channels ?? []);
      const reachabilityDeclared = channels.length > 0;

      type CrossNodeTarget = {
        nodeName: string;
      };
      const crossNodeTargets: CrossNodeTarget[] = [];

      if (reachabilityDeclared && myNodeName) {
        const seen = new Set<string>();

        const withinNodeAgentNames = new Set([myAgentName, ...nodeExecs.map((e) => e.agentName)]);

        for (const ch of channels) {
          if (ch.from !== myNodeName && ch.from !== myAgentName && ch.from !== '*') continue;
          const tos = Array.isArray(ch.to) ? ch.to : [ch.to];
          for (const toNode of tos) {
            if (toNode === myNodeName || toNode === myAgentName) continue;
            if (seen.has(toNode)) continue;
            if (withinNodeAgentNames.has(toNode)) continue;
            seen.add(toNode);
            crossNodeTargets.push({ nodeName: toNode });
          }
        }
      }

      const totalReachable = withinNodePeers.length + crossNodeTargets.length;
      const crossNodeSummary =
        crossNodeTargets.length > 0
          ? ` Cross-node targets: ${crossNodeTargets.map((t) => t.nodeName).join(', ')}.`
          : '';

      return jsonResult({
        success: true,
        myAgentName,
        myNodeName,
        withinNodePeers,
        crossNodeTargets,
        spaceAgent: {
          target: 'space-agent',
          description: 'Space-level escalation target. Use to request human/space-level judgment.',
        },
        reachabilityDeclared,
        message:
          `You can reach ${totalReachable} target(s) plus the space-agent escalation target. ` +
          `Within-node peers: ${withinNodePeers.length > 0 ? withinNodePeers.map((p) => p.agentName).join(', ') : 'none'}.` +
          crossNodeSummary +
          ` Use target 'space-agent' to escalate blockers or request human/space-level judgment.`,
      });
    },

    async list_channels(_args: ListChannelsInput): Promise<ToolResult> {
      const channels = workflow?.channels ?? [];
      const result = channels.map((ch) => ({
        channelId: ch.id ?? null,
        from: ch.from,
        to: ch.to,
        maxCycles: ch.maxCycles ?? null,
        label: ch.label ?? null,
      }));
      return jsonResult({
        success: true,
        channels: result,
        total: result.length,
        message: `Found ${result.length} channel(s) in workflow "${workflow?.name ?? 'unknown'}".`,
      });
    },

    async save_artifact(args: SaveArtifactInput): Promise<ToolResult> {
      const { artifactRepo } = config;
      if (!artifactRepo) {
        return jsonResult({ success: false, error: 'Artifact repository not available.' });
      }

      const { shape, kind, key: keyArg, summary, data } = args;

      if (!shape) {
        return jsonResult({
          success: false,
          error: `shape is required. Known shapes: ${ARTIFACT_SHAPES.join(', ')}.`,
        });
      }

      const artifactData: Record<string, unknown> = {};
      if (summary !== undefined) artifactData.summary = summary;
      if (data !== undefined) Object.assign(artifactData, data);
      if (kind !== undefined) artifactData.kind = kind;
      const normalized = shape === 'link' ? normalizeLinkData(artifactData) : artifactData;

      if (Object.keys(normalized).length === 0) {
        return jsonResult({
          success: false,
          error: 'At least one of `summary` or `data` must be provided.',
        });
      }

      const validation = validateArtifactShape(shape, normalized);
      if (!validation.ok) {
        return jsonResult({ success: false, error: validation.error });
      }

      try {
        const artifactKey = deriveArtifactKey(shape, normalized, keyArg);

        const record = artifactRepo.upsert({
          id: crypto.randomUUID(),
          runId: workflowRunId,
          nodeId: workflowNodeId,
          artifactType: shape,
          artifactKey,
          data: normalized,
        });

        logAudit('save_artifact', {
          shape,
          kind: kind ?? undefined,
          key: artifactKey,
          summary: summary ?? undefined,
          dataKeys: data ? Object.keys(data) : undefined,
        });

        return jsonResult({
          success: true,
          artifact: {
            id: record.id,
            runId: record.runId,
            nodeId: record.nodeId,
            shape: record.artifactType,
            key: record.artifactKey,
          },
          message: `Artifact "${shape}" saved (upsert).`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async list_artifacts(args: ListArtifactsInput): Promise<ToolResult> {
      const { artifactRepo } = config;
      if (!artifactRepo) {
        return jsonResult({ success: false, error: 'Artifact repository not available.' });
      }
      try {
        const artifacts = artifactRepo.listByRun(workflowRunId, {
          nodeId: args.nodeId,
          artifactType: args.type,
        });
        return jsonResult({
          success: true,
          artifacts: artifacts.map((a) => ({
            id: a.id,
            nodeId: a.nodeId,
            type: a.artifactType,
            key: a.artifactKey,
            data: a.data,
            createdAt: a.createdAt,
            updatedAt: a.updatedAt,
          })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async create_standalone_task(args: CreateStandaloneTaskInput): Promise<ToolResult> {
      if (!config.onCreateStandaloneTask) {
        return jsonResult({
          success: false,
          error: 'create_standalone_task is not available in this node-agent session.',
        });
      }
      const result = await config.onCreateStandaloneTask(args);
      const payload = decodeToolResultPayload(result);
      const createdTask = payload?.task as { id: string } | undefined;
      if (payload?.success && createdTask?.id) {
        logAudit(
          'create_standalone_task',
          {
            title: args.title,
            priority: args.priority,
            workflow_id: args.workflow_id,
            depends_on: args.depends_on,
            draft: args.draft,
          },
          createdTask.id
        );
      }
      return result;
    },

    async publish_task(args: PublishTaskInput): Promise<ToolResult> {
      if (!config.onPublishTask) {
        return jsonResult({
          success: false,
          error: 'publish_task is not available in this node-agent session.',
        });
      }
      const result = await config.onPublishTask(args);
      const payload = decodeToolResultPayload(result);
      if (payload?.success) {
        const publishedTask = payload?.task as { id: string } | undefined;
        logAudit('publish_task', { task_id: args.task_id }, publishedTask?.id);
      }
      return result;
    },

    async archive_task(args: ArchiveTaskInput): Promise<ToolResult> {
      if (!config.onArchiveTask) {
        return jsonResult({
          success: false,
          error: 'archive_task is not available in this node-agent session.',
        });
      }
      const result = await config.onArchiveTask(args);
      const payload = decodeToolResultPayload(result);
      if (payload?.success) {
        const archivedTask = payload?.task as { id: string } | undefined;
        logAudit('archive_task', { task_id: args.task_id }, archivedTask?.id);
      }
      return result;
    },

    async subscribe_external_event(args: SubscribeExternalEventInput): Promise<ToolResult> {
      if (!config.onSubscribeExternalEvent) {
        return jsonResult({
          success: false,
          error: 'External event subscriptions are not available.',
        });
      }
      const result = await config.onSubscribeExternalEvent(args);
      const payload = decodeToolResultPayload(result);
      if (payload?.success) {
        logAudit('subscribe_external_event', {
          topicPattern: args.topicPattern,
          label: args.label,
        });
      }
      return result;
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

    async unsubscribe_external_event(args: UnsubscribeExternalEventInput): Promise<ToolResult> {
      if (!config.onUnsubscribeExternalEvent) {
        return jsonResult({
          success: false,
          error: 'External event subscriptions are not available.',
        });
      }
      const result = await config.onUnsubscribeExternalEvent(args);
      const payload = decodeToolResultPayload(result);
      if (payload?.success) {
        logAudit('unsubscribe_external_event', { topicPattern: args.topicPattern });
      }
      return result;
    },

    async get_external_event(args: GetExternalEventInput): Promise<ToolResult> {
      const { externalEventStore } = config;
      if (!externalEventStore) {
        return jsonResult({
          success: false,
          error: 'External event lookup is not available.',
        });
      }
      const record = externalEventStore.getById(args.eventId);
      if (!record || record.event.spaceId !== spaceId) {
        return jsonResult({
          success: false,
          error: `External event not found: ${args.eventId}`,
        });
      }
      return jsonResult({ success: true, event: record.event, state: record.state });
    },

    async list_deliveries(args: ListDeliveriesInput): Promise<ToolResult> {
      const { externalEventStore } = config;
      if (!externalEventStore) {
        return jsonResult({
          success: false,
          error: 'External event delivery lookup is not available.',
        });
      }
      const limit = Math.min(args.limit ?? 50, 200);
      const offset = args.offset ?? 0;
      const records = externalEventStore.listDeliveryLog({
        spaceId,
        workflowRunId: args.workflowRunId ?? workflowRunId,
        nodeId: args.nodeId,
        status: args.state,
        limit,
        offset,
      });
      const deliveries = records.map((record) => ({
        eventId: record.eventId,
        deliveryKey: record.deliveryKey,
        workflowRunId: record.workflowRunId,
        taskId: record.taskId,
        nodeId: record.nodeId,
        agentName: record.agentName,
        state: record.state,
        failureReason: record.failureReason,
        deliveredAt: record.deliveredAt,
        updatedAt: record.updatedAt,
        event: {
          topic: record.event.topic,
          source: record.event.source,
          summary: record.event.summary,
          externalUrl: record.event.externalUrl ?? null,
          occurredAt: record.event.occurredAt,
          state: record.eventState,
        },
      }));
      return jsonResult({ success: true, deliveries });
    },

    async list_subscriptions(args: ListSubscriptionsInput): Promise<ToolResult> {
      if (!config.onListSubscriptions) {
        return jsonResult({
          success: false,
          error: 'Subscription diagnostics are not available.',
        });
      }
      return config.onListSubscriptions({
        workflowRunId: args.workflowRunId,
        nodeId: args.nodeId,
      });
    },

    async approve_task(args: ApproveTaskInput): Promise<ToolResult> {
      if (!config.onApproveTask) {
        return jsonResult({
          success: false,
          error: 'approve_task is not available in this node-agent session.',
        });
      }
      const result = await config.onApproveTask(args);
      const payload = decodeToolResultPayload(result);
      if (payload?.success) {
        logAudit('approve_task', {}, config.taskId);
      }
      return result;
    },

    async list_tasks(args: ListTasksInput): Promise<ToolResult> {
      const { taskRepo } = config;
      if (!taskRepo) {
        return jsonResult({ success: false, error: 'Task repository not available.' });
      }
      try {
        const limit = Math.min(args.limit ?? 20, 100);
        const offset = args.offset ?? 0;
        const total = taskRepo.countBySpace(spaceId, args.status ?? undefined, false);
        let tasks: SpaceTask[];
        if (args.status) {
          tasks = taskRepo.listByStatus(spaceId, args.status, limit, offset);
        } else {
          tasks = taskRepo.listBySpace(spaceId, false, limit, offset);
        }
        if (args.compact) {
          const compactTasks = tasks.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            priority: t.priority,
            createdAt: t.createdAt,
          }));
          return jsonResult({
            success: true,
            total,
            tasks: compactTasks,
            has_more: offset + tasks.length < total,
          });
        }
        return jsonResult({ success: true, total, tasks, has_more: offset + tasks.length < total });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async get_task(args: GetTaskInput): Promise<ToolResult> {
      const { taskRepo } = config;
      if (!taskRepo) {
        return jsonResult({ success: false, error: 'Task repository not available.' });
      }
      let task: SpaceTask | null = null;
      if (args.task_number !== undefined) {
        task = taskRepo.getTaskByNumber(spaceId, args.task_number);
      } else if (args.task_id) {
        task = taskRepo.getTask(args.task_id);
        if (task && task.spaceId !== spaceId) {
          task = null;
        }
      } else {
        return jsonResult({
          success: false,
          error: 'Either task_id or task_number is required',
        });
      }
      if (!task) {
        const ref = args.task_number !== undefined ? `#${args.task_number}` : args.task_id;
        return jsonResult({ success: false, error: `Task not found: ${ref}` });
      }
      return jsonResult({ success: true, task });
    },

    async list_audit_entries(args: ListAuditEntriesInput): Promise<ToolResult> {
      const { auditLogRepo } = config;
      if (!auditLogRepo) {
        return jsonResult({ success: false, error: 'Audit log repository not available.' });
      }
      try {
        const limit = Math.min(args.limit ?? 20, 100);
        const offset = args.offset ?? 0;
        let entries;
        let total: number;
        if (args.task_id) {
          entries = auditLogRepo.listByTaskAndSpace(args.task_id, spaceId, limit, offset);
          total = auditLogRepo.countByTaskAndSpace(args.task_id, spaceId);
        } else if (args.session_id) {
          entries = auditLogRepo.listBySessionAndSpace(args.session_id, spaceId, limit, offset);
          total = auditLogRepo.countBySessionAndSpace(args.session_id, spaceId);
        } else {
          entries = auditLogRepo.listBySpace(spaceId, limit, offset);
          total = auditLogRepo.countBySpace(spaceId);
        }
        return jsonResult({
          success: true,
          entries: entries.map((e) => ({
            id: e.id,
            timestamp: e.timestamp,
            agentName: e.agentName,
            sessionId: e.sessionId,
            toolName: e.toolName,
            paramsSummary: e.paramsSummary,
            spaceId: e.spaceId,
            taskId: e.taskId,
            workflowRunId: e.workflowRunId,
          })),
          total,
          has_more: offset + entries.length < total,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async restore_node_agent(args: RestoreNodeAgentInput): Promise<ToolResult> {
      const reason = args.reason?.trim();
      log.info(
        `node-agent.restore_node_agent invoked by session ${mySessionId} ` +
          `(agent=${myAgentName}, task=${config.taskId}, reason=${reason ?? '<unspecified>'})`
      );

      try {
        if (config.onRestoreNodeAgent) {
          await config.onRestoreNodeAgent({ reason });
        }
      } catch (err) {
        log.warn(
          `node-agent.restore_node_agent: server-side reattachment callback failed for session ${mySessionId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      return jsonResult({
        success: true,
        sessionId: mySessionId,
        agentName: myAgentName,
        message:
          'node-agent MCP server is registered for this session — the fact that this tool ' +
          'call succeeded proves it. If a previous mcp__node-agent__send_message call ' +
          'returned "No such tool available", retry it now.',
      });
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
    handlers.approve_task = wrap('approve_task', handlers.approve_task);
    handlers.create_standalone_task = wrap(
      'create_standalone_task',
      handlers.create_standalone_task
    );
  }

  return handlers;
}

export function createNodeAgentMcpServer(config: NodeAgentToolsConfig) {
  const handlers = createNodeAgentToolHandlers(config);
  async function submitForApproval(args: SubmitForApprovalInput): Promise<ToolResult> {
    return config.onSubmitForApproval!(args);
  }

  let wrappedSubmitForApproval = submitForApproval;
  let wrappedMarkComplete = config.onMarkComplete;
  if (config.hookEngine) {
    const meta = {
      sessionId: config.mySessionId,
      agentName: config.myAgentName,
      nodeId: config.workflowNodeId,
      taskId: config.taskId,
    };

    wrappedSubmitForApproval = wrapHandlerWithHooks(
      'submit_for_approval',
      submitForApproval,
      config.hookEngine,
      handlers as unknown as Record<string, (...args: unknown[]) => Promise<ToolResult>>,
      meta
    );

    if (wrappedMarkComplete) {
      wrappedMarkComplete = wrapHandlerWithHooks(
        'mark_complete',
        wrappedMarkComplete,
        config.hookEngine,
        handlers as unknown as Record<string, (...args: unknown[]) => Promise<ToolResult>>,
        meta
      );
    }
  }

  const tools = [
    tool(
      'list_peers',
      'List all other agents in this workflow node group with their agent names, statuses, session IDs, ' +
        'permitted channel connections, and output state from node executions. ' +
        'Use this to discover which peers are active, what direct messaging channels are available, ' +
        'and what output peers have saved (including their summaries).',
      ListPeersSchema.shape,
      (args) => handlers.list_peers(args)
    ),
    tool(
      'list_reachable_agents',
      'List all agents and nodes this agent can reach, grouped as within-node peers ' +
        '(agents in the same workflow node) and cross-node targets (agents/nodes on other nodes). ' +
        'Use this before sending a message to understand who you can reach.',
      ListReachableAgentsSchema.shape,
      (args) => handlers.list_reachable_agents(args)
    ),
    tool(
      'list_channels',
      'List all channels declared in this workflow. ' +
        'Channels define the messaging topology — which agents can communicate. Use this to ' +
        'understand the full channel map for this workflow run.',
      ListChannelsSchema.shape,
      (args) => handlers.list_channels(args)
    ),
    tool(
      'send_message',
      'Send a message to a peer agent by name (DM), a node by name (fan-out), or broadcast to all permitted targets. ' +
        "Use agent name for DM (e.g. 'coder'), node name for fan-out, or '*' for broadcast. " +
        'Validates against declared channel topology — returns an error with available targets if not permitted. ' +
        "The optional `data` payload is passed to any send_message hooks for validation. Use target 'space-agent' to escalate blockers or request human/space-level judgment.",
      SendMessageSchema.shape,
      (args) => handlers.send_message(args)
    ),
    ...(config.onSubscribeExternalEvent && config.onUnsubscribeExternalEvent
      ? [
          tool(
            'subscribe_external_event',
            'Subscribe to external events matching a topic pattern (e.g. github/*/*/pull_request/*.*). ' +
              'Use this during execution to receive matching events directly in this node-agent session.',
            SubscribeExternalEventSchema.shape,
            (args) => handlers.subscribe_external_event(args)
          ),
          tool(
            'unsubscribe_external_event',
            'Unsubscribe from external events for this node-agent session.',
            UnsubscribeExternalEventSchema.shape,
            (args) => handlers.unsubscribe_external_event(args)
          ),
          tool(
            'subscribe_pr_events',
            "Subscribe to GitHub PR events scoped to this workflow run's PR (reviews, comments, reactions). " +
              "Resolves the run's current PR automatically; pass `prUrl` to target a different PR. " +
              'Events are delivered to this node-agent session as messages. The coder node typically calls this.',
            SubscribePrEventsSchema.shape,
            (args) => handlers.subscribe_pr_events(args)
          ),
        ]
      : []),
    ...(config.onListSubscriptions
      ? [
          tool(
            'list_subscriptions',
            "Read-only diagnostic: snapshot this workflow run's external-event subscriptions across three layers — " +
              'declared (static interests in the workflow definition, durable), persisted (the dynamic subscription ' +
              'table, durable), and active (in-memory trie, a live cross-check only). Use this to confirm whether ' +
              'a node is actually wired to receive a class of events, and to surface declared-vs-active drift. ' +
              'The durable layers are the source of truth; the trie is never the answer. Defaults to this ' +
              'workflow run; pass `nodeId` to scope to one node.',
            ListSubscriptionsSchema.shape,
            (args) => handlers.list_subscriptions(args)
          ),
        ]
      : []),
    ...(config.externalEventStore
      ? [
          tool(
            'get_external_event',
            'Fetch the full raw record for a single external event by id — the on-demand deep-dive counterpart to ' +
              'the lean event summary injected into your session as a message. Use this for the rare case where the ' +
              'summary is not enough and you need the complete payload (incl. `rawPayload`, `body`, `actor`, ' +
              '`eventType`, source-native fields such as review `state`, check-run `conclusion`, diff `path`/`line`, etc.). ' +
              'Returns a not-found result for unknown ids.',
            GetExternalEventSchema.shape,
            (args) => handlers.get_external_event(args)
          ),
          tool(
            'list_deliveries',
            'Read-only diagnostic: list recent per-subscription external-event deliveries for a workflow run/node, ' +
              'joined to their source events. Use this to investigate why an event was or was not delivered ' +
              '(delivery state: pending / delivered / failed) and to see the event essence (topic, source, summary, url). ' +
              'Always scoped to the current space; defaults to this workflow run. ' +
              'These tables are space-scoped, so db_query cannot reach them — this tool is the surface for that state.',
            ListDeliveriesSchema.shape,
            (args) => handlers.list_deliveries(args)
          ),
        ]
      : []),
    tool(
      'restore_node_agent',
      'Self-heal primitive — call when you suspect the node-agent MCP server is unhealthy ' +
        '(e.g. a previous mcp__node-agent__send_message returned "No such tool available"). ' +
        'The fact that this call succeeds proves node-agent is registered for your session. ' +
        'The handler also re-attaches the server on the daemon side as a belt-and-braces ' +
        'measure and emits a structured log line for diagnosis. After calling, retry the ' +
        'failed tool once.',
      RestoreNodeAgentSchema.shape,
      (args) => handlers.restore_node_agent(args)
    ),
    ...(config.artifactRepo
      ? [
          tool(
            'save_artifact',
            'Persist a STRUCTURED FACT to the workflow run artifact store as a generic SHAPE from a ' +
              'closed set: `link`, `commit_set`, `check`, `metric`, `decision`, `note` — plus a freeform ' +
              '`kind` semantic hint (e.g. pr, issue, preview, ci, review). Provide `shape`, optional `kind`/' +
              '`key`, and at least one of `summary` or `data`. The shape drives structure and identity: ' +
              '`note` is a single rolling-status upsert; `link` is one per kind; `check`/`metric` keyed by name; ' +
              '`decision` is single-terminal or multi-round via `key`. Save structured facts (PR/preview/doc → ' +
              'link, CI/tests → check, review verdict → decision, current status → note), NOT a re-narration of ' +
              'the thread. Keep prose in chat; only structured facts belong here.',
            SaveArtifactSchema.shape,
            (args) => handlers.save_artifact(args)
          ),
          tool(
            'list_artifacts',
            'List artifacts for the current workflow run, optionally filtered by nodeId or shape ' +
              '(link/commit_set/check/metric/decision/note). Legacy type filters (progress/result/review/pr) ' +
              'are mapped to their shapes for compatibility.',
            ListArtifactsSchema.shape,
            (args) => handlers.list_artifacts(args)
          ),
        ]
      : []),
    ...(config.onCreateStandaloneTask
      ? [
          tool(
            'create_standalone_task',
            'Create a task request in this Space. Runtime may attach and execute a workflow for this task during orchestration. Supports structured task dependencies via depends_on — the task will be blocked until every listed dependency reaches status=done, and cascade-cancelled if a dependency is cancelled.',
            CreateStandaloneTaskSchema.shape,
            (args) => handlers.create_standalone_task(args)
          ),
        ]
      : []),
    ...(config.onPublishTask
      ? [
          tool(
            'publish_task',
            'Publish a draft task, transitioning it from draft to open status. Published tasks become eligible for orchestration by the runtime tick loop. Only valid for tasks currently in draft status.',
            PublishTaskSchema.shape,
            (args) => handlers.publish_task(args)
          ),
        ]
      : []),
    ...(config.onArchiveTask
      ? [
          tool(
            'archive_task',
            "Archive a task. Archived tasks are excluded from most queries and cannot be reactivated. Valid from any status that allows the 'archived' transition (e.g. draft, done, cancelled, blocked, review, approved).",
            ArchiveTaskSchema.shape,
            (args) => handlers.archive_task(args)
          ),
        ]
      : []),
    ...(config.onApproveTask
      ? [
          tool(
            'approve_task',
            'Close this task as done (self-approval). TERMINAL final action: do not send messages after calling. ' +
              'Only use when work is approved/QA-passed, all blocking findings are resolved, required review/artifact evidence is saved, and space autonomy meets workflow completionAutonomyLevel. ' +
              'If autonomy is too low, use submit_for_approval instead. Never use while findings, QA failures, or dispatch work remain open.',
            ApproveTaskSchema.shape,
            (args) => handlers.approve_task(args)
          ),
        ]
      : []),
    ...(config.onSubmitForApproval
      ? [
          tool(
            'submit_for_approval',
            "Request human sign-off for this task's completion. TERMINAL final action: do not send messages after calling. " +
              'Same approval semantic and preconditions as approve_task: use only when work is approved/QA-passed, all findings are resolved, and required review/artifact evidence is saved. ' +
              'Use when autonomy blocks self-close or risk warrants human sign-off. Never use to defer judgment while findings, QA failures, or dispatch work remain open.',
            SubmitForApprovalSchema.shape,
            wrappedSubmitForApproval
          ),
        ]
      : []),
    ...(wrappedMarkComplete
      ? [
          tool(
            'mark_complete',
            'Finish post-approval work and transition the task from `approved` to `done`. ' +
              'Call this after the post-approval instructions (e.g. merging a PR, ' +
              'publishing a release) have been carried out. Takes no arguments — the ' +
              'task is inferred from your session context. Distinct from `approve_task`: ' +
              '`approve_task` handles `in_progress → approved`; `mark_complete` handles ' +
              '`approved → done`. Rejected if the task is not currently in `approved`.',
            MarkCompleteSchema.shape,
            (args) => wrappedMarkComplete!(args)
          ),
        ]
      : []),
    ...(config.taskRepo
      ? [
          tool(
            'list_tasks',
            'List tasks in this space. Filterable by status. Use compact:true to reduce payload size. ' +
              'Use this to discover existing tasks before creating new ones or to check on task progress.',
            ListTasksSchema.shape,
            (args) => handlers.list_tasks(args)
          ),
          tool(
            'get_task',
            'Retrieve detailed information about a specific task including its status, result, and metadata. ' +
              'Provide either task_number (numeric ID like 5 for task #5, preferred) or task_id (UUID).',
            GetTaskSchema.shape,
            (args) => handlers.get_task(args)
          ),
        ]
      : []),
    ...(config.auditLogRepo
      ? [
          tool(
            'list_audit_entries',
            'List MCP audit log entries for this space. Filter by task_id or session_id. ' +
              'Returns entries ordered by timestamp descending (newest first). ' +
              'Use this to inspect the audit trail of tool operations performed by agents.',
            ListAuditEntriesSchema.shape,
            (args) => handlers.list_audit_entries(args)
          ),
        ]
      : []),
  ];

  const server = createSdkMcpServer({ name: 'node-agent', tools });
  instrumentTypedTelemetryAtMcpBoundary(server, config);
  return { ...server, tools };
}

export type NodeAgentMcpServer = ReturnType<typeof createNodeAgentMcpServer>;
