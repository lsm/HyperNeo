import { describe, expect, test } from 'bun:test';
import type { SpaceTaskStatus } from '@hyperneo/shared';
import {
  decideSpawnExecutionAdmission,
  type SpawnExecutionAdmissionDecision,
} from '../../../../src/lib/space/runtime/spawn-admission-gates';

const ALL_STATUSES: SpaceTaskStatus[] = [
  'draft',
  'open',
  'in_progress',
  'review',
  'approved',
  'done',
  'blocked',
  'cancelled',
  'archived',
  'rate_limited',
  'usage_limited',
  'stopped',
];

const STATUS_DECISIONS: Partial<Record<SpaceTaskStatus, SpawnExecutionAdmissionDecision>> = {
  archived: { action: 'reject_permanent', reason: 'task_archived' },
  cancelled: { action: 'reject_permanent', reason: 'task_cancelled' },
  rate_limited: { action: 'reject_transient', reason: 'task_rate_or_usage_limited' },
  usage_limited: { action: 'reject_transient', reason: 'task_rate_or_usage_limited' },
};

function statusDecision(status: SpaceTaskStatus): SpawnExecutionAdmissionDecision {
  return STATUS_DECISIONS[status] ?? { action: 'proceed_fresh' };
}

function decide(
  overrides: Partial<Parameters<typeof decideSpawnExecutionAdmission>[0]>
): SpawnExecutionAdmissionDecision {
  return decideSpawnExecutionAdmission({
    hasLiveIndexedSession: false,
    isSpawningExecution: false,
    taskStatus: 'in_progress',
    executionWorkflowValid: true,
    slotResolvable: true,
    ...overrides,
  });
}

describe('decideSpawnExecutionAdmission — decision table over task status and workflow/slot inputs', () => {
  for (const status of ALL_STATUSES) {
    const statusOutcome = statusDecision(status);

    test(`valid workflow + resolvable slot + ${status} → ${statusOutcome.action}`, () => {
      expect(decide({ taskStatus: status })).toEqual(statusOutcome);
    });

    const workflowOutcome: SpawnExecutionAdmissionDecision =
      statusOutcome.action === 'proceed_fresh'
        ? { action: 'reject_permanent', reason: 'workflow_invalid' }
        : statusOutcome;
    test(`invalid workflow + resolvable slot + ${status} → ${workflowOutcome.action}`, () => {
      expect(decide({ taskStatus: status, executionWorkflowValid: false })).toEqual(
        workflowOutcome
      );
    });

    const slotOutcome: SpawnExecutionAdmissionDecision =
      statusOutcome.action === 'proceed_fresh'
        ? { action: 'reject_permanent', reason: 'slot_unresolvable' }
        : statusOutcome;
    test(`valid workflow + unresolvable slot + ${status} → ${slotOutcome.action}`, () => {
      expect(decide({ taskStatus: status, slotResolvable: false })).toEqual(slotOutcome);
    });

    test(`invalid workflow + unresolvable slot + ${status} → ${workflowOutcome.action}`, () => {
      expect(
        decide({ taskStatus: status, executionWorkflowValid: false, slotResolvable: false })
      ).toEqual(workflowOutcome);
    });
  }

  test('archived and cancelled mirror the validateTaskAllowsSpawn permanent arm', () => {
    expect(decide({ taskStatus: 'archived' })).toEqual({
      action: 'reject_permanent',
      reason: 'task_archived',
    });
    expect(decide({ taskStatus: 'cancelled' })).toEqual({
      action: 'reject_permanent',
      reason: 'task_cancelled',
    });
  });

  test('rate_limited and usage_limited mirror the validateTaskAllowsSpawn transient arm', () => {
    expect(decide({ taskStatus: 'rate_limited' })).toEqual({
      action: 'reject_transient',
      reason: 'task_rate_or_usage_limited',
    });
    expect(decide({ taskStatus: 'usage_limited' })).toEqual({
      action: 'reject_transient',
      reason: 'task_rate_or_usage_limited',
    });
  });

  test('statuses validateTaskAllowsSpawn lets through pass through to proceed_fresh unchanged', () => {
    for (const status of ALL_STATUSES.filter((candidate) => !STATUS_DECISIONS[candidate])) {
      expect(decide({ taskStatus: status })).toEqual({ action: 'proceed_fresh' });
    }
  });
});

describe('decideSpawnExecutionAdmission — precedence', () => {
  test('reuse_live beats wait_concurrent, both rejects, and proceed', () => {
    expect(
      decide({
        hasLiveIndexedSession: true,
        isSpawningExecution: true,
        taskStatus: 'archived',
        executionWorkflowValid: false,
        slotResolvable: false,
      })
    ).toEqual({ action: 'reuse_live' });
  });

  test('reuse_live beats a permanent task rejection (live-session reuse precedes task validation)', () => {
    expect(
      decide({
        hasLiveIndexedSession: true,
        taskStatus: 'archived',
        executionWorkflowValid: false,
        slotResolvable: false,
      })
    ).toEqual({ action: 'reuse_live' });
  });

  test('wait_concurrent beats both rejects and proceed', () => {
    expect(
      decide({
        isSpawningExecution: true,
        taskStatus: 'cancelled',
        executionWorkflowValid: false,
        slotResolvable: false,
      })
    ).toEqual({ action: 'wait_concurrent' });
  });

  test('wait_concurrent beats proceed for an otherwise clean spawn', () => {
    expect(decide({ isSpawningExecution: true })).toEqual({ action: 'wait_concurrent' });
  });

  test('task-status rejection beats workflow rejection (task-status validation precedes workflow validation)', () => {
    expect(
      decide({ taskStatus: 'cancelled', executionWorkflowValid: false, slotResolvable: false })
    ).toEqual({ action: 'reject_permanent', reason: 'task_cancelled' });
  });

  test('a transient task-status rejection still beats the permanent workflow rejection', () => {
    expect(decide({ taskStatus: 'rate_limited', executionWorkflowValid: false })).toEqual({
      action: 'reject_transient',
      reason: 'task_rate_or_usage_limited',
    });
  });

  test('workflow rejection beats slot rejection', () => {
    expect(decide({ executionWorkflowValid: false, slotResolvable: false })).toEqual({
      action: 'reject_permanent',
      reason: 'workflow_invalid',
    });
  });

  test('slot rejection alone rejects permanent after a valid workflow', () => {
    expect(decide({ slotResolvable: false })).toEqual({
      action: 'reject_permanent',
      reason: 'slot_unresolvable',
    });
  });
});
