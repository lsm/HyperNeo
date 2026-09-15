import { generateUUID } from '@hyperneo/shared';
import { parseAddress } from '../../../../messaging/src/address.ts';
import type { MessageRecord } from '../../../../messaging/src/types.ts';
import { Logger } from '../logger.ts';
import { gatherEnrichedPeers } from './agent-message-peers.ts';
import type { AgentMessageRouterConfig } from './agent-message-router.ts';
import { ChannelResolver } from './channel-resolver.ts';
import { SpaceDeliveryFacade } from './delivery-facade.ts';
import { buildDataAppendix, deliverSingleTarget } from './delivery-door.ts';
import { formatAgentMessage } from './envelope.ts';
import {
  type AgentMessageResult,
  decideGenericAddressRouting,
  foldAgentMessageResult,
} from './routing-gates.ts';

const log = new Logger('agent-message-router');

export async function deliverGenericMessage(
  config: AgentMessageRouterConfig,
  params: {
    fromAgentName: string;
    fromSessionId: string;
    targets: string[];
    message: string;
    data?: Record<string, unknown>;
    slotToNode: Map<string, string>;
  }
): Promise<AgentMessageResult> {
  const { fromAgentName, fromSessionId, targets, message, data, slotToNode } = params;
  const {
    nodeExecutionRepo,
    workflowRunId,
    workflowChannels,
    channelRouter,
    sessionMessageInjector,
    spaceId,
    taskId,
    taskNumber,
    activateTargetSession,
    replyRoutingLookup,
    workflowNodeNameById,
    messageResolver,
    longTermAgentDelivery,
    nodeGroups,
  } = config;
  const resolver = new ChannelResolver(workflowChannels);
  const fromNodeName = slotToNode.get(fromAgentName) ?? fromAgentName;
  const enrichedPeers = gatherEnrichedPeers(config, fromAgentName, fromSessionId, fromNodeName);
  const singleNodeByAgentName = enrichedPeers.singleNodeByAgentName;
  let peers = enrichedPeers.peers;
  const hasNodeNameMap = workflowNodeNameById && Object.keys(workflowNodeNameById).length > 0;
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
  const buildEnvelope = (toLevel: 'node-agent' | 'long-horizon-agent', replyToSessionId?: string) =>
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

  const sessionDeliveryAvailable = Boolean(
    (config.deliverToTarget || sessionMessageInjector) && spaceId
  );
  const messagingFacadeAvailable = Boolean(messageResolver && longTermAgentDelivery && spaceId);

  for (const target of targets) {
    const decision = decideGenericAddressRouting(parseAddress(target), {
      sessionDeliveryAvailable,
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
        success: delivered.length + queued.length > 0 ? 'partial' : false,
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
        success: delivered.length + queued.length > 0 ? 'partial' : false,
        delivered,
        failed,
        reason:
          decision.action === 'failUnsupported'
            ? `Generic target ${decision.target} is not supported by node-agent send_message in this context.`
            : `Generic target ${decision.target} is not supported by node-agent send_message. Use @handle, @role:<role>, @session:<authorized-reply-session>, or @worker:<node>/<agent>.`,
        queued: queued.length > 0 ? queued : undefined,
        notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
      };
    }
    if (decision.action === 'failInvalidWorker') {
      return {
        success: delivered.length + queued.length > 0 ? 'partial' : false,
        delivered,
        failed,
        reason: `Invalid worker target ${decision.target}: ${decision.reason}`,
        queued: queued.length > 0 ? queued : undefined,
        notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
      };
    }
    if (decision.action === 'deliverToSession') {
      const sessionTarget = `@session:${decision.sessionId}`;
      const envelopedMessage = buildEnvelope('long-horizon-agent');
      try {
        const outcome = await deliverSingleTarget(
          config,
          { kind: 'session', sessionId: decision.sessionId },
          envelopedMessage,
          generateUUID()
        );
        if (outcome.state === 'delivered') {
          delivered.push({
            agentName: sessionTarget,
            sessionId: outcome.sessionId ?? decision.sessionId,
          });
        } else if (outcome.state === 'queued') {
          queued.push({ agentName: sessionTarget, messageId: outcome.messageId });
        } else if (outcome.state === 'failed') {
          failed.push({
            agentName: sessionTarget,
            sessionId: outcome.sessionId ?? decision.sessionId,
            error: outcome.error,
          });
        } else {
          notFound.push(sessionTarget);
        }
      } catch (err) {
        failed.push({
          agentName: sessionTarget,
          sessionId: decision.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    if (decision.action === 'deliverViaMessagingFacade') {
      const rawMessage = buildEnvelope('long-horizon-agent', fromSessionId);
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
          success: delivered.length + queued.length > 0 ? 'partial' : false,
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
        success: delivered.length + queued.length > 0 ? 'partial' : false,
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
        success: delivered.length + queued.length > 0 ? 'partial' : false,
        delivered,
        failed,
        reason: err instanceof Error ? err.message : String(err),
        queued: queued.length > 0 ? queued : undefined,
        notFoundAgentNames: notFound.length > 0 ? notFound : undefined,
      };
    }
    const matchesTargetNode = (peer: {
      agentName: string;
      nodeName?: string;
      workflowNodeId?: string;
    }) =>
      peer.agentName === agentName &&
      (!hasNodeNameMap || peer.nodeName === nodeName || peer.workflowNodeId === nodeName);
    if (!peers.some(matchesTargetNode) && activateTargetSession) {
      try {
        const targetWorkflowNodeId = hasNodeNameMap
          ? resolveWorkflowNodeId(nodeName, agentName)
          : undefined;
        const activated = await activateTargetSession(agentName, targetWorkflowNodeId);
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
              : (singleNodeByAgentName.get(session.agentName) ?? slotToNode.get(session.agentName)),
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
    if (sessions.length > 0) {
      if (config.deliverToTarget && !taskId) {
        failed.push({
          agentName,
          sessionId: sessions[0]?.sessionId ?? '',
          error: 'Task unavailable',
        });
        continue;
      }
      for (const session of sessions) {
        const envelopedMessage = buildEnvelope('node-agent');
        try {
          const outcome = await deliverSingleTarget(
            config,
            {
              kind: 'worker',
              taskId: taskId!,
              agentName,
              ...(session.workflowNodeId ? { workflowNodeId: session.workflowNodeId } : {}),
            },
            envelopedMessage,
            generateUUID(),
            session.sessionId
          );
          if (outcome.state === 'delivered') {
            delivered.push({ agentName, sessionId: outcome.sessionId });
          } else if (outcome.state === 'queued') {
            queued.push({ agentName, messageId: outcome.messageId });
          } else if (outcome.state === 'failed') {
            failed.push({
              agentName,
              sessionId: outcome.sessionId ?? session.sessionId,
              error: outcome.error,
            });
          } else {
            failed.push({
              agentName,
              sessionId: session.sessionId,
              error: outcome.error ?? 'target session unavailable during delivery',
            });
          }
        } catch (err) {
          failed.push({ ...session, error: err instanceof Error ? err.message : String(err) });
        }
      }
      continue;
    }
    notFound.push(agentName);
  }

  return foldAgentMessageResult({ delivered, queued, failed, notFound });
}
