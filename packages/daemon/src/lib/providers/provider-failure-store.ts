import type { ProviderAuthStatusInfo, ProviderFailureErrorKind } from '@hyperneo/shared/provider';

export interface ProviderFailureRecord {
  readonly providerId: string;
  readonly errorKind: ProviderFailureErrorKind;
  readonly message: string;
  readonly firstRecordedAt: number;
  readonly lastRecordedAt: number;
}

/** @public */
export interface ProviderFailureChange {
  readonly providerId: string;
  readonly record: ProviderFailureRecord | null;
}

export type ProviderFailureChangeListener = (change: ProviderFailureChange) => void;

const CREDENTIAL_MESSAGE_PATTERNS: readonly RegExp[] = [
  /\(http 40[13]\)/i,
  /invalid acp command/i,
  /acp_command not set/i,
  /acp agent process error:.*\b(?:enoent|eacces|enotdir|eisdir)\b/i,
  /unsupported acp protocol version/i,
];

const providerFailures = new Map<string, ProviderFailureRecord>();

const failureChangeListeners = new Set<ProviderFailureChangeListener>();

export function classifyProviderFailureMessage(message: string): ProviderFailureErrorKind {
  return CREDENTIAL_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
    ? 'credential'
    : 'transient';
}

export function classifyProviderFailure(error: unknown): {
  errorKind: ProviderFailureErrorKind;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  return { errorKind: classifyProviderFailureMessage(message), message };
}

function notifyFailureChange(change: ProviderFailureChange): void {
  for (const listener of failureChangeListeners) {
    listener(change);
  }
}

export function recordProviderFailure(providerId: string, error: unknown): ProviderFailureRecord {
  return recordClassifiedProviderFailure(providerId, classifyProviderFailure(error));
}

export function recordClassifiedProviderFailure(
  providerId: string,
  failure: { errorKind: ProviderFailureErrorKind; message: string }
): ProviderFailureRecord {
  const { errorKind, message } = failure;
  const now = Date.now();
  const existing = providerFailures.get(providerId);

  if (existing && existing.errorKind === errorKind) {
    const refreshed: ProviderFailureRecord = { ...existing, message, lastRecordedAt: now };
    providerFailures.set(providerId, refreshed);
    return refreshed;
  }

  const record: ProviderFailureRecord = {
    providerId,
    errorKind,
    message,
    firstRecordedAt: now,
    lastRecordedAt: now,
  };
  providerFailures.set(providerId, record);
  notifyFailureChange({ providerId, record });
  return record;
}

export function clearProviderFailure(providerId: string): boolean {
  if (!providerFailures.has(providerId)) {
    return false;
  }
  providerFailures.delete(providerId);
  notifyFailureChange({ providerId, record: null });
  return true;
}

export function removeProviderFailure(providerId: string): boolean {
  return providerFailures.delete(providerId);
}

/** @public */
export function getProviderFailure(providerId: string): ProviderFailureRecord | undefined {
  return providerFailures.get(providerId);
}

/** @public */
export function getAllProviderFailures(): ProviderFailureRecord[] {
  return Array.from(providerFailures.values());
}

export function subscribeProviderFailureChanges(
  listener: ProviderFailureChangeListener
): () => void {
  failureChangeListeners.add(listener);
  return () => {
    failureChangeListeners.delete(listener);
  };
}

export function clearProviderFailureRecords(): void {
  providerFailures.clear();
}

/** @public */
export function applyRecordedFailureToAuthStatus(
  providerId: string,
  status: ProviderAuthStatusInfo
): ProviderAuthStatusInfo {
  const failure = providerFailures.get(providerId);
  if (!failure) {
    return status;
  }
  if (failure.errorKind === 'credential') {
    return { ...status, isAuthenticated: false, error: failure.message, errorKind: 'credential' };
  }
  if (!status.isAuthenticated) {
    return status;
  }
  return { ...status, error: failure.message, errorKind: 'transient' };
}

/** @public */
export function resetProviderFailureStore(): void {
  providerFailures.clear();
  failureChangeListeners.clear();
}
