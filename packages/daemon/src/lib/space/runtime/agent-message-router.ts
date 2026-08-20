import { parseAddress } from '../../../../../messaging/src/address';
import type { ActorRef, MessageRecord } from '../../../../../messaging/src/types';
import type { ActorResolver } from '../../../../../messaging/src/contracts';
import { SpaceDeliveryFacade } from '../messaging-adapter';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { PendingAgentMessageRepository } from '../../../storage/repositories/pending-agent-message-repository';
import type { WorkflowChannel } from '@hyperneo/shared';
import { ChannelResolver } from './channel-resolver';
import {
  buildNodeNameResolver,
  buildSlotToNodeMap,
  decideNodeTargetDelivery,
  foldAgentMessageResult,
  resolveNodeAgentTargets,
  type AgentMessageResult,
} from './agent-message-routing-gates';
import { formatAgentMessage } from '../agent-message-envelope';
import { ActivationError, type ChannelRouter } from './channel-router';

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
    replyToSessionId?: string | null
  ) => Promise<void>;
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
      nodeGroups,
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
          const queueWorkflowNodeId = hasNodeNameMap
            ? resolveWorkflowNodeId(nodeName, agentName)
            : undefined;
          const queueTargetName = hasNodeNameMap ? scopedAgentName(nodeName, agentName) : agentName;
          const storedTargetName = queueWorkflowNodeId != null ? agentName : queueTargetName;
          const { record, deduped } = pendingMessageRepo.enqueue({
            workflowRunId,
            spaceId,
            taskId: taskId ?? null,
            sourceAgentName: fromAgentName,
            targetKind: 'node_agent',
            targetAgentName: storedTargetName,
            workflowNodeId: queueWorkflowNodeId,
            message: rawMessage,
            idempotencyKey: JSON.stringify([fromSessionId, target, rawMessage]),
            ttlMs: 60_000,
            maxAttempts: 3,
          });
          queued.push({ agentName: queueTargetName, messageId: record.id });
          const nodeResolved = !hasNodeNameMap || queueWorkflowNodeId != null;
          if (!deduped && nodeResolved) onMessageQueued?.(agentName, queueWorkflowNodeId);
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

    return foldAgentMessageResult({ delivered, queued, failed, notFound });
  }

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

    const resolver = new ChannelResolver(workflowChannels);
    const slotToNode = buildSlotToNodeMap(nodeGroups);
    const resolveNodeName = buildNodeNameResolver(slotToNode);
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

    const permittedTargets = resolver.getPermittedTargets(fromNodeName);
    const resolution = resolveNodeAgentTargets({
      target,
      fromAgentName,
      fromNodeName,
      peerAgentNames: peers.map((m) => m.agentName),
      nodeGroups,
      declaredAgentNames: allDeclaredAgentNames,
      permittedTargets,
      spaceAgentAvailable: Boolean(spaceAgentInjector && spaceId),
      canSend: (fromNode, toNode) => resolver.canSend(fromNode, toNode),
    });
    if (resolution.status === 'unauthorized') {
      return {
        success: false,
        delivered: [],
        failed: [],
        reason: resolution.reason,
        unauthorizedAgentNames: resolution.unauthorized,
        permittedTargets: resolution.permittedTargets,
      };
    }
    if (resolution.status !== 'resolved') {
      return {
        success: false,
        delivered: [],
        failed: [],
        reason: resolution.reason,
      };
    }
    const targetAgentNames = resolution.targetAgentNames;

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

    const dataAppendix =
      data && Object.keys(data).length > 0
        ? `\n\n<structured-data>\n${JSON.stringify(data, null, 2)}\n</structured-data>`
        : '';

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

      if (decision === 'injectLiveSessions') {
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
        continue;
      }

      if (decision === 'queueForActivation' && pendingMessageRepo && spaceId) {
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

    return foldAgentMessageResult({ delivered, queued, failed, notFound });
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
