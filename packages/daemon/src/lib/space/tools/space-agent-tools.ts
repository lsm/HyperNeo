/**
 * Space Agent Tools — MCP tools for the Space leader agent session.
 *
 * These tools allow the Space agent to inspect workflows, manage existing
 * workflow runs, and create/query Space tasks. They are in the Space namespace
 * (not Room).
 *
 * Tools (per M7 spec):
 *   list_workflows      — show all workflows with their descriptions and steps
 *   get_workflow_run    — check the status of a running workflow
 *   change_plan         — update task description or switch to a different workflow mid-run
 *   list_tasks          — see current and past tasks
 *   get_workflow_detail — get a specific workflow's full definition (steps, transitions, rules)
 *   suggest_workflow    — get workflow recommendations for a described piece of work
 *
 * Design note: workflow selection is LLM-driven and task-first. The agent uses
 * workflow discovery tools to reason about orchestration, then creates a task.
 * Runtime attaches and advances workflow execution from the task lifecycle.
 *
 * See: docs/plans/multi-agent-v2-customizable-agents-workflows/07-workflow-selection-intelligence.md
 */

import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type {
	NodeExecution,
	SpaceGoalStatus,
	SpaceGoalType,
	SpaceTask,
	SpaceTaskPriority,
	SpaceTaskStatus,
	TaskScheduleStatus,
	TaskScheduleTriggerType,
} from '@neokai/shared';
import { parseAddress } from '../../../../../messaging/src/address';
import { z } from 'zod';
import type { GateDataRepository } from '../../../storage/repositories/gate-data-repository';
import type { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus';
import { Logger } from '../../logger';
import type { PendingAgentMessageQueue } from '../../rpc-handlers/space-task-message-handlers';
import { formatAgentMessage } from '../agent-message-envelope';
import { SpaceDeliveryFacade, translateTaskMessageTarget } from '../messaging-adapter';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { SpaceManager } from '../managers/space-manager';
import type { SpaceTaskManager } from '../managers/space-task-manager';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { ReplyRoutingRegistry } from '../runtime/reply-routing-registry';
import type { ActorRef, MessageRecord } from '../../../../../messaging/src/types';
import type { ActorResolver } from '../../../../../messaging/src/contracts';
import type { SpaceRuntime } from '../runtime/space-runtime';
import type { TaskAgentManager } from '../runtime/task-agent-manager';
import { canTransition } from '../runtime/workflow-run-status-machine';
import type { ToolResult } from './tool-result';
import { jsonResult } from './tool-result';

const log = new Logger('space-agent-tools');

type GoalToolUpdateArgs = {
	title?: string;
	description?: string;
	status?: SpaceGoalStatus;
	type?: SpaceGoalType;
	priority?: SpaceTaskPriority;
	labels?: string[];
	metrics?: Record<string, string | number | boolean | null>;
	summary?: string;
	progress?: number;
	next_steps?: string[];
	preferred_workflow_id?: string | null;
	auto_trigger_next?: boolean;
};

function normalizeGoalUpdateArgs(args: GoalToolUpdateArgs) {
	return {
		title: args.title,
		description: args.description,
		status: args.status,
		type: args.type,
		priority: args.priority,
		labels: args.labels,
		metrics: args.metrics,
		summary: args.summary,
		progress: args.progress,
		nextSteps: args.next_steps,
		preferredWorkflowId: args.preferred_workflow_id,
		autoTriggerNext: args.auto_trigger_next,
	};
}

function normalizeAgentNameToken(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * Resolve a `node_id` selector ({execution UUID, agent name}) to a concrete
 * node_execution row. Preference order:
 *   1. Exact match on `NodeExecution.id` (execution UUID)
 *   2. Most recently created execution matching the agent name (case-insensitive)
 *
 * Under the DB's UNIQUE constraint on `(workflowRunId, workflowNodeId, agentName)`
 * an agent name only duplicates when it appears in multiple workflow nodes; in
 * that case the most recent creation is chosen.
 *
 * Returns null when no execution matches.
 */
function resolveNodeExecution(executions: NodeExecution[], selector: string): NodeExecution | null {
	const trimmed = selector.trim();
	if (!trimmed) return null;
	// 1. Exact execution id.
	const byId = executions.find((exec) => exec.id === trimmed);
	if (byId) return byId;

	// 2. Agent-name match (case-insensitive). `executions` is ordered ASC by
	//    createdAt (per NodeExecutionRepository.listByWorkflowRun), so the last
	//    matching row is the most recent.
	const targetName = normalizeAgentNameToken(trimmed);
	const byName = executions.filter(
		(exec) => normalizeAgentNameToken(exec.agentName) === targetName
	);
	return byName.at(-1) ?? null;
}

function resolveWorkerTargetExecution(
	executions: NodeExecution[],
	workflowRunId: string,
	workflowNodeNameById: Map<string, string>,
	target: string
): NodeExecution | null {
	const address = parseAddress(target);
	if (address.kind !== 'worker' || !address.agentName) return null;
	if (address.workflowRunId && address.workflowRunId !== workflowRunId) return null;
	let nodeName: string;
	let agentName: string;
	try {
		nodeName = decodeURIComponent(address.nodeId);
		agentName = decodeURIComponent(address.agentName);
	} catch {
		return null;
	}
	const matches = executions.filter(
		(exec) =>
			normalizeAgentNameToken(exec.agentName) === normalizeAgentNameToken(agentName) &&
			(workflowNodeNameById.get(exec.workflowNodeId) === nodeName ||
				exec.workflowNodeId === nodeName)
	);
	return matches.at(-1) ?? null;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SpaceAgentToolsConfig {
	/** The Space this agent is operating within. */
	spaceId: string;
	/** SpaceRuntime for starting and managing workflow runs. */
	runtime: SpaceRuntime;
	/** Workflow manager for listing available workflows. */
	workflowManager: SpaceWorkflowManager;
	/** Space manager for approve_task autonomy checks. */
	spaceManager?: Pick<SpaceManager, 'getSpace'>;
	/** Task repository for read queries (list/filter). */
	taskRepo: SpaceTaskRepository;
	/** Node execution repository for workflow run node execution queries. */
	nodeExecutionRepo: NodeExecutionRepository;
	/** Workflow run repository for listing and updating runs. */
	workflowRunRepo: SpaceWorkflowRunRepository;
	/** Task manager for create/retry/cancel/reassign operations. */
	taskManager: SpaceTaskManager;
	/** Space agent manager for reassign validation. */
	spaceAgentManager: SpaceAgentManager;
	/**
	 * Task Agent Manager for injecting messages into running task agent sessions.
	 * When provided, enables the `send_message_to_task` and `list_task_members` tools.
	 */
	taskAgentManager?: TaskAgentManager;
	/** Gate data repository for approve_gate tool. */
	gateDataRepo?: GateDataRepository;
	/** InternalEventBus<DaemonInternalEventMap> for emitting gate/task events. */
	internalEventBus?: InternalEventBus<DaemonInternalEventMap>;
	/** Callback to trigger channel re-evaluation after gate data changes. */
	onGateChanged?: (runId: string, gateId: string) => void;
	/**
	 * Callback to lazily activate a workflow node.
	 *
	 * Used by `send_message_to_task` when the caller targets a specific workflow node
	 * (via `node_id`) and that node has no live agent session: the callback invokes
	 * `ChannelRouter.activateNode()` which reuses an existing session (cyclic re-entry)
	 * or creates a pending node_execution that the tick loop will pick up.
	 *
	 * When omitted, `send_message_to_task` can still deliver to already-live sessions
	 * but cannot activate inactive nodes.
	 */
	activateNode?: (runId: string, nodeId: string) => Promise<void>;
	/**
	 * Pending message queue for messages addressed to workflow node agents that
	 * have been activated but do not have a live session yet.
	 */
	pendingMessageQueue?: PendingAgentMessageQueue;
	/**
	 * Resolves the space's current autonomy level.
	 * Required for approve_gate autonomy enforcement: agent approvals are rejected
	 * when space autonomy < gate.requiredLevel (default 5 if gate has no requiredLevel).
	 */
	getSpaceAutonomyLevel?: (spaceId: string) => Promise<number>;
	/**
	 * The calling agent's name (e.g., 'space-agent'). Used for gate writer authorization
	 * in approve_gate: the writers path is taken only when writers include this name or '*'.
	 * When omitted, only '*' in writers can match (falls back to autonomy path otherwise).
	 */
	myAgentName?: string;
	/**
	 * Optional name aliases for the calling agent. Checked alongside myAgentName during
	 * writer authorization.
	 */
	myAgentNameAliases?: string[];
	/**
	 * Session ID of the calling agent. Used to stamp `createdBySession` on tasks
	 * created via `create_standalone_task`.
	 */
	mySessionId?: string;

	/**
	 * Optional self-heal callback exposed as the `restore_node_agent` tool.
	 *
	 * When provided, the tool is added to this MCP server so it remains callable
	 * even if the `node-agent` MCP server is missing — breaking the namespace paradox
	 * where the self-heal tool lived in the same namespace as the server it repairs.
	 *
	 * Only set for specialised sessions that intentionally mirror this restore hook.
	 */
	onRestoreNodeAgent?: (args: { reason?: string }) => Promise<void> | void;
	/**
	 * MCP audit log repository for recording write operations.
	 * Optional — when absent, no audit entries are written.
	 */
	auditLogRepo?: McpAuditLogRepository;
	/**
	 * Schedule management service — required for the schedule management tools
	 * (create_scheduled_task, list_scheduled_tasks, etc.). Encapsulates the
	 * atomic create+enqueue, validation, and reschedule logic shared with the
	 * RPC handlers.
	 * Optional — when absent, schedule tools are not registered.
	 */
	scheduleService?: import('../schedule/schedule-service').ScheduleService;
	/**
	 * Reply routing registry for symmetric message routing. When a member session
	 * sends a message to a task/node agent, the registry records the sender's
	 * session ID so that replies via 'space-agent' route back to the originating
	 * session instead of the canonical space:chat: session.
	 */
	replyRoutingRegistry?: ReplyRoutingRegistry;
	/** Goal service for terminal goal-task side effects. */
	goalService?: import('../goals/goal-service').SpaceGoalService;
	/** Generic Space actor resolver for @handle/@role DMs. */
	messageResolver?: ActorResolver;
	/** Deliver to or activate long-term Space agents. */
	longTermAgentDelivery?: {
		deliverToSession?: (
			actor: ActorRef,
			message: MessageRecord
		) => Promise<string | null | undefined>;
		queueForActivation?: (
			actor: ActorRef,
			message: MessageRecord
		) => Promise<string | null | undefined>;
	};
}

// ---------------------------------------------------------------------------
// Tool handlers (separated for testability)
// ---------------------------------------------------------------------------

/**
 * Create handler functions that can be tested directly without an MCP server.
 * Returns a map of tool name → handler function.
 */
export function createSpaceAgentToolHandlers(config: SpaceAgentToolsConfig) {
	const {
		spaceId,
		runtime,
		workflowManager,
		taskRepo,
		nodeExecutionRepo,
		workflowRunRepo,
		taskManager,
		spaceAgentManager,
		taskAgentManager,
		gateDataRepo,
		internalEventBus,
		onGateChanged,
		activateNode,
		pendingMessageQueue,
		getSpaceAutonomyLevel,
		myAgentName,
		myAgentNameAliases,
		mySessionId,
		replyRoutingRegistry,
		messageResolver,
		longTermAgentDelivery,
	} = config;

	const agentNameAliases = new Set(
		[myAgentName, ...(myAgentNameAliases ?? [])]
			.filter((v): v is string => typeof v === 'string')
			.map((v) => normalizeAgentNameToken(v))
			.filter((v) => v.length > 0)
	);
	const outboundSenderName = myAgentName ?? 'space-agent';
	const outboundSenderLevel = outboundSenderName === 'task-agent' ? 'task-agent' : 'space-agent';
	const outboundSenderDisplayName =
		outboundSenderName === 'space-agent' ? 'Space Agent' : outboundSenderName;

	function requireGoalService() {
		if (!config.goalService) throw new Error('Goal management not available');
		return config.goalService;
	}

	function requireGoalInSpace(goalId: string) {
		const goal = requireGoalService().getGoal(goalId);
		if (!goal || goal.spaceId !== spaceId) throw new Error(`Goal not found: ${goalId}`);
		return goal;
	}

	const goalToolContext = {
		source: 'space_agent_tool' as const,
		sourceSessionId: mySessionId ?? null,
	};

	function emitTaskUpdated(task: SpaceTask): void {
		if (!internalEventBus) return;
		void internalEventBus
			.publish('space.task.updated', {
				sessionId: 'global',
				spaceId,
				taskId: task.id,
				task,
			})
			.catch((err: unknown) => {
				log.warn(
					`Failed to emit space.task.updated for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`
				);
			});
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
					taskId,
				});
			} catch {
				// Audit logging is best-effort; never block the tool operation.
			}
		}
	}

	return {
		/**
		 * List all available SpaceWorkflow records for this space.
		 * The LLM agent calls this first to understand available options.
		 */
		async list_workflows(): Promise<ToolResult> {
			const workflows = workflowManager.listWorkflowSummaries(spaceId);
			return jsonResult({ success: true, workflows });
		},

		/**
		 * Get the current status of a workflow run, including its current step.
		 */
		async get_workflow_run(args: { run_id: string }): Promise<ToolResult> {
			const run = workflowRunRepo.getRun(args.run_id);
			if (!run) {
				return jsonResult({ success: false, error: `Workflow run not found: ${args.run_id}` });
			}

			// Include node executions for this run
			const executions = nodeExecutionRepo.listByWorkflowRun(run.id);

			return jsonResult({ success: true, run, executions });
		},

		/**
		 * Update the current workflow run's task description, or switch to a
		 * different workflow mid-run (cancels the current run and starts a new one).
		 *
		 * - Provide `description` to update the run description in place.
		 * - Provide `workflow_id` or `workflow_handle` to switch workflows: the current run is cancelled
		 *   and a new run is started with the same title and updated description.
		 */
		async change_plan(args: {
			run_id: string;
			description?: string;
			workflow_id?: string;
			workflow_handle?: string;
		}): Promise<ToolResult> {
			const run = workflowRunRepo.getRun(args.run_id);
			if (!run) {
				return jsonResult({ success: false, error: `Workflow run not found: ${args.run_id}` });
			}

			if (run.status === 'done' || run.status === 'cancelled') {
				return jsonResult({
					success: false,
					error: `Cannot change plan for a ${run.status} run.`,
				});
			}

			// Resolve workflow identifier to UUID.
			// If workflow_id is provided but unusable (missing or belongs to another
			// space), attempt handle resolution so clients that cache both identifiers
			// still work after a workflow is re-created (new UUID, same handle).
			let targetWorkflowId = args.workflow_id;
			if (targetWorkflowId) {
				const wf = workflowManager.getWorkflow(targetWorkflowId);
				const idUnusable = !wf || wf.spaceId !== spaceId || !!wf.disabled;
				if (idUnusable && typeof args.workflow_handle === 'string') {
					const trimmedHandle = args.workflow_handle.trim();
					if (trimmedHandle === '') {
						return jsonResult({
							success: false,
							error: 'workflow_handle must be a non-empty string.',
						});
					}
					const byHandle = workflowManager.getWorkflowByHandle(spaceId, trimmedHandle);
					if (byHandle) {
						targetWorkflowId = byHandle.id;
					} else {
						// Both selectors failed — ID is unusable and handle is stale.
						// Reject immediately rather than falling through; the validation
						// block below does not check space membership, so a cross-space
						// ID would pass existence/disabled checks incorrectly.
						return jsonResult({
							success: false,
							error: `Workflow not found (id=${targetWorkflowId}, handle=${trimmedHandle})`,
						});
					}
				}
			} else if (typeof args.workflow_handle === 'string') {
				const trimmedHandle = args.workflow_handle.trim();
				if (trimmedHandle === '') {
					return jsonResult({
						success: false,
						error: 'workflow_handle must be a non-empty string.',
					});
				}
				const byHandle = workflowManager.getWorkflowByHandle(spaceId, trimmedHandle);
				if (!byHandle) {
					return jsonResult({
						success: false,
						error: `Workflow not found by handle: ${trimmedHandle}`,
					});
				}
				targetWorkflowId = byHandle.id;
			}

			// Switching workflow: validate the target workflow exists BEFORE cancelling
			// the old run, so a bad workflow_id never leaves the user with no active run.
			if (targetWorkflowId) {
				const targetWorkflow = workflowManager.getWorkflow(targetWorkflowId);
				if (!targetWorkflow) {
					return jsonResult({
						success: false,
						error: `Workflow not found: ${targetWorkflowId}`,
					});
				}
				if (targetWorkflow.disabled) {
					return jsonResult({
						success: false,
						error: `Workflow is disabled: ${targetWorkflowId}`,
					});
				}

				workflowRunRepo.transitionStatus(run.id, 'cancelled');

				try {
					const newDescription = args.description ?? run.description;
					const { run: newRun, tasks } = await runtime.startWorkflowRun(
						spaceId,
						targetWorkflowId,
						run.title,
						newDescription
					);
					return jsonResult({
						success: true,
						previousRunId: run.id,
						run: newRun,
						tasks,
						message: `Switched from workflow "${run.workflowId}" to "${targetWorkflowId}". Previous run cancelled.`,
					});
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return jsonResult({ success: false, error: message });
				}
			}

			// Description-only update.
			if (args.description !== undefined) {
				const updated = workflowRunRepo.updateRun(run.id, { description: args.description });
				return jsonResult({ success: true, run: updated });
			}

			return jsonResult({
				success: false,
				error: 'Provide at least one of: description, workflow_id, workflow_handle.',
			});
		},

		/**
		 * Get the full definition of a specific workflow — steps, transitions, and rules.
		 * Use this when list_workflows gives enough name/description to narrow down to one
		 * candidate and you want to inspect its complete structure before starting a run.
		 */
		async get_workflow_detail(args: {
			workflow_id?: string;
			workflow_handle?: string;
		}): Promise<ToolResult> {
			let workflow = null;
			if (args.workflow_id) {
				workflow = workflowManager.getWorkflow(args.workflow_id);
				// Fall back to handle when the ID is unusable: either it returned null,
				// it resolved to a workflow in a different space, or it is disabled.
				const idUnusable = !workflow || workflow.spaceId !== spaceId || !!workflow.disabled;
				if (idUnusable && typeof args.workflow_handle === 'string') {
					const trimmedHandle = args.workflow_handle.trim();
					if (trimmedHandle) {
						const byHandle = workflowManager.getWorkflowByHandle(spaceId, trimmedHandle);
						if (byHandle) {
							workflow = byHandle;
						}
					}
				}
			} else if (typeof args.workflow_handle === 'string') {
				const trimmedHandle = args.workflow_handle.trim();
				if (trimmedHandle === '') {
					return jsonResult({
						success: false,
						error: 'workflow_handle must be a non-empty string.',
					});
				}
				workflow = workflowManager.getWorkflowByHandle(spaceId, trimmedHandle);
			} else {
				return jsonResult({
					success: false,
					error: 'Provide either workflow_id or workflow_handle.',
				});
			}
			if (!workflow) {
				const ref = args.workflow_id ?? args.workflow_handle;
				return jsonResult({ success: false, error: `Workflow not found: ${ref}` });
			}
			return jsonResult({ success: true, workflow });
		},

		/**
		 * Return all workflows in the space so the Space Agent LLM can pick one.
		 *
		 * Previously this tool did keyword pre-ranking, but that could bias the
		 * LLM toward a substring-overlap pick (e.g. a "review feedback" task
		 * always surfacing a "review" workflow first). Selection is fully
		 * LLM-driven, so we just expose the full catalogue and let the caller
		 * reason over it.
		 *
		 * The `description` argument is retained for forward compatibility and
		 * call-site clarity, but is not used by the handler. Callers can still
		 * read it from structured tool logs for observability.
		 */
		async suggest_workflow(_args: { description: string }): Promise<ToolResult> {
			const allWorkflows = workflowManager
				.listWorkflowSummaries(spaceId)
				.filter((w) => !w.disabled);
			if (allWorkflows.length === 0) {
				return jsonResult({
					success: true,
					workflows: [],
					message: 'No workflows available in this space.',
				});
			}
			return jsonResult({ success: true, workflows: allWorkflows });
		},

		/**
		 * List SpaceTasks for this space, optionally filtered by status and/or workflowRunId.
		 *
		 * Use `compact: true` to return a trimmed projection (id, title, status,
		 * priority, createdAt) suitable for dense lists. Otherwise the full
		 * SpaceTask rows are returned.
		 */
		async list_tasks(args: {
			status?: SpaceTaskStatus;
			workflow_run_id?: string;
			search?: string;
			limit?: number;
			offset?: number;
			compact?: boolean;
		}): Promise<ToolResult> {
			let tasks: SpaceTask[];
			if (args.workflow_run_id) {
				tasks = taskRepo.listByWorkflowRun(args.workflow_run_id);
				if (args.status) {
					tasks = tasks.filter((t) => t.status === args.status);
				}
			} else if (args.status) {
				tasks = taskRepo.listByStatus(spaceId, args.status);
			} else {
				tasks = taskRepo.listBySpace(spaceId);
			}
			if (args.search) {
				const q = args.search.toLowerCase();
				tasks = tasks.filter((t) => t.title.toLowerCase().includes(q));
			}
			const total = tasks.length;
			const limit = args.limit ?? 50;
			const offset = args.offset ?? 0;
			tasks = tasks.slice(offset, offset + limit);
			if (args.compact) {
				const compactTasks = tasks.map((t) => ({
					id: t.id,
					title: t.title,
					status: t.status,
					priority: t.priority,
					createdAt: t.createdAt,
				}));
				return jsonResult({ success: true, total, tasks: compactTasks });
			}
			return jsonResult({ success: true, total, tasks });
		},

		/**
		 * Create a standalone task not associated with any workflow run.
		 *
		 * Supports structured dependencies via `depends_on`. The underlying
		 * SpaceTaskManager.createTask() validates that every dependency ID
		 * exists in the same space and rejects circular references; those
		 * errors are surfaced here as `{ success: false, error }`.
		 */
		async create_standalone_task(args: {
			title: string;
			description: string;
			priority?: SpaceTaskPriority;
			workflow_id?: string;
			workflow_handle?: string;
			depends_on?: string[];
			draft?: boolean;
		}): Promise<ToolResult> {
			let preferredWorkflowId = args.workflow_id ?? null;
			if (preferredWorkflowId) {
				const wf = workflowManager.getWorkflow(preferredWorkflowId);
				// Consider the ID "unusable" when the workflow is missing, belongs to a
				// different space, or is disabled. In any of those cases, a valid handle
				// in the same request should take precedence.
				const isUnusable = !wf || wf.spaceId !== spaceId || !!wf.disabled;
				if (isUnusable && typeof args.workflow_handle === 'string') {
					const trimmedHandle = args.workflow_handle.trim();
					if (trimmedHandle === '') {
						return jsonResult({
							success: false,
							error: 'workflow_handle must be a non-empty string.',
						});
					}
					const byHandle = workflowManager.getWorkflowByHandle(spaceId, trimmedHandle);
					if (byHandle) {
						if (byHandle.disabled) {
							return jsonResult({
								success: false,
								error: `Workflow is disabled: ${trimmedHandle}`,
							});
						}
						preferredWorkflowId = byHandle.id;
					} else {
						// Both identifiers were supplied but neither resolved — fail fast
						// rather than silently routing to an auto-selected workflow.
						return jsonResult({
							success: false,
							error: `Workflow not found by id or handle: ${trimmedHandle}`,
						});
					}
				}
				// If unusable and no handle provided, keep the stale ID;
				// the task runtime will fall back to automatic workflow selection.
			} else if (typeof args.workflow_handle === 'string') {
				const trimmedHandle = args.workflow_handle.trim();
				if (trimmedHandle === '') {
					return jsonResult({
						success: false,
						error: 'workflow_handle must be a non-empty string.',
					});
				}
				const byHandle = workflowManager.getWorkflowByHandle(spaceId, trimmedHandle);
				if (!byHandle) {
					return jsonResult({
						success: false,
						error: `Workflow not found by handle: ${trimmedHandle}`,
					});
				}
				if (byHandle.disabled) {
					return jsonResult({
						success: false,
						error: `Workflow is disabled: ${trimmedHandle}`,
					});
				}
				preferredWorkflowId = byHandle.id;
			}
			try {
				const task = await taskManager.createTask({
					title: args.title,
					description: args.description,
					priority: args.priority,
					preferredWorkflowId,
					dependsOn: args.depends_on,
					status: args.draft ? 'draft' : undefined,
					createdBy: myAgentName ?? null,
					createdBySession: mySessionId ?? null,
				});
				logAudit(
					'create_standalone_task',
					{
						title: args.title,
						priority: args.priority,
						workflow_id: preferredWorkflowId ?? undefined,
						workflow_handle: args.workflow_handle,
						depends_on: args.depends_on,
						draft: args.draft,
					},
					task.id
				);
				return jsonResult({ success: true, task });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Update an existing task's title, description, priority, or dependencies.
		 * The task must exist and belong to this space.
		 */
		async update_task(args: {
			task_id: string;
			title?: string;
			description?: string;
			priority?: SpaceTaskPriority;
			depends_on?: string[];
		}): Promise<ToolResult> {
			const hasChanges =
				args.title !== undefined ||
				args.description !== undefined ||
				args.priority !== undefined ||
				args.depends_on !== undefined;
			if (!hasChanges) {
				return jsonResult({
					success: false,
					error:
						'No fields to update. Provide at least one of: title, description, priority, depends_on.',
				});
			}

			const task = taskRepo.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			if (task.spaceId !== spaceId) {
				return jsonResult({
					success: false,
					error: `Task ${args.task_id} does not belong to this space.`,
				});
			}

			try {
				const updated = await taskManager.updateTask(
					args.task_id,
					{
						title: args.title,
						description: args.description,
						priority: args.priority,
						dependsOn: args.depends_on,
					},
					{
						onCascadedTasks: async (cascadedTasks) => {
							for (const cascadedTask of cascadedTasks) emitTaskUpdated(cascadedTask);
						},
					}
				);

				logAudit(
					'update_task',
					{
						title: args.title,
						description: args.description,
						priority: args.priority,
						depends_on: args.depends_on,
					},
					args.task_id
				);

				emitTaskUpdated(updated);

				return jsonResult({ success: true, task: updated });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Get the full detail of a task by UUID or by numeric task number (e.g. #5).
		 */
		async get_task_detail(args: { task_id?: string; task_number?: number }): Promise<ToolResult> {
			let task: SpaceTask | null = null;
			if (args.task_number !== undefined) {
				task = await taskManager.getTaskByNumber(args.task_number);
			} else if (args.task_id) {
				task = await taskManager.getTask(args.task_id);
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
		 * Retry a failed or cancelled task by resetting it to pending.
		 */
		async retry_task(args: { task_id: string; description?: string }): Promise<ToolResult> {
			try {
				const task = await taskManager.retryTask(args.task_id, {
					description: args.description,
				});
				return jsonResult({ success: true, task });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Cancel a task and optionally cancel its workflow run.
		 * Cascades cancellation to pending dependent tasks automatically.
		 */
		async cancel_task(args: {
			task_id: string;
			cancel_workflow_run?: boolean;
		}): Promise<ToolResult> {
			try {
				const task = await taskManager.cancelTask(args.task_id);

				if (args.cancel_workflow_run && task.workflowRunId) {
					// Only cancel if the run exists and the transition is valid (not already terminal).
					const existingRun = workflowRunRepo.getRun(task.workflowRunId);
					const runCancelled =
						existingRun !== null && canTransition(existingRun.status, 'cancelled');
					if (runCancelled) {
						workflowRunRepo.transitionStatus(task.workflowRunId, 'cancelled');
					}
					return jsonResult({
						success: true,
						task,
						workflowRunCancelled: runCancelled,
						workflowRunId: task.workflowRunId,
					});
				}

				return jsonResult({ success: true, task });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Publish a draft task, transitioning it from `draft` to `open`.
		 * Published tasks become eligible for the runtime's orchestration tick loop.
		 * Only valid for tasks currently in `draft` status.
		 */
		async publish_task(args: { task_id: string }): Promise<ToolResult> {
			const task = taskRepo.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			if (task.spaceId !== spaceId) {
				return jsonResult({
					success: false,
					error: `Task ${args.task_id} does not belong to this space.`,
				});
			}
			if (task.status !== 'draft') {
				return jsonResult({
					success: false,
					error: `Task is in '${task.status}' status, not 'draft'. Only draft tasks can be published.`,
				});
			}
			try {
				const updated = await taskManager.publishTask(args.task_id);

				logAudit('publish_task', { previousStatus: task.status }, args.task_id);

				emitTaskUpdated(updated);

				return jsonResult({ success: true, task: updated });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Archive a task, transitioning it to `archived` status.
		 * Archived tasks are excluded from most queries and cannot be reactivated.
		 * Valid from any status that allows the `archived` transition.
		 */
		async archive_task(args: { task_id: string }): Promise<ToolResult> {
			const task = taskRepo.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			if (task.spaceId !== spaceId) {
				return jsonResult({
					success: false,
					error: `Task ${args.task_id} does not belong to this space.`,
				});
			}
			try {
				const updated = await taskManager.archiveTask(args.task_id);

				logAudit('archive_task', { previousStatus: task.status }, args.task_id);

				emitTaskUpdated(updated);

				return jsonResult({ success: true, task: updated });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Reassign a task to a different agent.
		 */
		async reassign_task(args: {
			task_id: string;
			custom_agent_id?: string | null;
			assigned_agent?: 'coder' | 'general';
		}): Promise<ToolResult> {
			try {
				// Validate custom_agent_id if being set to a non-null value
				if (args.custom_agent_id != null) {
					const agent = spaceAgentManager.getById(args.custom_agent_id);
					if (!agent) {
						return jsonResult({
							success: false,
							error: `Custom agent not found: ${args.custom_agent_id}`,
						});
					}
				}

				// Pass args.custom_agent_id as-is (including undefined) so the manager
				// only updates that field when it was explicitly provided.
				const task = await taskManager.reassignTask(
					args.task_id,
					args.custom_agent_id,
					args.assigned_agent
				);
				return jsonResult({ success: true, task });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Send a message to a task. Requires a `node_id` (execution UUID or agent name)
		 * to target a specific workflow node agent.
		 *
		 * Auto-activate semantics:
		 * - When `node_id` is given but the target node has no live sub-session, the
		 *   `activateNode` callback (if configured) is invoked to lazily activate the
		 *   node, reusing an existing session for cyclic re-entry or marking a pending
		 *   execution that the tick loop will spawn.
		 *
		 * Tombstone model: archived tasks are the only non-recoverable state; every
		 * other status (open/in_progress/review/done/blocked/cancelled) can be
		 * reactivated.
		 */
		async send_message_to_task(args: {
			task_id?: string;
			task_number?: number;
			message: string;
			node_id?: string;
			target?: string;
		}): Promise<ToolResult> {
			if (!taskAgentManager) {
				return jsonResult({
					success: false,
					error: 'Task agent communication is not available in this context.',
				});
			}
			// --- Resolve task by id or by space-scoped task number ---
			let task: SpaceTask | null = null;
			if (args.task_id) {
				task = taskRepo.getTask(args.task_id);
				if (!task) {
					return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
				}
			} else if (typeof args.task_number === 'number') {
				task = taskRepo.getTaskByNumber(spaceId, args.task_number);
				if (!task) {
					return jsonResult({
						success: false,
						error: `Task not found in this space with task_number=${args.task_number}`,
					});
				}
			} else {
				return jsonResult({
					success: false,
					error: 'Either task_id or task_number must be provided.',
				});
			}
			if (task.spaceId !== spaceId) {
				return jsonResult({
					success: false,
					error: `Task ${task.id} does not belong to this space.`,
				});
			}
			if (task.status === 'archived') {
				return jsonResult({
					success: false,
					error: `Task ${task.id} is archived — create a new task.`,
				});
			}

			if (args.target === 'task-agent' || args.node_id === 'task-agent') {
				return jsonResult({
					success: false,
					error: 'Target "task-agent" is no longer supported. Use a worker target or node_id.',
				});
			}

			if (!args.node_id && !args.target) {
				return jsonResult({
					success: false,
					error: 'Target agent is required. Use node_id or target to specify a recipient.',
				});
			}
			if (!task.workflowRunId) {
				return jsonResult({
					success: false,
					error: `Task ${task.id} has no workflow run — cannot target workflow workers.`,
				});
			}
			const allExecutions = nodeExecutionRepo.listByWorkflowRun(task.workflowRunId);
			const run = workflowRunRepo.getRun(task.workflowRunId);
			const workflow = run ? (workflowManager.getWorkflow(run.workflowId) ?? null) : null;
			const workflowNodeNameById = new Map(
				(workflow?.nodes ?? []).map((node) => [node.id, node.name] as const)
			);
			let resolved: NodeExecution | null = null;
			let routedTarget = args.node_id ?? null;

			if (args.target) {
				let genericTarget: string;
				try {
					genericTarget = translateTaskMessageTarget(
						{ target: args.target, nodeId: args.node_id },
						{ workflowRunId: task.workflowRunId, nodeExecutions: allExecutions, workflow }
					);
				} catch (err) {
					return jsonResult({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
				routedTarget = genericTarget;
				const address = parseAddress(genericTarget);
				if (address.kind === 'handle' || address.kind === 'role') {
					if (!messageResolver || !longTermAgentDelivery) {
						return jsonResult({
							success: false,
							error: 'Long-term agent messaging is not available in this context.',
						});
					}
					const messageRecord: MessageRecord = {
						messageId: `msg_space_tool_${Date.now()}_${Math.random().toString(36).slice(2)}`,
						spaceId,
						senderActorId: mySessionId ? `session:${mySessionId}` : `agent:coordinator:${spaceId}`,
						targets: [genericTarget],
						body: formatAgentMessage({
							fromLevel: outboundSenderLevel,
							fromAgentName: outboundSenderDisplayName,
							toLevel: 'space-agent',
							body: args.message,
							taskId: task.id,
							taskNumber: task.taskNumber,
							replyToSessionId: mySessionId,
						}),
						kind: 'message',
						workflowRunId: task.workflowRunId,
						taskId: task.id,
						createdAt: Date.now(),
					};
					const routed = await new SpaceDeliveryFacade({
						resolver: messageResolver,
						deliverToSession: longTermAgentDelivery.deliverToSession,
						queueForActivation: longTermAgentDelivery.queueForActivation,
					}).routeMessage(messageRecord);
					return jsonResult({
						success: routed.deliveries.some((delivery) =>
							['delivered', 'queued'].includes(delivery.state)
						),
						task_id: task.id,
						target: 'space-agent',
						deliveries: routed.deliveries,
					});
				}
				if (address.kind === 'worker') {
					resolved = resolveWorkerTargetExecution(
						allExecutions,
						task.workflowRunId,
						workflowNodeNameById,
						genericTarget
					);
				} else if (address.kind === 'session') {
					resolved =
						allExecutions.find((exec) => exec.agentSessionId === address.sessionId) ?? null;
				} else {
					return jsonResult({
						success: false,
						error: `Generic target ${genericTarget} is not routable from this tool. Use @handle, @role:<role>, @worker:<node>/<agent>, @worker:<run>/<node>/<agent>, @session:<task-agent-session>, or node_id.`,
					});
				}
			} else if (args.node_id) {
				resolved = resolveNodeExecution(allExecutions, args.node_id);
			}

			if (!routedTarget) {
				return jsonResult({
					success: false,
					error: 'Target agent is required. Use node_id or target to specify a recipient.',
				});
			}
			if (!resolved) {
				return jsonResult({
					success: false,
					error:
						`Node not found for task ${task.id}: "${routedTarget}". ` +
						`Expected an execution UUID, agent name, @worker target, or task agent @session target.`,
				});
			}

			// Record reply route so node-agent replies go back to this session.
			if (replyRoutingRegistry && mySessionId) {
				replyRoutingRegistry.set(task.id, mySessionId, resolved.agentName);
			}

			// Attempt direct injection when the execution already has a live session.
			if (resolved.agentSessionId) {
				try {
					await taskAgentManager.injectSubSessionMessage(
						resolved.agentSessionId,
						formatAgentMessage({
							fromLevel: outboundSenderLevel,
							fromAgentName: outboundSenderDisplayName,
							toLevel: 'node-agent',
							body: args.message,
							taskId: task.id,
							taskNumber: task.taskNumber,
							nodeId: resolved.agentName,
							replyToSessionId: mySessionId,
						}),
						true
					);
					return jsonResult({
						success: true,
						task_id: task.id,
						target: 'node',
						node_execution_id: resolved.id,
						agent_name: resolved.agentName,
						activated: false,
					});
				} catch {
					// Fall through to activation path — the session may be dead; activateNode
					// will either revive it (cyclic re-entry) or reset the execution to pending.
				}
			}

			// No live session → activate and retry.
			if (!activateNode) {
				return jsonResult({
					success: false,
					error: `Node "${resolved.agentName}" has no live session and no activation callback is configured.`,
				});
			}
			try {
				await activateNode(task.workflowRunId, resolved.workflowNodeId);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({
					success: false,
					error: `Failed to activate node "${resolved.agentName}": ${message}`,
				});
			}

			// Re-read the execution — activateNode may have restored the session id.
			const refreshedExecution = nodeExecutionRepo.getById(resolved.id);
			const sessionIdAfter = refreshedExecution?.agentSessionId ?? null;
			if (sessionIdAfter) {
				try {
					await taskAgentManager.injectSubSessionMessage(
						sessionIdAfter,
						formatAgentMessage({
							fromLevel: outboundSenderLevel,
							fromAgentName: outboundSenderDisplayName,
							toLevel: 'node-agent',
							body: args.message,
							taskId: task.id,
							taskNumber: task.taskNumber,
							nodeId: resolved.agentName,
							replyToSessionId: mySessionId,
						}),
						true
					);
					return jsonResult({
						success: true,
						task_id: task.id,
						target: 'node',
						node_execution_id: resolved.id,
						agent_name: resolved.agentName,
						activated: true,
					});
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return jsonResult({
						success: false,
						error: `Failed to inject message into node "${resolved.agentName}": ${message}`,
					});
				}
			}

			let queuedMessageId: string | null = null;
			if (pendingMessageQueue) {
				const { record } = pendingMessageQueue.enqueue({
					workflowRunId: task.workflowRunId,
					spaceId,
					taskId: task.id,
					sourceAgentName: outboundSenderName,
					targetKind: 'node_agent',
					targetAgentName: resolved.agentName,
					message: formatAgentMessage({
						fromLevel: outboundSenderLevel,
						fromAgentName: outboundSenderDisplayName,
						toLevel: 'node-agent',
						body: args.message,
						taskId: task.id,
						taskNumber: task.taskNumber,
						nodeId: resolved.agentName,
						replyToSessionId: mySessionId,
					}),
				});
				queuedMessageId = record.id;
			}

			// No live session yet — the tick loop will spawn one. When a queue is
			// available, the queued row will be flushed into that session on activation.
			return jsonResult({
				success: true,
				task_id: task.id,
				target: 'node',
				node_execution_id: resolved.id,
				agent_name: resolved.agentName,
				activated: true,
				delivered: false,
				queued: queuedMessageId !== null,
				...(queuedMessageId !== null ? { queuedMessageId } : {}),
				message:
					queuedMessageId !== null
						? `Node "${resolved.agentName}" was activated and the message was queued; it will be delivered once the session spawns.`
						: `Node "${resolved.agentName}" was activated but does not yet have a live session; ` +
							`the message was not queued because no pending message queue is configured. Retry after the node starts.`,
			});
		},

		/**
		 * List all node executions for a task's workflow run.
		 */
		async list_task_members(args: { task_id: string }): Promise<ToolResult> {
			const task = taskRepo.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			if (task.spaceId !== spaceId) {
				return jsonResult({
					success: false,
					error: `Task ${args.task_id} does not belong to this space.`,
				});
			}
			if (!task.workflowRunId) {
				return jsonResult({
					success: true,
					task_id: args.task_id,
					executions: [],
					message: 'This task has no associated workflow run.',
				});
			}
			const executions = nodeExecutionRepo.listByWorkflowRun(task.workflowRunId);
			return jsonResult({ success: true, task_id: args.task_id, executions });
		},

		/**
		 * Approve or reject a workflow gate.
		 * Requires gateDataRepo to be configured.
		 */
		async approve_gate(args: {
			run_id: string;
			gate_id: string;
			approved: boolean;
			reason?: string;
		}): Promise<ToolResult> {
			if (!gateDataRepo) {
				return jsonResult({ success: false, error: 'Gate operations are not available' });
			}

			const run = workflowRunRepo.getRun(args.run_id);
			if (!run) {
				return jsonResult({ success: false, error: `Workflow run not found: ${args.run_id}` });
			}
			if (run.status === 'done' || run.status === 'cancelled' || run.status === 'pending') {
				return jsonResult({
					success: false,
					error: `Cannot modify gate on a ${run.status} workflow run`,
				});
			}

			// Per-field two-path authorization for agent-originated approvals.
			// Writers path: 'approved' field's writers includes this agent's name or '*' → allow.
			// Autonomy path: writers don't include this agent (or empty writers) → require
			// space.autonomyLevel >= gate.requiredLevel (default 5).
			// Human approval via spaceWorkflowRun.approveGate RPC is not subject to this check.
			if (args.approved && getSpaceAutonomyLevel) {
				const workflow = workflowManager.getWorkflow(run.workflowId);
				const gateDef = (workflow?.gates ?? []).find((g) => g.id === args.gate_id);
				const approvedField = (gateDef?.fields ?? []).find((f) => f.name === 'approved');
				const writers = approvedField?.writers ?? [];
				const writerMatches = writers.some((w) => {
					const normalized = normalizeAgentNameToken(w);
					return normalized === '*' || agentNameAliases.has(normalized);
				});

				if (!writerMatches) {
					// Autonomy path: this agent is not in the writers list
					const effectiveRequiredLevel = gateDef?.requiredLevel ?? 5;
					const spaceLevel = await getSpaceAutonomyLevel(spaceId);
					if (spaceLevel < effectiveRequiredLevel) {
						return jsonResult({
							success: false,
							error:
								`Agent approval blocked: gate "${args.gate_id}" requires autonomy level ` +
								`${effectiveRequiredLevel} but space autonomy is ${spaceLevel}. ` +
								`Increase space autonomy level or request human approval.`,
						});
					}
				}
				// Writers path: writerMatches → no autonomy check needed
			}

			const existing = gateDataRepo.get(args.run_id, args.gate_id);

			if (args.approved) {
				if (existing?.data?.approved === true) {
					return jsonResult({
						success: true,
						runId: args.run_id,
						gateId: args.gate_id,
						gateData: existing.data,
						message: 'Gate already approved',
					});
				}

				const gateData = gateDataRepo.merge(args.run_id, args.gate_id, {
					approved: true,
					approvedAt: Date.now(),
					approvalSource: 'agent',
				});

				// If previously rejected, transition back to in_progress
				let currentRun = run;
				if (run.status === 'blocked' && run.failureReason === 'humanRejected') {
					currentRun = workflowRunRepo.transitionStatus(args.run_id, 'in_progress');
					currentRun =
						workflowRunRepo.updateRun(args.run_id, { failureReason: null }) ?? currentRun;
				}

				if (internalEventBus) {
					void internalEventBus
						.publish('space.workflowRun.updated', {
							sessionId: 'global',
							spaceId: run.spaceId,
							runId: run.id,
							run: currentRun,
						})
						.catch(() => {});
					void internalEventBus
						.publish('space.gateData.updated', {
							sessionId: 'global',
							spaceId: run.spaceId,
							runId: args.run_id,
							gateId: args.gate_id,
							data: gateData.data,
						})
						.catch(() => {});
				}
				onGateChanged?.(args.run_id, args.gate_id);

				return jsonResult({
					success: true,
					runId: args.run_id,
					gateId: args.gate_id,
					gateData: gateData.data,
				});
			} else {
				if (existing?.data?.approved === false) {
					return jsonResult({
						success: true,
						runId: args.run_id,
						gateId: args.gate_id,
						gateData: existing.data,
						message: 'Gate already rejected',
					});
				}

				const gateData = gateDataRepo.merge(args.run_id, args.gate_id, {
					approved: false,
					rejectedAt: Date.now(),
					reason: args.reason ?? null,
					approvalSource: 'agent',
				});

				if (run.status !== 'blocked') {
					workflowRunRepo.transitionStatus(args.run_id, 'blocked');
				}
				const updatedRun =
					workflowRunRepo.updateRun(args.run_id, { failureReason: 'humanRejected' }) ?? run;

				// Block the canonical task with gate_rejected reason
				const runTasks = taskRepo.listByWorkflowRun(args.run_id);
				const canonicalTask = runTasks[0];
				if (canonicalTask && canonicalTask.status !== 'blocked') {
					await taskManager.setTaskStatus(canonicalTask.id, 'blocked', {
						result: args.reason ?? 'Gate rejected',
						blockReason: 'gate_rejected',
					});
				}

				if (internalEventBus) {
					void internalEventBus
						.publish('space.workflowRun.updated', {
							sessionId: 'global',
							spaceId: run.spaceId,
							runId: run.id,
							run: updatedRun,
						})
						.catch(() => {});
					void internalEventBus
						.publish('space.gateData.updated', {
							sessionId: 'global',
							spaceId: run.spaceId,
							runId: args.run_id,
							gateId: args.gate_id,
							data: gateData.data,
						})
						.catch(() => {});
				}

				return jsonResult({
					success: true,
					runId: args.run_id,
					gateId: args.gate_id,
					gateData: gateData.data,
				});
			}
		},

		/**
		 * Approve a task that is in 'review' status, transitioning it to 'done'.
		 * Records approval audit trail with agent as the source.
		 */
		async approve_task(args: { task_id: string; reason?: string }): Promise<ToolResult> {
			const task = taskRepo.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			if (task.spaceId !== spaceId) {
				return jsonResult({
					success: false,
					error: `Task ${args.task_id} does not belong to this space.`,
				});
			}

			const space = config.spaceManager ? await config.spaceManager.getSpace(spaceId) : null;
			const currentLevel =
				space?.autonomyLevel ?? (getSpaceAutonomyLevel ? await getSpaceAutonomyLevel(spaceId) : 1);
			let completionAutonomyLevel = 5;
			if (task.workflowRunId) {
				const run = workflowRunRepo.getRun(task.workflowRunId);
				if (run?.workflowId) {
					const workflow = workflowManager.getWorkflow(run.workflowId);
					if (workflow?.completionAutonomyLevel !== undefined) {
						completionAutonomyLevel = workflow.completionAutonomyLevel;
					}
				}
			}

			if (currentLevel < completionAutonomyLevel) {
				return jsonResult({
					success: false,
					error: `approve_task not permitted: space autonomy level ${currentLevel} < workflow completionAutonomyLevel ${completionAutonomyLevel}. Use submit_for_approval to request human review.`,
				});
			}

			if (task.status !== 'review') {
				return jsonResult({
					success: false,
					error: `Task is in '${task.status}' status, not 'review'. Only tasks in review can be approved.`,
				});
			}

			try {
				const updated = await taskManager.setTaskStatus(args.task_id, 'done', {
					result: task.result ?? undefined,
					approvalSource: 'agent',
					approvalReason: args.reason,
					onCascadedTasks: async (cascadedTasks) => {
						for (const cascadedTask of cascadedTasks) emitTaskUpdated(cascadedTask);
					},
				});

				// Best-effort goal terminal handling — must not block approve_task.
				try {
					config.goalService?.handleTaskTerminal(updated.id);
				} catch (err) {
					log.warn(
						`Goal terminal handling threw for task "${updated.id}": ${err instanceof Error ? err.message : String(err)}`
					);
				}

				logAudit(
					'approve_task',
					{
						reason: args.reason,
						previousStatus: task.status,
					},
					args.task_id
				);

				emitTaskUpdated(updated);

				return jsonResult({ success: true, task: updated });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * List goals for this space, optionally filtered by status.
		 */
		async list_goals(args: { status?: SpaceGoalStatus } = {}): Promise<ToolResult> {
			try {
				const goals = requireGoalService().listGoals({ spaceId, status: args.status });
				return jsonResult({ success: true, goals });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Get one goal in this space.
		 */
		async get_goal(args: { goal_id: string }): Promise<ToolResult> {
			try {
				const goal = requireGoalInSpace(args.goal_id);
				return jsonResult({ success: true, goal });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Create a long-horizon goal in this space.
		 */
		async create_goal(args: {
			title: string;
			description?: string;
			type?: SpaceGoalType;
			priority?: SpaceTaskPriority;
			labels?: string[];
			metrics?: Record<string, string | number | boolean | null>;
			summary?: string;
			progress?: number;
			next_steps?: string[];
			preferred_workflow_id?: string | null;
			auto_trigger_next?: boolean;
			check_in_cron_expression?: string;
			check_in_timezone?: string;
			trigger_immediately?: boolean;
		}): Promise<ToolResult> {
			try {
				const goal = requireGoalService().createGoal(
					{
						spaceId,
						title: args.title,
						description: args.description,
						type: args.type,
						priority: args.priority,
						labels: args.labels,
						metrics: args.metrics,
						summary: args.summary,
						progress: args.progress,
						nextSteps: args.next_steps,
						preferredWorkflowId: args.preferred_workflow_id,
						autoTriggerNext: args.auto_trigger_next,
						checkInCronExpression: args.check_in_cron_expression,
						checkInTimezone: args.check_in_timezone,
						triggerImmediately: args.trigger_immediately,
					},
					goalToolContext
				);
				logAudit('create_goal', {
					title: args.title,
					type: args.type,
					priority: args.priority,
					trigger_immediately: args.trigger_immediately,
					check_in_cron_expression: args.check_in_cron_expression,
				});
				return jsonResult({ success: true, goal });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Update public goal fields and rolling state.
		 */
		async update_goal(args: { goal_id: string } & GoalToolUpdateArgs): Promise<ToolResult> {
			try {
				requireGoalInSpace(args.goal_id);
				const { goal_id: goalId, ...updates } = args;
				const goal = requireGoalService().updateGoal(
					goalId,
					normalizeGoalUpdateArgs(updates),
					goalToolContext
				);
				logAudit('update_goal', { goal_id: goalId, fields: Object.keys(updates) });
				return jsonResult({ success: true, goal });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		async pause_goal(args: { goal_id: string }): Promise<ToolResult> {
			try {
				requireGoalInSpace(args.goal_id);
				const goal = requireGoalService().pauseGoal(args.goal_id, goalToolContext);
				logAudit('pause_goal', { goal_id: args.goal_id });
				return jsonResult({ success: true, goal });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		async resume_goal(args: { goal_id: string }): Promise<ToolResult> {
			try {
				requireGoalInSpace(args.goal_id);
				const goal = requireGoalService().resumeGoal(args.goal_id, goalToolContext);
				logAudit('resume_goal', { goal_id: args.goal_id });
				return jsonResult({ success: true, goal });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		async trigger_goal_task(args: { goal_id: string }): Promise<ToolResult> {
			try {
				requireGoalInSpace(args.goal_id);
				const result = requireGoalService().createImmediateTask(args.goal_id, goalToolContext);
				logAudit('trigger_goal_task', { goal_id: args.goal_id }, result.task?.id);
				return jsonResult({ success: true, ...result });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		async list_goal_tasks(args: {
			goal_id: string;
			status?: SpaceTaskStatus;
		}): Promise<ToolResult> {
			try {
				requireGoalInSpace(args.goal_id);
				const tasks = taskRepo
					.listBySpace(spaceId, args.status === 'archived')
					.filter((task) => task.goalId === args.goal_id)
					.filter((task) => (args.status ? task.status === args.status : true));
				return jsonResult({ success: true, total: tasks.length, tasks });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		async list_goal_events(args: {
			goal_id: string;
			limit?: number;
			before?: number;
			before_id?: string;
		}): Promise<ToolResult> {
			try {
				requireGoalInSpace(args.goal_id);
				const events = requireGoalService().listGoalEvents(args.goal_id, {
					limit: args.limit,
					before: args.before,
					beforeId: args.before_id,
				});
				return jsonResult({ success: true, total: events.length, events });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Create a recurring (cron) or one-shot (at) scheduled task.
		 */
		async create_scheduled_task(args: {
			title: string;
			description: string;
			priority?: SpaceTaskPriority;
			workflow_id?: string;
			labels?: string[];
			trigger_type: TaskScheduleTriggerType;
			cron_expression?: string;
			run_at?: number;
			timezone?: string;
		}): Promise<ToolResult> {
			if (!config.scheduleService) {
				return jsonResult({ success: false, error: 'Schedule management not available' });
			}
			try {
				const schedule = config.scheduleService.createSchedule({
					spaceId,
					title: args.title,
					description: args.description ?? '',
					priority: args.priority,
					preferredWorkflowId: args.workflow_id ?? null,
					labels: args.labels,
					triggerType: args.trigger_type,
					cronExpression: args.cron_expression ?? null,
					runAt: args.run_at ?? null,
					timezone: args.timezone,
					createdByAgent: myAgentName ?? null,
					createdBySession: mySessionId ?? null,
				});
				logAudit('create_scheduled_task', {
					title: args.title,
					trigger_type: args.trigger_type,
					cron_expression: args.cron_expression,
					run_at: args.run_at,
					timezone: args.timezone,
				});
				return jsonResult({ success: true, schedule });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * List all scheduled tasks for this space.
		 */
		async list_scheduled_tasks(args: { status?: TaskScheduleStatus }): Promise<ToolResult> {
			if (!config.scheduleService) {
				return jsonResult({ success: false, error: 'Schedule management not available' });
			}
			try {
				const schedules = config.scheduleService.listSchedules(spaceId, args.status);
				return jsonResult({ success: true, schedules });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Get schedule details including last spawned task.
		 */
		async get_scheduled_task(args: { schedule_id: string }): Promise<ToolResult> {
			if (!config.scheduleService) {
				return jsonResult({ success: false, error: 'Schedule management not available' });
			}
			try {
				const schedule = config.scheduleService.getSchedule(args.schedule_id);
				if (!schedule || schedule.spaceId !== spaceId) {
					return jsonResult({ success: false, error: `Schedule not found: ${args.schedule_id}` });
				}
				return jsonResult({ success: true, schedule });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Pause a schedule — stops creating new tasks.
		 */
		async pause_scheduled_task(args: { schedule_id: string }): Promise<ToolResult> {
			if (!config.scheduleService) {
				return jsonResult({ success: false, error: 'Schedule management not available' });
			}
			try {
				// Space-scope guard: callers can only pause schedules in their own space.
				const existing = config.scheduleService.getSchedule(args.schedule_id);
				if (!existing || existing.spaceId !== spaceId) {
					return jsonResult({ success: false, error: `Schedule not found: ${args.schedule_id}` });
				}
				const schedule = config.scheduleService.pauseSchedule(args.schedule_id);
				logAudit('pause_scheduled_task', { schedule_id: args.schedule_id });
				return jsonResult({ success: true, schedule });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Resume a paused schedule.
		 */
		async resume_scheduled_task(args: { schedule_id: string }): Promise<ToolResult> {
			if (!config.scheduleService) {
				return jsonResult({ success: false, error: 'Schedule management not available' });
			}
			try {
				const existing = config.scheduleService.getSchedule(args.schedule_id);
				if (!existing || existing.spaceId !== spaceId) {
					return jsonResult({ success: false, error: `Schedule not found: ${args.schedule_id}` });
				}
				const schedule = config.scheduleService.resumeSchedule(args.schedule_id);
				logAudit('resume_scheduled_task', { schedule_id: args.schedule_id });
				return jsonResult({ success: true, schedule });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Delete a schedule permanently.
		 */
		async delete_scheduled_task(args: { schedule_id: string }): Promise<ToolResult> {
			if (!config.scheduleService) {
				return jsonResult({ success: false, error: 'Schedule management not available' });
			}
			try {
				const existing = config.scheduleService.getSchedule(args.schedule_id);
				if (!existing || existing.spaceId !== spaceId) {
					return jsonResult({ success: false, error: `Schedule not found: ${args.schedule_id}` });
				}
				const ok = config.scheduleService.deleteSchedule(args.schedule_id);
				if (!ok) {
					return jsonResult({
						success: false,
						error:
							'Schedule was modified concurrently (e.g. a fire job advanced it). Please retry.',
					});
				}
				logAudit('delete_scheduled_task', { schedule_id: args.schedule_id });
				return jsonResult({ success: true });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},
	};
}

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

/**
 * Create an MCP server exposing all Space agent tools.
 * Pass the returned server to the SDK session init.
 */
export function createSpaceAgentMcpServer(config: SpaceAgentToolsConfig) {
	const handlers = createSpaceAgentToolHandlers(config);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const tools: SdkMcpToolDefinition<any>[] = [
		tool(
			'list_workflows',
			'Show all workflows in this space with their descriptions and steps. Call this first to understand available options before creating a task.',
			{},
			() => handlers.list_workflows()
		),
		tool(
			'get_workflow_run',
			'Check the current status of a workflow run, including the current step and associated tasks.',
			{
				run_id: z.string().describe('ID of the workflow run to inspect'),
			},
			(args) => handlers.get_workflow_run(args)
		),
		tool(
			'change_plan',
			'Update the task description for an ongoing run, or switch to a different workflow mid-run (cancels the current run and starts a new one).',
			{
				run_id: z.string().describe('ID of the current workflow run'),
				description: z.string().optional().describe('Updated task description'),
				workflow_id: z
					.string()
					.optional()
					.describe(
						'New workflow ID to switch to. The current run will be cancelled and a new run started with the same title.'
					),
				workflow_handle: z
					.string()
					.optional()
					.describe(
						'New workflow handle to switch to (alternative to workflow_id). The current run will be cancelled and a new run started with the same title.'
					),
			},
			(args) => handlers.change_plan(args)
		),
		tool(
			'get_workflow_detail',
			'Get the full definition of a specific workflow, including all steps, transitions, and rules. Use this to inspect a candidate workflow before creating a task.',
			{
				workflow_id: z.string().optional().describe('ID of the workflow to retrieve'),
				workflow_handle: z
					.string()
					.optional()
					.describe('Handle of the workflow to retrieve (alternative to workflow_id)'),
			},
			(args) => handlers.get_workflow_detail(args)
		),
		tool(
			'suggest_workflow',
			'List all workflows available in this space so you can pick the best one for a described piece of work. Returns every workflow in creation order with its id, handle (human-readable slug usable as workflow_handle in create_standalone_task), name, description, tags, and nodes — no pre-ranking, so your own reasoning is not biased by keyword overlap.',
			{
				description: z
					.string()
					.describe(
						'Description of the work you want to do. Provided for context; the tool returns all workflows regardless.'
					),
			},
			(args) => handlers.suggest_workflow(args)
		),
		tool(
			'list_tasks',
			'List SpaceTasks for this space. Filterable by status and workflow run. Use compact:true and limit/offset to reduce payload size.',
			{
				status: z
					.enum([
						'draft',
						'open',
						'in_progress',
						'review',
						'approved',
						'done',
						'blocked',
						'cancelled',
						'archived',
					])
					.optional()
					.describe('Filter by task status'),
				workflow_run_id: z
					.string()
					.optional()
					.describe('Filter to only tasks belonging to a specific workflow run'),
				search: z.string().optional().describe('Substring match on task title'),
				limit: z
					.number()
					.int()
					.positive()
					.optional()
					.default(50)
					.describe('Maximum number of tasks to return (default: 50)'),
				offset: z
					.number()
					.int()
					.min(0)
					.optional()
					.default(0)
					.describe('Number of tasks to skip for pagination (default: 0)'),
				compact: z
					.boolean()
					.optional()
					.default(false)
					.describe(
						'Return only summary fields (id, title, status, priority, createdAt) to reduce payload size'
					),
			},
			(args) => handlers.list_tasks(args)
		),
		tool(
			'create_standalone_task',
			'Create a task request. Runtime may attach and execute a workflow for this task during orchestration. Supports structured task dependencies via depends_on — the task will be blocked until every listed dependency reaches status=done, and cascade-cancelled if a dependency is cancelled.',
			{
				title: z.string().describe('Short title for the task'),
				description: z.string().describe('Detailed description of the work to be done'),
				priority: z
					.enum(['low', 'normal', 'high', 'urgent'])
					.optional()
					.describe('Task priority (default: normal)'),
				custom_agent_id: z
					.string()
					.optional()
					.describe('ID of a custom Space agent to assign this task to'),
				workflow_id: z
					.string()
					.optional()
					.describe(
						'ID of the workflow to use for this task. When provided, the runtime uses this workflow instead of auto-selecting one. Call list_workflows to discover available workflows (returns both IDs and handles).'
					),
				workflow_handle: z
					.string()
					.optional()
					.describe(
						'Handle of the workflow to use for this task (alternative to workflow_id). Example: "coding-with-qa".'
					),
				depends_on: z
					.array(z.string())
					.optional()
					.describe(
						'List of task IDs this task depends on. All must be in the same space. The task will be blocked until every dependency reaches status=done. Cycles and non-existent IDs are rejected.'
					),
				draft: z
					.boolean()
					.optional()
					.describe(
						'When true, create the task in draft status. Draft tasks are never auto-started by the runtime, even with a workflow and priority assigned. Must be explicitly published before orchestration picks it up.'
					),
			},
			(args) => handlers.create_standalone_task(args)
		),
		tool(
			'get_task_detail',
			'Retrieve detailed information about a specific task including its status, result, and metadata.',
			{
				task_id: z.string().optional().describe('UUID of the task to retrieve'),
				task_number: z
					.number()
					.optional()
					.describe('Numeric task ID (e.g. 5 for task #5) — preferred over task_id'),
			},
			(args) => handlers.get_task_detail(args)
		),
		tool(
			'update_task',
			"Edit an existing task's title, description, priority, or dependencies. The task must belong to this space. Only the fields you provide are updated.",
			{
				task_id: z.string().describe('UUID of the task to update'),
				title: z.string().min(1).optional().describe('New title for the task'),
				description: z.string().optional().describe('New description for the task'),
				priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('New priority'),
				depends_on: z
					.array(z.string())
					.optional()
					.describe(
						'New dependency list (replaces existing). All must be in the same space. Cycles and non-existent IDs are rejected.'
					),
			},
			(args) => handlers.update_task(args)
		),
		tool(
			'retry_task',
			'Retry a failed or cancelled task. Optionally update the task description for the retry attempt.',
			{
				task_id: z.string().describe('ID of the task to retry'),
				description: z
					.string()
					.optional()
					.describe('Updated task description for the retry attempt'),
			},
			(args) => handlers.retry_task(args)
		),
		tool(
			'cancel_task',
			'Cancel a task. Automatically cascades cancellation to pending dependent tasks. Optionally also cancel the associated workflow run.',
			{
				task_id: z.string().describe('ID of the task to cancel'),
				cancel_workflow_run: z
					.boolean()
					.optional()
					.describe(
						'If true and the task belongs to a workflow run, also cancel that workflow run'
					),
			},
			(args) => handlers.cancel_task(args)
		),
		tool(
			'reassign_task',
			'Change the agent assignment for a task. Only allowed for tasks in open, blocked, or cancelled status.',
			{
				task_id: z.string().describe('ID of the task to reassign'),
				custom_agent_id: z
					.string()
					.nullable()
					.optional()
					.describe(
						'ID of the custom Space agent to assign to. Pass null to clear the custom agent assignment.'
					),
				assigned_agent: z
					.enum(['coder', 'general'])
					.optional()
					.describe('Agent type to assign (coder or general)'),
			},
			(args) => handlers.reassign_task(args)
		),
		tool(
			'publish_task',
			'Publish a draft task, transitioning it from draft to open status. Published tasks become eligible for orchestration by the runtime tick loop. Only valid for tasks in draft status.',
			{
				task_id: z.string().describe('UUID of the draft task to publish'),
			},
			(args) => handlers.publish_task(args)
		),
		tool(
			'archive_task',
			"Archive a task. Archived tasks are excluded from most queries and cannot be reactivated — this is the true terminal state. Valid from any status that allows the 'archived' transition (e.g. draft, done, cancelled, blocked, review, approved).",
			{
				task_id: z.string().describe('UUID of the task to archive'),
			},
			(args) => handlers.archive_task(args)
		),

		// Task agent communication tools
		tool(
			'send_message_to_task',
			'Send a message to a specific workflow node agent or long-term Space agent on a task. Use node_id for workflow nodes, or target for @handle/@role/@session/@worker addresses. Inactive workflow nodes or long-term agents are activated/queued when supported. Provide either task_id or task_number — if both are given, task_id takes precedence.',
			{
				task_id: z
					.string()
					.optional()
					.describe(
						'ID of the task whose agent session should receive the message. Either task_id or task_number is required.'
					),
				task_number: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('Space-scoped numeric task ID (e.g. 37). Used when task_id is not provided.'),
				message: z.string().describe('Message to send to the target node agent'),
				node_id: z
					.string()
					.optional()
					.describe(
						'Workflow node selector. Accepts a node_execution UUID or an agent name (e.g. "coder", "reviewer"). The message is routed to that node\'s sub-session; the node is activated automatically if it has no live session.'
					),
				target: z
					.string()
					.optional()
					.describe(
						'Explicit generic target such as @handle, @role:task-manager, @session:<id>, or @worker:<node>/<agent>. Takes precedence over node_id when supported.'
					),
			},
			(args) => handlers.send_message_to_task(args)
		),
		tool(
			'list_task_members',
			"List all node executions (workflow member agents) for a task. Returns each node's status, result, and saved data. Use this to inspect the detailed execution state of a running or completed workflow task.",
			{
				task_id: z.string().describe('ID of the task to inspect'),
			},
			(args) => handlers.list_task_members(args)
		),
		tool(
			'approve_gate',
			'Approve or reject a workflow gate. Use this to control workflow progression by opening or closing gates on workflow runs.',
			{
				run_id: z.string().describe('ID of the workflow run'),
				gate_id: z.string().describe('ID of the gate to approve or reject'),
				approved: z.boolean().describe('true to approve (open gate), false to reject (block)'),
				reason: z.string().optional().describe('Reason for approval or rejection'),
			},
			(args) => handlers.approve_gate(args)
		),
		tool(
			'approve_task',
			"Approve a task in 'review' status, transitioning it to 'done'. Use this after reviewing a completed task's output to mark it as approved.",
			{
				task_id: z.string().describe('ID of the task to approve'),
				reason: z.string().optional().describe('Reason for approval'),
			},
			(args) => handlers.approve_task(args)
		),
	];

	// Goal management tools — only registered when goalService is provided.
	if (config.goalService) {
		const goalStatusSchema = z.enum(['active', 'paused', 'completed', 'archived']);
		const goalTypeSchema = z.enum(['one_shot', 'measurable', 'recurring']);
		const goalMetricsSchema = z.record(
			z.string(),
			z.union([z.string(), z.number(), z.boolean(), z.null()])
		);
		const goalUpdateShape = {
			title: z.string().min(1).optional().describe('New goal title'),
			description: z.string().optional().describe('New goal description'),
			status: goalStatusSchema.optional().describe('New lifecycle status'),
			type: goalTypeSchema.optional().describe('Goal type'),
			priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('Goal priority'),
			labels: z.array(z.string()).optional().describe('Labels for future goal tasks'),
			metrics: goalMetricsSchema.optional().describe('Structured measurement state'),
			summary: z.string().optional().describe('Rolling summary of current goal state'),
			progress: z.number().int().min(0).max(100).optional().describe('Progress percentage 0-100'),
			next_steps: z.array(z.string()).optional().describe('Rolling list of next steps'),
			preferred_workflow_id: z
				.string()
				.nullable()
				.optional()
				.describe('Preferred workflow ID for future goal tasks'),
			auto_trigger_next: z
				.boolean()
				.optional()
				.describe(
					'Queue one follow-up run when trigger is called while another goal task is active'
				),
		};

		tools.push(
			tool(
				'list_goals',
				'List long-horizon goals in this space. Use this before changing goal progress or creating goal tasks.',
				{ status: goalStatusSchema.optional().describe('Filter by goal status') },
				(args) => handlers.list_goals(args)
			),
			tool(
				'get_goal',
				'Get one goal with rolling state, active task pointers, next check-in, metrics, and next steps.',
				{ goal_id: z.string().describe('Goal ID') },
				(args) => handlers.get_goal(args)
			),
			tool(
				'create_goal',
				'Create a long-horizon goal in this space. Optionally schedule recurring check-ins or trigger the first task immediately.',
				{
					title: z.string().min(1).describe('Goal title'),
					description: z.string().optional().describe('Goal description'),
					type: goalTypeSchema.optional().describe('Goal type'),
					priority: z
						.enum(['low', 'normal', 'high', 'urgent'])
						.optional()
						.describe('Goal priority'),
					labels: z.array(z.string()).optional().describe('Labels for future goal tasks'),
					metrics: goalMetricsSchema.optional().describe('Initial structured metric state'),
					summary: z.string().optional().describe('Initial rolling summary'),
					progress: z.number().int().min(0).max(100).optional().describe('Initial progress 0-100'),
					next_steps: z.array(z.string()).optional().describe('Initial next steps'),
					preferred_workflow_id: z
						.string()
						.nullable()
						.optional()
						.describe('Preferred workflow ID for goal tasks'),
					auto_trigger_next: z
						.boolean()
						.optional()
						.describe('Queue one follow-up run when a trigger happens while active task exists'),
					check_in_cron_expression: z
						.string()
						.optional()
						.describe('Cron expression for recurring check-in task creation'),
					check_in_timezone: z.string().optional().describe('IANA timezone for check-ins'),
					trigger_immediately: z
						.boolean()
						.optional()
						.describe('Create first goal task immediately'),
				},
				(args) => handlers.create_goal(args)
			),
			tool(
				'update_goal',
				'Update public goal fields and rolling state. Use summary/progress/metrics/next_steps to keep long-horizon state current; internal fields like activeTaskId and taskScheduleId are not writable.',
				{ goal_id: z.string().describe('Goal ID'), ...goalUpdateShape },
				(args) => handlers.update_goal(args)
			),
			tool(
				'pause_goal',
				'Pause an active goal and its linked check-in schedule if present.',
				{ goal_id: z.string().describe('Goal ID') },
				(args) => handlers.pause_goal(args)
			),
			tool(
				'resume_goal',
				'Resume a paused goal and re-enable its linked check-in schedule if present.',
				{ goal_id: z.string().describe('Goal ID') },
				(args) => handlers.resume_goal(args)
			),
			tool(
				'trigger_goal_task',
				'Create an immediate task for a goal. If another goal task is active and auto_trigger_next is true, queues one follow-up instead of overlapping work.',
				{ goal_id: z.string().describe('Goal ID') },
				(args) => handlers.trigger_goal_task(args)
			),
			tool(
				'list_goal_tasks',
				'List tasks linked to a goal in this space, optionally filtered by status.',
				{
					goal_id: z.string().describe('Goal ID'),
					status: z
						.enum([
							'draft',
							'open',
							'in_progress',
							'review',
							'approved',
							'done',
							'blocked',
							'cancelled',
							'archived',
						])
						.optional()
						.describe('Filter by linked task status'),
				},
				(args) => handlers.list_goal_tasks(args)
			),
			tool(
				'list_goal_events',
				'List append-only history events for a goal. Use this to understand why the current rolling state changed before updating it.',
				{
					goal_id: z.string().describe('Goal ID'),
					limit: z.number().int().min(1).max(100).optional().describe('Max events to return'),
					before: z.number().int().optional().describe('Return events before this timestamp'),
					before_id: z
						.string()
						.optional()
						.describe('Cursor event ID for same-timestamp pagination'),
				},
				(args) => handlers.list_goal_events(args)
			)
		);
	}

	// Schedule management tools — only registered when scheduleService is provided.
	if (config.scheduleService) {
		tools.push(
			tool(
				'create_scheduled_task',
				'Create a recurring (cron) or one-shot (at) scheduled task. When it fires, a real SpaceTask is created automatically.',
				{
					title: z.string().describe('Short title for the task template'),
					description: z.string().describe('Detailed description for the task template'),
					priority: z
						.enum(['low', 'normal', 'high', 'urgent'])
						.optional()
						.describe('Task priority (default: normal)'),
					workflow_id: z
						.string()
						.optional()
						.describe('Preferred workflow ID to attach to created tasks'),
					labels: z.array(z.string()).optional().describe('Labels to apply to created tasks'),
					trigger_type: z
						.enum(['cron', 'at'])
						.describe('Trigger type: "cron" for recurring, "at" for one-shot'),
					cron_expression: z
						.string()
						.optional()
						.describe(
							'Cron expression (e.g. "0 9 * * 1" for every Monday at 9am, "@daily", "@hourly"). Required when trigger_type is "cron".'
						),
					run_at: z
						.number()
						.optional()
						.describe(
							'Unix timestamp in ms when the task should fire. Required when trigger_type is "at".'
						),
					timezone: z
						.string()
						.optional()
						.describe('IANA timezone string (default: "UTC"). Example: "America/New_York"'),
				},
				(args) => handlers.create_scheduled_task(args)
			),
			tool(
				'list_scheduled_tasks',
				'List all scheduled tasks for this space.',
				{
					status: z
						.enum(['active', 'paused', 'completed'])
						.optional()
						.describe('Filter by schedule status (default: all)'),
				},
				(args) => handlers.list_scheduled_tasks(args)
			),
			tool(
				'get_scheduled_task',
				'Get details of a specific scheduled task including last spawned task ID and next run time.',
				{
					schedule_id: z.string().describe('ID of the scheduled task to retrieve'),
				},
				(args) => handlers.get_scheduled_task(args)
			),
			tool(
				'pause_scheduled_task',
				'Pause a schedule — stops creating new tasks until resumed.',
				{
					schedule_id: z.string().describe('ID of the scheduled task to pause'),
				},
				(args) => handlers.pause_scheduled_task(args)
			),
			tool(
				'resume_scheduled_task',
				'Resume a paused schedule, computing the next run time and re-enqueueing the job.',
				{
					schedule_id: z.string().describe('ID of the scheduled task to resume'),
				},
				(args) => handlers.resume_scheduled_task(args)
			),
			tool(
				'delete_scheduled_task',
				'Permanently delete a scheduled task. Any pending job is cancelled.',
				{
					schedule_id: z.string().describe('ID of the scheduled task to delete'),
				},
				(args) => handlers.delete_scheduled_task(args)
			)
		);
	}

	// Optional legacy restore mirror. Workflow node sessions should use the
	// node-agent namespace directly; space-agent-tools is no longer attached there.
	if (config.onRestoreNodeAgent) {
		const restoreCallback = config.onRestoreNodeAgent;
		tools.push(
			tool(
				'restore_node_agent',
				'Self-heal tool: re-attaches the node-agent MCP server for this session and restarts ' +
					'the query so the new tool surface takes effect. Call this if a previous ' +
					'mcp__node-agent__send_message or similar call returned "No such tool available". ' +
					'The tool restarts your current turn — retry the failed tool call afterwards.',
				{
					reason: z
						.string()
						.optional()
						.describe('Brief explanation of why you are calling this tool'),
				},
				async (args) => {
					try {
						await restoreCallback({ reason: args.reason });
					} catch {
						// Log but don't surface the error to the agent — the query restart
						// may interrupt this response before we can return anyway.
					}
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify({
									success: true,
									message:
										'node-agent MCP server re-attached and query restarted. ' +
										'Your current turn will be interrupted — retry the failed tool call in the next turn.',
								}),
							},
						],
					};
				}
			)
		);
	}

	return createSdkMcpServer({ name: 'space-agent', tools });
}

export type SpaceAgentMcpServer = ReturnType<typeof createSpaceAgentMcpServer>;
