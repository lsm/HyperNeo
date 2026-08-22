import { describe, expect, test } from 'bun:test';
import type { AgentProcessingState } from '@hyperneo/shared';
import {
  assembleVerifiedStopResult,
  decideStopVerification,
  inspectSessionLiveness,
  isStopDownProcessingStatus,
  type StopVerificationDecision,
  type StopVerificationSnapshot,
  VERIFIED_STOP_MAX_INTERRUPT_ATTEMPTS,
} from '../../../../src/lib/space/runtime/stop-verification-gates';

const STATUS_DOWN_ELIGIBILITY: Record<AgentProcessingState['status'], boolean> = {
  idle: true,
  interrupted: true,
  queued: false,
  processing: false,
  waiting_for_input: false,
  rate_limit_cooldown: false,
};

const ALL_PROCESSING_STATUSES = Object.keys(
  STATUS_DOWN_ELIGIBILITY
) as AgentProcessingState['status'][];

const NOT_DOWN_PROCESSING_STATUSES = ALL_PROCESSING_STATUSES.filter(
  (status) => !STATUS_DOWN_ELIGIBILITY[status]
);

function makeSnapshot(overrides: Partial<StopVerificationSnapshot> = {}): StopVerificationSnapshot {
  return {
    sessionPresent: true,
    processingStatus: 'processing',
    interruptInProgress: false,
    livePids: [],
    interruptAttemptsSoFar: 1,
    escalationDone: false,
    ...overrides,
  };
}

describe('isStopDownProcessingStatus', () => {
  test('accepts idle and interrupted as down-eligible statuses', () => {
    expect(isStopDownProcessingStatus('idle')).toBe(true);
    expect(isStopDownProcessingStatus('interrupted')).toBe(true);
  });

  test('rejects every other processing status', () => {
    for (const status of NOT_DOWN_PROCESSING_STATUSES) {
      expect(isStopDownProcessingStatus(status)).toBe(false);
    }
  });

  test('agrees with the exhaustive eligibility table for every status', () => {
    for (const status of ALL_PROCESSING_STATUSES) {
      expect(isStopDownProcessingStatus(status)).toBe(STATUS_DOWN_ELIGIBILITY[status]);
    }
  });
});

describe('inspectSessionLiveness', () => {
  test('reports down for a settled session with no live pids', () => {
    expect(
      inspectSessionLiveness({ processingStatus: 'idle', interruptInProgress: false, livePids: [] })
    ).toEqual({ down: true });
    expect(
      inspectSessionLiveness({
        processingStatus: 'interrupted',
        interruptInProgress: false,
        livePids: [],
      })
    ).toEqual({ down: true });
  });

  test('reports the processing state reason first', () => {
    for (const status of NOT_DOWN_PROCESSING_STATUSES) {
      expect(
        inspectSessionLiveness({
          processingStatus: status,
          interruptInProgress: true,
          livePids: [7],
        })
      ).toEqual({ down: false, reason: `processing state '${status}'` });
    }
  });

  test('reports the interrupt-in-progress reason before live pids', () => {
    expect(
      inspectSessionLiveness({ processingStatus: 'idle', interruptInProgress: true, livePids: [7] })
    ).toEqual({ down: false, reason: 'interrupt still in progress' });
  });

  test('reports live pids in order as the last not-down reason', () => {
    expect(
      inspectSessionLiveness({
        processingStatus: 'idle',
        interruptInProgress: false,
        livePids: [11],
      })
    ).toEqual({ down: false, reason: 'live SDK process pid(s) 11' });
    expect(
      inspectSessionLiveness({
        processingStatus: 'interrupted',
        interruptInProgress: false,
        livePids: [11, 22],
      })
    ).toEqual({ down: false, reason: 'live SDK process pid(s) 11, 22' });
  });
});

