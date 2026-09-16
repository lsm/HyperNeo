import type { SpaceWorkflow } from '@hyperneo/shared';
import {
  ARTIFACT_SHAPES,
  deriveArtifactKey,
  normalizeLinkData,
  validateArtifactShape,
} from '@hyperneo/shared';
import type { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository.ts';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository.ts';
import type { ExternalEventStore } from '../../external-events/external-event-store.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus.ts';
import type { SpaceGoalService } from '../../goals/service.ts';
import type { AgentMessageRouter } from '../../messaging/agent-message-router.ts';
import type { WorkflowArtifactProfile } from '../../workflows/artifact-profile.ts';
import type { ChannelResolver } from '../../messaging/channel-resolver.ts';
import { buildPrEventTopicPattern, parsePrUrl } from '../../github/parse-pr-url.ts';
import type { WorkflowHookEngine } from '../../workflows/hook-engine.ts';
import { wrapHandlerWithHooks } from '../../workflows/hook-engine.ts';
import type {
  CreateStandaloneTaskInput,
  ListArtifactsInput,
  ListAuditEntriesInput,
  ListSubscriptionsInput,
  SaveArtifactInput,
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
  const { mySessionId, myAgentName, spaceId, workflowRunId, workflowNodeId } = config;

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
      const { auditLogRepo } = config;
      if (!auditLogRepo) {
        return jsonResult({ success: false, error: 'Audit log repository not available.' });
      }
      try {
        const limit = Math.min(args.limit ?? 20, 100);
        const offset = args.offset ?? 0;
        let entries: ReturnType<typeof auditLogRepo.listBySpace>;
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

    handlers.save_artifact = wrap('save_artifact', handlers.save_artifact);
  }

  return handlers;
}
