import { getSdkResultOriginKind, type SDKMessage } from '@hyperneo/shared/sdk';

export type LastMessageClassification =
  | { terminal: true; reason: string }
  | { terminal: false; reason: string };

export function classifyLastMessageForIdleAgent(
  message: SDKMessage | null | undefined
): LastMessageClassification {
  if (!message) return { terminal: false, reason: 'no SDK messages were recorded' };

  if (message.type === 'result') {
    if (isHollowTaskNotificationResult(message)) {
      return { terminal: false, reason: 'task-notification result awaits follow-up turn' };
    }
    const subtype =
      typeof (message as { subtype?: unknown }).subtype === 'string'
        ? (message as { subtype: string }).subtype
        : 'unknown';
    return { terminal: true, reason: `SDK result message (${subtype})` };
  }

  if (message.type !== 'assistant') {
    return { terminal: false, reason: `last SDK message type is ${message.type}` };
  }

  const assistant = message as {
    message?: { content?: unknown; stop_reason?: unknown };
    error?: unknown;
  };
  if (typeof assistant.error === 'string' && assistant.error.length > 0) {
    return { terminal: true, reason: `assistant error (${assistant.error})` };
  }

  const content = assistant.message?.content;
  if (!Array.isArray(content)) {
    return { terminal: false, reason: 'assistant message content is not an array' };
  }

  let hasToolUse = false;
  let hasThinking = false;
  let hasNonEmptyText = false;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'tool_use') hasToolUse = true;
    if (block.type === 'thinking') hasThinking = true;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      hasNonEmptyText = true;
    }
  }

  if (hasToolUse) {
    return { terminal: false, reason: 'assistant message ended with unresolved tool_use block(s)' };
  }
  if (hasThinking && !hasNonEmptyText) {
    return { terminal: false, reason: 'assistant message ended with thinking block only' };
  }

  const stopReason = assistant.message?.stop_reason;
  if (stopReason === 'end_turn') {
    return { terminal: true, reason: 'assistant end_turn with no pending tool_use' };
  }

  return { terminal: false, reason: 'assistant message has no terminal end_turn/result signal' };
}

export function isHollowTaskNotificationResult(message: SDKMessage): boolean {
  if ((message as { is_error?: unknown }).is_error === true) return false;
  if (getSdkResultOriginKind(message) !== 'task-notification') return false;
  const result = (message as { result?: unknown }).result;
  if (typeof result === 'string' && result.trim().length > 0) return false;
  const usage = (message as { usage?: unknown }).usage;
  const inputTokens =
    isRecord(usage) && typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens =
    isRecord(usage) && typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  return inputTokens === 0 && outputTokens === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
