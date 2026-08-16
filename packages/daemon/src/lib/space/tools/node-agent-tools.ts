/**
 * Node Agent Tools — MCP tool handlers for node agent sub-sessions.
 *
 * Action tools:
 *   send_message            — channel-validated direct messaging
 *   save_artifact           — persist typed data to the workflow run artifact store
 *   create_standalone_task  — create a new task in the same Space
 *
 * Discovery tools (read-only):
 *   list_artifacts        — list artifacts for the current workflow run
 *   list_peers            — discover other group members with agent names and permitted channels
 *   list_reachable_agents — list all reachable agents/nodes grouped by proximity
 *   list_channels         — list all channels declared in the workflow
 *
 * Communication model:
 * - Node agents communicate via declared channel topology (`send_message`).
 * - `save_artifact` stores artifacts in the workflow run table as a generic
 *   SHAPE from a closed vocabulary (link/commit_set/check/metric/decision/note)
 *   with a freeform `kind` semantic hint. Save STRUCTURED FACTS as the matching
 *   shape (a PR/preview/doc → `link`, a review verdict → `decision`, CI/tests →
 *   `check`, current status → `note`), NOT a re-narration of the chat thread.
 *   Rolling status: `save_artifact({ shape: 'note', data: { text: '...' } })`.
 *
 * Design:
 * - Handlers are pure functions tested independently of any MCP server layer.
 * - Dependencies are injected via `NodeAgentToolsConfig`.
 * - Message delivery is delegated to AgentMessageRouter for topology validation.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus';
import {
  ApproveTaskSchema,
  SubmitForApprovalSchema,
  MarkCompleteSchema,
  CompleteValidationTaskSchema,
} from './task-agent-tool-schemas';
import type {
  ApproveTaskInput,
  SubmitForApprovalInput,
  MarkCompleteInput,
  CompleteValidationTaskInput,
} from './task-agent-tool-schemas';
import { Logger } from '../../logger';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import { ChannelResolver } from '../runtime/channel-resolver';
import type { AgentMessageRouter } from '../runtime/agent-message-router';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';
import type { SpaceWorkflow } from '@hyperneo/shared';
import {
  ARTIFACT_SHAPES,
  deriveArtifactKey,
  normalizeLinkData,
  resolveNodeAgents,
  validateArtifactShape,
} from '@hyperneo/shared';
import { jsonResult } from './tool-result';
import type { ToolResult } from './tool-result';
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
} from './node-agent-tool-schemas';
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
} from './node-agent-tool-schemas';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceTask } from '@hyperneo/shared';
import type { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository';
import type { ExternalEventStore } from '../../external-events/external-event-store';
import { translateLegacyNodeTargets } from '../messaging-adapter';
import { buildPrEventTopicPattern, parsePrUrl } from '../runtime/parse-pr-url';
import type { WorkflowArtifactProfile } from '../runtime/artifact-profile';
import type { WorkflowHookEngine } from '../runtime/workflow-hook-engine';
import { wrapHandlerWithHooks } from '../runtime/workflow-hook-engine';

/**
 * Decode the JSON payload from a ToolResult created by jsonResult().
 * Returns the parsed object or null if parsing fails.
 */
function decodeToolResultPayload(result: ToolResult): Record<string, unknown> | null {
  try {
    const text = result.content?.[0]?.text;
    if (typeof text === 'string') {
      return JSON.parse(text) as Record<string, unknown>;
    }
  } catch {
    // Ignore parse errors — caller falls back to no-audit.
  }
  return null;
}

// Re-export for consumers that want the shared type
export type { ToolResult };

const log = new Logger('node-agent-tools');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into createNodeAgentToolHandlers().
 * All fields are required unless noted — the caller (TaskAgentManager) wires them up.
 */
