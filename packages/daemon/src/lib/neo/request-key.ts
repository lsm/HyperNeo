import type { OperationCaller } from '../operations/registry.ts';
import { neoDerivedId } from './derived-id.ts';

export function neoTurnRequestKey(
  caller: OperationCaller,
  operation: string,
  request: unknown
): string {
  const messageId = caller.neoTurn?.messageId;
  if (!caller.sessionId || !messageId) return crypto.randomUUID();
  return neoDerivedId(`${operation}:${caller.sessionId}:${messageId}:${JSON.stringify(request)}`);
}
