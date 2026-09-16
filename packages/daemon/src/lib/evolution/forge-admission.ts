import type { Session } from '@hyperneo/shared';
import { z } from 'zod';
import type { OperationCaller, OperationCallerRole } from '../operations/registry.ts';
import { resolveSessionSpaceId } from '../space/runtime/space-caller-scope.ts';
import type { SpaceMcpSessionPolicyContext } from '../space/runtime/space-mcp-session-policy.ts';

export type ForgeDenial<Reason extends string> = {
  accepted: false;
  reason: Reason;
  detail?: string;
};

export type ForgeGate<Value, Reason extends string> =
  | { value: Value }
  | { reason: ForgeDenial<Reason> };

export function denyForge<Reason extends string>(
  reason: Reason,
  detail?: string
): { reason: ForgeDenial<Reason> } {
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

export type ForgeCallerRejection = (typeof FORGE_CALLER_REJECTIONS)[number];

export interface ForgeAdmissionDependencies extends SpaceMcpSessionPolicyContext {
  readonly getSession: (sessionId: string) => Session | null;
}

export interface ForgeSpaceScope {
  readonly spaceId?: string;
}

export interface ForgeAuditEntry {
  readonly toolName: string;
  readonly paramsSummary: Record<string, unknown>;
  readonly caller: OperationCaller;
  readonly spaceId?: string;
  readonly taskId?: string;
}

export type ForgeAuditWriter = (entry: ForgeAuditEntry) => void;

const FORGE_READ_ROLES: ReadonlySet<OperationCallerRole> = new Set([
  'ad_hoc_member',
  'long_term_agent',
  'universal_read',
]);

const FORGE_MUTATE_ROLES: ReadonlySet<OperationCallerRole> = new Set([
  'ad_hoc_member',
  'long_term_agent',
]);

function admitForgeCaller(
  input: ForgeSpaceScope,
  caller: OperationCaller,
  roles: ReadonlySet<OperationCallerRole>
): ForgeGate<ForgeSpaceScope, ForgeCallerRejection> {
  if (caller.source !== 'mcp') return { value: { spaceId: input.spaceId } };
  if (!caller.role || !roles.has(caller.role)) {
    return denyForge(
      'forge_denied',
      `Forge is not available to role "${caller.role ?? 'unknown'}"`
    );
  }
  if (!caller.spaceId)
    return denyForge('space_required', 'Caller session is not scoped to a Space');
  if (input.spaceId && input.spaceId !== caller.spaceId) {
    return denyForge('space_mismatch', 'spaceId does not match the calling session Space');
  }
  return { value: { spaceId: caller.spaceId } };
}

export function admitForgeReader(
  input: ForgeSpaceScope,
  caller: OperationCaller
): ForgeGate<ForgeSpaceScope, ForgeCallerRejection> {
  return admitForgeCaller(input, caller, FORGE_READ_ROLES);
}

export function admitForgeMutator(
  input: ForgeSpaceScope,
  caller: OperationCaller,
  forge: ForgeAdmissionDependencies
): ForgeGate<ForgeSpaceScope, ForgeCallerRejection> {
  const admitted = admitForgeCaller(input, caller, FORGE_MUTATE_ROLES);
  if ('reason' in admitted || caller.source !== 'mcp') return admitted;
  const session = caller.sessionId ? forge.getSession(caller.sessionId) : null;
  return session?.status === 'active' &&
    resolveSessionSpaceId(session, forge) === admitted.value.spaceId
    ? admitted
    : denyForge('forge_denied', 'Forge mutations require an active session in the owning Space');
}

export function requireForgeSpace(scope: ForgeSpaceScope): ForgeGate<string, ForgeCallerRejection> {
  return scope.spaceId
    ? { value: scope.spaceId }
    : denyForge('space_required', 'spaceId is required for callers outside a Space session');
}
