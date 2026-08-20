import { describe, expect, test } from 'bun:test';
import { decisionRun } from '../../../../src/lib/space/runtime/decision-pipeline';

type ProbeDecision = { action: 'stop' } | { action: 'pass' };

interface ProbeCtx {
  flag: boolean;
  decision: ProbeDecision | null;
}

function gate(ctx: ProbeCtx): ProbeCtx {
  return ctx.flag ? { ...ctx, decision: { action: 'stop' } } : ctx;
}

function unreachableGate(_ctx: ProbeCtx): ProbeCtx {
  throw new Error('gate after a decision must never run');
}

function fallbackGate(ctx: ProbeCtx): ProbeCtx {
  return { ...ctx, decision: { action: 'pass' } };
}

describe('decisionRun', () => {
  test('halts at the first gate that decides', () => {
    const run = decisionRun('probe-first-decides', [gate, unreachableGate]);
    expect(run({ flag: true })).toEqual({ flag: true, decision: { action: 'stop' } });
  });

  test('continues past gates that leave the ctx undecided', () => {
    const run = decisionRun('probe-pass-through', [gate, fallbackGate]);
    expect(run({ flag: false })).toEqual({ flag: false, decision: { action: 'pass' } });
  });

  test('returns the undecided ctx when no gate decides', () => {
    const run = decisionRun('probe-no-decision', [gate]);
    expect(run({ flag: false })).toEqual({ flag: false, decision: null });
  });
});
