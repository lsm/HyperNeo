import { describe, expect, test } from 'bun:test';
import {
  decideRunTickAdmission,
  type RunTickAdmissionDecision,
  type RunTickAdmissionInput,
} from '../../../../src/lib/space/runtime/run-tick-admission-gates';
import {
  applyBlockedExecutionsGate,
  applyCanonicalTaskGate,
  applyExecutionsPresentGate,
  applyExecutorMetaGate,
  applyFinishedRunGate,
  applyMissingRunGate,
  applyProceedGate,
  applyRateLimitGate,
  applyRunTasksGate,
  applySlotAvailabilityGate,
  applyTaskStoppedGate,
  applyWaitingRunGate,
  applyWorkflowValidityGate,
  decideRunTickAdmissionViaPipeline,
  type RunTickDecisionCtx,
} from '../../../../src/lib/space/runtime/run-tick-decision-pipeline';

function makeInput(overrides: Partial<RunTickAdmissionInput> = {}): RunTickAdmissionInput {
  return {
    runStatus: 'in_progress',
    hasExecutorMeta: true,
    runTaskCount: 1,
    hasCanonicalTask: true,
    hasEndNodeId: true,
    canonicalTaskStatus: 'in_progress',
    executionCount: 1,
    runIsComplete: false,
    hasBlockedExecution: false,
    firstBlockedResult: null,
    availableTaskSlots: 1,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<RunTickAdmissionInput> = {}): RunTickDecisionCtx {
  return { ...makeInput(overrides), decision: null };
}

describe('run-tick admission decision pipeline', () => {
  const cases: Array<{
    name: string;
    input: Partial<RunTickAdmissionInput>;
    expected: RunTickAdmissionDecision;
  }> = [
    {
      name: 'skips a missing run',
      input: { runStatus: null },
      expected: { action: 'skip', reason: 'missing_run' },
    },
    {
      name: 'clears a cancelled run',
      input: { runStatus: 'cancelled' },
      expected: { action: 'clearFinishedRun' },
    },
    {
      name: 'clears a succeeded run',
      input: { runStatus: 'done' },
      expected: { action: 'clearFinishedRun' },
    },
    {
      name: 'recovers a waiting run',
      input: { runStatus: 'blocked' },
      expected: { action: 'recoverWaitingRun' },
    },
    {
      name: 'skips without executor metadata',
      input: { hasExecutorMeta: false },
      expected: { action: 'skip', reason: 'no_executor_meta' },
    },
    {
      name: 'skips without run tasks',
      input: { runTaskCount: 0 },
      expected: { action: 'skip', reason: 'no_run_tasks' },
    },
    {
      name: 'skips without a canonical task',
      input: { hasCanonicalTask: false },
      expected: { action: 'skip', reason: 'no_canonical_task' },
    },
    {
      name: 'blocks a workflow without an end node',
      input: { hasEndNodeId: false },
      expected: { action: 'blockInvalidWorkflow' },
    },
    {
      name: 'skips a rate-limited task',
      input: { canonicalTaskStatus: 'rate_limited' },
      expected: { action: 'skip', reason: 'rate_or_usage_limited' },
    },
    {
      name: 'skips a usage-limited task',
      input: { canonicalTaskStatus: 'usage_limited' },
      expected: { action: 'skip', reason: 'rate_or_usage_limited' },
    },
    {
      name: 'skips a stopped task',
      input: { canonicalTaskStatus: 'stopped' },
      expected: { action: 'skip', reason: 'task_stopped' },
    },
    {
      name: 'skips without executions',
      input: { executionCount: 0 },
      expected: { action: 'skip', reason: 'no_executions' },
    },
    {
      name: 'blocks on a blocked execution',
      input: { hasBlockedExecution: true, firstBlockedResult: 'Needs review' },
      expected: { action: 'blockOnBlockedExecutions', blockedReason: 'Needs review' },
    },
    {
      name: 'uses the default blocked reason',
      input: { hasBlockedExecution: true },
      expected: {
        action: 'blockOnBlockedExecutions',
        blockedReason: 'One or more workflow agents are blocked',
      },
    },
    {
      name: 'defers an open task without slots',
      input: { canonicalTaskStatus: 'open', availableTaskSlots: 0 },
      expected: { action: 'deferNoAvailableSlots' },
    },
    {
      name: 'proceeds otherwise',
      input: {},
      expected: { action: 'proceed' },
    },
  ];

  for (const { name, input, expected } of cases) {
    test(name, () => {
      expect(decideRunTickAdmissionViaPipeline(makeInput(input))).toEqual(expected);
    });
  }

  describe('gate precedence — first decision wins', () => {
    test('missing run beats finished-run recovery and every downstream gate', () => {
      expect(
        decideRunTickAdmissionViaPipeline(
          makeInput({
            runStatus: null,
            hasExecutorMeta: false,
            runTaskCount: 0,
            hasBlockedExecution: true,
            availableTaskSlots: 0,
          })
        )
      ).toEqual({ action: 'skip', reason: 'missing_run' });
    });

    test('finished run beats waiting recovery and metadata checks', () => {
      expect(
        decideRunTickAdmissionViaPipeline(
          makeInput({
            runStatus: 'done',
            hasExecutorMeta: false,
            runTaskCount: 0,
            hasCanonicalTask: false,
            hasEndNodeId: false,
            canonicalTaskStatus: 'stopped',
            executionCount: 0,
            hasBlockedExecution: true,
            availableTaskSlots: 0,
          })
        )
      ).toEqual({ action: 'clearFinishedRun' });
    });

    test('waiting run beats metadata checks', () => {
      expect(
        decideRunTickAdmissionViaPipeline(
          makeInput({
            runStatus: 'blocked',
            hasExecutorMeta: false,
            runTaskCount: 0,
            hasCanonicalTask: false,
          })
        )
      ).toEqual({ action: 'recoverWaitingRun' });
    });

    test('executor metadata beats run tasks and canonical task gates', () => {
      expect(
        decideRunTickAdmissionViaPipeline(
          makeInput({ hasExecutorMeta: false, runTaskCount: 0, hasCanonicalTask: false })
        )
      ).toEqual({ action: 'skip', reason: 'no_executor_meta' });
    });

    test('run tasks gate beats canonical task gate', () => {
      expect(
        decideRunTickAdmissionViaPipeline(makeInput({ runTaskCount: 0, hasCanonicalTask: false }))
      ).toEqual({ action: 'skip', reason: 'no_run_tasks' });
    });

    test('canonical task gate beats workflow validity', () => {
      expect(
        decideRunTickAdmissionViaPipeline(
          makeInput({ hasCanonicalTask: false, hasEndNodeId: false })
        )
      ).toEqual({ action: 'skip', reason: 'no_canonical_task' });
    });

    test('workflow validity beats rate limiting', () => {
      expect(
        decideRunTickAdmissionViaPipeline(
          makeInput({ hasEndNodeId: false, canonicalTaskStatus: 'rate_limited' })
        )
      ).toEqual({ action: 'blockInvalidWorkflow' });
    });

    test('rate limiting beats task stopped and executions presence', () => {
      expect(
        decideRunTickAdmissionViaPipeline(
          makeInput({ canonicalTaskStatus: 'rate_limited', executionCount: 0 })
        )
      ).toEqual({ action: 'skip', reason: 'rate_or_usage_limited' });
    });

    test('task stopped beats executions presence', () => {
      expect(
        decideRunTickAdmissionViaPipeline(
          makeInput({ canonicalTaskStatus: 'stopped', executionCount: 0 })
        )
      ).toEqual({ action: 'skip', reason: 'task_stopped' });
    });

    test('blocked execution beats the slot gate', () => {
      expect(
        decideRunTickAdmissionViaPipeline(
          makeInput({
            canonicalTaskStatus: 'open',
            hasBlockedExecution: true,
            firstBlockedResult: 'Agent blocked',
            availableTaskSlots: 0,
          })
        )
      ).toEqual({ action: 'blockOnBlockedExecutions', blockedReason: 'Agent blocked' });
    });

    test('completed run ignores blocked executions', () => {
      expect(
        decideRunTickAdmissionViaPipeline(
          makeInput({ runIsComplete: true, hasBlockedExecution: true })
        )
      ).toEqual({ action: 'proceed' });
    });

    test('slot gate only applies to open tasks', () => {
      expect(
        decideRunTickAdmissionViaPipeline(
          makeInput({ canonicalTaskStatus: 'in_progress', availableTaskSlots: 0 })
        )
      ).toEqual({ action: 'proceed' });
    });
  });

  describe('gate pass-through contract', () => {
    test('gates with a no-op branch leave ctx untouched when not firing', () => {
      const noOpCases: Array<
        [(ctx: RunTickDecisionCtx) => RunTickDecisionCtx, Partial<RunTickAdmissionInput>]
      > = [
        [applyMissingRunGate, { runStatus: 'in_progress' }],
        [applyFinishedRunGate, { runStatus: 'in_progress' }],
        [applyWaitingRunGate, { runStatus: 'in_progress' }],
        [applyExecutorMetaGate, {}],
        [applyRunTasksGate, {}],
        [applyCanonicalTaskGate, {}],
        [applyWorkflowValidityGate, {}],
        [applyRateLimitGate, { canonicalTaskStatus: 'in_progress' }],
        [applyRateLimitGate, { canonicalTaskStatus: null }],
        [applyTaskStoppedGate, { canonicalTaskStatus: 'in_progress' }],
        [applyExecutionsPresentGate, {}],
        [applyBlockedExecutionsGate, { hasBlockedExecution: false }],
        [applyBlockedExecutionsGate, { runIsComplete: true, hasBlockedExecution: true }],
        [applySlotAvailabilityGate, { canonicalTaskStatus: 'in_progress', availableTaskSlots: 0 }],
        [applySlotAvailabilityGate, { canonicalTaskStatus: 'open', availableTaskSlots: 1 }],
      ];
      for (const [gate, overrides] of noOpCases) {
        const ctx = makeCtx(overrides);
        expect(gate(ctx)).toBe(ctx);
      }
    });

    test('proceed gate is the final arbiter and always decides', () => {
      expect(applyProceedGate(makeCtx({})).decision).not.toBeNull();
      expect(applyProceedGate(makeCtx({})).decision).toEqual({ action: 'proceed' });
      expect(
        applyProceedGate(makeCtx({ executionCount: 0, hasBlockedExecution: true })).decision
      ).toEqual({ action: 'proceed' });
    });
  });

  describe('parity with decideRunTickAdmission', () => {
    for (const { name, input } of cases) {
      test(`matches decideRunTickAdmission when it ${name}`, () => {
        expect(decideRunTickAdmissionViaPipeline(makeInput(input))).toEqual(
          decideRunTickAdmission(makeInput(input))
        );
      });
    }
  });
});
