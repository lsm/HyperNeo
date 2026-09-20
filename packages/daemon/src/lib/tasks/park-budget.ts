import type { Job } from '../../storage/repositories/job-queue-repository.ts';

export interface ParkBudget {
  readonly maxParks: number;
  readonly maxParkedMs: number;
}

export interface ParkAdmissionInput {
  readonly parkCount: number;
  readonly parkedSince: number | undefined;
  readonly now: number;
  readonly budget: ParkBudget;
}

export type ParkBudgetExhausted = 'park_count_exceeded' | 'park_window_exceeded';

export const DIRECT_TASK_PARK_BUDGET: ParkBudget = {
  maxParks: 60,
  maxParkedMs: 30 * 60_000,
};

export function decideParkAdmission(
  input: ParkAdmissionInput
): { value: 'park' } | { reason: ParkBudgetExhausted } {
  const { parkCount, parkedSince, now, budget } = input;
  if (parkCount >= budget.maxParks) return { reason: 'park_count_exceeded' };
  if (parkedSince !== undefined && now - parkedSince >= budget.maxParkedMs) {
    return { reason: 'park_window_exceeded' };
  }
  return { value: 'park' };
}

export function parkAdmissionInput(job: Job, budget: ParkBudget, now: number): ParkAdmissionInput {
  const parkCount = job.payload.__parkCount;
  const parkedSince = job.payload.__parkedSince;
  return {
    parkCount: typeof parkCount === 'number' ? parkCount : 0,
    parkedSince: typeof parkedSince === 'number' ? parkedSince : undefined,
    now,
    budget,
  };
}
