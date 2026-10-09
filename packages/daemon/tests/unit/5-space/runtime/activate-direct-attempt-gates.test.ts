import { describe, expect, test } from 'bun:test';
import type { Space, SpaceTask } from '@hyperneo/shared';
import type { DirectTaskAttempt } from '../../../../src/storage/repositories/direct-task-execution-repository';
import {
  requireActivationCapacity,
  requireAdmittedGeneration,
} from '../../../../src/lib/tasks/activate-direct-attempt';

type Target = Parameters<typeof requireActivationCapacity>[0];
const space = { id: 's1', maxConcurrentTasks: 1 } as Space;
const target = (extra: Partial<Target> = {}): Target => ({
  attempt: { id: 'a1', phase: 'reserved' } as DirectTaskAttempt,
  task: { id: 't1' } as SpaceTask,
  slots: { space, running: 0 },
  admittedGeneration: null,
  lifecycleGeneration: 3,
  ...extra,
});
const unavailable = { reason: { activated: false as const, reason: 'unavailable' as const } };

describe('requireActivationCapacity', () => {
  test('passes with a free slot', () => {
    const free = target();
    expect(requireActivationCapacity(free)).toEqual({ value: free });
  });

  test('waits for capacity only for a reserved attempt on a known task and Space', () => {
    const full = { space, running: 1 };
    expect(requireActivationCapacity(target({ slots: full }))).toEqual({
      reason: { activated: false, reason: 'awaiting_capacity' },
    });
    expect(
      requireActivationCapacity(
        target({ slots: full, attempt: { id: 'a1', phase: 'running' } as DirectTaskAttempt })
      )
    ).toEqual(unavailable);
    expect(requireActivationCapacity(target({ slots: full, task: null }))).toEqual(unavailable);
    expect(requireActivationCapacity(target({ slots: { space: null, running: 0 } }))).toEqual(
      unavailable
    );
  });
});

describe('requireAdmittedGeneration', () => {
  test('rejects a start admitted under another lifecycle generation', () => {
    const unadmitted = target();
    expect(requireAdmittedGeneration(unadmitted)).toEqual({ value: unadmitted });
    const current = target({ admittedGeneration: 3 });
    expect(requireAdmittedGeneration(current)).toEqual({ value: current });
    expect(requireAdmittedGeneration(target({ admittedGeneration: 2 }))).toEqual(unavailable);
    expect(
      requireAdmittedGeneration(target({ admittedGeneration: 3, lifecycleGeneration: null }))
    ).toEqual(unavailable);
  });
});
