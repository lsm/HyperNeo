/**
 * AgentMessageRouter — unified message delivery for node agents.
 *
 * Handles all message routing through a single code path — no separate within-node
 * vs cross-node logic. Target resolution:
 *   - Agent name: delivers as DM to all sessions with that agent name
 *   - Node name: fan-out to all agents in a named node (via nodeGroups)
 *   - '*': broadcast to all permitted targets
 *   - No match: returns clear error message
 *
 * Authorization is validated against the declared channel topology (via ChannelResolver)
 * before delivery.
 *
 * Note: This is distinct from ChannelRouter (channel-router.ts), which handles
 * workflow-level orchestration (lazy node activation, gate evaluation). This class
 * is used by node-agent-tools to deliver messages between live sessions at runtime.
 */

import { parseAddress } from '../../../../../messaging/src/address';
import type { ActorRef, MessageRecord } from '../../../../../messaging/src/types';
import type { ActorResolver } from '../../../../../messaging/src/contracts';
import { SpaceDeliveryFacade } from '../messaging-adapter';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { PendingAgentMessageRepository } from '../../../storage/repositories/pending-agent-message-repository';
import type { WorkflowChannel } from '@neokai/shared';
import { ChannelResolver } from './channel-resolver';
import { formatAgentMessage } from '../agent-message-envelope';
import { ActivationError, ChannelGateBlockedError, type ChannelRouter } from './channel-router';

export interface AgentMessageRouterConfig {
	/** Node execution repository for looking up agent sessions by workflow run. */
	nodeExecutionRepo: NodeExecutionRepository;
	/** Workflow run ID for looking up peer tasks. */
	workflowRunId: string;
	/** Workflow channel definitions for this run. */
	workflowChannels: WorkflowChannel[];
	/** Injects a message into a target session as a user turn. */
	messageInjector: (sessionId: string, message: string) => Promise<void>;
	/**
	 * Optional channel router for workflow-level delivery checks and lazy node activation.
	 * When provided, send_message activates target nodes (and enforces gate/cycle checks)
	 * even before target agent sessions are spawned.
	 */
	channelRouter?: ChannelRouter;
	/**
	 * Optional map of node name → array of agent names in that node.
	 * When provided, enables fan-out delivery by node name.
	 */
	nodeGroups?: Record<string, string[]>;
	/**
	 * Optional injector for routing messages to the Space Agent chat session.
	 * Used when a node agent explicitly targets `space-agent`.
	 */
	spaceAgentInjector?: (
		spaceId: string,
		message: string,
		replyToSessionId?: string | null
	) => Promise<void>;
	/** Space-scoped task number for message envelopes. */
	taskNumber?: number | null;
	/**
	 * Optional persistent queue for messages whose target session is not yet active.
	 * When provided, a message whose target is declared in the workflow topology or
	 * node_executions (but has no live session yet) is queued instead of failing.
	 * The queue is drained when TaskAgentManager activates the target session.
	 */
	pendingMessageRepo?: PendingAgentMessageRepository;
	/**
	 * Space ID — required when pendingMessageRepo is provided (used when enqueueing).
	 */
	spaceId?: string;
	/**
	 * Task ID — stored on queued messages for diagnostics and filtering.
	 * Optional; defaults to null.
	 */
	taskId?: string;
	/**
	 * Ensures a workflow-node target has a live session before message delivery.
	 * This is intentionally separate from gate evaluation: gates may hold message
	 * content, but they must never prevent the receiving agent from being activated.
	 */
	activateTargetSession?: (
		agentName: string
	) => Promise<Array<{ agentName: string; sessionId: string }>>;
	/** Optional workflow-node id → node-name map for generic @worker target isolation. */
	workflowNodeNameById?: Record<string, string>;
	/**
	 * Optional callback fired after a message is persisted to `pendingMessageRepo`
	 * for a declared-but-inactive target. This is now only a diagnostic/backstop
	 * path; successful send_message results must reflect live delivery, not queueing.
	 *
	 * Fires only for non-deduped enqueues (deduped = message already in queue).
	 */
	onMessageQueued?: (agentName: string) => void;
	/**
	 * Optional lookup callback for reply-to-session routing.
	 * When a node agent sends to `space-agent`, this callback is invoked to
	 * determine whether the reply should go to a specific session (instead of
	 * the default `space:chat:${spaceId}`). Returns `null` for default routing.
	 */
	replyRoutingLookup?: (agentName?: string | null) => string | null;
	/** Generic Space actor resolver for @handle/@role long-term agent DMs. */
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

export interface AgentMessageParams {
	/** Agent name of the sending agent. */
	fromAgentName: string;
	/** Session ID of the sending agent (excluded from delivery). */
	fromSessionId: string;
	/**
	 * Delivery target: an agent name (DM), a node name (fan-out),
	 * an array of agent names (multicast), or '*' (broadcast to all permitted targets).
	 */
	target: string | string[];
	/** Message content to deliver. */
	message: string;
	/**
	 * Optional structured data payload attached to the message.
	 * Included in the delivered message as a JSON appendix when present,
	 * making it available to the receiving agent for programmatic use
	 * (e.g. gate writes, task results, structured feedback).
	 */
	data?: Record<string, unknown>;
}

export interface AgentMessageResult {
	success: boolean | 'partial';
	delivered: Array<{ agentName: string; sessionId: string }>;
	failed: Array<{ agentName: string; sessionId: string; error: string }>;
	/** Set when success is false — human-readable reason for the failure. */
	reason?: string;
	/**
	 * Agent names that were requested but not permitted by channel topology.
	 * Populated on authorization failure.
	 */
	unauthorizedAgentNames?: string[];
	/**
	 * Agent names that are permitted by topology for this sender.
	 * Populated on authorization failure.
	 */
	permittedTargets?: string[];
	/**
	 * Target agent names that had no active sessions.
	 * Populated when delivery was attempted but no sessions were found.
	 */
	notFoundAgentNames?: string[];
	/**
	 * Messages that were queued for later delivery because the target session
	 * was not yet active. Populated when pendingMessageRepo is configured and
	 * the target is a declared-but-inactive node agent.
	 */
	queued?: Array<{ agentName: string; messageId: string }>;
}

import { Logger } from '../../logger';

const log = new Logger('agent-message-router');

export class AgentMessageRouter {
	constructor(private readonly config: AgentMessageRouterConfig) {}