describe('decideStopVerification pinned decision table', () => {
  const cases: Array<{
    name: string;
    input: Partial<StopVerificationSnapshot>;
    expected: StopVerificationDecision;
  }> = [
    {
      name: 'missing session decides down regardless of every other gate',
      input: {
        sessionPresent: false,
        processingStatus: 'processing',
        interruptInProgress: true,
        livePids: [7],
        interruptAttemptsSoFar: 5,
        escalationDone: true,
      },
      expected: { action: 'down' },
    },
    {
      name: 'settled idle session decides down',
      input: { processingStatus: 'idle', interruptAttemptsSoFar: 1 },
      expected: { action: 'down' },
    },
    {
      name: 'settled interrupted session decides down',
      input: { processingStatus: 'interrupted', interruptAttemptsSoFar: 1 },
      expected: { action: 'down' },
    },
    {
      name: 'busy session with retry budget decides retry_interrupt',
      input: { processingStatus: 'processing', interruptAttemptsSoFar: 1 },
      expected: { action: 'retry_interrupt', reason: "processing state 'processing'" },
    },
    {
      name: 'interrupt in progress with retry budget decides retry_interrupt',
      input: { processingStatus: 'idle', interruptInProgress: true, interruptAttemptsSoFar: 1 },
      expected: { action: 'retry_interrupt', reason: 'interrupt still in progress' },
    },
    {
      name: 'live pids with retry budget decides retry_interrupt',
      input: { processingStatus: 'idle', livePids: [4242], interruptAttemptsSoFar: 1 },
      expected: { action: 'retry_interrupt', reason: 'live SDK process pid(s) 4242' },
    },
    {
      name: 'spent retry budget decides escalate_terminate',
      input: { processingStatus: 'processing', interruptAttemptsSoFar: 2, escalationDone: false },
      expected: { action: 'escalate_terminate', reason: "processing state 'processing'" },
    },
    {
      name: 'spent retry budget with a live pid decides escalate_terminate',
      input: { processingStatus: 'idle', livePids: [4242], interruptAttemptsSoFar: 2 },
      expected: { action: 'escalate_terminate', reason: 'live SDK process pid(s) 4242' },
    },
    {
      name: 'escalated session that is still busy decides report_leak',
      input: { processingStatus: 'processing', interruptAttemptsSoFar: 2, escalationDone: true },
      expected: { action: 'report_leak', reason: "processing state 'processing'" },
    },
    {
      name: 'escalated session with an interrupt in progress decides report_leak',
      input: {
        processingStatus: 'idle',
        interruptInProgress: true,
        interruptAttemptsSoFar: 2,
        escalationDone: true,
      },
      expected: { action: 'report_leak', reason: 'interrupt still in progress' },
    },
    {
      name: 'escalation marker alone does not outrank a remaining retry',
      input: { processingStatus: 'processing', interruptAttemptsSoFar: 1, escalationDone: true },
      expected: { action: 'retry_interrupt', reason: "processing state 'processing'" },
    },
  ];

  for (const { name, input, expected } of cases) {
    test(name, () => {
      expect(decideStopVerification(makeSnapshot(input))).toStrictEqual(expected);
    });
  }

  test('pins the retry budget at one initial interrupt plus one retry', () => {
    expect(VERIFIED_STOP_MAX_INTERRUPT_ATTEMPTS).toBe(2);
  });

  test('covers the full decision table across every input combination', () => {
    for (const sessionPresent of [false, true]) {
      for (const processingStatus of ALL_PROCESSING_STATUSES) {
        for (const interruptInProgress of [false, true]) {
          for (const livePids of [[], [11], [11, 22]]) {
            for (const interruptAttemptsSoFar of [0, 1, 2, 5]) {
              for (const escalationDone of [false, true]) {
                const snapshot = makeSnapshot({
                  sessionPresent,
                  processingStatus,
                  interruptInProgress,
                  livePids,
                  interruptAttemptsSoFar,
                  escalationDone,
                });
                const decision = decideStopVerification(snapshot);
                const statusDownEligible =
                  processingStatus === 'idle' || processingStatus === 'interrupted';
                const livenessDown =
                  statusDownEligible && !interruptInProgress && livePids.length === 0;
                if (!sessionPresent || livenessDown) {
                  expect(decision).toStrictEqual({ action: 'down' });
                  continue;
                }
                const expectedReason = !statusDownEligible
                  ? `processing state '${processingStatus}'`
                  : interruptInProgress
                    ? 'interrupt still in progress'
                    : `live SDK process pid(s) ${livePids.join(', ')}`;
                const expectedAction =
                  interruptAttemptsSoFar < VERIFIED_STOP_MAX_INTERRUPT_ATTEMPTS
                    ? 'retry_interrupt'
                    : escalationDone
                      ? 'report_leak'
                      : 'escalate_terminate';
                expect(decision).toStrictEqual({ action: expectedAction, reason: expectedReason });
              }
            }
          }
        }
      }
    }
  });
});

