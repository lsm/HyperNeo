import type { HandoffTransition } from '../types/space.ts';
import { HANDOFF_TARGET_WILDCARD } from '../types/space.ts';

export const MAX_NODE_HANDOFF_TRANSITIONS = 32;

export type HandoffResolveFailure = 'no_transitions' | 'unknown_target' | 'ambiguous';

export type HandoffResolveResult =
  | { ok: true; transition: HandoffTransition }
  | { ok: false; reason: HandoffResolveFailure };

export function resolveHandoffTransition(
  transitions: readonly HandoffTransition[] | undefined,
  target: string
): HandoffResolveResult {
  if (!transitions || transitions.length === 0) {
    return { ok: false, reason: 'no_transitions' };
  }

  const matches = transitions.filter((t) => t.target === target);
  if (matches.length === 0) {
    return { ok: false, reason: 'unknown_target' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: 'ambiguous' };
  }
  return { ok: true, transition: matches[0] };
}

export function isBroadcastHandoffTarget(target: string): boolean {
  return target === HANDOFF_TARGET_WILDCARD;
}
