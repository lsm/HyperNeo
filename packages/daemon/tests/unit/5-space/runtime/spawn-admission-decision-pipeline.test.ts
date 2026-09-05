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
  return input;
}

describe('spawn admission decisionRun gates', () => {
  test('non-deciding gates return the ctx in a value arm', () => {
    const ctx = undecided(BASE);
    expect(applyLiveSessionGate(ctx)).toEqual({ value: ctx });
    expect(applyConcurrentSpawnGate(ctx)).toEqual({ value: ctx });
    expect(applyTaskStatusGate(ctx)).toEqual({ value: ctx });
    expect(applyWorkflowValidityGate(ctx)).toEqual({ value: ctx });
    expect(applySlotResolutionGate(ctx)).toEqual({ value: ctx });
  });

  test('applyProceedGate always decides proceed_fresh', () => {
    const ctx = undecided(BASE);
    expect(applyProceedGate(ctx)).toEqual({ reason: { action: 'proceed_fresh' } });
  });

  test('applyLiveSessionGate decides reuse_live on a live indexed session', () => {
    expect(applyLiveSessionGate(undecided({ ...BASE, hasLiveIndexedSession: true }))).toEqual({
      reason: { action: 'reuse_live' },
    });
  });

  test('applyConcurrentSpawnGate decides wait_concurrent on an in-flight spawn', () => {
    expect(applyConcurrentSpawnGate(undecided({ ...BASE, isSpawningExecution: true }))).toEqual({
      reason: { action: 'wait_concurrent' },
    });
  });

  test('applyTaskStatusGate maps each terminal and rate/usage status to its member', () => {
    expect(applyTaskStatusGate(undecided({ ...BASE, taskStatus: 'archived' }))).toEqual({
      reason: { action: 'reject_permanent', reason: 'task_archived' },
    });
    expect(applyTaskStatusGate(undecided({ ...BASE, taskStatus: 'cancelled' }))).toEqual({
      reason: { action: 'reject_permanent', reason: 'task_cancelled' },
    });
    expect(applyTaskStatusGate(undecided({ ...BASE, taskStatus: 'rate_limited' }))).toEqual({
      reason: { action: 'reject_transient', reason: 'task_rate_or_usage_limited' },
    });
    expect(applyTaskStatusGate(undecided({ ...BASE, taskStatus: 'usage_limited' }))).toEqual({
      reason: { action: 'reject_transient', reason: 'task_rate_or_usage_limited' },
    });
    expect(applyTaskStatusGate(undecided({ ...BASE, taskStatus: 'stopped' }))).toEqual({
      value: { ...BASE, taskStatus: 'stopped' },
    });
  });

  test('applyWorkflowValidityGate and applySlotResolutionGate decide their permanent rejects', () => {
    expect(
      applyWorkflowValidityGate(undecided({ ...BASE, executionWorkflowValid: false }))
    ).toEqual({ reason: { action: 'reject_permanent', reason: 'workflow_invalid' } });
    expect(applySlotResolutionGate(undecided({ ...BASE, slotResolvable: false }))).toEqual({
      reason: { action: 'reject_permanent', reason: 'slot_unresolvable' },
    });
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
