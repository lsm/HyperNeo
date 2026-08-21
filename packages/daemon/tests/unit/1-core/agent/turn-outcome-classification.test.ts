import { describe, it, expect } from 'bun:test';
import {
  classifyTurnCompletion,
  decideReconcileAdmission,
  selectStrandedDeliveries,
  shouldRearmSpuriousTurnEnd,
} from '../../../../src/lib/agent/turn-outcome-classification';

describe('classifyTurnCompletion', () => {
  it('returns completed when producedResult is true', () => {
    const result = classifyTurnCompletion({
      producedResult: true,
      turnError: null,
      errorResultSubtype: null,
      deliveryTurnStalled: false,
      claimGuardHeld: true,
    });
    expect(result).toEqual({ outcome: 'completed' });
  });

  describe('detail precedence', () => {
    it('prefers turnError.userMessage over turnError.message and subtype text', () => {
      const result = classifyTurnCompletion({
        producedResult: false,
        turnError: {
          userMessage: 'User-facing message',
          message: 'Internal message',
          recoverable: true,
        },
        errorResultSubtype: 'error_during_execution',
        deliveryTurnStalled: true,
        claimGuardHeld: true,
      });
      if (result.outcome !== 'recoverable_error') {
        throw new Error(`expected recoverable_error, got ${result.outcome}`);
      }
      expect(result.detail).toBe('User-facing message');
      expect(result.reopenForRetry).toBe(true);
    });

    it('falls back to turnError.message when userMessage is absent', () => {
      const result = classifyTurnCompletion({
        producedResult: false,
        turnError: { message: 'Internal message', recoverable: true },
        errorResultSubtype: 'error_during_execution',
        deliveryTurnStalled: true,
        claimGuardHeld: true,
      });
      if (result.outcome !== 'recoverable_error') {
        throw new Error(`expected recoverable_error, got ${result.outcome}`);
      }
      expect(result.detail).toBe('Internal message');
    });

    it('falls back to errorResultSubtype text when turnError has no messages', () => {
      const result = classifyTurnCompletion({
        producedResult: false,
        turnError: { recoverable: true },
        errorResultSubtype: 'error_during_execution',
        deliveryTurnStalled: true,
        claimGuardHeld: true,
      });
      if (result.outcome !== 'recoverable_error') {
        throw new Error(`expected recoverable_error, got ${result.outcome}`);
      }
      expect(result.detail).toBe('Turn ended with a terminal error (error_during_execution)');
    });

    it('falls back to stalled text when there is no turnError or subtype', () => {
      const result = classifyTurnCompletion({
        producedResult: false,
        turnError: null,
        errorResultSubtype: null,
        deliveryTurnStalled: true,
        claimGuardHeld: true,
      });
      if (result.outcome !== 'recoverable_error') {
        throw new Error(`expected recoverable_error, got ${result.outcome}`);
      }
      expect(result.detail).toBe('No response from the model — resetting and retrying');
    });

    it('uses "Turn ended without a response" as the final fallback', () => {
      const result = classifyTurnCompletion({
        producedResult: false,
        turnError: null,
        errorResultSubtype: null,
        deliveryTurnStalled: false,
        claimGuardHeld: true,
      });
      if (result.outcome !== 'recoverable_error') {
        throw new Error(`expected recoverable_error, got ${result.outcome}`);
      }
      expect(result.detail).toBe('Turn ended without a response');
    });
  });

  describe('terminal vs recoverable for every error shape', () => {
    it('turn error with a terminal category is terminal', () => {
      const result = classifyTurnCompletion({
        producedResult: false,
        turnError: { message: 'Auth failed', category: 'authentication', recoverable: true },
        errorResultSubtype: null,
        deliveryTurnStalled: false,
        claimGuardHeld: true,
      });
      if (result.outcome !== 'terminal_error') {
        throw new Error(`expected terminal_error, got ${result.outcome}`);
      }
      expect(result.detail).toBe('Auth failed');
      expect(result.category).toBe('authentication');
    });

    it('turn error that is not recoverable is terminal regardless of category', () => {
      const result = classifyTurnCompletion({
        producedResult: false,
        turnError: { message: 'Permanent failure', category: 'unknown', recoverable: false },
        errorResultSubtype: null,
        deliveryTurnStalled: false,
        claimGuardHeld: true,
      });
      if (result.outcome !== 'terminal_error') {
        throw new Error(`expected terminal_error, got ${result.outcome}`);
      }
      expect(result.detail).toBe('Permanent failure');
      expect(result.category).toBe('unknown');
    });

    it('turn error that is recoverable and not in terminal category is recoverable', () => {
      const result = classifyTurnCompletion({
        producedResult: false,
        turnError: { message: 'Transient', category: 'timeout', recoverable: true },
        errorResultSubtype: null,
        deliveryTurnStalled: false,
        claimGuardHeld: true,
      });
      if (result.outcome !== 'recoverable_error') {
        throw new Error(`expected recoverable_error, got ${result.outcome}`);
      }
      expect(result.detail).toBe('Transient');
      expect(result.category).toBe('timeout');
      expect(result.reopenForRetry).toBe(true);
    });

    it('non-retryable errorResultSubtype with no turnError is terminal', () => {
      const result = classifyTurnCompletion({
        producedResult: false,
        turnError: null,
        errorResultSubtype: 'invalid_api_key',
        deliveryTurnStalled: false,
        claimGuardHeld: true,
      });
      if (result.outcome !== 'terminal_error') {
        throw new Error(`expected terminal_error, got ${result.outcome}`);
      }
      expect(result.detail).toBe('Turn ended with a terminal error (invalid_api_key)');
      expect(result.category).toBe('invalid_api_key');
    });

    it('retryable errorResultSubtype with no turnError is recoverable', () => {
      const result = classifyTurnCompletion({
        producedResult: false,
        turnError: null,
        errorResultSubtype: 'error_during_execution',
        deliveryTurnStalled: false,
        claimGuardHeld: true,
      });
      if (result.outcome !== 'recoverable_error') {
        throw new Error(`expected recoverable_error, got ${result.outcome}`);
      }
      expect(result.detail).toBe('Turn ended with a terminal error (error_during_execution)');
      expect(result.category).toBeUndefined();
      expect(result.reopenForRetry).toBe(true);
    });

    it('normalizes an absent claim guard to permitting reopen', () => {
      const result = classifyTurnCompletion({
        producedResult: false,
        turnError: null,
        errorResultSubtype: 'error_max_turns',
        deliveryTurnStalled: false,
      });
      if (result.outcome !== 'recoverable_error') {
        throw new Error(`expected recoverable_error, got ${result.outcome}`);
      }
      expect(result.detail).toBe('Turn ended with a terminal error (error_max_turns)');
      expect(result.reopenForRetry).toBe(true);
    });

    it('ignores a non-retryable errorResultSubtype when a recoverable turnError is present', () => {
      const result = classifyTurnCompletion({
        producedResult: false,
        turnError: { message: 'Transient', recoverable: true },
        errorResultSubtype: 'invalid_api_key',
        deliveryTurnStalled: false,
        claimGuardHeld: true,
      });
      if (result.outcome !== 'recoverable_error') {
        throw new Error(`expected recoverable_error, got ${result.outcome}`);
      }
      expect(result.detail).toBe('Transient');
      expect(result.category).toBeUndefined();
      expect(result.reopenForRetry).toBe(true);
    });
  });

  describe('claimGuard toggling reopenForRetry', () => {
    it('sets reopenForRetry to true when claimGuardHeld is true', () => {
      const result = classifyTurnCompletion({
        producedResult: false,
        turnError: null,
        errorResultSubtype: 'error_during_execution',
        deliveryTurnStalled: false,
        claimGuardHeld: true,
      });
      if (result.outcome !== 'recoverable_error') {
        throw new Error(`expected recoverable_error, got ${result.outcome}`);
      }
      expect(result.reopenForRetry).toBe(true);
    });

    it('sets reopenForRetry to false when claimGuardHeld is false', () => {
      const result = classifyTurnCompletion({
        producedResult: false,
        turnError: null,
        errorResultSubtype: 'error_during_execution',
        deliveryTurnStalled: false,
        claimGuardHeld: false,
      });
      if (result.outcome !== 'recoverable_error') {
        throw new Error(`expected recoverable_error, got ${result.outcome}`);
      }
      expect(result.reopenForRetry).toBe(false);
    });
  });
});

