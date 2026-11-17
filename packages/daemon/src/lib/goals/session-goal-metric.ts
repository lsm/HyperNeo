import { z } from 'zod';
import type { GoalJournalEntry, SessionGoal } from '@hyperneo/shared/types/session-goal';

export const MetricSchema = z
  .object({
    name: z.string().min(1),
    target: z.number().finite(),
    direction: z.enum(['increase', 'decrease']),
    baseline: z.number().finite(),
  })
  .strict();

export const PointSchema = z
  .object({
    value: z.number().finite(),
    evidence: z.string().min(1),
  })
  .strict();

const key = '__goal_metric_v1';
export const metricKey = key;
const prefix = 'goal-metric-v1:';
export const metricFields = (metric: z.infer<typeof MetricSchema>) => ({
  [key]: JSON.stringify(metric),
});
export const readMetric = (goal: SessionGoal) => {
  const raw = goal.metrics[key];
  if (typeof raw !== 'string') return null;
  try {
    const result = MetricSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};
export const metricEvidence = (point: z.infer<typeof PointSchema>) => ({
  kind: 'metric' as const,
  ref: prefix + JSON.stringify(point),
});
export const reservedMetricEvidence = (ref: string) => ref.startsWith(prefix);
export const readPoint = (entry: GoalJournalEntry) => {
  const ref = entry.evidence.find(
    (item) => item.kind === 'metric' && reservedMetricEvidence(item.ref)
  )?.ref;
  if (!ref) return null;
  try {
    const result = PointSchema.safeParse(JSON.parse(ref.slice(prefix.length)));
    return result.success ? { ...result.data, time: entry.createdAt } : null;
  } catch {
    return null;
  }
};
export const reachedTarget = (metric: z.infer<typeof MetricSchema>, value: number) =>
  metric.direction === 'increase' ? value >= metric.target : value <= metric.target;
