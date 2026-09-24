import type { OperationCaller, OperationCallerRole } from '../operations/registry.ts';
import { normalizeReplyTargetHandle } from './agent-handle.ts';
import type { AgentMessageLevel } from './envelope.ts';

export const OUTBOUND_SENDER_REJECTION = 'sender_identity_unavailable' as const;

export type OutboundSenderRejection = typeof OUTBOUND_SENDER_REJECTION;

export interface OutboundSender {
  readonly sessionId: string;
  readonly level: AgentMessageLevel;
  readonly displayName: string;
  readonly replyTargetHandle: string;
}

const DEFAULT_SENDER_DISPLAY_NAME: Record<AgentMessageLevel, string> = {
  'long-horizon-agent': 'space-agent',
  'task-agent': 'task-agent',
  'node-agent': 'node-agent',
  'session-agent': 'space-member',
};

export function outboundSenderLevel(
  role: OperationCallerRole | undefined
): AgentMessageLevel | null {
  switch (role) {
    case 'long_term_agent':
      return 'long-horizon-agent';
    case 'workflow_worker':
      return 'node-agent';
    case 'legacy_task_agent':
      return 'task-agent';
    case 'direct_task_worker':
      return 'session-agent';
    default:
      return null;
  }
}

export function resolveOutboundSender(
  caller: OperationCaller
): { value: OutboundSender } | { reason: OutboundSenderRejection } {
  const level = outboundSenderLevel(caller.role);
  const sessionId = caller.sessionId?.trim();
  if (!level || !sessionId) return { reason: OUTBOUND_SENDER_REJECTION };
  const agentName = caller.agentName?.trim();
  return {
    value: {
      sessionId,
      level,
      displayName: agentName || DEFAULT_SENDER_DISPLAY_NAME[level],
      replyTargetHandle:
        (agentName ? normalizeReplyTargetHandle(agentName) : null) ?? `@session:${sessionId}`,
    },
  };
}