export interface NodeAgentToolsConfig {
  /** Session ID of this node agent (used to exclude self from list_peers). */
  mySessionId: string;
  /** Agent name of this node agent (e.g., 'coder', 'reviewer'). */
  myAgentName: string;
  /**
   * Optional agent name aliases that should be treated as equivalent to myAgentName for
   * writer authorization checks (e.g., slot name + underlying agent name).
   */
  myAgentNameAliases?: string[];
  /** ID of the parent task (used for error messages). */
  taskId: string;
  /** Space ID — used for event emission. */
  spaceId: string;
  /**
   * Pre-built channel resolver for this sub-session's topology.
   * Created by TaskAgentManager at session spawn time from the workflow run config.
   * An empty resolver (no channels) means send_message is unavailable for this session.
   */
  channelResolver: ChannelResolver;
  /** Workflow run ID — used to query node execution state. */
  workflowRunId: string;
  /** Workflow node ID — used to query peer executions on the same node. */
  workflowNodeId: string;
  /**
   * Node execution repository for list_peers and send_message peer resolution.
   */
  nodeExecutionRepo: NodeExecutionRepository;
  /**
   * InternalEventBus<DaemonInternalEventMap> instance for emitting task update events.
   * Optional — if omitted, no events are emitted (e.g. in unit tests that don't need them).
   */
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>;
  /**
   * Optional AgentMessageRouter for unified message delivery.
   * send_message delegates all routing to AgentMessageRouter.
   */
  agentMessageRouter: AgentMessageRouter;
  /**
   * Workflow definition for this task.
   * Used by list_channels to access channel definitions. Null when the task has
   * no workflow assigned.
   */
  workflow: SpaceWorkflow | null;
  /**
   * Optional callback for the `approve_task` tool. When provided, `approve_task`
   * is added to the MCP server. Intended for the end node when
   * `space.autonomyLevel >= workflow.completionAutonomyLevel`. The handler
   * also runtime-checks as defense-in-depth against a buggy/malicious client
   * bypassing registration gating.
   */
  onApproveTask?: (args: ApproveTaskInput) => Promise<ToolResult>;
  /**
   * Optional callback for the `submit_for_approval` tool. When provided, the
   * tool is added to the MCP server. Always present for end nodes regardless
   * of autonomy level — agents may voluntarily escalate risky outcomes for
   * human review even when they could self-close.
   */
  onSubmitForApproval?: (args: SubmitForApprovalInput) => Promise<ToolResult>;
  /**
   * Optional callback for the `mark_complete` tool (PR 2/5 of the
   * task-agent-as-post-approval-executor refactor). When provided, the tool
   * is mirrored onto this node-agent's MCP surface so a spawned post-approval
   * sub-session can close its task directly via `approved → done`. Routed
   * through the same `mark_complete` handler the Task Agent uses — the
   * autonomy / status validation is centralised on the task side.
   */
  onMarkComplete?: (args: MarkCompleteInput) => Promise<ToolResult>;
  /**
   * Optional callback for the `complete_validation_task` tool (task #918) —
   * validation-only (no-PR) task completion. Mirrored onto every node-agent
   * like `mark_complete`: the tool ships ONLY on this server (space-agent-tools
   * does not carry it), keeping the completion family node-agent-scoped and
   * hook-wrapped. The handler self-validates (caller binding, autonomy,
   * no-PR + run checks) so a worker that has no validation verdict to record
   * simply never calls it.
   */
  onCompleteValidationTask?: (args: CompleteValidationTaskInput) => Promise<ToolResult>;
  /**
   * Optional callback for `create_standalone_task`. When provided, node agents
   * can create follow-up tasks without receiving the broader space-agent-tools
   * namespace.
   */
  onCreateStandaloneTask?: (args: CreateStandaloneTaskInput) => Promise<ToolResult>;
  /** Optional callback for dynamic external-event subscription requests. */
  onSubscribeExternalEvent?: (args: SubscribeExternalEventInput) => Promise<ToolResult>;
  /** Optional callback for dynamic external-event unsubscription requests. */
  onUnsubscribeExternalEvent?: (args: UnsubscribeExternalEventInput) => Promise<ToolResult>;
  /**
   * Optional callback for the read-only `list_subscriptions` diagnostic. Returns
   * the declared / persisted / active subscription layers for a run. Read-only —
   * never mutates subscription state.
   */
  onListSubscriptions?: (args: ListSubscriptionsInput) => Promise<ToolResult>;
  /**
   * Optional callback for \`publish_task\`. When provided, node agents can
   * publish draft tasks (transition draft → open) without the broader
   * space-agent-tools namespace.
   */
  onPublishTask?: (args: PublishTaskInput) => Promise<ToolResult>;
  /**
   * Optional callback for \`archive_task\`. When provided, node agents can
   * archive tasks without the broader space-agent-tools namespace.
   */
  onArchiveTask?: (args: ArchiveTaskInput) => Promise<ToolResult>;
  /** Optional lookup callback for symmetric reply routing to Space sessions. */
  replyRoutingLookup?: (agentName?: string | null) => string | null;
  /**
   * Workflow run artifact repository for save_artifact / list_artifacts tools.
   * Optional — when absent, artifact tools are not registered.
   */
  artifactRepo?: WorkflowRunArtifactRepository;
  /**
   * Domain artifact profile. Owns coding-specific semantics (primary-link
   * resolution, terminal outcome summary) so
   * these handlers never name domain kinds. Threaded from TaskAgentManager.
   */
  artifactProfile?: WorkflowArtifactProfile;
  /**
   * Task repository for list_tasks and get_task tools.
   * Optional — when absent, task read tools are not registered.
   */
  taskRepo?: SpaceTaskRepository;
  /**
   * MCP audit log repository for recording write operations.
   * Optional — when absent, no audit entries are written.
   */
  auditLogRepo?: McpAuditLogRepository;
  /**
   * External event store for the `get_external_event` on-demand fetch tool.
   * Optional — when absent, the tool is not registered. Reads are scoped to
   * the current space so events never leak across spaces.
   */
  externalEventStore?: ExternalEventStore;
  /**
   * Optional callback invoked when the agent calls `restore_node_agent`.
   *
   * Wired by TaskAgentManager to re-attach the per-session node-agent MCP server
   * (preserving any other registry-sourced servers) and emit a structured log
   * entry for diagnosis. The callback is fire-and-forget from the tool's
   * perspective — failures are logged but do not block the tool result.
   *
   * When omitted (e.g. in unit tests), the tool still succeeds and reports the
   * visible MCP server names but performs no server-side reattachment.
   */
  onRestoreNodeAgent?: (args: { reason?: string }) => Promise<void> | void;
  /**
   * Optional workflow hook engine for intercepting and modifying MCP actions.
   * When provided, registered hooks run before `send_message`, `save_artifact`,
   * `submit_for_approval`, `approve_task`, and `mark_complete` handlers.
   */
  hookEngine?: WorkflowHookEngine;
}