describe('shouldRearmSpuriousTurnEnd', () => {
  const base = {
    feedAcknowledged: true,
    turnEndFired: true,
    queryEnded: false,
    withinGraceMs: true,
    graceRearms: 0,
    hasTerminalResult: false,
  };

  it('re-arms when all conjuncts hold', () => {
    expect(shouldRearmSpuriousTurnEnd(base)).toBe(true);
  });

  it('does not re-arm when feedAcknowledged is false', () => {
    expect(shouldRearmSpuriousTurnEnd({ ...base, feedAcknowledged: false })).toBe(false);
  });

  it('does not re-arm when turnEndFired is false', () => {
    expect(shouldRearmSpuriousTurnEnd({ ...base, turnEndFired: false })).toBe(false);
  });

  it('does not re-arm when queryEnded is true', () => {
    expect(shouldRearmSpuriousTurnEnd({ ...base, queryEnded: true })).toBe(false);
  });

  it('does not re-arm when withinGraceMs is false', () => {
    expect(shouldRearmSpuriousTurnEnd({ ...base, withinGraceMs: false })).toBe(false);
  });

  it('does not re-arm when graceRearms has reached the cap', () => {
    expect(shouldRearmSpuriousTurnEnd({ ...base, graceRearms: 2 })).toBe(false);
    expect(shouldRearmSpuriousTurnEnd({ ...base, graceRearms: 3 })).toBe(false);
  });

  it('re-arms below the cap and stops at the cap', () => {
    expect(shouldRearmSpuriousTurnEnd({ ...base, graceRearms: 0 })).toBe(true);
    expect(shouldRearmSpuriousTurnEnd({ ...base, graceRearms: 1 })).toBe(true);
    expect(shouldRearmSpuriousTurnEnd({ ...base, graceRearms: 2 })).toBe(false);
  });

  it('does not re-arm when a terminal result is present', () => {
    expect(shouldRearmSpuriousTurnEnd({ ...base, hasTerminalResult: true })).toBe(false);
  });
});

