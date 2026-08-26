import type { WorkflowChannel } from '@hyperneo/shared';
import { parseAddress } from '../../../../../messaging/src/address.ts';
import type { ActorResolver } from '../../../../../messaging/src/contracts.ts';
import type { ActorRef, MessageRecord } from '../../../../../messaging/src/types.ts';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository.ts';
import type {
  EnqueueResult,
  PendingAgentMessageRepository,
} from '../../../storage/repositories/pending-agent-message-repository.ts';
import { formatAgentMessage } from '../agent-message-envelope.ts';
import type { SpaceAgentInjectionOutcome } from './space-agent-message-delivery.ts';
import { SpaceDeliveryFacade } from '../messaging-adapter.ts';
import {
  type AgentMessageResult,
  buildNodeNameResolver,
  buildSlotToNodeMap,
  decideGenericAddressRouting,
  decideNodeTargetDelivery,
  foldAgentMessageResult,
  promoteQueuedSpaceAgentResult,
  resolveNodeAgentTargets,
} from './agent-message-routing-gates.ts';
import { decideAgentMessageRouting } from './agent-message-routing-pipeline.ts';
import { ChannelResolver } from './channel-resolver.ts';
import { ActivationError, type ChannelRouter } from './channel-router.ts';

export type { AgentMessageResult };

export interface AgentMessageRouterConfig {
  nodeExecutionRepo: NodeExecutionRepository;
  workflowRunId: string;
  workflowChannels: WorkflowChannel[];
  messageInjector: (sessionId: string, message: string) => Promise<void>;
  channelRouter?: ChannelRouter;
  nodeGroups?: Record<string, string[]>;
  spaceAgentInjector?: (
    spaceId: string,
    message: string,
    replyToSessionId?: string | null,
    explicitMessageId?: string,
    options?: { onConsumed?: (settledSessionId: string) => void }
  ) => Promise<SpaceAgentInjectionOutcome>;
  taskNumber?: number | null;
  pendingMessageRepo?: PendingAgentMessageRepository;
  spaceId?: string;
  taskId?: string;
  findPostApprovalSessionId?: () => string | undefined;
  findPostApprovalTargetAgentName?: () => string | undefined;
  activateTargetSession?: (
    agentName: string
  ) => Promise<Array<{ agentName: string; sessionId: string }>>;
  workflowNodeNameById?: Record<string, string>;
  onMessageQueued?: (agentName: string, workflowNodeId?: string) => void;
  replyRoutingLookup?: (agentName?: string | null) => string | null;
  messageResolver?: ActorResolver;
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
  fromAgentName: string;
  fromSessionId: string;
  target: string | string[];
  message: string;
  data?: Record<string, unknown>;
}

import { Logger } from '../../logger.ts';

const log = new Logger('agent-message-router');

function buildDataAppendix(data?: Record<string, unknown>): string {
  return data && Object.keys(data).length > 0
    ? `\n\n<structured-data>\n${JSON.stringify(data, null, 2)}\n</structured-data>`
    : '';
}

export class AgentMessageRouter {
  constructor(private readonly config: AgentMessageRouterConfig) {}

  private gatherEnrichedPeers(
    fromAgentName: string,
    fromSessionId: string,
    fromNodeName: string
  ): {
    singleNodeByAgentName: Map<string, string>;
    peers: Array<{
      sessionId: string;
      agentName: string;
      workflowNodeId?: string;
      nodeName?: string;
    }>;
  } {
    const { nodeExecutionRepo, workflowRunId, workflowNodeNameById, nodeGroups } = this.config;
    const selfExecution = nodeExecutionRepo
      .listByWorkflowRun(workflowRunId)
      .find((e) => e.agentName === fromAgentName && e.agentSessionId === fromSessionId);
    const singleNodeByAgentName = new Map<string, string>();
    for (const [nodeName, slots] of nodeGroups ? Object.entries(nodeGroups) : []) {
      for (const slot of slots) {
        if (singleNodeByAgentName.has(slot)) {
          singleNodeByAgentName.delete(slot);
        } else {
          singleNodeByAgentName.set(slot, nodeName);
        }
      }
    }
    const peers = nodeExecutionRepo
      .listByWorkflowRun(workflowRunId)
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
    return { singleNodeByAgentName, peers };
  }

