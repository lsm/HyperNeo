import { parseAddress } from '../../../../messaging/src/address';
import type { ParsedAddress, WorkerAddress } from '../../../../messaging/src/address';
import type {
	ActorRef,
	DeliveryRecord,
	DeliveryState,
	MessageRecord,
} from '../../../../messaging/src/types';
import type {
	ActorResolver,
	ResolvedTarget,
	ResolveTargetsResult,
	RouteMessageResult,
	UnresolvedTarget,
} from '../../../../messaging/src/contracts';
import type { PendingAgentMessageRecord } from '../../storage/repositories/pending-agent-message-repository';
import type { NodeExecution } from '@neokai/shared';
import type { SpaceWorkflowRepository } from '../../storage/repositories/space-workflow-repository';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';
import type { SpaceWorkflow, WorkflowChannel, WorkflowNode } from '@neokai/shared';
import { ChannelResolver } from './runtime/channel-resolver';
import type { SpaceActorRegistryAdapter } from './actor-registry';

export interface SpaceMessageResolverContext {
	spaceId: string;
	workflowRunId?: string;
	nodeId?: string;
	agentName?: string;
}

export interface SpaceMessageResolverConfig {
	actorRegistry: SpaceActorRegistryAdapter;
	workflowRepo: SpaceWorkflowRepository;
	workflowRunRepo: SpaceWorkflowRunRepository;
}

export class SpaceMessageResolver implements ActorResolver {
	constructor(
		private readonly config: SpaceMessageResolverConfig,
		private readonly context: SpaceMessageResolverContext
	) {}

	async resolveTargets(message: MessageRecord): Promise<ResolveTargetsResult> {
		const resolved: ResolvedTarget[] = [];
		const unresolved: UnresolvedTarget[] = [];
		const seen = new Set<string>();

		if (message.spaceId !== this.context.spaceId) {
			return {
				resolved,
				unresolved: message.targets.map((targetRef) => ({
					targetRef,
					reason: `Message space ${message.spaceId} does not match resolver space ${this.context.spaceId}`,
				})),
			};
		}

		if (
			this.context.workflowRunId &&
			message.workflowRunId &&
			message.workflowRunId !== this.context.workflowRunId
		) {
			return {
				resolved,
				unresolved: message.targets.map((targetRef) => ({
					targetRef,
					reason: `Message workflowRunId ${message.workflowRunId} does not match resolver workflowRunId ${this.context.workflowRunId}`,
				})),
			};
		}

		for (const targetRef of message.targets) {
			let address: ParsedAddress;
			try {
				address = parseAddress(targetRef);
			} catch (error) {
				unresolved.push({
					targetRef,
					reason: error instanceof Error ? error.message : String(error),
				});
				continue;
			}

			const result = this.resolveAddress(targetRef, address, message);
			for (const actor of result.actors) {
				const key = `${targetRef}\0${actor.actorId}`;
				if (seen.has(key)) continue;
				seen.add(key);
				resolved.push({ targetRef, address, actor });
			}
			if (result.reason) {
				unresolved.push({ targetRef, address, reason: result.reason });
			}
		}

		return { resolved, unresolved };
	}

	private resolveAddress(
		targetRef: string,
		address: ParsedAddress,
		message: MessageRecord
	): { actors: ActorRef[]; reason?: string } {
		const spaceId = message.spaceId || this.context.spaceId;
		const actors = this.config.actorRegistry.listActors(spaceId);

		switch (address.kind) {
			case 'handle': {
				const handle = `@${address.handle}`;
				const matches = actors.filter((actor) => actor.handle === handle && isRoutable(actor));
				return matches.length > 0
					? { actors: stableActors(matches) }
					: { actors: [], reason: `No routable actor found for handle ${handle}` };
			}
			case 'role': {
				const role = actorRole(address.role);
				const workflowRunId = message.workflowRunId ?? this.context.workflowRunId;
				const holders = this.permitRoleActors([
					...actors.filter((actor) => this.actorHasRole(actor, address.role, role, workflowRunId)),
					...this.declaredRoleActors(workflowRunId, address.role, actors),
				]);
				const active = holders.filter((actor) => actor.status === 'active');
				const inactive = holders.filter((actor) => actor.status === 'inactive');
				const routable = active.length > 0 ? active : inactive;
				return routable.length > 0
					? { actors: stableActors(routable) }
					: { actors: [], reason: `No routable actor found for role ${address.role}` };
			}
			case 'session': {
				const actorId = `session:${address.sessionId}`;
				const actor = actors.find(
					(candidate) => candidate.actorId === actorId && isRoutable(candidate)
				);
				return actor
					? { actors: [actor] }
					: { actors: [], reason: `No routable session actor found for ${address.sessionId}` };
			}
			case 'worker':
				return this.resolveWorker(targetRef, address, message, actors);
			case 'channel':
				return {
					actors: [],
					reason: `Channel targets are not enabled in Space messaging v1: #${address.name}`,
				};
		}
	}

