/**
 * Pure contract logic for the first-class workflow handoff operation.
 *
 * A handoff `target` (see `HandoffOperation`) must resolve to a declared
 * outbound `WorkflowTransition` on the sender's node. This module owns that
 * resolution as a pure function so the contract is testable without the daemon
 * runtime. Runtime transition EXECUTION (completing the sender's round,
 * delivering to the target, enforcing gate/hook authorization, checking the
 * `data` shape) is a separate phase and intentionally NOT implemented here.
 */

import type { WorkflowTransition } from '../types/space.ts';
import { HANDOFF_TARGET_WILDCARD } from '../types/space.ts';

/**
 * Why a handoff failed to resolve.
 *
 * - `no_transitions` — the sender's node declares no outbound transitions.
 * - `unknown_target` — no transition on the node targets the requested name.
 * - `ambiguous` — more than one transition targets the requested name. The
 *   workflow manager's validation forbids duplicate targets within a node, so a
 *   validated workflow never produces this; it exists so callers can stay
 *   defensive against hand-built (unvalidated) transition lists.
 */
export type HandoffResolveFailure = 'no_transitions' | 'unknown_target' | 'ambiguous';

export type HandoffResolveResult =
  | { ok: true; transition: WorkflowTransition }
  | { ok: false; reason: HandoffResolveFailure };

/**
 * Resolve a sender-supplied handoff `target` against a node's declared outbound
 * transitions.
 *
 * A transition matches when its `target` is exactly the requested name. The
 * broadcast wildcard {@link HANDOFF_TARGET_WILDCARD} (`'*'`) is a LITERAL
 * target — it matches only a sender-supplied `'*'`, not any named target — so a
 * broadcast transition is reached by `handoff({ target: '*' })`, never by
 * accident.
 *
 * @param transitions The sender node's declared `transitions` (may be omitted).
 * @param target      The `target` from the sender's `handoff({ target })`.
 * @returns The unique matching transition, or a typed failure reason.
 */
export function resolveHandoffTransition(
  transitions: readonly WorkflowTransition[] | undefined,
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

/**
 * Whether a handoff `target` names the broadcast wildcard. Centralized so the
 * contract has one definition of "broadcast".
 */
export function isBroadcastHandoffTarget(target: string): boolean {
  return target === HANDOFF_TARGET_WILDCARD;
}