  private gatherPeerSnapshot(
    fromAgentName: string,
    fromSessionId: string
  ): {
    peers: Array<{ sessionId: string; agentName: string }>;
    declaredAgentNames: Set<string>;
  } {
    const { nodeExecutionRepo, workflowRunId, nodeGroups } = this.config;
    const allExecutions = nodeExecutionRepo.listByWorkflowRun(workflowRunId);
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

    const postApprovalSessionId = this.config.findPostApprovalSessionId?.();
    const postApprovalTargetAgent = this.config.findPostApprovalTargetAgentName?.();
    if (
      postApprovalSessionId &&
      postApprovalTargetAgent &&
      postApprovalSessionId !== fromSessionId &&
      postApprovalTargetAgent !== fromAgentName
    ) {
      if (!peers.some((p) => p.sessionId === postApprovalSessionId)) {
        peers = peers.filter(
          (p) => !(p.agentName === postApprovalTargetAgent && p.sessionId !== postApprovalSessionId)
        );
        peers.push({ sessionId: postApprovalSessionId, agentName: postApprovalTargetAgent });
      }
    }

    const declaredAgentNames = new Set(
      allExecutions.filter((e) => e.agentSessionId !== fromSessionId).map((e) => e.agentName)
    );
    if (nodeGroups) {
      for (const slots of Object.values(nodeGroups)) {
        for (const slot of slots) {
          if (slot === fromAgentName) continue;
          declaredAgentNames.add(slot);
        }
      }
    }
    return { peers, declaredAgentNames };
  }

