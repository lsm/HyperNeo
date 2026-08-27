export const DEFAULT_STUCK_INITIALIZING_REFUSE_MS = 120_000;

export const STUCK_INITIALIZING_PARK_MS = 30_000;

export function stuckInitializingRefuseMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HYPERNEO_DELIVERY_STUCK_INITIALIZING_MS;
  if (!raw) return DEFAULT_STUCK_INITIALIZING_REFUSE_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STUCK_INITIALIZING_REFUSE_MS;
}

export type StuckInitializingGate =
  | { action: 'admit' }
  | { action: 'refuse'; initializingMs: number; retryAt: number };

export function resolveStuckInitializingGate(args: {
  stuckInitializingMs: number | null;
  thresholdMs: number;
  parkMs: number;
  now: number;
}): StuckInitializingGate {
  if (args.stuckInitializingMs === null || args.stuckInitializingMs < args.thresholdMs) {
    return { action: 'admit' };
  }
  return {
    action: 'refuse',
    initializingMs: args.stuckInitializingMs,
    retryAt: args.now + args.parkMs,
  };
}
