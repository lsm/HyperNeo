import type { McpAuditLogRepository } from '../../storage/repositories/mcp-audit-log-repository.ts';
import type { SpaceAgentSubscriptionRepository } from '../../storage/repositories/space-agent-subscription-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceRuntime } from '../space/runtime/space-runtime.ts';
import { jsonResult } from '../space/tools/tool-result.ts';
import type { ToolResult } from '../space/tools/tool-result.ts';
import { validateGlobPattern } from './topic-validator.ts';

export interface AgentEventSubscriptionDependencies {
  spaceId: string;
  runtime: SpaceRuntime;
  longHorizonAgentRepo?: SpaceLongHorizonAgentRepository;
  subscriptionRepo?: SpaceAgentSubscriptionRepository;
  auditLogRepo?: McpAuditLogRepository;
  myAgentName?: string;
  mySessionId?: string;
}

export function createAgentEventSubscriptionImpls(deps: AgentEventSubscriptionDependencies) {
  const { spaceId, runtime, myAgentName, mySessionId } = deps;

  function requireLongHorizonAgentRepo(): SpaceLongHorizonAgentRepository {
    if (!deps.longHorizonAgentRepo) throw new Error('Long-horizon agent management not available');
    return deps.longHorizonAgentRepo;
  }

  function requireSubscriptionRepo(): SpaceAgentSubscriptionRepository {
    if (!deps.subscriptionRepo) throw new Error('Long-horizon agent management not available');
    return deps.subscriptionRepo;
  }

  function getLongHorizonAgentInSpace(agentId: string) {
    const existing = requireLongHorizonAgentRepo().getById(agentId);
    return existing?.spaceId === spaceId ? existing : null;
  }

  function requireLongHorizonAgentInSpace(agentId: string) {
    const agent = getLongHorizonAgentInSpace(agentId);
    if (!agent) throw new Error(`Long-horizon agent not found: ${agentId}`);
    return agent;
  }

  function sourceFromTopicPattern(topicPattern: string): string {
    return topicPattern.split('/')[0] ?? '';
  }

  function logAudit(
    toolName: string,
    paramsSummary: Record<string, unknown>,
    taskId?: string
  ): void {
    if (deps.auditLogRepo) {
      try {
        deps.auditLogRepo.createEntry({
          agentName: myAgentName,
          sessionId: mySessionId,
          toolName,
          paramsSummary: JSON.stringify(paramsSummary),
          spaceId,
          taskId,
        });
      } catch {}
    }
  }

  return {
    async subscribeAgentEvent(args: {
      agent_id: string;
      topic_pattern: string;
      label?: string;
    }): Promise<ToolResult> {
      try {
        requireLongHorizonAgentInSpace(args.agent_id);
        const validation = validateGlobPattern(args.topic_pattern);
        if (!validation.valid) {
          return jsonResult({ success: false, error: validation.reason ?? 'invalid pattern' });
        }
        const repo = requireSubscriptionRepo();
        const subscription = repo.upsertSubscription({
          spaceId,
          agentId: args.agent_id,
          source: sourceFromTopicPattern(args.topic_pattern),
          topic: args.topic_pattern,
          filter: args.label ? { label: args.label } : {},
          status: 'active',
        });
        const refresh = runtime.refreshLongHorizonSubscription(spaceId, subscription.id);
        if (!refresh.success) {
          return jsonResult({ success: false, error: refresh.error ?? 'invalid pattern' });
        }
        logAudit('subscribe_agent_event', args);
        return jsonResult({ success: true, subscription });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async unsubscribeAgentEvent(args: {
      agent_id: string;
      topic_pattern: string;
      label?: string;
    }): Promise<ToolResult> {
      try {
        const agent = getLongHorizonAgentInSpace(args.agent_id);
        if (!agent) return jsonResult({ success: true });
        const repo = requireSubscriptionRepo();
        const source = sourceFromTopicPattern(args.topic_pattern);
        const subscription = repo.getSubscriptionByRoute(
          spaceId,
          args.agent_id,
          source,
          args.topic_pattern
        );
        repo.deleteSubscriptionByRoute(spaceId, args.agent_id, source, args.topic_pattern);
        if (subscription) runtime.removeLongHorizonSubscription(spaceId, subscription.id);
        logAudit('unsubscribe_agent_event', args);
        return jsonResult({ success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async listAgentEventSubscriptions(args: { agent_id: string }): Promise<ToolResult> {
      try {
        const agent = getLongHorizonAgentInSpace(args.agent_id);
        if (!agent) return jsonResult({ success: true, subscriptions: [] });
        const subscriptions = requireSubscriptionRepo().listSubscriptions(args.agent_id);
        return jsonResult({ success: true, subscriptions });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },
  };
}
