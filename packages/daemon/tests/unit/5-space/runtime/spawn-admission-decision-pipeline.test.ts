import { describe, expect, test } from 'bun:test';
import type { SpaceTaskStatus } from '@hyperneo/shared';
import type { SpawnExecutionAdmissionInput } from '../../../../src/lib/space/runtime/spawn-admission-gates';
import { decideSpawnExecutionAdmission } from '../../../../src/lib/space/runtime/spawn-admission-gates';
import {
  applyConcurrentSpawnGate,
  applyLiveSessionGate,
  applyProceedGate,
  applySlotResolutionGate,
  applyTaskStatusGate,
  applyWorkflowValidityGate,
  decideSpawnExecutionAdmissionViaPipeline,
  type SpawnAdmissionCtx,
} from '../../../../src/lib/space/runtime/spawn-admission-decision-pipeline';

const BASE: SpawnExecutionAdmissionInput = {
  hasLiveIndexedSession: false,
  isSpawningExecution: false,
  taskStatus: 'in_progress',
  executionWorkflowValid: true,
  slotResolvable: true,
};

function undecided(input: SpawnExecutionAdmissionInput): SpawnAdmissionCtx {
  return { ...input, decision: null };
}

describe('spawn admission decisionRun gates', () => {
  test('non-deciding gates pass the ctx through by reference', () => {
    const ctx = undecided(BASE);
    expect(applyLiveSessionGate(ctx)).toBe(ctx);
    expect(applyConcurrentSpawnGate(ctx)).toBe(ctx);
    expect(applyTaskStatusGate(ctx)).toBe(ctx);
    expect(applyWorkflowValidityGate(ctx)).toBe(ctx);
    expect(applySlotResolutionGate(ctx)).toBe(ctx);
  });

  test('applyProceedGate always decides proceed_fresh', () => {
    const ctx = undecided(BASE);
    expect(applyProceedGate(ctx).decision).toEqual({ action: 'proceed_fresh' });
  });

  test('applyLiveSessionGate decides reuse_live on a live indexed session', () => {
    const decision = applyLiveSessionGate(
      undecided({ ...BASE, hasLiveIndexedSession: true })
    ).decision;
    expect(decision).toEqual({ action: 'reuse_live' });
  });

  test('applyConcurrentSpawnGate decides wait_concurrent on an in-flight spawn', () => {
    const decision = applyConcurrentSpawnGate(
      undecided({ ...BASE, isSpawningExecution: true })
    ).decision;
    expect(decision).toEqual({ action: 'wait_concurrent' });
  });

  test('applyTaskStatusGate maps each terminal and rate/usage status to its member', () => {
    expect(applyTaskStatusGate(undecided({ ...BASE, taskStatus: 'archived' })).decision).toEqual({
      action: 'reject_permanent',
      reason: 'task_archived',
    });
    expect(applyTaskStatusGate(undecided({ ...BASE, taskStatus: 'cancelled' })).decision).toEqual({
      action: 'reject_permanent',
      reason: 'task_cancelled',
    });
    expect(
      applyTaskStatusGate(undecided({ ...BASE, taskStatus: 'rate_limited' })).decision
    ).toEqual({ action: 'reject_transient', reason: 'task_rate_or_usage_limited' });
    expect(
      applyTaskStatusGate(undecided({ ...BASE, taskStatus: 'usage_limited' })).decision
    ).toEqual({ action: 'reject_transient', reason: 'task_rate_or_usage_limited' });
    expect(applyTaskStatusGate(undecided({ ...BASE, taskStatus: 'stopped' })).decision).toBeNull();
  });

  test('applyWorkflowValidityGate and applySlotResolutionGate decide their permanent rejects', () => {
    expect(
      applyWorkflowValidityGate(undecided({ ...BASE, executionWorkflowValid: false })).decision
    ).toEqual({ action: 'reject_permanent', reason: 'workflow_invalid' });
    expect(applySlotResolutionGate(undecided({ ...BASE, slotResolvable: false })).decision).toEqual(
      {
        action: 'reject_permanent',
        reason: 'slot_unresolvable',
      }
    );
  });
});

describe('spawn admission decisionRun parity with the pure core', () => {
  const STATUSES: SpaceTaskStatus[] = [
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

  test('the pipeline matches decideSpawnExecutionAdmission across the full input matrix', () => {
    for (const hasLiveIndexedSession of [false, true]) {
      for (const isSpawningExecution of [false, true]) {
        for (const taskStatus of STATUSES) {
          for (const executionWorkflowValid of [false, true]) {
            for (const slotResolvable of [false, true]) {
              const input: SpawnExecutionAdmissionInput = {
                hasLiveIndexedSession,
                isSpawningExecution,
                taskStatus,
                executionWorkflowValid,
                slotResolvable,
              };
              expect(decideSpawnExecutionAdmissionViaPipeline(input)).toEqual(
                decideSpawnExecutionAdmission(input)
              );
            }
          }
        }
      }
    }
  });

  test('precedence: a live indexed session beats every downstream gate', () => {
    const decision = decideSpawnExecutionAdmissionViaPipeline({
      hasLiveIndexedSession: true,
      isSpawningExecution: true,
      taskStatus: 'archived',
      executionWorkflowValid: false,
      slotResolvable: false,
    });
    expect(decision).toEqual({ action: 'reuse_live' });
  });

  test('precedence: an in-flight concurrent spawn beats the reject gates', () => {
    const decision = decideSpawnExecutionAdmissionViaPipeline({
      hasLiveIndexedSession: false,
      isSpawningExecution: true,
      taskStatus: 'usage_limited',
      executionWorkflowValid: false,
      slotResolvable: false,
    });
    expect(decision).toEqual({ action: 'wait_concurrent' });
  });

  test('precedence: task status beats workflow validity beats slot resolvability', () => {
    expect(
      decideSpawnExecutionAdmissionViaPipeline({
        hasLiveIndexedSession: false,
        isSpawningExecution: false,
        taskStatus: 'archived',
        executionWorkflowValid: false,
        slotResolvable: false,
      })
    ).toEqual({ action: 'reject_permanent', reason: 'task_archived' });
    expect(
      decideSpawnExecutionAdmissionViaPipeline({
        hasLiveIndexedSession: false,
        isSpawningExecution: false,
        taskStatus: 'in_progress',
        executionWorkflowValid: false,
        slotResolvable: false,
      })
    ).toEqual({ action: 'reject_permanent', reason: 'workflow_invalid' });
  });

  test('the pipeline decides synchronously', () => {
    let observed: unknown = 'unset';
    Promise.resolve().then(() => {
      observed = 'microtask ran first';
    });
    const decision = decideSpawnExecutionAdmissionViaPipeline(BASE);
    expect(decision).toEqual({ action: 'proceed_fresh' });
    expect(observed).toBe('unset');
  });
});
