import { expect, test } from 'bun:test';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';
import {
  DIRECT_TASK_PARK_BUDGET,
  decideParkAdmission,
  parkAdmissionInput,
} from '../../../../src/lib/tasks/park-budget';

const BUDGET = { maxParks: 3, maxParkedMs: 1000 };

function job(payload: Record<string, unknown>): Job {
  return { id: 'job', queue: 'q', payload } as Job;
}

test('a park inside both bounds is admitted', () => {
  expect(
    decideParkAdmission({ parkCount: 2, parkedSince: 500, now: 1400, budget: BUDGET })
  ).toEqual({ value: 'park' });
});

test('a park is refused once either bound is reached', () => {
  expect(decideParkAdmission({ parkCount: 3, parkedSince: 500, now: 600, budget: BUDGET })).toEqual(
    { reason: 'park_count_exceeded' }
  );
  expect(
    decideParkAdmission({ parkCount: 0, parkedSince: 500, now: 1500, budget: BUDGET })
  ).toEqual({ reason: 'park_window_exceeded' });
});

test('a job that has never parked is admitted whatever the clock says', () => {
  expect(
    decideParkAdmission({ parkCount: 0, parkedSince: undefined, now: 9e12, budget: BUDGET })
  ).toEqual({ value: 'park' });
});

test('park bookkeeping missing from a payload reads as a first park', () => {
  expect(parkAdmissionInput(job({}), BUDGET, 42)).toEqual({
    parkCount: 0,
    parkedSince: undefined,
    now: 42,
    budget: BUDGET,
  });
  expect(
    parkAdmissionInput(job({ __parkCount: 'nope', __parkedSince: null }), BUDGET, 42)
  ).toMatchObject({ parkCount: 0, parkedSince: undefined });
});

test('park bookkeeping present on a payload is carried into the decision', () => {
  expect(parkAdmissionInput(job({ __parkCount: 7, __parkedSince: 100 }), BUDGET, 42)).toEqual({
    parkCount: 7,
    parkedSince: 100,
    now: 42,
    budget: BUDGET,
  });
});

test('the direct-task budget bounds a 30s park loop to half an hour', () => {
  expect(DIRECT_TASK_PARK_BUDGET.maxParkedMs / 30_000).toBe(DIRECT_TASK_PARK_BUDGET.maxParks);
});