	private resolveWorker(
		targetRef: string,
		address: WorkerAddress,
		message: MessageRecord,
		actors: ActorRef[]
	): { actors: ActorRef[]; reason?: string } {
		const workflowRunId =
			address.workflowRunId ?? message.workflowRunId ?? this.context.workflowRunId;
		if (!workflowRunId) {
			return {
				actors: [],
				reason: `Worker target ${targetRef} requires workflowRunId or @worker:<run>/<node>/<agent>`,
			};
		}

		const workflow = this.workflowForRun(workflowRunId);
		const nodeId = decodeAddressComponent(address.nodeId, targetRef);
		if (!nodeId.ok) return { actors: [], reason: nodeId.reason };
		const targetNodeId = workflowNodeId(workflow?.nodes ?? [], nodeId.value) ?? nodeId.value;
		const agentName = address.agentName
			? decodeAddressComponent(address.agentName, targetRef)
			: undefined;
		if (agentName && !agentName.ok) return { actors: [], reason: agentName.reason };
		const workerActors = actors.filter(
			(actor) =>
				actor.kind === 'worker' &&
				parseWorkerActorId(actor.actorId)?.workflowRunId === workflowRunId
		);
		const matches = workerActors.filter((actor) => {
			const parsed = parseWorkerActorId(actor.actorId);
			if (!parsed) return false;
			if (parsed.nodeId !== targetNodeId) return false;
			return agentName ? parsed.agentName === agentName.value : true;
		});
		const declaredAgentName = this.declaredAgentName(workflow, targetNodeId, agentName?.value);
		const declaredAgentNames = this.declaredAgentNames(workflow, targetNodeId);
		if (declaredAgentName) {
			const declared = this.declaredWorkerActor(workflowRunId, targetNodeId, declaredAgentName);
			const hasDeclared = matches.some((actor) => actor.actorId === declared?.actorId);
			if (declared && !hasDeclared) matches.push(declared);
		}
		let routable = matches.filter(isRoutable);
		if (!agentName && declaredAgentNames.length > 1 && !declaredAgentName) {
			return {
				actors: [],
				reason: `Worker target ${targetRef} is ambiguous; specify @worker:<node>/<agent>`,
			};
		}
		if (!agentName && this.context.agentName) {
			const contextMatches = routable.filter(
				(actor) => parseWorkerActorId(actor.actorId)?.agentName === this.context.agentName
			);
			if (contextMatches.length > 0 || declaredAgentName === this.context.agentName) {
				routable = contextMatches;
			}
		}
		if (routable.length === 0) {
			return { actors: [], reason: `No routable worker actor found for ${targetRef}` };
		}
		if (!agentName && routable.length > 1) {
			return {
				actors: [],
				reason: `Worker target ${targetRef} is ambiguous; specify @worker:<node>/<agent>`,
			};
		}

		const permitted = routable.filter((actor) =>
			this.canSendToWorker(workflowRunId, actor, address)
		);
		if (permitted.length === 0) {
			return {
				actors: [],
				reason: `Channel topology does not permit worker target ${targetRef}`,
			};
		}
		return { actors: stableActors(permitted) };
	}

	private actorHasRole(
		actor: ActorRef,
		role: string,
		encodedRole: string,
		workflowRunId: string | undefined
	): boolean {
		if (actor.kind !== 'worker') {
			return actor.roles?.includes(role) || actor.roles?.includes(encodedRole) || false;
		}
		const parsed = parseWorkerActorId(actor.actorId);
		if (!parsed) return false;
		if (workflowRunId && parsed.workflowRunId !== workflowRunId) return false;
		return Boolean(
			actor.roles?.includes(role) ||
				actor.roles?.includes(encodedRole) ||
				this.workerNodeMatchesRole(workflowRunId ?? parsed.workflowRunId, parsed.nodeId, role)
		);
	}

