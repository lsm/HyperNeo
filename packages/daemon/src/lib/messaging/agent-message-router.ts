import { generateUUID, type WorkflowChannel } from '@hyperneo/shared';
import type { ActorResolver } from '../../../../messaging/src/contracts.ts';
import type { ActorRef, MessageRecord } from '../../../../messaging/src/types.ts';
import type { SessionTarget } from '../session-resolution/target.ts';
import type { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository.ts';
import { Logger } from '../logger.ts';
import { gatherPeerSnapshot } from './agent-message-peers.ts';
import { ChannelResolver } from './channel-resolver.ts';
import { ActivationError, type ChannelRouter } from './channel-router.ts';
import { buildDataAppendix, deliverSingleTarget } from './delivery-door.ts';
import { formatAgentMessage } from './envelope.ts';
import { deliverGenericMessage } from './generic-address-delivery.ts';
import {
  type AgentMessageResult,
  buildNodeNameResolver,
  buildSlotToNodeMap,
  decideNodeTargetDelivery,
  foldAgentMessageResult,
  resolveNodeAgentTargets,
} from './routing-gates.ts';
import { decideAgentMessageRouting } from './routing-pipeline.ts';
import type { SessionInjectionOutcome } from './session-message-delivery.ts';

export type { AgentMessageResult };

export type AgentMessageDeliveryOutcome =
  | { state: 'delivered'; sessionId: string; messageId: string }
  | { state: 'queued'; sessionId: string; messageId: string }
  | { state: 'not_found'; messageId: string; error?: string }
  | { state: 'failed'; sessionId?: string; messageId: string; error: string };

export interface AgentMessageRouterConfig {
  nodeExecutionRepo: NodeExecutionRepository;
  workflowRunId: string;
  workflowChannels: WorkflowChannel[];
  deliverToTarget?: (
    target: SessionTarget,
    message: string,
    messageId: string,
    sessionIdHint?: string
  ) => Promise<AgentMessageDeliveryOutcome>;
  messageInjector?: (sessionId: string, message: string) => Promise<void>;
  channelRouter?: ChannelRouter;
  nodeGroups?: Record<string, string[]>;
  sessionMessageInjector?: (
    spaceId: string,
    message: string,
    replyToSessionId?: string | null,
    explicitMessageId?: string,
    options?: {
      onConsumed?: (settledSessionId: string) => void;
      onLateFailure?: () => void;
      disposeSignal?: AbortSignal;
    }
  ) => Promise<SessionInjectionOutcome>;
  taskNumber?: number | null;
  spaceId?: string;
  taskId?: string;
  findPostApprovalSessionId?: () => string | undefined;
  findPostApprovalTargetAgentName?: () => string | undefined;
  activateTargetSession?: (
    agentName: string,
    workflowNodeId?: string
  ) => Promise<Array<{ agentName: string; sessionId: string }>>;
  workflowNodeNameById?: Record<string, string>;
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

const log = new Logger('agent-message-router');

export class AgentMessageRouter {
  constructor(private readonly config: AgentMessageRouterConfig) {}

  async deliverMessage(params: AgentMessageParams): Promise<AgentMessageResult> {
    const { fromAgentName, fromSessionId, target, message, data } = params;
    const {
      workflowRunId,
      workflowChannels,
      channelRouter,
      nodeGroups,
      taskId,
      taskNumber,
      activateTargetSession,
    } = this.config;

    const resolver = new ChannelResolver(workflowChannels);
    const slotToNode = buildSlotToNodeMap(nodeGroups);
    const resolveNodeName = buildNodeNameResolver(slotToNode);
    const fromNodeName = resolveNodeName(fromAgentName);
    const requestedTargets =
      target === '*' ? ['*'] : Array.isArray(target) ? [...target] : [target];

    const peerSnapshot = gatherPeerSnapshot(this.config, fromAgentName, fromSessionId);
    const allDeclaredAgentNames = peerSnapshot.declaredAgentNames;
    let peers = peerSnapshot.peers;

    const permittedTargets = resolver.getPermittedTargets(fromNodeName);
    const routing = decideAgentMessageRouting({
      target,
      requestedTargets,
      topologyEmpty: resolver.isEmpty(),
      resolution: resolveNodeAgentTargets({
        target,
        fromAgentName,
        fromNodeName,
        peerAgentNames: peers.map((m) => m.agentName),
        nodeGroups,
        declaredAgentNames: allDeclaredAgentNames,
        permittedTargets,
        canSend: (fromNode, toNode) => resolver.canSend(fromNode, toNode),
      }),
    });

    if (routing.action === 'delegateGeneric') {
      return deliverGenericMessage(this.config, {
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

    if (channelRouter) {
      for (const agentName of targetAgentNames) {
        try {
          await channelRouter.deliverMessage(workflowRunId, fromAgentName, agentName, message);
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
    const buildEnvelope = (
      toLevel: 'node-agent' | 'long-horizon-agent',
      replyToSessionId?: string
    ) =>
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
        hasLiveSessions: agentSessions.length > 0,
      });

      if (decision === 'injectLiveSessions') {
        if (this.config.deliverToTarget && !taskId) {
          failed.push({
            agentName,
            sessionId: agentSessions[0]?.sessionId ?? '',
            error: 'Task unavailable',
          });
          continue;
        }
        for (const member of agentSessions) {
          const envelopedMessage = buildEnvelope('node-agent');
          try {
            const outcome = await deliverSingleTarget(
              this.config,
              {
                kind: 'worker',
                taskId: taskId!,
                agentName,
                ...(member.workflowNodeId ? { workflowNodeId: member.workflowNodeId } : {}),
              },
              envelopedMessage,
              generateUUID(),
              member.sessionId
            );
            if (outcome.state === 'delivered') {
              delivered.push({ agentName, sessionId: outcome.sessionId });
            } else if (outcome.state === 'queued') {
              queued.push({ agentName, messageId: outcome.messageId });
            } else if (outcome.state === 'failed') {
              failed.push({
                agentName,
                sessionId: outcome.sessionId ?? member.sessionId,
                error: outcome.error,
              });
            } else {
              failed.push({
                agentName,
                sessionId: member.sessionId,
                error: outcome.error ?? 'target session unavailable during delivery',
              });
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            failed.push({ agentName, sessionId: member.sessionId, error: errMsg });
          }
        }
        continue;
      }

      notFound.push(agentName);
    }

    return foldAgentMessageResult({ delivered, queued, failed, notFound });
  }
}
