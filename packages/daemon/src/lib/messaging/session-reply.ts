import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { parseAddress, parseRemoteAddress } from '../mailbox/address.ts';

export const REPLY_ORIGIN_MAX = 500;
const CLI_PREFIX =
  'Message Neo only at milestones (PR opened, merged or closed; blocked; a question; done; failed), with no acknowledgments and no progress pings. Use: hyperneo send ';
const CLI_SUFFIX =
  ' --kind <kind> "<text>" (not SendMessage). Choose kind done, blocked, question or failed; use done for a PR milestone. Keep working after you send.';

export function replyMessageBodyLength(message: string): number {
  const at = message.lastIndexOf(`\n\n${CLI_PREFIX}`);
  const argumentLength = message.length - at - 2 - CLI_PREFIX.length - CLI_SUFFIX.length;
  return at >= 0 &&
    message.endsWith(CLI_SUFFIX) &&
    argumentLength > 0 &&
    argumentLength <= REPLY_ORIGIN_MAX * 4 + 2
    ? at
    : message.length;
}

export function withReplyLine(
  message: string,
  from: string,
  format: 'mcp' | 'cli' = 'mcp'
): string {
  const sender = parseAddress(from);
  const replyTo =
    sender?.kind === 'session' ? sender.sessionId : parseRemoteAddress(from) ? from : null;
  if (!replyTo) return message;
  if (format === 'mcp')
    return `${message}\n\nReport milestones with ${sessionReplyCall(replyTo)}, choosing kind done, blocked, question or failed; use done for a PR milestone. Use this operation, not SendMessage.`;
  const argument = /^[A-Za-z0-9_:./%-]+$/.test(replyTo)
    ? replyTo
    : `'${replyTo.replaceAll("'", "'\\''")}'`;
  const line = `${CLI_PREFIX}${argument}${CLI_SUFFIX}`;
  return message.includes(line) ? message : `${message}\n\n${line}`;
}

export function sessionReplyCall(sessionId: string): string {
  return `mcp__hyperneo-operations__invoke ${JSON.stringify({
    name: 'message.send',
    input: {
      sessionId,
      kind: '<kind>',
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
        permissionDecisionReason: `${to} is a HyperNeo session; SendMessage cannot reach it. Send it with ${sessionReplyCall(to)}. Choose kind done, blocked, question or failed; use done for a PR milestone.`,
      },
    };
  };
}
