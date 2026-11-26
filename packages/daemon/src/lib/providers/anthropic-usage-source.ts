import type { SDKControlGetUsageResponse } from '@hyperneo/shared/sdk';
import type { UsageWindow } from '@hyperneo/shared/provider';

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
