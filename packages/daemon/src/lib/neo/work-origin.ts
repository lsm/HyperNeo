import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { isLocalUser } from '../operations/caller.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { isNeoAskLive } from './done-check.ts';

export type NeoWorkOrigin = { originSessionId: string; originMessageId: string | null };
type Admission = { value: NeoWorkOrigin } | { reason: { ok: false; reason: string } };

export function hasNeoHumanWorkInput(
  caller: OperationCaller,
  prompts: readonly { type: string; inputKind?: unknown }[]
): boolean {
  return (
    caller.source === 'mcp' &&
    !!caller.neoTurn?.human &&
    !caller.neoTurn.consultationId &&
    prompts.some((message) => message.type === 'user' && message.inputKind === 'human')
  );
}

export function requireNeoHumanWorkOrigin(
  origin: NeoWorkOrigin,
  caller: OperationCaller
): Admission {
  if (isLocalUser(caller)) return { value: origin };
  return caller.neoTurn?.human && !caller.neoTurn.consultationId
    ? requireLiveNeoWorkOrigin(origin, caller)
    : { reason: { ok: false, reason: 'This action needs the user.' } };
}

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

export function isNeoAskStartApproved(
  work: Pick<NeoWork, 'id' | 'status'>,
  ask: Pick<NeoAsk, 'originSessionId' | 'approvedAt' | 'status' | 'workIds'> | null,
  caller: OperationCaller
): boolean {
  return (
    caller.source === 'mcp' &&
    !!ask?.approvedAt &&
    isNeoAskLive(ask) &&
    caller.sessionId === ask.originSessionId &&
    ask.workIds.includes(work.id) &&
    work.status === 'proposed' &&
    !!caller.neoTurn?.isLive()
  );
}