  private enqueueNodeAgentMessage(input: {
    repo: PendingAgentMessageRepository;
    spaceId: string;
    fromAgentName: string;
    fromSessionId: string;
    targetAgentName: string;
    idempotencyTarget: string;
    workflowNodeId?: string;
    message: string;
  }): EnqueueResult {
    return input.repo.enqueue({
      workflowRunId: this.config.workflowRunId,
      spaceId: input.spaceId,
      taskId: this.config.taskId ?? null,
      sourceAgentName: input.fromAgentName,
      targetKind: 'node_agent',
      targetAgentName: input.targetAgentName,
      workflowNodeId: input.workflowNodeId,
      message: input.message,
      idempotencyKey: JSON.stringify([input.fromSessionId, input.idempotencyTarget, input.message]),
      ttlMs: 60_000,
      maxAttempts: 3,
    });
  }

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
      nodeGroups,
    } = this.config;
    const resolver = new ChannelResolver(workflowChannels);
    const fromNodeName = slotToNode.get(fromAgentName) ?? fromAgentName;
    const enrichedPeers = this.gatherEnrichedPeers(fromAgentName, fromSessionId, fromNodeName);
    const singleNodeByAgentName = enrichedPeers.singleNodeByAgentName;
    let peers = enrichedPeers.peers;
    const hasNodeNameMap = workflowNodeNameById && Object.keys(workflowNodeNameById).length > 0;
    const scopedAgentName = (nodeName: string, agentName: string) => `${nodeName}/${agentName}`;
    const resolveWorkflowNodeId = (nodeRef: string, agentName: string): string | undefined => {
      if (!workflowNodeNameById) return undefined;
      const entries = Object.entries(workflowNodeNameById);
      const hasSlot = (nodeName: string) =>
        nodeGroups ? nodeGroups[nodeName]?.includes(agentName) === true : false;
      const slotMatch = entries.find(
        ([nodeId, name]) => (nodeId === nodeRef || name === nodeRef) && hasSlot(name)
      );
      if (slotMatch) return slotMatch[0];
      if (entries.some(([nodeId]) => nodeId === nodeRef)) return nodeRef;
      return entries.find(([, name]) => name === nodeRef)?.[0];
    };
    const delivered: Array<{ agentName: string; sessionId: string }> = [];
    const queued: Array<{ agentName: string; messageId: string }> = [];
    const notFound: string[] = [];
    const failed: Array<{ agentName: string; sessionId: string; error: string }> = [];
    const body = `${message}${buildDataAppendix(data)}`;
    const buildEnvelope = (toLevel: 'node-agent' | 'space-agent', replyToSessionId?: string) =>
      formatAgentMessage({
        fromLevel: 'node-agent',
        fromAgentName,
        toLevel,
        body,
        taskId,
        taskNumber,
        nodeId: fromAgentName,
        replyToSessionId,
      });

    const spaceAgentAvailable = Boolean(spaceAgentInjector && spaceId);
    const messagingFacadeAvailable = Boolean(messageResolver && longTermAgentDelivery && spaceId);

    for (const target of targets) {
      const decision = decideGenericAddressRouting(parseAddress(target), {
        spaceAgentAvailable,
        messagingFacadeAvailable,
        replyToSessionId: replyRoutingLookup?.(fromAgentName) || null,
        workflowRunId,
      });

      if (decision.action === 'notFound') {
        notFound.push(decision.target);
        continue;
      }
      if (decision.action === 'failSessionUnauthorized') {
        return {
          success:
            delivered.length > 0 || failed.length > 0 || queued.length > 0 ? 'partial' : false,
          delivered,
          failed,
          reason: `Session target ${decision.target} is not an authorized reply route for '${fromAgentName}'.`,
          unauthorizedAgentNames: [decision.target],
          queued: queued.length > 0 ? queued : undefined,
          notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
        };
      }
      if (decision.action === 'failUnsupported' || decision.action === 'failUnsupportedKind') {
        return {
          success:
            delivered.length > 0 || failed.length > 0 || queued.length > 0 ? 'partial' : false,
          delivered,
          failed,
          reason:
            decision.action === 'failUnsupported'
              ? `Generic target ${decision.target} is not supported by node-agent send_message in this context.`
              : `Generic target ${decision.target} is not supported by node-agent send_message. Use @coordinator, @handle, @role:<role>, @session:<authorized-reply-session>, or @worker:<node>/<agent>.`,
          queued: queued.length > 0 ? queued : undefined,
          notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
        };
      }
      if (decision.action === 'failInvalidWorker') {
        return {
          success:
            delivered.length > 0 || failed.length > 0 || queued.length > 0 ? 'partial' : false,
          delivered,
          failed,
          reason: `Invalid worker target ${decision.target}: ${decision.reason}`,
          queued: queued.length > 0 ? queued : undefined,
          notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
        };
      }
      if (decision.action === 'deliverToCoordinator') {
        const envelopedMessage = buildEnvelope('space-agent');
        try {
          const outcome = await spaceAgentInjector!(spaceId!, envelopedMessage, null);
          if (outcome.state === 'delivered') {
            delivered.push({ agentName: 'space-agent', sessionId: outcome.sessionId });
          } else if (outcome.state === 'queued') {
            queued.push({ agentName: 'space-agent', messageId: outcome.messageId });
          } else {
            failed.push({
              agentName: 'space-agent',
              sessionId: outcome.sessionId,
              error: outcome.error,
            });
          }
        } catch (err) {
          failed.push({
            agentName: 'space-agent',
            sessionId: `space:chat:${spaceId!}`,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }
      if (decision.action === 'deliverToSession') {
        const envelopedMessage = buildEnvelope('space-agent');
        try {
          const outcome = await spaceAgentInjector!(spaceId!, envelopedMessage, decision.sessionId);
          if (outcome.state === 'delivered') {
            delivered.push({ agentName: 'space-agent', sessionId: outcome.sessionId });
          } else if (outcome.state === 'queued') {
            queued.push({ agentName: 'space-agent', messageId: outcome.messageId });
          } else {
            failed.push({
              agentName: 'space-agent',
              sessionId: outcome.sessionId,
              error: outcome.error,
            });
          }
        } catch (err) {
          failed.push({
            agentName: 'space-agent',
            sessionId: decision.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }
      if (decision.action === 'deliverViaMessagingFacade') {
        const rawMessage = buildEnvelope('space-agent', fromSessionId);
        const messageRecord: MessageRecord = {
          messageId: `msg_node_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          spaceId: spaceId!,
          senderActorId: `worker:${encodeURIComponent(workflowRunId)}:unresolved:${encodeURIComponent(fromAgentName)}`,
          targets: [target],
          body: rawMessage,
          kind: 'message',
          workflowRunId,
          ...(taskId ? { taskId } : {}),
          createdAt: Date.now(),
        };
        let routed;
        try {
          routed = await new SpaceDeliveryFacade({
            resolver: messageResolver!,
            deliverToSession: longTermAgentDelivery!.deliverToSession,
            queueForActivation: longTermAgentDelivery!.queueForActivation,
          }).routeMessage(messageRecord);
        } catch (err) {
          return {
            success:
              delivered.length > 0 || failed.length > 0 || queued.length > 0 ? 'partial' : false,
            delivered,
            failed,
            reason: err instanceof Error ? err.message : String(err),
            queued: queued.length > 0 ? queued : undefined,
            notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
          };
        }
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

      const { nodeName, agentName } = decision;
      const permittedChannelTarget = resolver.canSend(fromNodeName, nodeName)
        ? nodeName
        : resolver.canSend(fromNodeName, agentName)
          ? agentName
          : null;
      if (!permittedChannelTarget) {
        return {
          success:
            delivered.length > 0 || failed.length > 0 || queued.length > 0 ? 'partial' : false,
          delivered,
          failed,
          reason: `Channel topology does not permit '${fromAgentName}' to send to: ${target}.`,
          unauthorizedAgentNames: [target],
          permittedTargets: resolver.getPermittedTargets(fromNodeName),
          queued: queued.length > 0 ? queued : undefined,
          notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
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
          success:
            delivered.length > 0 || failed.length > 0 || queued.length > 0 ? 'partial' : false,
          delivered,
          failed,
          reason: err instanceof Error ? err.message : String(err),
          queued: queued.length > 0 ? queued : undefined,
          notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
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
      const workerDelivery = decideNodeTargetDelivery(agentName, {
        isSpaceAgent: false,
        hasLiveSessions: sessions.length > 0,
        queueCapable: Boolean(pendingMessageRepo && spaceId),
        activatedTargets: new Set<string>(),
        declaredAgentNames: [agentName],
        permittedTargets: [],
        resolveNodeName: buildNodeNameResolver(slotToNode),
      });
      if (workerDelivery === 'queueForActivation' && pendingMessageRepo && spaceId) {
        const rawMessage = buildEnvelope('node-agent');
        const queueWorkflowNodeId = hasNodeNameMap
          ? resolveWorkflowNodeId(nodeName, agentName)
          : undefined;
        const queueTargetName = hasNodeNameMap ? scopedAgentName(nodeName, agentName) : agentName;
        const storedTargetName = queueWorkflowNodeId != null ? agentName : queueTargetName;
        const { record, deduped } = this.enqueueNodeAgentMessage({
          repo: pendingMessageRepo,
          spaceId,
          fromAgentName,
          fromSessionId,
          targetAgentName: storedTargetName,
          idempotencyTarget: target,
          workflowNodeId: queueWorkflowNodeId,
          message: rawMessage,
        });
        queued.push({ agentName: queueTargetName, messageId: record.id });
        const nodeResolved = !hasNodeNameMap || queueWorkflowNodeId != null;
        if (!deduped && nodeResolved) onMessageQueued?.(agentName, queueWorkflowNodeId);
        notFound.push(agentName);
        continue;
      }
      if (workerDelivery === 'injectLiveSessions') {
        for (const session of sessions) {
          const envelopedMessage = buildEnvelope('node-agent');
          try {
            await messageInjector(session.sessionId, envelopedMessage);
            delivered.push(session);
          } catch (err) {
            failed.push({ ...session, error: err instanceof Error ? err.message : String(err) });
          }
        }
        continue;
      }
      notFound.push(agentName);
    }

    return promoteQueuedSpaceAgentResult(
      foldAgentMessageResult({ delivered, queued, failed, notFound })
    );
  }

  async deliverMessage(params: AgentMessageParams): Promise<AgentMessageResult> {
    const { fromAgentName, fromSessionId, target, message, data } = params;
    const {
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

    const resolver = new ChannelResolver(workflowChannels);
    const slotToNode = buildSlotToNodeMap(nodeGroups);
    const resolveNodeName = buildNodeNameResolver(slotToNode);
    const fromNodeName = resolveNodeName(fromAgentName);
    const requestedTargets =
      target === '*' ? ['*'] : Array.isArray(target) ? [...target] : [target];

    const peerSnapshot = this.gatherPeerSnapshot(fromAgentName, fromSessionId);
    const allDeclaredAgentNames = peerSnapshot.declaredAgentNames;
    let peers = peerSnapshot.peers;

    const spaceAgentAvailable = Boolean(spaceAgentInjector && spaceId);
    const permittedTargets = resolver.getPermittedTargets(fromNodeName);
    const routing = decideAgentMessageRouting({
      target,
      requestedTargets,
      topologyEmpty: resolver.isEmpty(),
      spaceAgentAvailable,
      resolution: resolveNodeAgentTargets({
        target,
        fromAgentName,
        fromNodeName,
        peerAgentNames: peers.map((m) => m.agentName),
        nodeGroups,
        declaredAgentNames: allDeclaredAgentNames,
        permittedTargets,
        spaceAgentAvailable,
        canSend: (fromNode, toNode) => resolver.canSend(fromNode, toNode),
      }),
    });

    if (routing.action === 'delegateGeneric') {
      return this.deliverGenericMessage({
        fromAgentName,
        fromSessionId,
        targets: requestedTargets,
        message,
        data,
        slotToNode,
      });
    }
    if (routing.action === 'failNoTopology') {
      return {
        success: false,
        delivered: [],
        failed: [],
        reason:
          'No channel topology declared for this node. ' +
          'Direct messaging via send_message is not available.',
      };
    }
    if (routing.action === 'failUnknownTarget') {
      return {
        success: false,
        delivered: [],
        failed: [],
        reason: routing.reason,
      };
    }
    if (routing.action === 'failUnauthorized') {
      return {
        success: false,
        delivered: [],
        failed: [],
        reason: routing.reason,
        unauthorizedAgentNames: routing.unauthorizedAgentNames,
        permittedTargets: routing.permittedTargets,
      };
    }
    const targetAgentNames = routing.targetAgentNames;

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

    const body = `${message}${buildDataAppendix(data)}`;
    const buildEnvelope = (toLevel: 'node-agent' | 'space-agent', replyToSessionId?: string) =>
      formatAgentMessage({
        fromLevel: 'node-agent',
        fromAgentName,
        toLevel,
        body,
        taskId,
        taskNumber,
        nodeId: fromAgentName,
        replyToSessionId,
      });

    const delivered: Array<{ agentName: string; sessionId: string }> = [];
    const queued: Array<{ agentName: string; messageId: string }> = [];
    const notFound: string[] = [];
    const failed: Array<{ agentName: string; sessionId: string; error: string }> = [];

    for (const agentName of targetAgentNames) {
      const agentSessions = peers.filter((m) => m.agentName === agentName);
      const decision = decideNodeTargetDelivery(agentName, {
        isSpaceAgent: agentName === 'space-agent',
        hasLiveSessions: agentSessions.length > 0,
        queueCapable: Boolean(pendingMessageRepo && spaceId),
        activatedTargets,
        declaredAgentNames: allDeclaredAgentNames,
        permittedTargets,
        resolveNodeName,
      });

      if (decision === 'deliverToSpaceAgent') {
        if (!spaceAgentInjector || !spaceId) {
          notFound.push(agentName);
          continue;
        }
        const replyTo = replyRoutingLookup ? replyRoutingLookup(fromAgentName) : null;
        const sessionId = replyTo || `space:chat:${spaceId}`;
        const envelopedMessage = buildEnvelope('space-agent');
        try {
          const outcome = await spaceAgentInjector(spaceId, envelopedMessage, replyTo);
          if (outcome.state === 'delivered') {
            delivered.push({ agentName, sessionId: outcome.sessionId || sessionId });
          } else if (outcome.state === 'queued') {
            queued.push({ agentName, messageId: outcome.messageId });
          } else {
            failed.push({
              agentName,
              sessionId: outcome.sessionId || sessionId,
              error: outcome.error,
            });
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          failed.push({
            agentName,
            sessionId,
            error: errMsg,
          });
        }
        continue;
      }

      if (decision === 'injectLiveSessions') {
        for (const member of agentSessions) {
          const envelopedMessage = buildEnvelope('node-agent');
          try {
            await messageInjector(member.sessionId, envelopedMessage);
            delivered.push({ agentName, sessionId: member.sessionId });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            failed.push({ agentName, sessionId: member.sessionId, error: errMsg });
          }
        }
        continue;
      }

      if (decision === 'queueForActivation' && pendingMessageRepo && spaceId) {
        const rawMessage = buildEnvelope('node-agent');
        try {
          const { record, deduped } = this.enqueueNodeAgentMessage({
            repo: pendingMessageRepo,
            spaceId,
            fromAgentName,
            fromSessionId,
            targetAgentName: agentName,
            idempotencyTarget: agentName,
            message: rawMessage,
          });
          queued.push({ agentName, messageId: record.id });
          notFound.push(agentName);
          log.info(
            `[AgentMessageRouter] queued message ${record.id} for agent "${agentName}" ` +
              `(run=${workflowRunId}, from=${fromAgentName})`
          );
          if (!deduped) onMessageQueued?.(agentName);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.warn(
            `[AgentMessageRouter] failed to queue message for agent "${agentName}": ${errMsg}`
          );
          notFound.push(agentName);
        }
        continue;
      }

      if (decision === 'activatedWithoutQueue') {
        log.warn(
          `[AgentMessageRouter] target "${agentName}" was activated but no pendingMessageRepo is configured — ` +
            `message may not be delivered to the new session. Configure pendingMessageRepo to enable reliable delivery.`
        );
        continue;
      }

      notFound.push(agentName);
    }

    return promoteQueuedSpaceAgentResult(
      foldAgentMessageResult({ delivered, queued, failed, notFound })
    );
  }
}
