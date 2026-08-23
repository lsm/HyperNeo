import type { HyperNeoActionMessage, MessageOrigin } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { isHyperNeoActionMessage } from '@hyperneo/shared/sdk';
import { HIDDEN_SYSTEM_SUBTYPES } from '@hyperneo/shared/sdk/type-guards';

export type SendStatus = 'deferred' | 'enqueued' | 'submitted' | 'consumed' | 'failed';

export type MessageAdmissionVariant = 'sdk' | 'user' | 'hyperneo_action';

export interface MessageAdmissionOptions {
  variant: MessageAdmissionVariant;
  sendStatus: SendStatus | null;
  origin?: MessageOrigin;
}

export interface NormalizedMessageAdmissionInput {
  message: SDKMessage;
}

export interface MessageAdmissionRecord {
  isRenderable: 0 | 1;
  isTerminal: 0 | 1;
  isConversationAnchor: boolean;
  countsTowardsBadge: boolean;
  parentToolUseId: string | null;
  sdkUuid: string | null;
  replacementEdges: SDKMessageReplacementEdge[];
}

const BADGE_HIDDEN_SUBTYPES = new Set<string>([...HIDDEN_SYSTEM_SUBTYPES, 'thinking_tokens']);

function isVisibleBadgeRow(opts: {
  parentToolUseId: string | null;
  messageType: string;
  messageSubtype: string | null;
  sendStatus: SendStatus | null;
}): boolean {
  if (opts.parentToolUseId !== null) return false;
  if (BADGE_HIDDEN_SUBTYPES.has(opts.messageSubtype ?? '')) return false;
  if (opts.messageType === 'user') {
    const status = opts.sendStatus ?? 'consumed';
    return status === 'consumed' || status === 'failed';
  }
  return true;
}

export function computeIsRenderable(message: SDKMessage): 0 | 1 {
  const messageType = message.type;
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) {
    return 1;
  }

  if (messageType === 'user') {
    const hasToolResult = content.some(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'tool_result'
    );
    return hasToolResult ? 0 : 1;
  }

  if (messageType === 'assistant') {
    const hasRenderable = content.some((block) => {
      if (typeof block !== 'object' || block === null) return false;
      const blockObj = block as { type?: unknown; text?: unknown; thinking?: unknown };
      if (blockObj.type === 'tool_use') return true;
      if (blockObj.type === 'text') {
        const text = typeof blockObj.text === 'string' ? blockObj.text : '';
        return text.trim().length > 0;
      }
      if (blockObj.type === 'thinking') {
        const thinking = typeof blockObj.thinking === 'string' ? blockObj.thinking : '';
        return thinking.trim().length > 0;
      }
      return false;
    });
    return hasRenderable ? 1 : 0;
  }

  return 1;
}

export function computeIsTerminal(message: SDKMessage): 0 | 1 {
  return message.type === 'result' ? 1 : 0;
}

export function extractParentToolUseId(message: SDKMessage): string | null {
  const candidate = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  return typeof candidate === 'string' ? candidate : null;
}

export function extractSdkUuid(message: SDKMessage): string | null {
  const candidate = (message as { uuid?: unknown }).uuid;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

export interface SDKMessageReplacementEdge {
  targetUuid: string;
  kind: 'superseded' | 'retracted';
}

export function extractReplacementEdges(message: SDKMessage): SDKMessageReplacementEdge[] {
  const replacementMessage = message as SDKMessage & {
    supersedes?: unknown;
    retracted_message_uuids?: unknown;
  };
  const edges: SDKMessageReplacementEdge[] = [];
  const seen = new Set<string>();
  const append = (values: unknown, kind: SDKMessageReplacementEdge['kind']) => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      if (typeof value !== 'string' || value.length === 0) continue;
      const key = `${kind}\0${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ targetUuid: value, kind });
    }
  };
  append(replacementMessage.supersedes, 'superseded');
  if ('subtype' in replacementMessage && replacementMessage.subtype === 'model_refusal_fallback') {
    append(replacementMessage.retracted_message_uuids, 'retracted');
  }
  return edges;
}

export function normalizeMessageAdmissionInput(
  message: SDKMessage | HyperNeoActionMessage
): NormalizedMessageAdmissionInput {
  if (isHyperNeoActionMessage(message)) {
    return {
      message: {
        type: 'hyperneo_action',
        subtype: message.action,
        uuid: message.uuid,
      } as unknown as SDKMessage,
    };
  }
  return { message };
}

export function decideMessageAdmission(
  input: NormalizedMessageAdmissionInput,
  options: MessageAdmissionOptions
): MessageAdmissionRecord {
  const { message } = input;
  const { variant, sendStatus } = options;
  const messageType = message.type;
  const messageSubtype = 'subtype' in message ? (message.subtype as string) : null;
  const isRenderable = computeIsRenderable(message);
  const anchorStatusAllowed =
    variant !== 'user' || sendStatus === 'consumed' || sendStatus === 'failed';
  const parentToolUseId = extractParentToolUseId(message);
  return {
    isRenderable,
    isTerminal: computeIsTerminal(message),
    isConversationAnchor: isRenderable === 1 && messageType === 'user' && anchorStatusAllowed,
    countsTowardsBadge: isVisibleBadgeRow({
      parentToolUseId,
      messageType,
      messageSubtype,
      sendStatus,
    }),
    parentToolUseId,
    sdkUuid: extractSdkUuid(message),
    replacementEdges: extractReplacementEdges(message),
  };
}
