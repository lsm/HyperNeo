import { describe, expect, test } from 'bun:test';
import {
  applyBodyNonemptyGate,
  applyEligibilityGate,
  applyIndexGate,
  applySearchableTypeGate,
  applySupersededGate,
  applyUserStatusGate,
  decideMessageSearchAdmission,
  isMessageSearchIndexEligible,
  isOlderThanMessageSearchTtl,
  type MessageSearchAdmissionCtx,
  type MessageSearchAdmissionInput,
  type MessageSearchEligibilityRow,
} from '../../../../src/storage/repositories/message-search-admission';

const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_MS = 30 * DAY_MS;
const NOW = 1_700_000_000_000;

function eligibleRow(
  overrides: Partial<MessageSearchEligibilityRow> = {}
): MessageSearchEligibilityRow {
  return {
    session_id: 'session-1',
    session_status: 'active',
    session_type: null,
    session_last_active_at: null,
    session_room_id: null,
    task_status: null,
    task_completed_at: null,
    task_updated_at: null,
    ...overrides,
  };
}

function admittingInput(
  overrides: Partial<MessageSearchAdmissionInput> = {}
): MessageSearchAdmissionInput {
  return {
    messageType: 'user',
    body: 'searchable body',
    now: NOW,
    eligibility: eligibleRow(),
    isSuperseded: false,
    isSearchableUserStatus: true,
    ...overrides,
  };
}

describe('decideMessageSearchAdmission', () => {
  test('indexes when every gate passes', () => {
    expect(decideMessageSearchAdmission(admittingInput())).toEqual({ action: 'index' });
  });

  test('superseded wins over every later gate', () => {
    const decision = decideMessageSearchAdmission(
      admittingInput({
        messageType: 'result',
        body: '',
        eligibility: eligibleRow({ session_id: 'room:chat:room-1', session_status: 'archived' }),
        isSuperseded: true,
        isSearchableUserStatus: false,
      })
    );
    expect(decision).toEqual({ action: 'skip', reason: 'superseded' });
  });

  test('searchable-type wins over eligibility, body, and user-status', () => {
    const decision = decideMessageSearchAdmission(
      admittingInput({
        messageType: 'result',
        body: '',
        eligibility: eligibleRow({ session_status: 'archived' }),
        isSearchableUserStatus: false,
      })
    );
    expect(decision).toEqual({ action: 'skip', reason: 'non_searchable_type' });
  });

  test('eligibility wins over body and user-status', () => {
    const decision = decideMessageSearchAdmission(
      admittingInput({
        body: '',
        eligibility: eligibleRow({ session_status: 'archived' }),
        isSearchableUserStatus: false,
      })
    );
    expect(decision).toEqual({ action: 'skip', reason: 'ineligible' });
  });

  test('body-nonempty wins over user-status', () => {
    const decision = decideMessageSearchAdmission(
      admittingInput({ body: '', isSearchableUserStatus: false })
    );
    expect(decision).toEqual({ action: 'skip', reason: 'empty_body' });
  });

  test('user-status decides last for user rows', () => {
    const decision = decideMessageSearchAdmission(
      admittingInput({ isSearchableUserStatus: false })
    );
    expect(decision).toEqual({ action: 'skip', reason: 'user_status_not_searchable' });
  });

  test('consults the superseded fact first and the user-status fact last', () => {
    const calls: string[] = [];
    const decision = decideMessageSearchAdmission(
      admittingInput({
        isSuperseded: () => {
          calls.push('superseded');
          return false;
        },
        isSearchableUserStatus: () => {
          calls.push('user-status');
          return true;
        },
      })
    );
    expect(decision).toEqual({ action: 'index' });
    expect(calls).toEqual(['superseded', 'user-status']);
  });

  test('does not consult the user-status fact when an earlier gate skips', () => {
    const calls: string[] = [];
    const decision = decideMessageSearchAdmission(
      admittingInput({
        messageType: 'result',
        isSuperseded: false,
        isSearchableUserStatus: () => {
          calls.push('user-status');
          return false;
        },
      })
    );
    expect(decision).toEqual({ action: 'skip', reason: 'non_searchable_type' });
    expect(calls).toEqual([]);
  });

  test('skips the user-status fact entirely for non-user rows that pass earlier gates', () => {
    const decision = decideMessageSearchAdmission(
      admittingInput({
        messageType: 'assistant',
        isSearchableUserStatus: () => {
          throw new Error('user-status fact must not be consulted for assistant rows');
        },
      })
    );
    expect(decision).toEqual({ action: 'index' });
  });

  test('evaluates ended-session retention against the injected now', () => {
    const oldActiveAt = new Date(NOW - TTL_MS - DAY_MS).toISOString();
    const endedRow = eligibleRow({
      session_status: 'ended',
      session_last_active_at: oldActiveAt,
    });

    expect(decideMessageSearchAdmission(admittingInput({ eligibility: endedRow }))).toEqual({
      action: 'skip',
      reason: 'ineligible',
    });

    expect(
      decideMessageSearchAdmission(admittingInput({ eligibility: endedRow, now: NOW - 2 * DAY_MS }))
    ).toEqual({ action: 'index' });
  });
});

