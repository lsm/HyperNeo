import type { RateLimitHoldReason } from '../state-types.ts';

export interface ModelHold {
  provider: string;
  reason: RateLimitHoldReason;
  since: number;
  resetAt?: number;
}

interface HeldState {
  status: string;
  reason?: RateLimitHoldReason | null;
  since?: number | null;
  retryAt?: number | null;
}

export function modelHoldOf(
  state: HeldState | null | undefined,
  provider: string
): ModelHold | undefined {
  if (state?.status !== 'rate_limit_cooldown') return undefined;
  const reason = state.reason ?? 'limit';
  return {
    provider,
    reason,
    since: state.since ?? 0,
    ...(reason === 'limit' && state.retryAt ? { resetAt: state.retryAt } : {}),
  };
}

const PROVIDER_NAMES: Record<string, string> = { anthropic: 'Claude' };

const clockTime = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function modelHoldLine(
  hold: ModelHold,
  formatTime: (at: number) => string = clockTime
): { text: string; signIn: boolean } {
  const name = PROVIDER_NAMES[hold.provider] ?? hold.provider;
  switch (hold.reason) {
    case 'login':
      return { text: `${name} needs you to sign in again`, signIn: true };
    case 'limit':
      return {
        text: hold.resetAt
          ? `${name} usage limit · resets ${formatTime(hold.resetAt)}`
          : `${name} usage limit`,
        signIn: false,
      };
    case 'network':
      return { text: `Can't reach ${name} · retrying`, signIn: false };
    case 'overloaded':
      return { text: `${name} is overloaded · retrying`, signIn: false };
  }
}

export function shownModelHold(
  entries: readonly { role?: 'neo' | 'front'; modelHold?: ModelHold }[]
): ModelHold | undefined {
  const held = entries.filter((entry) => entry.role && entry.modelHold);
  return (
    held.find((entry) => entry.modelHold?.reason === 'login') ??
    held.find((entry) => entry.role === 'neo') ??
    held[0]
  )?.modelHold;
}
