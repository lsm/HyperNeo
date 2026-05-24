/**
 * Explicit reasons for routing work out of deterministic runtime ownership.
 *
 * Runtime should keep mechanically decidable workflow progression in the
 * runtime/node path. These values mark the narrow cases where Task Agent or
 * human-mediated handling is still expected.
 */
export const RUNTIME_ESCALATION_REASONS = {
  HUMAN_APPROVAL: 'HUMAN_APPROVAL',
  AMBIGUOUS_GATE: 'AMBIGUOUS_GATE',
  MISSING_INTENT: 'MISSING_INTENT',
  NODE_FAILURE: 'NODE_FAILURE',
} as const;

export type RuntimeEscalationReason =
  (typeof RUNTIME_ESCALATION_REASONS)[keyof typeof RUNTIME_ESCALATION_REASONS];
