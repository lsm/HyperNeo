import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { OperationCaller } from '../operations/registry.ts';

export type NeoConsultationOrigin = { originSessionId: string; originMessageId: string };
type Admission = { value: NeoConsultationOrigin } | { reason: { ok: false; reason: string } };

export function requireLiveNeoConsultationOrigin(
  origin: NeoConsultationOrigin,
  turn: OperationCaller['neoTurn']
): Admission {
  return turn?.isLive() && origin.originMessageId && turn.messageId === origin.originMessageId
    ? { value: origin }
    : { reason: { ok: false, reason: 'A live root Neo input is required to consult a holder.' } };
}

export function admitNeoConsultationOrigin(
  caller: OperationCaller,
  binding: NeoBinding | null
): Admission {
  if (caller.source !== 'mcp' || binding?.kind !== 'neo' || binding.sessionId !== caller.sessionId)
    return { reason: { ok: false, reason: 'Only root Neo can consult.' } };
  return requireLiveNeoConsultationOrigin(
    { originSessionId: binding.sessionId, originMessageId: caller.neoTurn?.messageId ?? '' },
    caller.neoTurn
  );
}
