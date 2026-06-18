import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';

export type MessageReplacementStatus = 'superseded' | 'retracted';

export function getMessageUuid(message: SDKMessage | null | undefined): string | undefined {
  const uuid = (message as { uuid?: unknown } | null | undefined)?.uuid;
  return typeof uuid === 'string' && uuid.length > 0 ? uuid : undefined;
}

export function buildMessageReplacementStatusMap(
  messages: SDKMessage[]
): Map<string, MessageReplacementStatus> {
  const map = new Map<string, MessageReplacementStatus>();

  for (const message of messages) {
    const maybeReplacing = message as SDKMessage & {
      supersedes?: unknown;
      retracted_message_uuids?: unknown;
    };

    if (Array.isArray(maybeReplacing.supersedes)) {
      for (const uuid of maybeReplacing.supersedes) {
        if (typeof uuid === 'string' && uuid.length > 0) {
          map.set(uuid, 'superseded');
        }
      }
    }

    if (
      message.type === 'system' &&
      message.subtype === 'model_refusal_fallback' &&
      Array.isArray(maybeReplacing.retracted_message_uuids)
    ) {
      for (const uuid of maybeReplacing.retracted_message_uuids) {
        if (typeof uuid === 'string' && uuid.length > 0) {
          map.set(uuid, 'retracted');
        }
      }
    }
  }

  return map;
}