describe('decideReconcileAdmission', () => {
  it('skips for processing, queued, and waiting_for_input', () => {
    expect(decideReconcileAdmission({ processingStatus: 'processing' })).toEqual({
      action: 'skip',
    });
    expect(decideReconcileAdmission({ processingStatus: 'queued' })).toEqual({ action: 'skip' });
    expect(decideReconcileAdmission({ processingStatus: 'waiting_for_input' })).toEqual({
      action: 'skip',
    });
  });

  it('runs for any other status', () => {
    expect(decideReconcileAdmission({ processingStatus: 'idle' })).toEqual({ action: 'run' });
    expect(decideReconcileAdmission({ processingStatus: 'archived' })).toEqual({ action: 'run' });
    expect(decideReconcileAdmission({ processingStatus: 'done' })).toEqual({ action: 'run' });
    expect(decideReconcileAdmission({ processingStatus: 'error' })).toEqual({ action: 'run' });
  });
});

describe('selectStrandedDeliveries', () => {
  it('returns uuid-bearing enqueued messages not in the active set', () => {
    const enqueued = [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }];
    const active = new Set(['b']);
    expect(selectStrandedDeliveries(enqueued, active)).toEqual(['a', 'c']);
  });

  it('excludes missing or empty uuids', () => {
    const enqueued: Array<{ uuid?: string }> = [
      {},
      { uuid: '' },
      { uuid: 'a' },
      { uuid: undefined },
    ];
    const active = new Set<string>();
    expect(selectStrandedDeliveries(enqueued, active)).toEqual(['a']);
  });

  it('excludes uuids in the active set', () => {
    const enqueued = [{ uuid: 'a' }, { uuid: 'b' }];
    const active = new Set(['a', 'b']);
    expect(selectStrandedDeliveries(enqueued, active)).toEqual([]);
  });

  it('preserves order and handles duplicates', () => {
    const enqueued = [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'a' }, { uuid: 'c' }];
    const active = new Set(['b']);
    expect(selectStrandedDeliveries(enqueued, active)).toEqual(['a', 'a', 'c']);
  });

  it('returns an empty array for empty input', () => {
    expect(selectStrandedDeliveries([], new Set())).toEqual([]);
  });

  it('excludes uuids matched by isInFlight', () => {
    const enqueued = [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }];
    const active = new Set<string>();
    const isInFlight = (uuid: string) => uuid === 'b';
    expect(selectStrandedDeliveries(enqueued, active, isInFlight)).toEqual(['a', 'c']);
  });

  it('works without isInFlight (two-arg call)', () => {
    const enqueued = [{ uuid: 'a' }, { uuid: 'b' }];
    const active = new Set<string>();
    expect(selectStrandedDeliveries(enqueued, active)).toEqual(['a', 'b']);
  });
});
