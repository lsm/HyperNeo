import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { parseRemoteAddress } from '../mailbox/address.ts';

export function sessionReplyCall(sessionId: string): string {
  return `mcp__hyperneo-operations__invoke ${JSON.stringify({
    name: 'message.send',
    input: {
      sessionId,
      message: { type: 'user', message: { content: '<your reply>' }, parent_tool_use_id: null },
    },
  })}`;
}

export function createSendMessageRedirectHook(
  isHyperneoSession: (sessionId: string) => boolean
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'SendMessage') return {};
    const to = (input.tool_input as { to?: unknown } | undefined)?.to;
    if (typeof to !== 'string' || !(isHyperneoSession(to) || parseRemoteAddress(to))) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: `${to} is a HyperNeo session; SendMessage cannot reach it. Send it with ${sessionReplyCall(to)}.`,
      },
    };
  };
}
