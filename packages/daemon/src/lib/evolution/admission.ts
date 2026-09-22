import type { Session } from '@hyperneo/shared';
import { z } from 'zod';
import type { OperationCaller } from '../operations/registry.ts';
import { resolveSessionSpaceId } from '../space/runtime/space-caller-scope.ts';
import type { SpaceMcpSessionPolicyContext } from '../space/runtime/space-mcp-session-policy.ts';

export type EvolutionDenial<Reason extends string> = {
  accepted: false;
  reason: Reason;
  detail?: string;
};

export type EvolutionGate<Value, Reason extends string> =
  | { value: Value }
  | { reason: EvolutionDenial<Reason> };

export function denyForge<Reason extends string>(
  reason: Reason,
  detail?: string
): { reason: EvolutionDenial<Reason> } {
  return {
    reason:
      detail === undefined ? { accepted: false, reason } : { accepted: false, reason, detail },
  };
}

export function forgeDenialSchema<const Reasons extends readonly [string, ...string[]]>(
  reasons: Reasons
) {
  return z.object({
    accepted: z.literal(false),
    reason: z.enum(reasons),
    detail: z.string().optional(),
  });
}

export const FORGE_CALLER_REJECTIONS = [
  'forge_denied',
  'space_required',
  'space_mismatch',
] as const;

export type EvolutionCallerRejection = (typeof FORGE_CALLER_REJECTIONS)[number];

export interface EvolutionAdmissionDependencies extends SpaceMcpSessionPolicyContext {
  readonly getSession: (sessionId: string) => Session | null;
}

export interface EvolutionSpaceScope {
  readonly spaceId?: string;
}

export interface EvolutionAuditEntry {
  readonly toolName: string;
  readonly paramsSummary: Record<string, unknown>;
  readonly caller: OperationCaller;
  readonly spaceId?: string;
  readonly taskId?: string;
}

export type EvolutionAuditWriter = (entry: EvolutionAuditEntry) => void;

export function admitForgeReader(
  input: EvolutionSpaceScope,
  caller: OperationCaller
): EvolutionGate<EvolutionSpaceScope, EvolutionCallerRejection> {
  if (caller.source !== 'mcp') {
    const spaceId = input.spaceId ?? caller.spaceId;
    return spaceId
      ? { value: { spaceId } }
      : denyForge('space_required', 'spaceId is required for callers outside a Space session');
  }
  if (!caller.spaceId)
    return denyForge('space_required', 'Caller session is not scoped to a Space');
  if (input.spaceId && input.spaceId !== caller.spaceId) {
    return denyForge('space_mismatch', 'spaceId does not match the calling session Space');
  }
  return { value: { spaceId: caller.spaceId } };
}

export function admitForgeMutator(
  input: EvolutionSpaceScope,
  caller: OperationCaller,
  forge: EvolutionAdmissionDependencies
): EvolutionGate<EvolutionSpaceScope, EvolutionCallerRejection> {
  const admitted = admitForgeReader(input, caller);
  if ('reason' in admitted || caller.source !== 'mcp') return admitted;
  const session = caller.sessionId ? forge.getSession(caller.sessionId) : null;
  return session?.status === 'active' &&
    resolveSessionSpaceId(session, forge) === admitted.value.spaceId
    ? admitted
    : denyForge('forge_denied', 'Forge mutations require an active session in the owning Space');
}

export function requireForgeSpace(
  scope: EvolutionSpaceScope
): EvolutionGate<string, EvolutionCallerRejection> {
  return scope.spaceId
    ? { value: scope.spaceId }
    : denyForge('space_required', 'spaceId is required for callers outside a Space session');
}