	private permitRoleActors(actors: ActorRef[]): ActorRef[] {
		if (!this.context.workflowRunId || !this.context.nodeId) return actors;
		return actors.filter((actor) => {
			if (actor.kind !== 'worker') return true;
			const parsed = parseWorkerActorId(actor.actorId);
			if (!parsed || parsed.workflowRunId !== this.context.workflowRunId) return false;
			return this.canSendToWorker(this.context.workflowRunId!, actor);
		});
	}

	private canSendToWorker(
		workflowRunId: string,
		actor: ActorRef,
		address?: WorkerAddress
	): boolean {
		const run = this.config.workflowRunRepo.getRun(workflowRunId);
		if (!run || run.spaceId !== this.context.spaceId) return false;
		const workflow = this.config.workflowRepo.getWorkflow(run.workflowId);
		if (!workflow) return false;
		const parsed = parseWorkerActorId(actor.actorId);
		if (!parsed) return false;

		if (address?.workflowRunId && !this.context.nodeId) return true;

		const fromNodeName = workflowNodeName(workflow.nodes, this.context.nodeId);
		const targetNodeName = workflowNodeName(workflow.nodes, parsed.nodeId);
		if (!fromNodeName || !targetNodeName) return false;
		if (!workflow.channels || workflow.channels.length === 0) return false;
		return canSendToWorkerTarget(
			workflow.channels,
			[fromNodeName, this.context.agentName],
			[targetNodeName, parsed.agentName]
		);
	}

	private declaredRoleActors(
		workflowRunId: string | undefined,
		role: string,
		actors: ActorRef[]
	): ActorRef[] {
		if (!workflowRunId) return [];
		const workflow = this.workflowForRun(workflowRunId);
		if (!workflow) return [];
		return workflow.nodes.flatMap((node) =>
			node.agents
				.filter(
					(agent) =>
						agent.name === role ||
						actorRole(agent.name) === role ||
						node.id === role ||
						node.name === role ||
						actorRole(node.id) === role ||
						actorRole(node.name) === role
				)
				.map((agent) => {
					const actorId = workerActorId(workflowRunId, node.id, agent.name);
					if (actors.some((actor) => actor.actorId === actorId)) return null;
					return this.declaredWorkerActor(workflowRunId, node.id, agent.name);
				})
				.filter((actor): actor is ActorRef => Boolean(actor))
		);
	}

	private workerNodeMatchesRole(workflowRunId: string, nodeId: string, role: string): boolean {
		const workflow = this.workflowForRun(workflowRunId);
		const node = workflow?.nodes.find((candidate) => candidate.id === nodeId);
		return Boolean(
			node &&
				(node.id === role ||
					node.name === role ||
					actorRole(node.id) === role ||
					actorRole(node.name) === role)
		);
	}

	private declaredWorkerActor(
		workflowRunId: string,
		nodeId: string,
		agentName: string | undefined
	): ActorRef | null {
		if (!agentName) return null;
		const workflow = this.workflowForRun(workflowRunId);
		const node = workflow?.nodes.find((candidate) => candidate.id === nodeId);
		if (!node?.agents.some((agent) => agent.name === agentName)) return null;
		return {
			actorId: workerActorId(workflowRunId, nodeId, agentName),
			kind: 'worker',
			spaceId: this.context.spaceId,
			handle: workerHandle(workflowRunId, nodeId, agentName),
			roles: uniqueStrings([actorRole(agentName), actorRole(nodeId)]),
			status: 'inactive',
		};
	}

	private declaredAgentName(
		workflow: SpaceWorkflow | null,
		nodeId: string,
		explicitAgentName: string | undefined
	): string | undefined {
		const agentNames = this.declaredAgentNames(workflow, nodeId);
		if (agentNames.length === 0) return explicitAgentName;
		if (explicitAgentName)
			return agentNames.includes(explicitAgentName) ? explicitAgentName : undefined;
		if (this.context.agentName && agentNames.includes(this.context.agentName)) {
			return this.context.agentName;
		}
		return agentNames.length === 1 ? agentNames[0] : undefined;
	}

