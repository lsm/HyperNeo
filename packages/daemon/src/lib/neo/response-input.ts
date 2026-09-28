import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { NeoInputOrigin } from '@hyperneo/shared/types/neo-message';
import superpipe, { type PipelineAPI } from 'superpipe';

export function selectNeoResponseInput(
  sessionId: string,
  messageId: string | null | undefined
): { origin: NeoInputOrigin | null } {
  return { origin: sessionId.trim() && messageId?.trim() ? { sessionId, messageId } : null };
}

export function applyNeoResponseInput(
  message: SDKMessage,
  selection: { origin: NeoInputOrigin | null }
): SDKMessage & { neoInputOrigin: NeoInputOrigin | null } {
  return { ...message, neoInputOrigin: selection.origin };
}

export const stampNeoResponseInput = (superpipe({})('neo-response-input') as PipelineAPI)
  .input(['message', 'sessionId', 'messageId'])
  .pipe(selectNeoResponseInput, ['sessionId', 'messageId'], 'selection')
  .pipe(applyNeoResponseInput, ['message', 'selection'], 'message')
  .end('message') as (
  message: SDKMessage,
  sessionId: string,
  messageId: string | null | undefined
) => SDKMessage & { neoInputOrigin: NeoInputOrigin | null };
