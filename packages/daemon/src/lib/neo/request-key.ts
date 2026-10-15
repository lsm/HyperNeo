import type { OperationCaller } from '../operations/registry.ts';
import type { NeoAskOrigin } from './ask-origin.ts';
import { neoDerivedId } from './derived-id.ts';

export function neoTurnRequestKey(
  inputTrigger: (input: NeoAskOrigin) => string | null,
  caller: OperationCaller,
  operation: string,
  request: unknown
): string {
  const messageId = caller.neoTurn?.messageId;
  if (!caller.sessionId || !messageId) return crypto.randomUUID();
  const turn = { sessionId: caller.sessionId, messageId };
  const chain = inputTrigger(turn) ?? `${turn.sessionId}:${turn.messageId}`;
  return neoDerivedId(`${operation}:${chain}:${JSON.stringify(request)}`);
}
