import type { SpaceGoalMetrics } from '@hyperneo/shared';

export function combineOutcomeMetrics(
  current: SpaceGoalMetrics,
  replacement?: Record<string, string | number | boolean | null>,
  observations?: Array<{ key: string; value: number }>
): SpaceGoalMetrics | null {
  if (!replacement && !observations) return null;
  const merged: SpaceGoalMetrics = { ...current };
  if (replacement) {
    for (const [key, value] of Object.entries(replacement)) merged[key] = value;
  }
  if (observations) {
    for (const observation of observations) {
      const existing = merged[observation.key];
      if (existing === undefined || existing === null) {
        merged[observation.key] = observation.value;
      } else if (typeof existing === 'number') {
        merged[observation.key] = existing + observation.value;
      } else {
        throw new Error(
          `Cannot apply a numeric observation to non-numeric metric "${observation.key}"`
        );
      }
    }
  }
  return merged;
}
