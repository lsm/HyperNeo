const MINUTE = 60_000;
const PER_MINUTE = 5;
const PER_HOUR = 20;
const LOCK_MS = 15 * MINUTE;

export type PairingAdmission =
  | { ok: true }
  | { ok: false; error: 'pairing_rate_limited' | 'pairing_locked'; retryAfterMs: number };

export interface PairingLimiter {
  admit(now: number): PairingAdmission;
  fail(now: number): void;
  reset(): void;
}

export function createPairingLimiter(): PairingLimiter {
  let failures: number[] = [];
  let lockedUntil = 0;
  return {
    admit(now) {
      if (now < lockedUntil)
        return { ok: false, error: 'pairing_locked', retryAfterMs: lockedUntil - now };
      const recent = failures.filter((at) => now - at < MINUTE);
      return recent.length < PER_MINUTE
        ? { ok: true }
        : { ok: false, error: 'pairing_rate_limited', retryAfterMs: recent[0] + MINUTE - now };
    },
    fail(now) {
      failures = [...failures.filter((at) => now - at < 60 * MINUTE), now];
      if (failures.length < PER_HOUR) return;
      lockedUntil = now + LOCK_MS;
      failures = [];
    },
    reset() {
      failures = [];
      lockedUntil = 0;
    },
  };
}

export const daemonPairingLimiter = createPairingLimiter();
