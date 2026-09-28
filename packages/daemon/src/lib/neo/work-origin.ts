import type { OperationCaller } from '../operations/registry.ts';

export type NeoWorkOrigin = { originSessionId: string; originMessageId: string | null };
type Admission = { value: NeoWorkOrigin } | { reason: { ok: false; reason: string } };

export function requireLiveNeoWorkOrigin(
  origin: NeoWorkOrigin,
  caller: OperationCaller
): Admission {
  if (caller.source === 'rpc' && caller.principal === 'local' && origin.originMessageId === null)
    return { value: origin };
  return caller.source === 'mcp' &&
    caller.sessionId === origin.originSessionId &&
    origin.originMessageId &&
    caller.neoTurn?.messageId === origin.originMessageId &&
    caller.neoTurn.isLive()
    ? { value: origin }
    : { reason: { ok: false, reason: 'A live Neo input is required to propose work.' } };
}

export function admitNeoWorkOrigin(
  caller: OperationCaller,
  originSessionId: string | undefined
): Admission {
  if (!originSessionId) return { reason: { ok: false, reason: 'Open Neo first.' } };
  return requireLiveNeoWorkOrigin(
    {
      originSessionId,
      originMessageId: caller.source === 'mcp' ? (caller.neoTurn?.messageId ?? null) : null,
    },
    caller
  );
}
