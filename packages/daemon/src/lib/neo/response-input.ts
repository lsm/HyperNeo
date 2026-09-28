import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { NeoInputOrigin } from '@hyperneo/shared/types/neo-message';
import superpipe, { type PipelineAPI } from 'superpipe';

type NeoResponse = SDKMessage & {
  neoInputOrigin: NeoInputOrigin | null;
  neoAskOrigin: NeoInputOrigin | null;
};
type AskResolver = (input: NeoInputOrigin) => NeoInputOrigin | null;

export function selectNeoResponseInput(
  sessionId: string,
  messageId: string | null | undefined
): { origin: NeoInputOrigin | null } {
  return { origin: sessionId.trim() && messageId?.trim() ? { sessionId, messageId } : null };
}

export function applyNeoResponseInput(
  message: SDKMessage,
  selection: { origin: NeoInputOrigin | null },
  ask: { origin: NeoInputOrigin | null } = { origin: null }
): NeoResponse {
  return { ...message, neoInputOrigin: selection.origin, neoAskOrigin: ask.origin };
}

export function readNeoResponseAsk(
  selection: { origin: NeoInputOrigin | null },
  resolveAskOrigin: AskResolver | undefined
): { origin: NeoInputOrigin | null } {
  return {
    origin: selection.origin && resolveAskOrigin ? resolveAskOrigin(selection.origin) : null,
  };
}

export const stampNeoResponseInput = (superpipe({})('neo-response-input') as PipelineAPI)
  .input(['message', 'sessionId', 'messageId', 'resolveAskOrigin'])
  .pipe(selectNeoResponseInput, ['sessionId', 'messageId'], 'selection')
  .pipe(readNeoResponseAsk, ['selection', 'resolveAskOrigin'], 'ask')
  .pipe(applyNeoResponseInput, ['message', 'selection', 'ask'], 'message')
  .end('message') as (
  message: SDKMessage,
  sessionId: string,
  messageId: string | null | undefined,
  resolveAskOrigin?: AskResolver
) => NeoResponse;