	private declaredAgentNames(workflow: SpaceWorkflow | null, nodeId: string): string[] {
		const node = workflow?.nodes.find((candidate) => candidate.id === nodeId);
		return node?.agents.map((agent) => agent.name) ?? [];
	}

	private workflowForRun(workflowRunId: string) {
		const run = this.config.workflowRunRepo.getRun(workflowRunId);
		if (!run || run.spaceId !== this.context.spaceId) return null;
		return this.config.workflowRepo.getWorkflow(run.workflowId) ?? null;
	}
}

export interface SpaceDeliveryFacadeConfig {
	resolver: ActorResolver;
	deliverToSession?: (
		actor: ActorRef,
		message: MessageRecord
	) => Promise<string | null | undefined>;
	queueForActivation?: (
		actor: ActorRef,
		message: MessageRecord
	) => Promise<string | null | undefined>;
}

export interface LegacyNodeTargetTranslatorConfig {
	spaceId: string;
	workflowRunId: string;
	workflowNodeId: string;
	agentName: string;
	workflow: SpaceWorkflow | null;
	actors?: ActorRef[];
	replyRoutingLookup?: (agentName?: string | null) => string | null;
}

export interface TaskMessageTargetTranslatorConfig {
	workflowRunId: string;
	nodeExecutions: NodeExecution[];
	workflow: SpaceWorkflow | null;
}

export function translateLegacyNodeTargets(
	target: string | string[],
	config: LegacyNodeTargetTranslatorConfig
): string[] {
	const targets = Array.isArray(target) ? target : [target];
	const translated = targets.flatMap((targetRef) => {
		const matches = translateLegacyNodeTarget(targetRef, config);
		if (matches.length === 0) {
			throw new Error(`Unknown target "${targetRef}".`);
		}
		return matches;
	});
	return uniqueStrings(translated);
}

export function translateTaskMessageTarget(
	input: { target?: string | null; nodeId?: string | null },
	config: TaskMessageTargetTranslatorConfig
): string {
	const explicitTarget = input.target?.trim();
	if (explicitTarget) {
		if (explicitTarget === 'task-agent') {
			throw new Error(
				'Target "task-agent" is no longer supported. Use @coordinator or a worker target.'
			);
		}
		const address = parseAddress(explicitTarget);
		if (
			address.kind !== 'worker' &&
			address.kind !== 'session' &&
			address.kind !== 'handle' &&
			address.kind !== 'role'
		) {
			throw new Error(
				`Generic target ${explicitTarget} is not routable from this tool. Use @handle, @role:<role>, @worker:<node>/<agent>, @worker:<run>/<node>/<agent>, @session:<task-agent-session>, or node_id.`
			);
		}
		return explicitTarget;
	}

	const nodeId = input.nodeId?.trim();
	if (!nodeId) {
		throw new Error('Target is required. Provide target or node_id.');
	}
	if (nodeId === 'task-agent') {
		throw new Error(
			'Target "task-agent" is no longer supported. Use @coordinator or a worker target.'
		);
	}

	const resolved = resolveTaskNodeExecution(config.nodeExecutions, nodeId);
	if (!resolved) {
		throw new Error(`Node not found: "${nodeId}". Expected an execution UUID or agent name.`);
	}
	const nodeName = workflowNodeName(config.workflow?.nodes ?? [], resolved.workflowNodeId);
	if (!nodeName) {
		throw new Error(`Workflow node not found for execution ${resolved.id}.`);
	}
	return workerTarget(config.workflowRunId, nodeName, resolved.agentName);
}

export class SpaceDeliveryFacade {
	constructor(private readonly config: SpaceDeliveryFacadeConfig) {}