	private async deliverGenericMessage(params: {
		fromAgentName: string;
		fromSessionId: string;
		targets: string[];
		message: string;
		data?: Record<string, unknown>;
		slotToNode: Map<string, string>;
	}): Promise<AgentMessageResult> {
		const { fromAgentName, fromSessionId, targets, message, data, slotToNode } = params;
		const {
			nodeExecutionRepo,
			workflowRunId,
			workflowChannels,
			messageInjector,
			channelRouter,
			spaceAgentInjector,
			pendingMessageRepo,
			spaceId,
			taskId,
			taskNumber,
			activateTargetSession,
			onMessageQueued,
			replyRoutingLookup,
			workflowNodeNameById,
			messageResolver,
			longTermAgentDelivery,
		} = this.config;
		const resolver = new ChannelResolver(workflowChannels);
		const fromNodeName = slotToNode.get(fromAgentName) ?? fromAgentName;
		const selfExecution = nodeExecutionRepo
			.listByWorkflowRun(workflowRunId)
			.find((e) => e.agentName === fromAgentName && e.agentSessionId === fromSessionId);
		const singleNodeByAgentName = new Map<string, string>();
		for (const [nodeName, slots] of this.config.nodeGroups
			? Object.entries(this.config.nodeGroups)
			: []) {
			for (const slot of slots) {
				if (singleNodeByAgentName.has(slot)) {
					singleNodeByAgentName.delete(slot);
				} else {
					singleNodeByAgentName.set(slot, nodeName);
				}
			}
		}
		const hasNodeNameMap = workflowNodeNameById && Object.keys(workflowNodeNameById).length > 0;
		const scopedAgentName = (nodeName: string, agentName: string) => `${nodeName}/${agentName}`;
		const allExecutions = nodeExecutionRepo.listByWorkflowRun(workflowRunId);
		let peers: Array<{
			sessionId: string;
			agentName: string;
			workflowNodeId?: string;
			nodeName?: string;
		}> = allExecutions
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
		const delivered: Array<{ agentName: string; sessionId: string }> = [];
		const queued: Array<{ agentName: string; messageId: string }> = [];
		const notFound: string[] = [];
		const failed: Array<{ agentName: string; sessionId: string; error: string }> = [];
		const dataAppendix =
			data && Object.keys(data).length > 0
				? `\n\n<structured-data>\n${JSON.stringify(data, null, 2)}\n</structured-data>`
				: '';

		for (const target of targets) {
			const address = parseAddress(target);
			if (address.kind === 'handle' && address.handle === 'coordinator') {
				if (!spaceAgentInjector || !spaceId) {
					notFound.push(target);
					continue;
				}
				const envelopedMessage = formatAgentMessage({
					fromLevel: 'node-agent',
					fromAgentName,
					toLevel: 'space-agent',
					body: `${message}${dataAppendix}`,
					taskId,
					taskNumber,
					nodeId: fromAgentName,
				});
				try {
					await spaceAgentInjector(spaceId, envelopedMessage, null);
					delivered.push({ agentName: 'space-agent', sessionId: `space:chat:${spaceId}` });
				} catch (err) {
					failed.push({
						agentName: 'space-agent',
						sessionId: `space:chat:${spaceId}`,
						error: err instanceof Error ? err.message : String(err),
					});
				}
				continue;
			}
			if (address.kind === 'session') {
				if (!spaceAgentInjector || !spaceId) {
					notFound.push(target);
					continue;
				}
				const replyTo = replyRoutingLookup?.(fromAgentName);
				if (!replyTo || address.sessionId !== replyTo) {
					return {
						success: delivered.length > 0 || failed.length > 0 ? 'partial' : false,
						delivered,
						failed,
						reason: `Session target ${target} is not an authorized reply route for '${fromAgentName}'.`,
						unauthorizedAgentNames: [target],
						queued: queued.length > 0 ? queued : undefined,
						notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
					};
				}
				const envelopedMessage = formatAgentMessage({
					fromLevel: 'node-agent',
					fromAgentName,
					toLevel: 'space-agent',
					body: `${message}${dataAppendix}`,
					taskId,
					taskNumber,
					nodeId: fromAgentName,
				});
				try {
					await spaceAgentInjector(spaceId, envelopedMessage, address.sessionId);
					delivered.push({ agentName: 'space-agent', sessionId: address.sessionId });
				} catch (err) {
					failed.push({
						agentName: 'space-agent',
						sessionId: address.sessionId,
						error: err instanceof Error ? err.message : String(err),
					});
				}
				continue;
			}
			if (address.kind === 'handle' || address.kind === 'role') {
				if (!messageResolver || !longTermAgentDelivery || !spaceId) {
					return {
						success: delivered.length > 0 || failed.length > 0 ? 'partial' : false,
						delivered,
						failed,
						reason: `Generic target ${target} is not supported by node-agent send_message in this context.`,
						queued: queued.length > 0 ? queued : undefined,
						notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
					};
				}
				const rawMessage = formatAgentMessage({
					fromLevel: 'node-agent',
					fromAgentName,
					toLevel: 'space-agent',
					body: `${message}${dataAppendix}`,
					taskId,
					taskNumber,
					nodeId: fromAgentName,
					replyToSessionId: fromSessionId,
				});
				const messageRecord: MessageRecord = {
					messageId: `msg_node_${Date.now()}_${Math.random().toString(36).slice(2)}`,
					spaceId,
					senderActorId: `worker:${encodeURIComponent(workflowRunId)}:unresolved:${encodeURIComponent(fromAgentName)}`,
					targets: [target],
					body: rawMessage,
					kind: 'message',
					workflowRunId,
					...(taskId ? { taskId } : {}),
					createdAt: Date.now(),
				};
				const routed = await new SpaceDeliveryFacade({
					resolver: messageResolver,
					deliverToSession: longTermAgentDelivery.deliverToSession,
					queueForActivation: longTermAgentDelivery.queueForActivation,
				}).routeMessage(messageRecord);
				for (const delivery of routed.deliveries) {
					const targetName = delivery.targetActorId ?? target;
					if (delivery.state === 'delivered' && delivery.deliveredSessionId) {
						delivered.push({ agentName: targetName, sessionId: delivery.deliveredSessionId });
					} else if (delivery.state === 'queued') {
						queued.push({ agentName: targetName, messageId: delivery.deliveryId });
					} else if (delivery.state === 'failed') {
						failed.push({
							agentName: targetName,
							sessionId: delivery.deliveredSessionId ?? '',
							error: delivery.lastError ?? 'Delivery failed',
						});
					}
				}
				continue;
			}
			if (address.kind !== 'worker') {
				return {
					success: delivered.length > 0 || failed.length > 0 ? 'partial' : false,
					delivered,
					failed,
					reason: `Generic target ${target} is not supported by node-agent send_message. Use @coordinator, @handle, @role:<role>, @session:<authorized-reply-session>, or @worker:<node>/<agent>.`,
					queued: queued.length > 0 ? queued : undefined,
					notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
				};
			}

			const runId = address.workflowRunId ?? workflowRunId;
			if (runId !== workflowRunId) {
				notFound.push(target);
				continue;
			}
			let nodeName: string;
			let agentName: string | null;
			try {
				nodeName = decodeURIComponent(address.nodeId);
				agentName = address.agentName ? decodeURIComponent(address.agentName) : null;
			} catch (err) {
				return {
					success: false,
					delivered: [],
					failed: [],
					reason: `Invalid worker target ${target}: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
			if (!agentName) {
				notFound.push(target);
				continue;
			}
			const permittedChannelTarget = resolver.canSend(fromNodeName, nodeName)
				? nodeName
				: resolver.canSend(fromNodeName, agentName)
					? agentName
					: null;
			if (!permittedChannelTarget) {
				return {
					success: false,
					delivered: [],
					failed: [],
					reason: `Channel topology does not permit '${fromAgentName}' to send to: ${target}.`,
					unauthorizedAgentNames: [target],
					permittedTargets: resolver.getPermittedTargets(fromNodeName),
				};
			}
			try {
				await channelRouter?.deliverMessage(
					workflowRunId,
					fromAgentName,
					permittedChannelTarget,
					message
				);
			} catch (err) {
				return {
					success: false,
					delivered: [],
					failed: [],
					reason: err instanceof Error ? err.message : String(err),
				};
			}
			const matchesTargetNode = (peer: { agentName: string; nodeName?: string }) =>
				peer.agentName === agentName && (!hasNodeNameMap || peer.nodeName === nodeName);
			if (!peers.some(matchesTargetNode) && activateTargetSession) {
				try {
					const activated = await activateTargetSession(agentName);
					const refreshed = nodeExecutionRepo.listByWorkflowRun(workflowRunId);
					const hydrated = activated.map((session) => {
						const execution = refreshed.find(
							(e) => e.agentName === session.agentName && e.agentSessionId === session.sessionId
						);
						return {
							...session,
							workflowNodeId: execution?.workflowNodeId,
							nodeName: execution
								? (workflowNodeNameById?.[execution.workflowNodeId] ??
									singleNodeByAgentName.get(execution.agentName) ??
									execution.workflowNodeId)
								: (singleNodeByAgentName.get(session.agentName) ??
									slotToNode.get(session.agentName)),
						};
					});
					peers = [...peers, ...hydrated].filter((peer) => peer.sessionId !== fromSessionId);
				} catch (err) {
					log.warn(
						`[AgentMessageRouter] failed to activate generic target "${agentName}": ${err instanceof Error ? err.message : String(err)}`
					);
				}
			}
			const sessions = peers.filter(matchesTargetNode);
			if (sessions.length === 0) {
				if (pendingMessageRepo && spaceId) {
					const rawMessage = formatAgentMessage({
						fromLevel: 'node-agent',
						fromAgentName,
						toLevel: 'node-agent',
						body: `${message}${dataAppendix}`,
						taskId,
						taskNumber,
						nodeId: fromAgentName,
					});
					const queueTargetName = hasNodeNameMap ? scopedAgentName(nodeName, agentName) : agentName;
					const { record, deduped } = pendingMessageRepo.enqueue({
						workflowRunId,
						spaceId,
						taskId: taskId ?? null,
						sourceAgentName: fromAgentName,
						targetKind: 'node_agent',
						targetAgentName: queueTargetName,
						message: rawMessage,
						idempotencyKey: JSON.stringify([fromSessionId, target, rawMessage]),
						ttlMs: 60_000,
						maxAttempts: 3,
					});
					queued.push({ agentName: queueTargetName, messageId: record.id });
					if (!deduped) onMessageQueued?.(queueTargetName);
				}
				notFound.push(agentName);
				continue;
			}
			for (const session of sessions) {
				const envelopedMessage = formatAgentMessage({
					fromLevel: 'node-agent',
					fromAgentName,
					toLevel: 'node-agent',
					body: `${message}${dataAppendix}`,
					taskId,
					taskNumber,
					nodeId: fromAgentName,
				});
				try {
					await messageInjector(session.sessionId, envelopedMessage);
					delivered.push(session);
				} catch (err) {
					failed.push({ ...session, error: err instanceof Error ? err.message : String(err) });
				}
			}
		}

		if (notFound.length > 0 && delivered.length === 0 && failed.length === 0) {
			return {
				success: false,
				delivered: [],
				failed: [],
				reason: `Could not deliver message to target agent(s): ${notFound.join(', ')}. The target is declared but no live session received the message.`,
				queued: queued.length > 0 ? queued : undefined,
				notFoundAgentNames: notFound,
			};
		}
		if (delivered.length === 0 && queued.length === 0 && failed.length > 0) {
			return {
				success: false,
				delivered,
				failed,
				notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
			};
		}
		return {
			success: failed.length > 0 ? 'partial' : true,
			delivered,
			failed,
			queued: queued.length > 0 ? queued : undefined,
			notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
		};
	}

	/**
	 * Deliver a message to the specified target.
	 *
	 * Resolution order:
	 *   1. '*' → broadcast to all topology-permitted targets
	 *   2. Agent name match → DM/fan-out to all sessions with that agent name in the node
	 *   3. Node name match → fan-out to all agents mapped to that node (via nodeGroups)
	 *   4. No match → error with list of known reachable agents
	 *
	 * Authorization is checked against the declared channel topology before delivery.
	 * Returns a structured result — never throws.
	 */
	async deliverMessage(params: AgentMessageParams): Promise<AgentMessageResult> {
		const { fromAgentName, fromSessionId, target, message, data } = params;
		const {
			nodeExecutionRepo,
			workflowRunId,
			workflowChannels,
			messageInjector,
			channelRouter,
			nodeGroups,
			spaceAgentInjector,
			pendingMessageRepo,
			spaceId,
			taskId,
			taskNumber,
			activateTargetSession,
			onMessageQueued,
			replyRoutingLookup,
		} = this.config;

		// --- Build channel resolver + slot-to-node translation map ---
		const resolver = new ChannelResolver(workflowChannels);
		// Channels use node names as addresses. Build a reverse map from agent slot name
		// → node name so the router can translate 'coder' → 'Code' before calling canSend.
		const slotToNode = new Map<string, string>();
		if (nodeGroups) {
			for (const [nodeName, slots] of Object.entries(nodeGroups)) {
				for (const slot of slots) {
					slotToNode.set(slot, nodeName);
				}
			}
		}
		const resolveNodeName = (slotOrNode: string) => slotToNode.get(slotOrNode) ?? slotOrNode;
		const fromNodeName = resolveNodeName(fromAgentName);
		const requestedTargets =
			target === '*' ? ['*'] : Array.isArray(target) ? [...target] : [target];
		const wantsSpaceAgent = target !== '*' && requestedTargets.includes('space-agent');
		if (requestedTargets.length > 0 && requestedTargets.every(isGenericAddress)) {
			return this.deliverGenericMessage({
				fromAgentName,
				fromSessionId,
				targets: requestedTargets,
				message,
				data,
				slotToNode,
			});
		}

		// Channel topology required except for built-in inter-level targets.
		if (resolver.isEmpty() && !(wantsSpaceAgent && spaceAgentInjector && spaceId)) {
			return {
				success: false,
				delivered: [],
				failed: [],
				reason:
					'No channel topology declared for this node. ' +
					'Direct messaging via send_message is not available.',
			};
		}

		// --- Load ALL executions (for target resolution and declared-agent detection) ---
		// We load ALL executions — not just those with agentSessionId — so we can detect
		// agents that are declared but not yet active (pending activation by the tick loop).
		// This prevents "Unknown target" errors for agents whose sessions haven't spawned yet.
		const allExecutions = nodeExecutionRepo.listByWorkflowRun(workflowRunId);

		// Peers with live sessions — used for direct message injection.
		const execWithSession = allExecutions.filter(
			(e) => e.agentSessionId && e.agentSessionId !== fromSessionId
		);
		if (execWithSession.length === 0 && allExecutions.length > 0) {
			log.warn(
				`[AgentMessageRouter] nodeExecutionRepo has ${allExecutions.length} execution(s) for run ${workflowRunId} ` +
					`but none have an agentSessionId yet — will attempt activation/queuing.`
			);
		}
		let peers: Array<{ sessionId: string; agentName: string }> = execWithSession.map((e) => ({
			sessionId: e.agentSessionId!,
			agentName: e.agentName,
		}));

		// All declared agent names (with or without a live session) for target resolution.
		// Source 1: node_executions (lazily created on first activation).
		// Source 2: workflow definition — every slot declared in any node group is a
		//   legitimate peer name even before its node_execution row exists. nodeGroups
		//   is derived from `workflow.nodes.map(n => resolveNodeAgents(n).map(a => a.name))`
		//   in TaskAgentManager.buildNodeAgentMcpServerForSession, so it covers the full
		//   static workflow surface. Without source 2, never-activated peers fall through
		//   to "Unknown target" — the bug Task #133 closes.
		const allDeclaredAgentNames = new Set(
			allExecutions.filter((e) => e.agentSessionId !== fromSessionId).map((e) => e.agentName)
		);
		if (nodeGroups) {
			for (const slots of Object.values(nodeGroups)) {
				for (const slot of slots) {
					if (slot === fromAgentName) continue;
					allDeclaredAgentNames.add(slot);
				}
			}
		}

		// --- Resolve target agent names ---
		let targetAgentNames: string[];

		if (target === '*') {
			// Broadcast: expand to all topology-permitted targets
			const permittedNodes = resolver.getPermittedTargets(fromNodeName);
			if (permittedNodes.length === 0) {
				return {
					success: false,
					delivered: [],
					failed: [],
					reason: `No permitted targets for agent '${fromAgentName}' in the declared channel topology.`,
				};
			}
			targetAgentNames = permittedNodes;
		} else if (Array.isArray(target)) {
			// Multicast: explicit list of agent names. Built-in names are reserved and
			// are handled unconditionally by the delivery branch below.
			targetAgentNames = target;
		} else if (target === 'space-agent' && spaceAgentInjector && spaceId) {
			targetAgentNames = ['space-agent'];
		} else {
			// Single target: try to resolve by agent name or node name.
			// Resolution order:
			//   1. Agent name matches a live session peer
			//   2. Node name maps to agents via nodeGroups
			//   3. Agent name is declared in any node_execution for this run (pending activation)
			//   4. Channel topology declares a channel to this node name (not yet activated)
			// If none match → unknown target error.
			const agentMatches = peers.filter((m) => m.agentName === target).map((m) => m.agentName);

			if (agentMatches.length > 0) {
				// Agent name → DM to its live session(s)
				targetAgentNames = [target];
			} else if (nodeGroups && nodeGroups[target]) {
				// Node name match → fan-out to all agents in that node
				targetAgentNames = nodeGroups[target];
			} else if (allDeclaredAgentNames.has(target)) {
				// Agent is declared in a node_execution but hasn't spawned a session yet.
				// Route through activation/queue path below.
				targetAgentNames = [target];
			} else {
				// Check if the target is a topology-declared node that hasn't been activated yet.
				// This handles the case where the caller uses a node name that hasn't been seen yet.
				const permittedNodes = resolver.getPermittedTargets(fromNodeName);
				const isTopologyDeclared =
					permittedNodes.includes(target) ||
					permittedNodes.some((n) => resolveNodeName(n) === target);
				if (isTopologyDeclared) {
					// Target is declared in channel topology but not yet activated.
					// Route through activation/queue path below as a single target.
					targetAgentNames = [target];
				} else {
					// No match — unknown target
					const knownAgentNames = [...new Set(peers.map((m) => m.agentName))].sort();
					const nodeNames = nodeGroups ? Object.keys(nodeGroups) : [];
					const allTargets = [
						...new Set([...knownAgentNames, ...nodeNames, ...allDeclaredAgentNames]),
					].sort();
					if (spaceAgentInjector && spaceId) allTargets.push('space-agent');
					return {
						success: false,
						delivered: [],
						failed: [],
						reason:
							`Unknown target '${target}': no agent or node found with this name. ` +
							(allTargets.length > 0
								? `Reachable targets: ${allTargets.join(', ')}.`
								: 'No reachable targets available.'),
					};
				}
			}
		}

		// --- Authorization check (translate slot names → node names for canSend) ---
		const topologyTargets = targetAgentNames.filter((r) => r !== 'space-agent');
		const unauthorized = topologyTargets.filter(
			(r) => !resolver.canSend(fromNodeName, resolveNodeName(r))
		);
		if (unauthorized.length > 0) {
			const permittedNodes = resolver.getPermittedTargets(fromNodeName);
			return {
				success: false,
				delivered: [],
				failed: [],
				reason:
					`Channel topology does not permit '${fromAgentName}' to send to: ${unauthorized.join(', ')}. ` +
					`Permitted targets: ${permittedNodes.length > 0 ? permittedNodes.join(', ') : 'none'}.`,
				unauthorizedAgentNames: unauthorized,
				permittedTargets: permittedNodes,
			};
		}

		// --- Workflow-level delivery checks + lazy node activation ---
		// This ensures cross-node messages can activate downstream nodes even when
		// target sessions do not exist yet.
		const activatedTargets = new Set<string>();
		if (channelRouter) {
			for (const agentName of targetAgentNames) {
				if (agentName === 'space-agent') continue;
				try {
					const routed = await channelRouter.deliverMessage(
						workflowRunId,
						fromAgentName,
						agentName,
						message
					);
					if (routed.activatedTasks && routed.activatedTasks.length > 0) {
						activatedTargets.add(agentName);
					}
				} catch (err) {
					if (err instanceof ChannelGateBlockedError) {
						return {
							success: false,
							delivered: [],
							failed: [],
							reason: err.message,
						};
					}
					if (err instanceof ActivationError) {
						return {
							success: false,
							delivered: [],
							failed: [],
							reason: err.message,
						};
					}
					return {
						success: false,
						delivered: [],
						failed: [],
						reason: err instanceof Error ? err.message : String(err),
					};
				}
			}
		}

		// --- Ensure target sessions are live before content delivery ---
		// ChannelRouter activation above may only create pending node_execution rows.
		// The runtime callback is responsible for spawning/resuming the actual session;
		// send_message must not report success until that session can receive content.
		if (activateTargetSession) {
			const refreshed = new Map(peers.map((peer) => [`${peer.agentName}:${peer.sessionId}`, peer]));
			for (const agentName of targetAgentNames) {
				if (agentName === 'space-agent') continue;
				if (peers.some((peer) => peer.agentName === agentName)) continue;
				try {
					const activatedSessions = await activateTargetSession(agentName);
					for (const session of activatedSessions) {
						refreshed.set(`${session.agentName}:${session.sessionId}`, session);
					}
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					log.warn(
						`[AgentMessageRouter] failed to activate target session for agent "${agentName}": ${errMsg}`
					);
				}
			}
			peers = [...refreshed.values()].filter((peer) => peer.sessionId !== fromSessionId);
		}

		// --- Build the message content (with optional structured-data appendix) ---
		const dataAppendix =
			data && Object.keys(data).length > 0
				? `\n\n<structured-data>\n${JSON.stringify(data, null, 2)}\n</structured-data>`
				: '';

		// --- Deliver to all resolved sessions (best-effort) ---
		const delivered: Array<{ agentName: string; sessionId: string }> = [];
		const queued: Array<{ agentName: string; messageId: string }> = [];
		const notFound: string[] = [];
		const failed: Array<{ agentName: string; sessionId: string; error: string }> = [];

		for (const agentName of targetAgentNames) {
			if (agentName === 'space-agent') {
				if (!spaceAgentInjector || !spaceId) {
					notFound.push(agentName);
					continue;
				}
				// Check if this node agent should route its reply to a specific
				// originating session (symmetric reply routing for ad-hoc members).
				const replyTo = replyRoutingLookup ? replyRoutingLookup(fromAgentName) : null;
				const envelopedMessage = formatAgentMessage({
					fromLevel: 'node-agent',
					fromAgentName,
					toLevel: 'space-agent',
					body: `${message}${dataAppendix}`,
					taskId,
					taskNumber,
					nodeId: fromAgentName,
				});
				try {
					await spaceAgentInjector(spaceId, envelopedMessage, replyTo);
					delivered.push({
						agentName,
						sessionId: replyTo || `space:chat:${spaceId}`,
					});
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					failed.push({
						agentName,
						sessionId: replyTo || `space:chat:${spaceId}`,
						error: errMsg,
					});
				}
				continue;
			}

			const agentSessions = peers.filter((m) => m.agentName === agentName);
			if (agentSessions.length === 0) {
				// No live session for this target. This is not a successful delivery:
				// `delivered: true` requires a live session that received the message.
				// Keep the legacy queue as a recovery backstop only.
				// Queue when:
				//   (a) channelRouter just activated the target node (activatedTargets), OR
				//   (b) the target is already declared in node_executions (pending spawn), OR
				//   (c) the target was resolved from topology (may not have an execution yet)
				// — and a pendingMessageRepo is available for persistent queuing.
				const isDeclaredOrActivated =
					activatedTargets.has(agentName) ||
					// Target appears in a node_execution (pending activation by the tick loop).
					allDeclaredAgentNames.has(agentName) ||
					// Target appears in the channel topology even without an execution record.
					// Three sub-conditions cover the slot/node name mapping in both directions:
					//   n === agentName             — channel target IS the slot name directly (slot-name addressed channel)
					//   resolveNodeName(n) === agentName — channel target is a node name that maps to this agent via slotToNode
					//   n === resolveNodeName(agentName) — agent's slot maps to a node name that is the channel target
					//                                      (node-name addressed channels when nodeGroups is configured)
					resolver
						.getPermittedTargets(fromNodeName)
						.some(
							(n) =>
								n === agentName ||
								resolveNodeName(n) === agentName ||
								n === resolveNodeName(agentName)
						);

				if (isDeclaredOrActivated && pendingMessageRepo && spaceId) {
					// Audited (Task #139): onMessageQueued below covers all
					// queuing paths. No independent activation gap exists —
					// every branch that enqueues also fires the callback.
					// Queue the already-enveloped message; flushPendingMessagesForTarget injects it
					// as-is so queued delivery matches direct delivery.
					const rawMessage = formatAgentMessage({
						fromLevel: 'node-agent',
						fromAgentName,
						toLevel: 'node-agent',
						body: `${message}${dataAppendix}`,
						taskId,
						taskNumber,
						nodeId: fromAgentName,
					});
					try {
						const { record, deduped } = pendingMessageRepo.enqueue({
							workflowRunId,
							spaceId,
							taskId: taskId ?? null,
							sourceAgentName: fromAgentName,
							targetKind: 'node_agent',
							targetAgentName: agentName,
							message: rawMessage,
							idempotencyKey: JSON.stringify([fromSessionId, agentName, rawMessage]),
							ttlMs: 60_000,
							maxAttempts: 3,
						});
						queued.push({ agentName, messageId: record.id });
						notFound.push(agentName);
						log.info(
							`[AgentMessageRouter] queued message ${record.id} for agent "${agentName}" ` +
								`(run=${workflowRunId}, from=${fromAgentName})`
						);
						// Best-effort auto-resume: if the target already has a known session
						// (e.g. a previous execution that is now idle/completed), trigger an
						// immediate resume so the queue is drained without waiting for the
						// next activation cycle.
						if (!deduped) onMessageQueued?.(agentName);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.warn(
							`[AgentMessageRouter] failed to queue message for agent "${agentName}": ${errMsg}`
						);
						notFound.push(agentName);
					}
				} else if (activatedTargets.has(agentName)) {
					// channelRouter activated the node but no pending queue is configured.
					// The node will be spawned by the tick loop; message delivery is best-effort.
					// Don't count as notFound since the activation handoff was accepted.
					log.warn(
						`[AgentMessageRouter] target "${agentName}" was activated but no pendingMessageRepo is configured — ` +
							`message may not be delivered to the new session. Configure pendingMessageRepo to enable reliable delivery.`
					);
				} else {
					notFound.push(agentName);
				}
				continue;
			}

			for (const member of agentSessions) {
				const envelopedMessage = formatAgentMessage({
					fromLevel: 'node-agent',
					fromAgentName,
					toLevel: 'node-agent',
					body: `${message}${dataAppendix}`,
					taskId,
					taskNumber,
					nodeId: fromAgentName,
				});
				try {
					await messageInjector(member.sessionId, envelopedMessage);
					delivered.push({ agentName, sessionId: member.sessionId });
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					failed.push({ agentName, sessionId: member.sessionId, error: errMsg });
				}
			}
		}

		// All outcomes failed (nothing delivered to a live session). A queued row is
		// a recovery artifact, not delivery, so success must stay false when the only
		// outcome was queueing.
		if (notFound.length > 0 && delivered.length === 0 && failed.length === 0) {
			return {
				success: false,
				delivered: [],
				failed: [],
				reason:
					`Could not deliver message to target agent(s): ${notFound.join(', ')}. ` +
					`The target is declared but no live session received the message.`,
				queued: queued.length > 0 ? queued : undefined,
				notFoundAgentNames: notFound,
			};
		}

		if (delivered.length === 0 && queued.length === 0 && failed.length > 0) {
			return {
				success: false,
				delivered,
				failed,
				notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
			};
		}
		if (failed.length > 0) {
			return {
				success: 'partial',
				delivered,
				failed,
				queued: queued.length > 0 ? queued : undefined,
				notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
			};
		}
		return {
			success: true,
			delivered,
			failed,
			queued: queued.length > 0 ? queued : undefined,
			notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
		};
	}
}

function isGenericAddress(target: string): boolean {
	try {
		parseAddress(target);
		return true;
	} catch {
		return false;
	}
}