// ---------------------------------------------------------------------------
// Tool handlers (separated for testability)
// ---------------------------------------------------------------------------

/**
 * Create handler functions for the node agent peer communication tools.
 * Returns a map of tool name → async handler function.
 */
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

  /** Helper to log MCP write operations to the audit log. */
  function logAudit(
    toolName: string,
    paramsSummary: Record<string, unknown>,
    taskId?: string
  ): void {
    if (config.auditLogRepo) {
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
      } catch {
        // Audit logging is best-effort; never block the tool operation.
      }
    }
  }

  const handlers = {
    /**
     * List all peers (other group members) with their agent names, statuses, session IDs,
     * permitted channel connections, and completion state.
     *
     * Does NOT include self (filtered by `mySessionId`).
     * Always includes `space-agent` as an escalation target.
     *
     * Returns permittedTargets: agent names this agent can directly send to via send_message.
     * Returns completionState per peer: execution status, latest progress summary, and completedAt.
     * Returns nodeCompletionState: all executions on this workflow node with their completion state.
     *
     * Progress summary is sourced from the latest `note` artifact for the node
     * (written via save_artifact({ shape: 'note', ... })). Falls back to ne.result for
     * historical rows that predate the artifact migration.
     */
    async list_peers(_args: ListPeersInput): Promise<ToolResult> {
      const resolver = channelResolver;

      // Within-node executions (agents sharing the same workflow node as the caller).
      const nodeExecs = workflowRunId
        ? nodeExecutionRepo.listByNode(workflowRunId, workflowNodeId)
        : [];

      // Fetch the rolling-status (note) artifact for this node so we can surface
      // it in completionState. The rolling status is the note keyed 'current'
      // (what save_artifact writes for status). A node may carry other notes too
      // (e.g. migrated unknown legacy types), so select 'current' explicitly and
      // fall back to the most recently updated note.
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

      // Exclude self (by agentSessionId) and include peers with a session or completed state
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

          // Source completion summary from artifacts first, then fall back to ne.result.
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

      // Cross-node peers from channel topology:
      // All declared peer nodes reachable via send_message — even those not yet started.
      // This fixes the chicken-and-egg problem where agents couldn't discover peers that
      // haven't been activated yet (they'd see no peers and never know to send a message).
      //
      // Channels may be addressed by either agent name (e.g. 'coder') or node name
      // (e.g. 'Coding'), so we query by both to ensure we don't miss any targets.
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
        // All executions in this run (to look up cross-node state).
        const allRunExecs = nodeExecutionRepo.listByWorkflowRun(workflowRunId);
        // Index by workflowNodeId for fast lookup
        const execsByNode = new Map<string, typeof allRunExecs>();
        for (const exec of allRunExecs) {
          if (exec.workflowNodeId === workflowNodeId) continue; // skip self-node
          const arr = execsByNode.get(exec.workflowNodeId) ?? [];
          arr.push(exec);
          execsByNode.set(exec.workflowNodeId, arr);
        }

        const seenAgentNames = new Set<string>(withinNodePeers.map((p) => p.agentName));

        for (const targetNodeName of topologyTargets) {
          // Resolve the target node definition so we can look up its executions.
          const targetNode = workflow?.nodes.find((n) => n.name === targetNodeName);
          const targetNodeId = targetNode?.id;
          const targetExecs = targetNodeId ? (execsByNode.get(targetNodeId) ?? []) : [];

          if (targetExecs.length === 0) {
            // Node not yet activated — resolve declared agent slots from the workflow
            // definition and show them as "not_started" so the caller knows who to
            // target via send_message to kick off the node.
            let agentNames: string[] = [];
            if (targetNode) {
              try {
                agentNames = resolveNodeAgents(targetNode).map((a) => a.name);
              } catch {
                // If resolveNodeAgents fails, fall back to the node name itself.
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
            // Node has execution records — include all agents with their current status.
            for (const ne of targetExecs) {
              if (seenAgentNames.has(ne.agentName)) continue;
              seenAgentNames.add(ne.agentName);
              const execStatus = ne.status;
              // 'pending' means the execution was created but the session hasn't spawned yet —
              // report as 'not_started' rather than 'active' to avoid misleading callers.
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
      // Include BOTH topology node names (e.g. 'Review') AND resolved agent slot names
      // (e.g. 'agent-reviewer') so callers can use either form with send_message.
      // The router accepts both: node names via nodeGroups fan-out, slot names via
      // allDeclaredAgentNames or peer session lookup.
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

    /**
     * Send a message to a peer agent by name (DM), a node by name (fan-out),
     * or broadcast to all permitted targets.
     *
     * Validates against declared channel topology — returns an error with
     * available targets if not permitted.
     */
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
        return jsonResult({
          success: 'partial',
          delivered: result.delivered,
          failed: result.failed,
          queued: result.queued,
          notFoundAgentNames: result.notFoundAgentNames,
          message: `Message delivered to ${result.delivered.length} peer(s) but failed for ${result.failed.length} peer(s).`,
        });
      }

      // Build a human-readable summary
      const summaryParts: string[] = [];
      if (result.delivered.length > 0) {
        summaryParts.push(
          `delivered to ${result.delivered.length} peer(s): ` +
            result.delivered.map((t) => `${t.agentName} (${t.sessionId})`).join(', ')
        );
      }
      if (result.queued && result.queued.length > 0) {
        summaryParts.push(
          `queued for ${result.queued.length} peer(s) pending activation: ` +
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

    /**
     * List all agents and nodes this agent can reach, grouped as:
     *   - withinNodePeers: agents in the same workflow node (current group members)
     *   - crossNodeTargets: agents/nodes reachable via declared cross-node paths
     *
     * Uses agent-friendly terminology — no mention of channels or policies.
     */
    async list_reachable_agents(_args: ListReachableAgentsInput): Promise<ToolResult> {
      // Determine this agent's node name from the workflow definition.
      // Falls back to myAgentName (agent slot name) for backward compatibility
      // when no workflow is available (e.g. direct MCP calls without a workflow).
      const myNode = workflow?.nodes.find((n) => n.id === workflowNodeId);
      const myNodeName = myNode?.name ?? myAgentName;

      // Within-node peers: other agents in the same node
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

      // Use channels from the resolver (which was built from the workflow channels at spawn time)
      // or fall back to workflow.channels directly. This ensures the handler works both
      // when a full workflow is available and when only a channel resolver is provided.
      const channels =
        channelResolver.getChannels().length > 0
          ? channelResolver.getChannels()
          : (workflow?.channels ?? []);
      const reachabilityDeclared = channels.length > 0;

      // Cross-node targets: channels where FROM node is this agent's node
      type CrossNodeTarget = {
        nodeName: string;
      };
      const crossNodeTargets: CrossNodeTarget[] = [];

      if (reachabilityDeclared && myNodeName) {
        const seen = new Set<string>();

        // Track within-node agent names to exclude them from cross-node targets
        const withinNodeAgentNames = new Set([myAgentName, ...nodeExecs.map((e) => e.agentName)]);

        for (const ch of channels) {
          // Match channels where FROM is this agent's node name, slot name, or wildcard
          if (ch.from !== myNodeName && ch.from !== myAgentName && ch.from !== '*') continue;
          const tos = Array.isArray(ch.to) ? ch.to : [ch.to];
          for (const toNode of tos) {
            // Skip: same as source, already seen, or is a within-node agent
            if (toNode === myNodeName || toNode === myAgentName) continue;
            if (seen.has(toNode)) continue;
            if (withinNodeAgentNames.has(toNode)) continue; // within-node agent → not cross-node
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

    /**
     * List all channels declared in this workflow.
     *
     * Returns the messaging topology for the current workflow run —
     * channels define which agents can communicate. Use this to understand the
     * full channel map before calling list_reachable_agents or send_message.
     */
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

    // ── Artifact tools ────────────────────────────────────────────────

    /**
     * Persist data to the workflow run artifact store as a generic SHAPE.
     *
     * `shape` is a closed, domain-agnostic structure vocabulary (link,
     * commit_set, check, metric, decision, note); `kind` is a freeform semantic
     * hint. Identity is derived from the shape (note→single upsert, link→one
     * per kind, check/metric→name, decision→key|kind|'current'), so repeated
     * status updates overwrite in place instead of accumulating per round.
     *
     * Requires `artifactRepo` to be provided in the config.
     */
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

      // Merge summary + data into a single payload, then fold in the kind hint.
      const artifactData: Record<string, unknown> = {};
      if (summary !== undefined) artifactData.summary = summary;
      if (data !== undefined) Object.assign(artifactData, data);
      if (kind !== undefined) artifactData.kind = kind;
      // Link rows may carry a URL-bearing field under a domain key; normalise
      // onto data.url so link readers (which key off data.url) find it.
      const normalized = shape === 'link' ? normalizeLinkData(artifactData) : artifactData;

      if (Object.keys(normalized).length === 0) {
        return jsonResult({
          success: false,
          error: 'At least one of `summary` or `data` must be provided.',
        });
      }

      // Validate the payload against the per-shape contract.
      const validation = validateArtifactShape(shape, normalized);
      if (!validation.ok) {
        return jsonResult({ success: false, error: validation.error });
      }

      try {
        const artifactKey = deriveArtifactKey(shape, normalized, keyArg);

        // BACKFILL before any overwriting write: a run whose PR-bearing
        // artifact predates the record-time memory has no reserved identity,
        // and this upsert may replace the only row carrying the PR. Resolve
        // the CURRENT PR first and remember it, so the overwrite cannot make
        // a previously PR-bound run read as no-PR (task #918).
        if (config.artifactProfile) {
          try {
            const existing = config.artifactProfile.resolvePrimaryLinkUrlStrict?.(workflowRunId);
            if (existing?.url) {
              config.artifactProfile.rememberPrimaryLinkUrl?.(workflowRunId, existing.url);
            } else {
              const lenient = config.artifactProfile.resolvePrimaryLinkUrl(workflowRunId);
              if (lenient) {
                config.artifactProfile.rememberPrimaryLinkUrl?.(workflowRunId, lenient);
              }
            }
          } catch {
            // Best-effort backfill; the record-time memory is additive.
          }
        }

        const record = artifactRepo.upsert({
          id: crypto.randomUUID(),
          runId: workflowRunId,
          nodeId: workflowNodeId,
          artifactType: shape,
          artifactKey,
          data: normalized,
        });

        // Write-once PR memory at RECORD time: a PR-bearing payload (a
        // `link kind:'pr'`, or a legacy `pr_url` field on any shape) is
        // remembered under the reserved hook id, so a later same-key
        // artifact overwrite cannot erase the run's PR-bound identity from
        // the no-PR completion gate (task #918).
        const prUrlInPayload =
          shape === 'link' && normalized.kind === 'pr'
            ? typeof normalized.url === 'string'
              ? normalized.url
              : ''
            : typeof normalized.pr_url === 'string'
              ? normalized.pr_url
              : typeof normalized.prUrl === 'string'
                ? normalized.prUrl
                : '';
        if (prUrlInPayload) {
          config.artifactProfile?.rememberPrimaryLinkUrl?.(workflowRunId, prUrlInPayload);
        }

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
        // `type` filters by the canonical SHAPE vocabulary (link / commit_set /
        // check / metric / decision / note); artifacts are always stored as a
        // shape, so a single filter value is enough.
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
      // Decode the JSON payload from the ToolResult content to check success and extract the task ID.
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

    /**
     * Fetch the full raw record for a single external event by id.
     *
     * On-demand counterpart to the lean "essence" injected into sessions as a
     * message: use this for the rare deep-dive case where the digested summary
     * is not enough and you need the complete payload (incl. `rawPayload`,
     * `body`, `actor`, `eventType`, source-native fields, etc.).
     *
     * Returns a clear not-found result for unknown ids. Reads are scoped to the
     * current space — an id that resolves to an event in another space is
     * treated as not-found so events never leak across spaces.
     */
    async get_external_event(args: GetExternalEventInput): Promise<ToolResult> {
      const { externalEventStore } = config;
      if (!externalEventStore) {
        return jsonResult({
          success: false,
          error: 'External event lookup is not available.',
        });
      }
      const record = externalEventStore.getById(args.eventId);
      // Scope by space: getById resolves by id only, so an id belonging to
      // another space must be treated as not-found.
      if (!record || record.event.spaceId !== spaceId) {
        return jsonResult({
          success: false,
          error: `External event not found: ${args.eventId}`,
        });
      }
      return jsonResult({ success: true, event: record.event, state: record.state });
    },

    /**
     * List recent per-subscription external-event deliveries for diagnosis —
     * why an event was (or was not) delivered to a run/node. Read-only.
     *
     * Reads `space_external_event_deliveries` joined to `space_external_events`,
     * which `db_query` cannot reach because those tables are space-scoped (by
     * `space_id`), not session-scoped. Always scoped to the current space;
     * defaults to the current workflow run. Each row carries the delivery state
     * plus a lean event essence (topic, source, summary, url, event state).
     */
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

    /**
     * Read-only diagnostic: snapshot a workflow run's external-event
     * subscriptions across three layers — declared (workflow definition),
     * persisted (PR 5 table), and active (in-memory trie, cross-check only) —
     * so an agent can confirm whether a node is actually wired to receive a
     * class of events from durable state alone. Durable layers are the source of
     * truth; the trie is a sanity check, with declared-vs-active drift surfaced
     * via per-entry `source`/`active` flags and a `mismatches` summary.
     */
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

    // ── Task read tools ──────────────────────────────────────────────

    /**
     * List tasks in the current space, optionally filtered by status.
     *
     * Use `compact: true` to return a trimmed projection (id, title, status,
     * priority, createdAt) suitable for dense lists.
     */
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

    /**
     * Get the full detail of a task by UUID or by numeric task number (e.g. #5).
     */
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
        // Scope by space: getTask resolves by UUID only, so verify ownership.
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

    /**
     * List MCP audit log entries for this space, filtered by task or session.
     *
     * Returns entries ordered by timestamp descending (newest first).
     * Use this to inspect the audit trail of tool operations performed
     * by agents in this workflow.
     */
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

    // ── Self-heal ────────────────────────────────────────────────────

    /**
     * Self-heal primitive.
     *
     * Successfully invoking this tool is itself proof that the node-agent
     * MCP server is registered for the current session — if the server were
     * missing, the SDK would have rejected the call with "No such tool
     * available". The handler additionally invokes the optional
     * `onRestoreNodeAgent` callback (wired by TaskAgentManager) which
     * re-attaches the per-session node-agent server as a belt-and-braces
     * measure and writes a structured log entry for diagnosis.
     *
     * The result reports back the visible MCP server names so the agent can
     * confirm its environment before retrying a critical handoff.
     */
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

  // Wrap action handlers with workflow hooks when engine is provided.
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

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

/**
 * Create an MCP server exposing all node agent peer communication tools.
 * Pass the returned server to the AgentSessionInit.mcpServers for node agent sessions.
 */
export function createNodeAgentMcpServer(config: NodeAgentToolsConfig) {
  const handlers = createNodeAgentToolHandlers(config);

  async function submitForApproval(args: SubmitForApprovalInput): Promise<ToolResult> {
    return config.onSubmitForApproval!(args);
  }

  // Wrap submit_for_approval and mark_complete with hooks when engine is provided.
  let wrappedSubmitForApproval = submitForApproval;
  let wrappedMarkComplete = config.onMarkComplete;
  let wrappedCompleteValidation = config.onCompleteValidationTask;
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

    // `complete_validation_task` joins the wrapped completion family so
    // workflow-declared validators on this method run around the validation
    // close (task #918) — the tool is node-agent-exclusive, so this is the
    // ONLY surface the engine needs to cover.
    if (wrappedCompleteValidation) {
      const inner = wrappedCompleteValidation;
      const unauthorized = async (_args: CompleteValidationTaskInput): Promise<ToolResult> => {
        // Fail closed BEFORE the engine wrapper: executeAction treats an
        // empty matching hook set as `allow` (correct for routing-scoped
        // hooks), so a workflow that scopes its completion validator to a
        // designated caller would let every OTHER node bypass it. When
        // enabled hooks exist for this method but none authorize THIS
        // caller under the engine's own matching rules, refuse outright.
        return jsonResult({
          success: false,
          error:
            'This workflow declares complete_validation_task validators, but none of them authorize this agent to close the task. Completion belongs to the designated validator node/slot — escalate to the coordinator if the task still needs closing.',
        });
      };
      const authorized = config.hookEngine.hasEnabledHooksFor('complete_validation_task')
        ? config.hookEngine.hooksAuthorizeCaller('complete_validation_task', meta)
          ? inner
          : unauthorized
        : inner;
      wrappedCompleteValidation = wrapHandlerWithHooks(
        'complete_validation_task',
        authorized,
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
    ...(wrappedCompleteValidation
      ? [
          tool(
            'complete_validation_task',
            'Validation-only (no-PR) task completion — OPT-IN: only for workflows that declare a complete_validation_task hook. ' +
              'For tasks that complete via validation rather than a reviewed PR ' +
              '(Forge review/automation, diagnostics, already-complete work). Captures the validation outcome as the task ' +
              'result and transitions review/in_progress → done WITHOUT requiring a pr_url. Autonomy-gated to the ' +
              "workflow's completionAutonomyLevel; rejects tasks whose run already has a PR (use the normal approve/merge " +
              'path for those). Worker sessions may only complete their own task. TERMINAL final action: do NOT send ' +
              'messages or call tools after a successful completion — a later peer send_message can reopen the run this ' +
              'tool just completed and spawn replacement workers.',
            CompleteValidationTaskSchema.shape,
            (args) => wrappedCompleteValidation!(args)
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
  return { ...server, tools };
}

export type NodeAgentMcpServer = ReturnType<typeof createNodeAgentMcpServer>;