	async routeMessage(message: MessageRecord): Promise<RouteMessageResult> {
		const result = await this.config.resolver.resolveTargets(message);
		const deliveries: DeliveryRecord[] = [];

		for (const target of result.resolved) {
			const delivery = createDeliveryFromActor(message, target.targetRef, target.actor);
			if (target.actor.status === 'active' && this.config.deliverToSession) {
				try {
					const deliveredSessionId = await this.config.deliverToSession(target.actor, message);
					if (deliveredSessionId) {
						delivery.state = 'delivered';
						delivery.deliveredAt = Date.now();
						delivery.deliveredSessionId = deliveredSessionId;
					}
				} catch (error) {
					delivery.state = 'failed';
					delivery.attemptCount += 1;
					delivery.lastError = error instanceof Error ? error.message : String(error);
				}
			} else if (target.actor.status === 'inactive' && this.config.queueForActivation) {
				try {
					const messageId = await this.config.queueForActivation(target.actor, message);
					if (messageId) delivery.deliveryId = `delivery_${messageId}`;
				} catch (error) {
					delivery.state = 'failed';
					delivery.attemptCount += 1;
					delivery.lastError = error instanceof Error ? error.message : String(error);
				}
			}
			deliveries.push(delivery);
		}

		const failedCounts = new Map<string, number>();
		for (const target of result.unresolved) {
			const occurrence = failedCounts.get(target.targetRef) ?? 0;
			failedCounts.set(target.targetRef, occurrence + 1);
			deliveries.push(createFailedDelivery(message, target.targetRef, target.reason, occurrence));
		}

		return { message, deliveries };
	}
}

export function pendingMessageToMessageRecord(
	row: PendingAgentMessageRecord,
	actors: ActorRef[] = []
): MessageRecord {
	return {
		messageId: `msg_legacy_${row.id}`,
		spaceId: row.spaceId,
		senderActorId: legacySenderActorId(row, actors),
		targets: [row.targetAgentName],
		body: row.message,
		kind: 'message',
		workflowRunId: row.workflowRunId,
		...(row.taskId ? { taskId: row.taskId } : {}),
		...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
		createdAt: row.createdAt,
	};
}

export function pendingMessageToDeliveryRecords(
	row: PendingAgentMessageRecord,
	actors: ActorRef[],
	workflow?: SpaceWorkflow | null
): DeliveryRecord[] {
	const messageId = `msg_legacy_${row.id}`;
	const state = pendingStatusToDeliveryState(row.status);
	const targetActors = legacyTargetActors(row, actors, workflow);
	if (targetActors.length === 0) {
		return [createLegacyDelivery(row, messageId, state)];
	}
	return targetActors.map((actor, index) =>
		createLegacyDelivery(row, messageId, state, actor, index === 0 ? undefined : index)
	);
}

function createDeliveryFromActor(
	message: MessageRecord,
	targetRef: string,
	actor: ActorRef
): DeliveryRecord {
	return {
		deliveryId: `delivery_${message.messageId}_${encodeURIComponent(targetRef)}_${encodeURIComponent(actor.actorId)}`,
		messageId: message.messageId,
		targetActorId: actor.actorId,
		targetRef,
		state: 'queued',
		attemptCount: 0,
		maxAttempts: 5,
		createdAt: Date.now(),
	};
}

function createFailedDelivery(
	message: MessageRecord,
	targetRef: string,
	lastError: string,
	occurrence = 0
): DeliveryRecord {
	const suffix = occurrence === 0 ? '' : `_${occurrence}`;
	return {
		deliveryId: `delivery_${message.messageId}_${encodeURIComponent(targetRef)}_failed${suffix}`,
		messageId: message.messageId,
		targetRef,
		state: 'failed',
		attemptCount: 0,
		maxAttempts: 0,
		createdAt: Date.now(),
		lastError,
	};
}

function createLegacyDelivery(
	row: PendingAgentMessageRecord,
	messageId: string,
	state: DeliveryState,
	actor?: ActorRef,
	fanoutIndex?: number
): DeliveryRecord {
	return {
		deliveryId: `delivery_legacy_${row.id}${fanoutIndex === undefined ? '' : `_${fanoutIndex}`}`,
		messageId,
		targetActorId: actor?.actorId,
		targetRef: row.targetAgentName,
		state,
		attemptCount: row.attempts,
		maxAttempts: row.maxAttempts,
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
		...(row.lastError ? { lastError: row.lastError } : {}),
		...(row.deliveredSessionId ? { deliveredSessionId: row.deliveredSessionId } : {}),
		...(row.deliveredAt ? { deliveredAt: row.deliveredAt } : {}),
	};
}

