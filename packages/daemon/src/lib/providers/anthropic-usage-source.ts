import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from '@hyperneo/shared/sdk';
import type { UsageWindow } from '@hyperneo/shared/provider';

export type RateLimitEventReader = () => Promise<readonly SDKRateLimitInfo[]>;

let reader: RateLimitEventReader = async () => [];

export function setRateLimitEventReader(next: RateLimitEventReader | null): void {
  reader = next ?? (async () => []);
}

export function resetRateLimitEventReader(): void {
  reader = async () => [];
}

export async function readStoredRateLimitEvents(): Promise<readonly SDKRateLimitInfo[]> {
  try {
    return await reader();
  } catch {
    return [];
  }
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5 hours',
  seven_day: '7 days',
  seven_day_opus: '7 days (Opus)',
  seven_day_sonnet: '7 days (Sonnet)',
};

const WINDOW_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const;

function controlWindow(
  label: string,
  window: { utilization: number | null; resets_at: string | null } | null | undefined
): UsageWindow | null {
  if (!window || typeof window.utilization !== 'number') return null;
  return {
    label,
    used: window.utilization,
    limit: 100,
    resetAt: typeof window.resets_at === 'string' ? window.resets_at : null,
  };
}

export function usageWindowsFromControl(
  response: SDKControlGetUsageResponse | null | undefined
): UsageWindow[] | null {
  const limits = response?.rate_limits;
  if (!response?.rate_limits_available || !limits || typeof limits !== 'object') return null;
  const windows = WINDOW_ORDER.flatMap((key) => {
    const window = controlWindow(WINDOW_LABELS[key], limits[key]);
    return window ? [window] : [];
  });
  for (const scoped of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    const window = controlWindow(scoped?.display_name?.trim() || 'Model', scoped);
    if (window) windows.push(window);
  }
  return windows.length ? windows : null;
}

export function usageWindowsFromEvents(events: readonly SDKRateLimitInfo[]): UsageWindow[] {
  return events.flatMap((event) => {
    const label = event.rateLimitType ? WINDOW_LABELS[event.rateLimitType] : undefined;
    if (!label) return [];
    const resetAt =
      typeof event.resetsAt === 'number' ? new Date(event.resetsAt * 1000).toISOString() : null;
    if (typeof event.utilization === 'number')
      return [{ label, used: Math.round(event.utilization * 100), limit: 100, resetAt }];
    if (event.status === 'rejected') return [{ label, used: 100, limit: 100, resetAt }];
    return [];
  });
}
