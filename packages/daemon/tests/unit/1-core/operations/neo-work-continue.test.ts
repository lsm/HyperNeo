import { describe, expect, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  neoContinuedReport,
  requireNeoAskContinueReserved,
  requireNeoContinueDelivered,
  requireNeoWorkContinuable,
  requireNeoWorkStillContinuable,
} from '../../../../src/lib/neo/continue-work.ts';

const HOUR = 60 * 60 * 1000;
const ref = { adapter: 'claude-desktop', daemon: 'laptop', id: 'local_ios' };

describe('requireNeoAskContinueReserved', () => {
  test('refuses a continue the shared budget could not reserve', () => {
    expect(requireNeoAskContinueReserved({ ask: null, ok: true })).toEqual({
      value: { ask: null, ok: true },
    });
    expect(requireNeoAskContinueReserved({ ask: null, ok: false })).toMatchObject({
      reason: { ok: false, reason: expect.stringContaining('no longer approved') },
    });
  });
});

const continued: NeoWork = Object.freeze({
  id: 'work-1',
  requestKey: 'root:k',
  originSessionId: 'root',
  originMessageId: 'm1',
  projectId: null,
  title: 'Font',
  instruction: 'Raise the font.',
  targetSessionId: null,
  sessionId: null,
  status: 'reported',
  report: 'Done.',
  createdAt: 0,
  updatedAt: 0,
});
const rejected = (reason: string) => ({ reason: { ok: false as const, reason } });

describe('requireNeoWorkContinuable', () => {
  const turn = { guarded: true, human: false, doneWhenMet: false, prs: [], wake: null };
  const evidence = { work: continued, ref, turn, inFlight: false, ask: null };

  test('admits started work that is queued or reported', () => {
    expect(requireNeoWorkContinuable(evidence, HOUR)).toEqual({
      value: { work: continued, ref, human: false },
    });
  });

  test.each([
    ['unstarted work', { ...evidence, ref: null }, 'Only started driver work can be continued.'],
    ['missing work', { ...evidence, work: null }, 'Only started driver work can be continued.'],
    [
      'failed work',
      { ...evidence, work: { ...continued, status: 'failed' as const } },
      'This work already failed; it cannot be continued.',
    ],
    [
      'an in-flight continue',
      { ...evidence, inFlight: true },
      'This work is already being continued; wait for that first.',
    ],
  ])('rejects %s', (_name, input, reason) => {
    expect(requireNeoWorkContinuable(input, HOUR)).toEqual(rejected(reason));
  });

  test('in-flight protection holds regardless of historical stall counts', () => {
    expect(
      requireNeoWorkContinuable(
        {
          ...evidence,
          turn: { ...turn, wake: { wakes: 4, continuedWake: null, stalled: 3 } },
          inFlight: true,
        },
        HOUR
      )
    ).toMatchObject({ reason: { reason: expect.stringContaining('already being continued') } });
  });
});

describe('requireNeoContinueDelivered', () => {
  const target = { work: continued, ref, human: false };

  test('a delivered or queued send passes and a failed one rejects with the driver reason', () => {
    expect(
      requireNeoContinueDelivered(target, {
        kind: 'completed',
        value: { ok: true, value: { delivered: true } },
      })
    ).toEqual({ value: { ref } });
    expect(
      requireNeoContinueDelivered(target, {
        kind: 'completed',
        value: { ok: true, value: { delivered: false } },
      })
    ).toEqual({ value: { ref, queued: true } });
    expect(
      requireNeoContinueDelivered(target, {
        kind: 'failed',
        code: 'execution_failed',
        message: 'offline',
      })
    ).toEqual(rejected('offline'));
  });
});

describe('requireNeoWorkStillContinuable', () => {
  test('work cancelled while the message was in flight stays cancelled', () => {
    expect(requireNeoWorkStillContinuable({ work: continued })).toEqual({ value: continued });
    expect(requireNeoWorkStillContinuable({ work: { ...continued, status: 'cancelled' } })).toEqual(
      rejected('The message was sent, but this work was cancelled meanwhile; it stays cancelled.')
    );
  });
});

describe('neoContinuedReport', () => {
  test('counts the continue and keeps the message short', () => {
    expect(neoContinuedReport(2, 'Also fix the footer.')).toBe('Continued 2: Also fix the footer.');
    expect(neoContinuedReport(1, 'x'.repeat(400))).toHaveLength('Continued 1: '.length + 300);
  });
});