describe('decideStopVerification precedence', () => {
  test('down beats every downstream gate at any attempt count or escalation state', () => {
    for (const interruptAttemptsSoFar of [0, 1, 2, 5]) {
      for (const escalationDone of [false, true]) {
        for (const processingStatus of ['idle', 'interrupted'] as const) {
          expect(
            decideStopVerification(
              makeSnapshot({
                processingStatus,
                interruptInProgress: false,
                livePids: [],
                interruptAttemptsSoFar,
                escalationDone,
              })
            )
          ).toStrictEqual({ action: 'down' });
        }
      }
    }
  });

  test('the processing-state gate outranks the interrupt-in-progress gate', () => {
    const decision = decideStopVerification(
      makeSnapshot({ processingStatus: 'processing', interruptInProgress: true, livePids: [7] })
    );
    expect(decision).toStrictEqual({
      action: 'retry_interrupt',
      reason: "processing state 'processing'",
    });
  });

  test('the interrupt-in-progress gate outranks the live-pids gate', () => {
    const decision = decideStopVerification(
      makeSnapshot({ processingStatus: 'idle', interruptInProgress: true, livePids: [7] })
    );
    expect(decision).toStrictEqual({
      action: 'retry_interrupt',
      reason: 'interrupt still in progress',
    });
  });
});

describe('decideStopVerification pass-through identity', () => {
  test('repeated calls with the same snapshot return the identical decision', () => {
    const snapshot = makeSnapshot({
      processingStatus: 'idle',
      livePids: [],
      interruptAttemptsSoFar: 5,
    });
    expect(decideStopVerification(snapshot)).toStrictEqual(decideStopVerification(snapshot));
    const busy = makeSnapshot({
      processingStatus: 'processing',
      interruptAttemptsSoFar: 2,
      escalationDone: true,
    });
    expect(decideStopVerification(busy)).toStrictEqual(decideStopVerification(busy));
  });

  test('does not mutate the input snapshot', () => {
    const snapshot = makeSnapshot({ processingStatus: 'idle', livePids: [3, 4] });
    const before = JSON.stringify(snapshot);
    decideStopVerification(snapshot);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});

describe('assembleVerifiedStopResult', () => {
  test('omits the detail key for a clean down verdict', () => {
    const result = assembleVerifiedStopResult({
      sessionId: 'sess-1',
      notes: [],
      decision: { action: 'down' },
    });
    expect(result).toStrictEqual({ sessionId: 'sess-1', stopped: true });
    expect(Object.hasOwn(result, 'detail')).toBe(false);
  });

  test('passes the notes through verbatim and in order for a down verdict', () => {
    expect(
      assembleVerifiedStopResult({
        sessionId: 'sess-1',
        notes: ['interrupt failed: boom', 'first interrupt did not land; stopped on retry'],
        decision: { action: 'down' },
      })
    ).toStrictEqual({
      sessionId: 'sess-1',
      stopped: true,
      detail: 'interrupt failed: boom; first interrupt did not land; stopped on retry',
    });
  });

  test('appends the still-alive leak reason after the notes', () => {
    expect(
      assembleVerifiedStopResult({
        sessionId: 'sess-1',
        notes: ['escalated after verification failure (interrupt still in progress)'],
        decision: { action: 'report_leak', reason: 'interrupt still in progress' },
      })
    ).toStrictEqual({
      sessionId: 'sess-1',
      stopped: false,
      detail:
        'escalated after verification failure (interrupt still in progress); ' +
        'still alive: interrupt still in progress',
    });
  });

  test('reports a bare leak when no notes accumulated', () => {
    expect(
      assembleVerifiedStopResult({
        sessionId: 'sess-1',
        notes: [],
        decision: { action: 'report_leak', reason: "processing state 'processing'" },
      })
    ).toStrictEqual({
      sessionId: 'sess-1',
      stopped: false,
      detail: "still alive: processing state 'processing'",
    });
  });

  test('does not mutate the notes array', () => {
    const notes = ['a', 'b'];
    assembleVerifiedStopResult({ sessionId: 'sess-1', notes, decision: { action: 'down' } });
    expect(notes).toStrictEqual(['a', 'b']);
  });
});
