import type { ProviderFailureErrorKind } from '@hyperneo/shared/provider';

export type RefreshTrigger = 'expiring' | 'credential_failure';

export type RefreshNotDueReason = 'not_due' | 'no_expiry_without_credential_failure';

export interface RefreshDueInput {
  readonly expiresAt: number | undefined;
  readonly now: number;
  readonly refreshWindowMs: number;
  readonly failureKind: ProviderFailureErrorKind | undefined;
}

export function decideRefreshDue(
  input: RefreshDueInput
): { value: RefreshTrigger } | { reason: RefreshNotDueReason } {
  const { expiresAt, now, refreshWindowMs, failureKind } = input;
  if (typeof expiresAt === 'number') {
    return expiresAt - now <= refreshWindowMs ? { value: 'expiring' } : { reason: 'not_due' };
  }
  return failureKind === 'credential'
    ? { value: 'credential_failure' }
    : { reason: 'no_expiry_without_credential_failure' };
}