describe('isOlderThanMessageSearchTtl', () => {
  test('keeps a value exactly at the cutoff', () => {
    expect(isOlderThanMessageSearchTtl(NOW - TTL_MS, NOW)).toBe(false);
  });

  test('rejects a value one millisecond past the cutoff', () => {
    expect(isOlderThanMessageSearchTtl(NOW - TTL_MS - 1, NOW)).toBe(true);
  });

  test('parses ISO strings and numeric timestamps identically', () => {
    const timestamp = NOW - TTL_MS - DAY_MS;
    expect(isOlderThanMessageSearchTtl(new Date(timestamp).toISOString(), NOW)).toBe(true);
    expect(isOlderThanMessageSearchTtl(timestamp, NOW)).toBe(true);
  });

  test('keeps null, undefined, and unparseable values', () => {
    expect(isOlderThanMessageSearchTtl(null, NOW)).toBe(false);
    expect(isOlderThanMessageSearchTtl(undefined, NOW)).toBe(false);
    expect(isOlderThanMessageSearchTtl('not-a-date', NOW)).toBe(false);
  });

  test('uses the injected now, not the wall clock', () => {
    const timestamp = Date.now() - TTL_MS - DAY_MS;
    expect(isOlderThanMessageSearchTtl(timestamp, timestamp + TTL_MS)).toBe(false);
    expect(isOlderThanMessageSearchTtl(timestamp, timestamp + TTL_MS + 1)).toBe(true);
  });
});

describe('isMessageSearchIndexEligible', () => {
  test('admits a plain session with no policy signals', () => {
    expect(isMessageSearchIndexEligible(eligibleRow(), NOW)).toBe(true);
  });

  test('rejects room-prefixed session ids before any status check', () => {
    expect(isMessageSearchIndexEligible(eligibleRow({ session_id: 'room:chat:room-1' }), NOW)).toBe(
      false
    );
  });

  test('rejects terminal space tasks past the injected cutoff via updated_at fallback', () => {
    const row = eligibleRow({
      session_id: 'space:space-1:task:task-1:exec:exec-1',
      task_status: 'done',
      task_completed_at: null,
      task_updated_at: NOW - TTL_MS - DAY_MS,
    });
    expect(isMessageSearchIndexEligible(row, NOW)).toBe(false);
    expect(isMessageSearchIndexEligible(row, NOW - 2 * DAY_MS)).toBe(true);
  });
});

describe('gate pass-through identity (ADR 0004 Decision item 6b)', () => {
  function gateCtx(overrides: Partial<MessageSearchAdmissionCtx> = {}): MessageSearchAdmissionCtx {
    return {
      messageType: 'user',
      body: 'searchable body',
      now: NOW,
      eligibility: eligibleRow(),
      isSuperseded: false,
      isSearchableUserStatus: true,
      decision: null,
      ...overrides,
    };
  }

  test('passing gates return the ctx unchanged by reference', () => {
    const passingGates = [
      applySupersededGate,
      applySearchableTypeGate,
      applyEligibilityGate,
      applyBodyNonemptyGate,
      applyUserStatusGate,
    ];
    for (const gate of passingGates) {
      const ctx = gateCtx();
      expect(gate(ctx)).toBe(ctx);
    }
  });

  test('each deciding gate stamps its skip reason on a copied ctx', () => {
    const superseded = gateCtx({ isSuperseded: true });
    expect(applySupersededGate(superseded)).toEqual({
      ...superseded,
      decision: { action: 'skip', reason: 'superseded' },
    });
    const nonSearchable = gateCtx({ messageType: 'result' });
    expect(applySearchableTypeGate(nonSearchable)).toEqual({
      ...nonSearchable,
      decision: { action: 'skip', reason: 'non_searchable_type' },
    });
    const ineligible = gateCtx({ eligibility: eligibleRow({ session_status: 'archived' }) });
    expect(applyEligibilityGate(ineligible)).toEqual({
      ...ineligible,
      decision: { action: 'skip', reason: 'ineligible' },
    });
    const emptyBody = gateCtx({ body: '' });
    expect(applyBodyNonemptyGate(emptyBody)).toEqual({
      ...emptyBody,
      decision: { action: 'skip', reason: 'empty_body' },
    });
    const unsearchableStatus = gateCtx({ isSearchableUserStatus: false });
    expect(applyUserStatusGate(unsearchableStatus)).toEqual({
      ...unsearchableStatus,
      decision: { action: 'skip', reason: 'user_status_not_searchable' },
    });
  });

  test('the index gate always decides', () => {
    const ctx = gateCtx();
    expect(applyIndexGate(ctx)).toEqual({ ...ctx, decision: { action: 'index' } });
  });
});