function translateLegacyNodeTarget(
	target: string,
	config: LegacyNodeTargetTranslatorConfig
): string[] {
	const targetRef = target.trim();
	if (!targetRef) return [];
	if (targetRef === 'task-agent') {
		throw new Error('Target "task-agent" is no longer supported. Use space-agent or @coordinator.');
	}
	if (targetRef.startsWith('@') || targetRef.startsWith('#')) {
		parseAddress(targetRef);
		return [targetRef];
	}
	if (targetRef === 'space-agent') {
		const replyTo = config.replyRoutingLookup?.(config.agentName);
		return [replyTo ? `@session:${replyTo}` : '@coordinator'];
	}
	if (targetRef === '*') {
		return permittedWorkerTargets(config);
	}
	return legacyBareTargetMatches(targetRef, config);
}

function permittedWorkerTargets(config: LegacyNodeTargetTranslatorConfig): string[] {
	const workflow = config.workflow;
	if (!workflow) return [];
	const fromNodeName = workflowNodeName(workflow.nodes, config.workflowNodeId);
	if (!fromNodeName) return [];
	const resolver = new ChannelResolver(workflow.channels ?? []);
	return uniqueStrings(
		workflow.nodes.flatMap((node) => {
			if (!resolver.canSend(fromNodeName, node.name)) return [];
			return node.agents.map((agent) => workerTarget(config.workflowRunId, node.name, agent.name));
		})
	);
}

function legacyBareTargetMatches(
	targetRef: string,
	config: LegacyNodeTargetTranslatorConfig
): string[] {
	const workflow = config.workflow;
	if (!workflow) return [];
	const nodeMatches = workflow.nodes
		.filter((node) => node.name === targetRef || node.id === targetRef)
		.flatMap((node) =>
			node.agents.map((agent) => workerTarget(config.workflowRunId, node.name, agent.name))
		);
	if (nodeMatches.length > 0) return uniqueStrings(nodeMatches);

	const actorMatches = (config.actors ?? [])
		.filter((actor) => {
			if (actor.kind !== 'worker') return false;
			const parsed = parseWorkerActorId(actor.actorId);
			return parsed?.workflowRunId === config.workflowRunId && parsed.agentName === targetRef;
		})
		.map((actor) => {
			const parsed = parseWorkerActorId(actor.actorId)!;
			const nodeName = workflowNodeName(workflow.nodes, parsed.nodeId) ?? parsed.nodeId;
			return workerTarget(parsed.workflowRunId, nodeName, parsed.agentName);
		});
	if (actorMatches.length > 0) return uniqueStrings(actorMatches);

	const agentMatches = workflow.nodes.flatMap((node) =>
		node.agents
			.filter((agent) => agent.name === targetRef)
			.map((agent) => workerTarget(config.workflowRunId, node.name, agent.name))
	);
	if (agentMatches.length > 0) return uniqueStrings(agentMatches);

	return [];
}

function resolveTaskNodeExecution(
	executions: NodeExecution[],
	selector: string
): NodeExecution | null {
	const byId = executions.find((execution) => execution.id === selector);
	if (byId) return byId;
	const targetName = selector.toLowerCase();
	const byName = executions.filter((execution) => execution.agentName.toLowerCase() === targetName);
	return byName.at(-1) ?? null;
}

function workerTarget(workflowRunId: string, nodeName: string, agentName: string): string {
	return `@worker:${encodeURIComponent(workflowRunId)}/${encodeURIComponent(nodeName)}/${encodeURIComponent(agentName)}`;
}

function legacyTargetActors(
	row: PendingAgentMessageRecord,
	actors: ActorRef[],
	workflow?: SpaceWorkflow | null
): ActorRef[] {
	if (row.targetKind === 'space_agent') {
		return actors.filter(
			(actor) =>
				actor.handle === '@coordinator' && (row.status === 'pending' ? isRoutable(actor) : true)
		);
	}
	const matches = actors.filter((actor) => {
		if (actor.kind !== 'worker') return false;
		if (row.status === 'pending' && !isRoutable(actor)) return false;
		const parsed = parseWorkerActorId(actor.actorId);
		return parsed?.workflowRunId === row.workflowRunId && parsed.agentName === row.targetAgentName;
	});
	if (row.status === 'pending') {
		return stableActors([...matches, ...declaredLegacyTargetActors(row, actors, workflow)]);
	}
	const sorted = stableActors(matches);
	if (sorted.length === 1) return sorted;
	return [];
}

