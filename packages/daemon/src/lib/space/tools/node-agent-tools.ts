/**
 * Node Agent Tools — MCP tool handlers for node agent sub-sessions.
 *
 * Action tools:
 *   send_message            — channel-validated direct messaging; auto-writes gate data on gated channels
 *   save_artifact           — persist typed data to the workflow run artifact store
 *   create_standalone_task  — create a new task in the same Space
 *
 * Discovery tools (read-only):
 *   list_artifacts        — list artifacts for the current workflow run
 *   list_peers            — discover other group members with agent names and permitted channels
 *   list_reachable_agents — list all reachable agents/nodes grouped by proximity
 *   list_channels         — list all channels declared in the workflow
 *   list_gates            — list all gates with current runtime data
 *   read_gate             — read current data for a specific gate
 *
 * Communication model:
 * - Node agents communicate via declared channel topology (`send_message`).
 * - When a channel is gated, the `data` payload in `send_message` is automatically
 *   merged into the gate's data store — no separate write_gate call needed.
 * - `save_artifact` stores typed artifacts in the workflow run artifact table.
 *   Progress updates: `save_artifact({ type: 'progress', key: 'current', summary: '...' })`
 *   Audit records: `save_artifact({ type: 'result', append: true, summary: '...' })`
 *
 * Design:
 * - Handlers are pure functions tested independently of any MCP server layer.
 * - Dependencies are injected via `NodeAgentToolsConfig`.
 * - Message delivery is delegated to AgentMessageRouter for topology/gate validation.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus';
import {
	ApproveTaskSchema,
	SubmitForApprovalSchema,
	MarkCompleteSchema,
} from './task-agent-tool-schemas';
import type {
	ApproveTaskInput,
	SubmitForApprovalInput,
	MarkCompleteInput,
} from './task-agent-tool-schemas';
import { Logger } from '../../logger';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import { ChannelResolver } from '../runtime/channel-resolver';
import {
	evaluateGate,
	type GateScriptExecutorFn,
	type GateScriptExecutorContext,
} from '../runtime/gate-evaluator';
import type { AgentMessageRouter } from '../runtime/agent-message-router';
import type { GateDataRepository } from '../../../storage/repositories/gate-data-repository';
import type { SpaceWorkflow } from '@neokai/shared';
import { computeGateDefaults, resolveNodeAgents } from '@neokai/shared';
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
	ListGatesSchema,
	ReadGateSchema,
	RestoreNodeAgentSchema,
	ListTasksSchema,
	GetTaskSchema,
	ListAuditEntriesSchema,
	PublishTaskSchema,
	ArchiveTaskSchema,
	SubscribeExternalEventSchema,
	UnsubscribeExternalEventSchema,
} from './node-agent-tool-schemas';
import type {
	ListPeersInput,
	SendMessageInput,
	SaveArtifactInput,
	CreateStandaloneTaskInput,
	ListArtifactsInput,
	ListReachableAgentsInput,
	ListChannelsInput,
	ListGatesInput,
	ReadGateInput,
	RestoreNodeAgentInput,
	ListTasksInput,
	GetTaskInput,
	ListAuditEntriesInput,
	PublishTaskInput,
	ArchiveTaskInput,
	SubscribeExternalEventInput,
	UnsubscribeExternalEventInput,
} from './node-agent-tool-schemas';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceTask } from '@neokai/shared';
import type { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository';
import { parseAddress } from '../../../../../messaging/src/address';
import { translateLegacyNodeTargets } from '../messaging-adapter';

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

function normalizeAgentNameToken(value: string): string {
	return value.trim().toLowerCase();
}

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
	 * Used by list_channels, list_gates, read_gate, write_gate to access channel and
	 * gate definitions. Null when the task has no workflow assigned.
	 */
	workflow: SpaceWorkflow | null;
	/**
	 * Gate data repository for reading and writing gate runtime data.
	 * Used by list_gates, read_gate, write_gate.
	 */
	gateDataRepo: GateDataRepository;
	/**
	 * Callback invoked after a gate data write to trigger re-evaluation and
	 * potential lazy node activation for any channels referencing the changed gate.
	 *
	 * Called by `send_message` after a successful gated message delivery. The
	 * handler awaits and serializes notifications per gate so cyclic reset-on-
	 * delivery cannot race ahead of the in-flight send and make the same call
	 * validate against freshly reset data.
	 * When provided, blocked target nodes are auto-activated the moment their gate
	 * condition is satisfied — enabling vote-counting and push-on-write semantics.
	 * When absent, nodes are activated at the next `deliverMessage` call instead.
	 */
	onGateDataChanged?: (runId: string, gateId: string) => Promise<unknown>;
	/**
	 * Optional script executor for async gate evaluation.
	 * When provided, `read_gate` and the gate-write path in `send_message` run
	 * gate scripts before field evaluation.
	 */
	scriptExecutor?: GateScriptExecutorFn;
	/**
	 * Context for gate script execution (workspace path, gate/run IDs).
	 * Required when `scriptExecutor` is provided.
	 */
	scriptContext?: GateScriptExecutorContext;
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
	 * Resolves the space's current autonomy level.
	 * When provided, agent gate writes via send_message are blocked when
	 * space autonomy < gate.requiredLevel (default 5 if gate has no requiredLevel).
	 */
	getSpaceAutonomyLevel?: (spaceId: string) => Promise<number>;
	/**
	 * Workflow run artifact repository for save_artifact / list_artifacts tools.
	 * Optional — when absent, artifact tools are not registered.
	 */
	artifactRepo?: WorkflowRunArtifactRepository;
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
		myAgentNameAliases,
		spaceId,
		channelResolver,
		workflowRunId,
		workflowNodeId,
		nodeExecutionRepo,
		internalEventBus,
		agentMessageRouter,
		workflow,
		gateDataRepo,
		scriptExecutor,
		scriptContext,
		getSpaceAutonomyLevel,
	} = config;

	const myNodeName = workflow
		? (workflow.nodes.find((node) => node.id === workflowNodeId)?.name ?? myAgentName)
		: myAgentName;

	// Build a slot-to-node map so we can resolve agent names to node names when
	// matching channels for gate data writes. Channels use node names as addresses,
	// but agents often send to other agents by their slot/agent name.
	const slotToNode = new Map<string, string>();
	if (workflow) {
		for (const node of workflow.nodes) {
			try {
				for (const agent of resolveNodeAgents(node)) {
					slotToNode.set(agent.name, node.name);
				}
			} catch {
				// If resolveNodeAgents throws (e.g. empty agents array with no legacy
				// agentId), skip this node — there are no agent slots to map anyway.
			}
		}
	}
	const resolveNodeName = (slotOrNode: string) => slotToNode.get(slotOrNode) ?? slotOrNode;
	const genericWorkerTargetNodes = (targetRef: string): string[] => {
		if (!targetRef.startsWith('@worker:')) return [];
		try {
			const address = parseAddress(targetRef);
			if (address.kind !== 'worker') return [];
			const nodeRef = decodeURIComponent(address.nodeId);
			return [nodeRef, resolveNodeName(nodeRef)];
		} catch {
			return [];
		}
	};
	const uniqueTargetRefs = (values: string[]): string[] => [...new Set(values)];

	const agentNameAliases = new Set(
		[myAgentName, myNodeName, ...(myAgentNameAliases ?? [])]
			.map((value) => normalizeAgentNameToken(value))
			.filter((value) => value.length > 0)
	);

	const pendingGateChangeNotifications = new Map<string, Promise<unknown>>();

	async function notifyGateDataChanged(gateId: string): Promise<void> {
		if (!config.onGateDataChanged) return;

		const previous = pendingGateChangeNotifications.get(gateId);
		const current = (async () => {
			if (previous) {
				try {
					await previous;
				} catch {
					// Prior notification failures are already logged by their owner.
				}
			}
			return config.onGateDataChanged!(workflowRunId, gateId);
		})();

		pendingGateChangeNotifications.set(gateId, current);
		try {
			await current;
		} finally {
			if (pendingGateChangeNotifications.get(gateId) === current) {
				pendingGateChangeNotifications.delete(gateId);
			}
		}
	}

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

	return {
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
		 * Progress summary is sourced from the latest 'progress' type artifact for the node
		 * (written via save_artifact({ type: 'progress', ... })). Falls back to ne.result for
		 * historical rows that predate the artifact migration.
		 */
		async list_peers(_args: ListPeersInput): Promise<ToolResult> {
			const resolver = channelResolver;

			// Within-node executions (agents sharing the same workflow node as the caller).
			const nodeExecs = workflowRunId
				? nodeExecutionRepo.listByNode(workflowRunId, workflowNodeId)
				: [];

			// Fetch the latest progress artifact for this node so we can surface it in
			// completionState. All agents in the same node share the same nodeId, so we
			// read the latest progress artifact across the whole node and use it as the
			// completion summary for peers that don't have a direct ne.result.
			let latestProgressSummary: string | null = null;
			if (config.artifactRepo && workflowRunId) {
				const progressArtifacts = config.artifactRepo.listByRun(workflowRunId, {
					nodeId: workflowNodeId,
					artifactType: 'progress',
				});
				if (progressArtifacts.length > 0) {
					const latest = progressArtifacts[progressArtifacts.length - 1];
					const s = latest.data.summary;
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
		 *
		 * When `data` is provided and the target channel is gated, the data is
		 * automatically merged into the gate's data store before delivery.
		 * Gate re-evaluation fires after the merge — if the gate opens the message
		 * is delivered immediately; otherwise it is held until the condition passes.
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

			// Auto gate-write: if data is provided and the outbound channel to this
			// target is gated, merge the data into the gate before delivery.
			// This allows agents to satisfy gate conditions as part of a single send call.
			let gateWriteResult: { gateId: string; gateOpen: boolean } | null = null;
			if (data && workflow) {
				const targetName = Array.isArray(target) ? null : target;
				const routedTargetNames = uniqueTargetRefs([
					...(targetName ? [targetName] : []),
					...translatedTargets,
					...(targetName ? genericWorkerTargetNodes(targetName) : []),
				]);
				if (
					targetName &&
					targetName !== '*' &&
					targetName !== 'task-agent' &&
					targetName !== 'space-agent'
				) {
					const node = workflow.nodes.find((n) => n.id === workflowNodeId);
					const myNodeName = node?.name ?? myAgentName;
					const fromRefs = new Set([myAgentName, myNodeName]);

					const gatedChannel = (workflow.channels ?? []).find((ch) => {
						if (!ch.gateId) return false;
						if (ch.from !== '*' && !fromRefs.has(ch.from)) return false;
						const tos = Array.isArray(ch.to) ? ch.to : [ch.to];
						const candidateTargets = uniqueTargetRefs([
							...routedTargetNames,
							...routedTargetNames.map(resolveNodeName),
						]);
						return tos.some(
							(to) => candidateTargets.includes(to) || to === myNodeName || to === myAgentName
						);
					});

					if (gatedChannel?.gateId) {
						const gateId = gatedChannel.gateId;
						const gates = workflow.gates ?? [];
						const gateDef = gates.find((g) => g.id === gateId);

						if (gateDef) {
							// Per-field two-path authorization for agent gate writes:
							//   Writers path: field has a non-empty writers list and this agent matches one
							//     (including '*' wildcard) → workflow author made an explicit trust decision → allow,
							//     no autonomy check.
							//   Autonomy path: field has no writers or an empty writers list
							//     → require space.autonomyLevel >= gate.requiredLevel (default 5 when unset).
							// Human approval via spaceWorkflowRun.approveGate RPC is not affected.
							const effectiveRequiredLevel = gateDef.requiredLevel ?? 5;
							const spaceLevel = getSpaceAutonomyLevel ? await getSpaceAutonomyLevel(spaceId) : 0;

							const fieldMap = new Map((gateDef.fields ?? []).map((f) => [f.name, f]));
							const authorizedData: Record<string, unknown> = {};
							for (const [key, value] of Object.entries(data)) {
								const fieldDef = fieldMap.get(key);
								if (!fieldDef) continue;

								let fieldAllowed = false;
								if (fieldDef.writers.length > 0) {
									// Writers path: check if this agent matches a declared writer
									fieldAllowed = fieldDef.writers.some((writer) => {
										const normalized = normalizeAgentNameToken(writer);
										return normalized === '*' || agentNameAliases.has(normalized);
									});
								} else if (getSpaceAutonomyLevel) {
									// Autonomy path: no writers declared — require sufficient space autonomy
									fieldAllowed = spaceLevel >= effectiveRequiredLevel;
								}

								if (fieldAllowed) authorizedData[key] = value;
							}

							if (Object.keys(authorizedData).length > 0) {
								// Deep-merge map-type fields atomically: each reviewer in a
								// vote-counting gate (e.g. plan-approval-gate `approvals: map`)
								// writes a partial map keyed by their lens/identity. A naive
								// shallow merge would replace the whole map with the latest
								// writer's entry, losing prior votes. Doing the read-merge-write
								// in JS would also race with `incrementAndResetCyclicChannel`
								// (which clears the gate on revision feedback) — if a stale
								// snapshot was read before the reset and written back after,
								// cleared votes would resurrect. Push the deep-merge into the
								// repository so it runs inside a single SQLite transaction.
								const mapFields = new Set<string>();
								for (const key of Object.keys(authorizedData)) {
									const fieldDef = fieldMap.get(key);
									if (fieldDef?.type === 'map') mapFields.add(key);
								}
								const partialToMerge: Record<string, unknown> = {
									...authorizedData,
									approvalSource: 'agent',
								};
								const updated =
									mapFields.size > 0
										? gateDataRepo.mergeWithMapFields(
												workflowRunId,
												gateId,
												partialToMerge,
												mapFields
											)
										: gateDataRepo.merge(workflowRunId, gateId, partialToMerge);
								const evalResult = await evaluateGate(
									gateDef,
									updated.data,
									scriptExecutor,
									scriptContext ? { ...scriptContext, gateId, gateData: updated.data } : undefined
								);
								gateWriteResult = { gateId, gateOpen: evalResult.open };

								// Multi-round review history: every time the reviewer writes a
								// `review_url` to this gate, append an append-only artifact row
								// so we get one record per cycle (cycle 0, 1, 2 …) without any
								// deduplication. The per-cycle artifactKey makes each write a
								// distinct row even though the table uses upsert semantics.
								//
								// Note: `comment_urls` is not a gate field (so it's stripped from
								// `authorizedData`), but we still want to persist it alongside the
								// review for the audit trail — pull it straight from the original
								// `data` payload the reviewer supplied.
								if (
									config.artifactRepo &&
									gateId === 'review-posted-gate' &&
									typeof authorizedData.review_url === 'string' &&
									authorizedData.review_url.length > 0
								) {
									try {
										const priorReviews = config.artifactRepo.listByRun(workflowRunId, {
											artifactType: 'review',
										});
										const cycle = priorReviews.length;
										const artifactData: Record<string, unknown> = {
											review_url: authorizedData.review_url,
											cycle,
											submittedAt: new Date().toISOString(),
										};
										const rawCommentUrls = (data as Record<string, unknown>).comment_urls;
										if (
											Array.isArray(rawCommentUrls) &&
											rawCommentUrls.every((u) => typeof u === 'string')
										) {
											artifactData.comment_urls = rawCommentUrls;
										}
										config.artifactRepo.upsert({
											id: crypto.randomUUID(),
											runId: workflowRunId,
											nodeId: workflowNodeId,
											artifactType: 'review',
											artifactKey: `cycle-${cycle}`,
											data: artifactData,
										});
									} catch (err) {
										log.warn(
											`Failed to append review artifact for run "${workflowRunId}":`,
											err instanceof Error ? err.message : String(err)
										);
									}
								}

								if (internalEventBus) {
									void internalEventBus
										.publish('space.gateData.updated', {
											sessionId: 'global',
											spaceId,
											runId: workflowRunId,
											gateId,
											data: updated.data,
										})
										.catch((err) => {
											log.warn(`Failed to emit space.gateData.updated for gate "${gateId}":`, err);
										});
								}
							}
						}
					}
				}
			}

			const gateIdToNotify = gateWriteResult?.gateId;

			// Audit log: gate data writes via send_message
			if (gateWriteResult) {
				logAudit('send_message', {
					target,
					gateId: gateWriteResult.gateId,
					gateOpen: gateWriteResult.gateOpen,
					dataKeys: data ? Object.keys(data) : undefined,
				});
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

			if (gateIdToNotify) {
				try {
					await notifyGateDataChanged(gateIdToNotify);
				} catch (err) {
					log.warn(
						`onGateDataChanged failed for gate "${gateIdToNotify}" in run "${workflowRunId}":`,
						err instanceof Error ? err.message : String(err)
					);
				}
			}

			if (!result.success) {
				return jsonResult({
					success: false,
					error: result.reason ?? 'Message delivery failed.',
					delivered: result.delivered.length > 0 ? result.delivered : undefined,
					failed: result.failed.length > 0 ? result.failed : undefined,
					queued: result.queued,
					unauthorizedAgentNames: result.unauthorizedAgentNames,
					permittedTargets: result.permittedTargets,
					notFoundAgentNames: result.notFoundAgentNames,
					gateWrite: gateWriteResult ?? undefined,
				});
			}

			if (result.success === 'partial') {
				return jsonResult({
					success: 'partial',
					delivered: result.delivered,
					failed: result.failed,
					queued: result.queued,
					notFoundAgentNames: result.notFoundAgentNames,
					gateWrite: gateWriteResult ?? undefined,
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
				gateWrite: gateWriteResult ?? undefined,
				message: summaryParts.length > 0 ? `Message ${summaryParts.join('; ')}.` : 'No action.',
			});
		},

		/**
		 * List all agents and nodes this agent can reach, grouped as:
		 *   - withinNodePeers: agents in the same workflow node (current group members)
		 *   - crossNodeTargets: agents/nodes reachable via declared cross-node paths
		 *
		 * Uses agent-friendly terminology — no mention of channels or policies.
		 * Gate status is included for cross-node targets so agents know whether
		 * a target may require conditions to be met before delivery is permitted.
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
				gate: { type: string; isGated: boolean; description?: string };
			};
			const crossNodeTargets: CrossNodeTarget[] = [];

			if (reachabilityDeclared && myNodeName) {
				const gatesById = new Map((workflow?.gates ?? []).map((g) => [g.id, g]));
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
						const gateEntity = ch.gateId ? gatesById.get(ch.gateId) : undefined;
						const gateType = gateEntity
							? (gateEntity.fields ?? []).some((f) => f.type === 'map' && f.check.op === 'count')
								? 'count'
								: 'check'
							: 'none';
						const entry: CrossNodeTarget = {
							nodeName: toNode,
							gate: { type: gateType, isGated: gateEntity !== undefined },
						};
						if (gateEntity?.description) entry.gate.description = gateEntity.description;
						crossNodeTargets.push(entry);
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
		 * channels define which agents can communicate and whether a gate
		 * guards the channel. Use this to understand the full channel map
		 * before calling list_reachable_agents or send_message.
		 *
		 * A channel can be gated via `gateId`, which references a Gate entity
		 * in `workflow.gates`; use `list_gates` to see current gate data and status.
		 * `hasGate` is true when a gateId is set.
		 */
		async list_channels(_args: ListChannelsInput): Promise<ToolResult> {
			const channels = workflow?.channels ?? [];
			const result = channels.map((ch) => ({
				channelId: ch.id ?? null,
				from: ch.from,
				to: ch.to,
				maxCycles: ch.maxCycles ?? null,
				label: ch.label ?? null,
				hasGate: ch.gateId !== undefined,
				gateId: ch.gateId ?? null,
			}));
			return jsonResult({
				success: true,
				channels: result,
				total: result.length,
				message: `Found ${result.length} channel(s) in workflow "${workflow?.name ?? 'unknown'}".`,
			});
		},

		/**
		 * List all gates declared in this workflow with their current runtime data.
		 *
		 * Gates guard channels — a message on a gated channel is held until the
		 * gate condition passes. Use this to understand what conditions are
		 * currently evaluated and what data has been written to each gate.
		 *
		 * Your nodeId is included in the response — use it as the map key when
		 * writing to count-condition gates (vote gates) so each node's vote
		 * counts exactly once.
		 */
		async list_gates(_args: ListGatesInput): Promise<ToolResult> {
			const gates = workflow?.gates ?? [];
			const gateResults = gates.map((gate) => {
				const record = gateDataRepo.get(workflowRunId, gate.id);
				return {
					gateId: gate.id,
					fields: gate.fields ?? [],
					description: gate.description ?? null,
					currentData: record?.data ?? computeGateDefaults(gate.fields ?? []),
				};
			});
			return jsonResult({
				success: true,
				gates: gateResults,
				total: gateResults.length,
				nodeId: workflowNodeId,
				message:
					`Found ${gateResults.length} gate(s). ` +
					`Your nodeId is "${workflowNodeId}" — use it as the map key for vote-counting (map field) gates.`,
			});
		},

		/**
		 * Read the current runtime data for a specific gate.
		 *
		 * Returns the live data from the gate_data table for this workflow run.
		 * Use this to inspect the current state of a gate before deciding
		 * whether to write to it.
		 */
		async read_gate(args: ReadGateInput): Promise<ToolResult> {
			const { gateId } = args;

			// Verify gate exists in this workflow
			const gates = workflow?.gates ?? [];
			const gateDef = gates.find((g) => g.id === gateId);
			if (!gateDef) {
				return jsonResult({
					success: false,
					error: `Gate "${gateId}" not found in this workflow.`,
					availableGateIds: gates.map((g) => g.id),
				});
			}

			const record = gateDataRepo.get(workflowRunId, gateId);
			const currentData = record?.data ?? computeGateDefaults(gateDef.fields ?? []);

			// Evaluate current gate status. Uses scriptExecutor when available for
			// async script-based gates; otherwise falls back to field-only evaluation.
			const evalResult = await evaluateGate(
				gateDef,
				currentData,
				scriptExecutor,
				scriptContext ? { ...scriptContext, gateId, gateData: currentData } : undefined
			);

			return jsonResult({
				success: true,
				gateId,
				fields: gateDef.fields ?? [],
				data: currentData,
				gateOpen: evalResult.open,
				reason: evalResult.reason ?? null,
				updatedAt: record?.updatedAt ?? null,
				message: evalResult.open
					? `Gate "${gateId}" is currently OPEN.`
					: `Gate "${gateId}" is currently CLOSED: ${evalResult.reason ?? 'condition not met'}.`,
			});
		},

		// ── Artifact tools ────────────────────────────────────────────────

		/**
		 * Persist data to the workflow run artifact store.
		 *
		 * Unified replacement for the old `save` and `write_artifact` tools.
		 *
		 * Two modes:
		 *   - Overwrite (default, append: false): upsert on (nodeId, type, key).
		 *     Same (type, key) replaces the previous value.
		 *     Use `type: 'progress', key: 'current'` for a rolling status update.
		 *   - Append (append: true): always inserts a new row with an auto-generated key.
		 *     Use for audit trails, cycle records, or any multi-record history.
		 *
		 * Requires `artifactRepo` to be provided in the config.
		 */
		async save_artifact(args: SaveArtifactInput): Promise<ToolResult> {
			const { artifactRepo } = config;
			if (!artifactRepo) {
				return jsonResult({ success: false, error: 'Artifact repository not available.' });
			}

			const { type, key: keyArg, append, summary, data } = args;

			if (summary === undefined && data === undefined) {
				return jsonResult({
					success: false,
					error: 'At least one of `summary` or `data` must be provided.',
				});
			}

			try {
				// In append mode, always generate a unique key to guarantee a new row.
				// In overwrite mode, use the provided key (defaults to '' for upsert matching the DB default).
				const artifactKey = append
					? `${Date.now()}-${Math.random().toString(36).slice(2)}`
					: (keyArg ?? '');

				// Merge summary and data into a single record stored in the data field.
				const artifactData: Record<string, unknown> = {};
				if (summary !== undefined) artifactData.summary = summary;
				if (data !== undefined) Object.assign(artifactData, data);

				const record = artifactRepo.upsert({
					id: crypto.randomUUID(),
					runId: workflowRunId,
					nodeId: workflowNodeId,
					artifactType: type,
					artifactKey,
					data: artifactData,
				});

				logAudit('save_artifact', {
					type,
					key: artifactKey,
					append: append ?? false,
					summary: summary ?? undefined,
					dataKeys: data ? Object.keys(data) : undefined,
				});

				return jsonResult({
					success: true,
					artifact: {
						id: record.id,
						runId: record.runId,
						nodeId: record.nodeId,
						type: record.artifactType,
						key: record.artifactKey,
					},
					message: `Artifact "${type}" ${append ? 'appended as new record' : 'saved (upsert)'}.`,
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
				'Gate status is included for each cross-node target so you know whether a condition ' +
				'must pass before delivery is permitted. ' +
				'Use this before sending a message to understand who you can reach and whether any gates apply.',
			ListReachableAgentsSchema.shape,
			(args) => handlers.list_reachable_agents(args)
		),
		tool(
			'list_channels',
			'List all channels declared in this workflow. ' +
				'Channels define the messaging topology — which agents can communicate and whether a gate ' +
				'guards the channel. Use this to understand the full channel map for this workflow run. ' +
				'Each entry includes `hasGate` (true when a gate guards the channel) and `gateId`.',
			ListChannelsSchema.shape,
			(args) => handlers.list_channels(args)
		),
		tool(
			'list_gates',
			'List all gates declared in this workflow with their field schemas and current runtime data. ' +
				'Gates guard channels — a message on a gated channel is held until all gate fields pass their checks. ' +
				'Use this to see what data each gate currently holds and whether any gate is open. ' +
				'Your nodeId is included — use it as the map key when writing to map-type (vote) fields.',
			ListGatesSchema.shape,
			(args) => handlers.list_gates(args)
		),
		tool(
			'read_gate',
			'Read the current runtime data for a specific gate. ' +
				'Returns the live data from the gate_data table and whether the gate is currently open.',
			ReadGateSchema.shape,
			(args) => handlers.read_gate(args)
		),
		tool(
			'send_message',
			'Send a message to a peer agent by name (DM), a node by name (fan-out), or broadcast to all permitted targets. ' +
				"Use agent name for DM (e.g. 'coder'), node name for fan-out, or '*' for broadcast. " +
				'Validates against declared channel topology — returns an error with available targets if not permitted. ' +
				'When the target channel is gated, the optional `data` payload is automatically merged into the gate ' +
				"and gate re-evaluation fires — no separate gate write needed. Use target 'space-agent' to escalate blockers or request human/space-level judgment.",
			SendMessageSchema.shape,
			(args) => handlers.send_message(args)
		),
		...(config.onSubscribeExternalEvent && config.onUnsubscribeExternalEvent
			? [
					tool(
						'subscribe_external_event',
						'Subscribe to external events matching a topic pattern (e.g. github/*/*/pull_request.*). ' +
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
						'Persist data to the workflow run artifact store. Provide a `type` (category tag), ' +
							'`key` (unique within type; defaults to empty string), and at least one of `summary` or `data`. ' +
							'By default (append: false), writing the same (type, key) overwrites the previous value. ' +
							'Set `append: true` to always create a new record — useful for audit trails and cycle history. ' +
							'The `type` field is fully generic: use "progress" for rolling status, "result" for final outcomes, ' +
							'"review" for review feedback, or any custom label.',
						SaveArtifactSchema.shape,
						(args) => handlers.save_artifact(args)
					),
					tool(
						'list_artifacts',
						'List artifacts for the current workflow run. ' +
							'Optionally filter by nodeId or type (e.g. "progress", "result", "review").',
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
						'Close this task as done (self-approval). Only available when the space autonomy level ' +
							"meets the workflow's completionAutonomyLevel threshold. Takes no arguments — the task " +
							'is inferred from your session context. After calling, the completion-action pipeline ' +
							'runs and resolves the terminal status. Use this as your final action when you are ' +
							'authorized to self-close; otherwise use submit_for_approval.',
						ApproveTaskSchema.shape,
						(args) => handlers.approve_task(args)
					),
				]
			: []),
		...(config.onSubmitForApproval
			? [
					tool(
						'submit_for_approval',
						"Request human review of this task's completion. Always available to end-node agents. " +
							'Use this when you want to escalate for human sign-off — either because autonomy rules ' +
							'require it, or because the outcome is risky enough to warrant attention. Pass an ' +
							'optional `reason` explaining why you are escalating; it is shown in the approval UI.',
						SubmitForApprovalSchema.shape,
						(args) => config.onSubmitForApproval!(args)
					),
				]
			: []),
		...(config.onMarkComplete
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
						(args) => config.onMarkComplete!(args)
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

	return createSdkMcpServer({ name: 'node-agent', tools });
}

export type NodeAgentMcpServer = ReturnType<typeof createNodeAgentMcpServer>;