function declaredLegacyTargetActors(
	row: PendingAgentMessageRecord,
	actors: ActorRef[],
	workflow?: SpaceWorkflow | null
): ActorRef[] {
	if (!workflow) return [];
	return workflow.nodes.flatMap((node) =>
		node.agents.flatMap((agent): ActorRef[] => {
			if (agent.name !== row.targetAgentName) return [];
			const actorId = workerActorId(row.workflowRunId, node.id, agent.name);
			if (actors.some((actor) => actor.actorId === actorId)) return [];
			return [
				{
					actorId,
					kind: 'worker',
					spaceId: row.spaceId,
					handle: workerHandle(row.workflowRunId, node.id, agent.name),
					roles: uniqueStrings([actorRole(agent.name), actorRole(node.id)]),
					status: 'inactive',
				},
			];
		})
	);
}

function pendingStatusToDeliveryState(status: PendingAgentMessageRecord['status']): DeliveryState {
	switch (status) {
		case 'pending':
			return 'queued';
		case 'delivered':
			return 'delivered';
		case 'failed':
			return 'failed';
		case 'expired':
			return 'expired';
	}
}

function legacySenderActorId(row: PendingAgentMessageRecord, actors: ActorRef[]): string {
	if (row.sourceAgentName === 'human') return 'human:legacy';
	if (
		row.sourceAgentName === 'coordinator' ||
		row.sourceAgentName === 'space-agent' ||
		row.sourceAgentName === 'task-agent'
	) {
		return `agent:coordinator:${row.spaceId}`;
	}
	const matches = actors.filter((actor) => {
		if (actor.kind !== 'worker') return false;
		const parsed = parseWorkerActorId(actor.actorId);
		return parsed?.workflowRunId === row.workflowRunId && parsed.agentName === row.sourceAgentName;
	});
	if (matches.length === 1) return matches[0].actorId;
	return `worker:${encodeURIComponent(row.workflowRunId)}:unresolved:${encodeURIComponent(row.sourceAgentName)}`;
}

function isRoutable(actor: ActorRef): boolean {
	return actor.status === 'active' || actor.status === 'inactive';
}

function stableActors(actors: ActorRef[]): ActorRef[] {
	return [...actors].sort((left, right) => left.actorId.localeCompare(right.actorId));
}

function actorRole(role: string): string {
	return `actor-role:${encodeURIComponent(role)}`;
}

function workflowNodeId(nodes: WorkflowNode[], nodeRef: string): string | null {
	const node = nodes.find((candidate) => candidate.id === nodeRef || candidate.name === nodeRef);
	return node?.id ?? null;
}

function workflowNodeName(nodes: WorkflowNode[], nodeId: string | undefined): string | null {
	if (!nodeId) return null;
	const node = nodes.find((candidate) => candidate.id === nodeId || candidate.name === nodeId);
	return node?.name ?? null;
}

function canSendToWorkerTarget(
	channels: WorkflowChannel[],
	fromRefs: Array<string | undefined>,
	toRefs: Array<string | undefined>
): boolean {
	const resolver = new ChannelResolver(channels);
	for (const from of uniqueStrings(fromRefs)) {
		for (const to of uniqueStrings(toRefs)) {
			if (resolver.canSend(from, to)) return true;
		}
	}
	return false;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function decodeAddressComponent(
	component: string,
	targetRef: string
): { ok: true; value: string } | { ok: false; reason: string } {
	try {
		return { ok: true, value: decodeURIComponent(component) };
	} catch (error) {
		if (error instanceof URIError) {
			return { ok: false, reason: `Invalid worker target escape in ${targetRef}` };
		}
		throw error;
	}
}

function workerActorId(workflowRunId: string, nodeId: string, agentName: string): string {
	return `worker:${[workflowRunId, nodeId, agentName].map(encodeURIComponent).join(':')}`;
}

function workerHandle(workflowRunId: string, nodeId: string, agentName: string): string {
	return `@worker:${[workflowRunId, nodeId, agentName].map(encodeURIComponent).join('/')}`;
}

function parseWorkerActorId(
	actorId: string
): { workflowRunId: string; nodeId: string; agentName: string } | null {
	if (!actorId.startsWith('worker:')) return null;
	const parts = actorId.slice('worker:'.length).split(':');
	if (parts.length !== 3) return null;
	return {
		workflowRunId: decodeURIComponent(parts[0]),
		nodeId: decodeURIComponent(parts[1]),
		agentName: decodeURIComponent(parts[2]),
	};
}
