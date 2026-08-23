import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import {
  classifyProviderFailure,
  classifyProviderFailureMessage,
  clearProviderFailure,
  getAllProviderFailures,
  getProviderFailure,
  recordProviderFailure,
  removeProviderFailure,
  resetProviderFailureStore,
  subscribeProviderFailureChanges,
  type ProviderFailureChange,
} from '../../../../src/lib/providers/provider-failure-store';

const T0 = new Date('2026-01-01T00:00:00Z').getTime();

describe('provider failure classification', () => {
  it('classifies probe 401/403 rejections as credential', () => {
    expect(classifyProviderFailureMessage('Z.ai API key rejected (HTTP 401)')).toBe('credential');
    expect(classifyProviderFailureMessage('Z.ai API key rejected (HTTP 403)')).toBe('credential');
    expect(classifyProviderFailureMessage('Codex credentials rejected (HTTP 401)')).toBe(
      'credential'
    );
  });

  it('classifies probe 5xx responses as transient', () => {
    expect(classifyProviderFailureMessage('Z.ai probe failed (HTTP 500)')).toBe('transient');
    expect(classifyProviderFailureMessage('Z.ai probe failed (HTTP 502)')).toBe('transient');
    expect(classifyProviderFailureMessage('Z.ai probe failed (HTTP 503)')).toBe('transient');
    expect(classifyProviderFailureMessage('Codex probe failed (HTTP 529)')).toBe('transient');
  });

  it('classifies rate-limit responses as transient', () => {
    expect(classifyProviderFailureMessage('Z.ai probe failed (HTTP 429)')).toBe('transient');
  });

  it('classifies probe timeouts as transient', () => {
    expect(classifyProviderFailureMessage('Z.ai probe timed out after 5000ms')).toBe('transient');
    expect(classifyProviderFailureMessage('Codex probe timed out after 8000ms')).toBe('transient');
  });

  it('classifies network-level probe failures as transient', () => {
    expect(classifyProviderFailureMessage('Z.ai probe failed: fetch failed')).toBe('transient');
    expect(classifyProviderFailureMessage('Codex probe failed: ECONNREFUSED')).toBe('transient');
  });

  it('classifies ACP command parse errors as credential', () => {
    expect(classifyProviderFailureMessage('Invalid ACP command: unmatched quote')).toBe(
      'credential'
    );
    expect(classifyProviderFailureMessage('Invalid ACP command: command is empty')).toBe(
      'credential'
    );
    expect(classifyProviderFailureMessage('HYPERNEO_ACP_COMMAND not set')).toBe('credential');
  });

  it('classifies ACP spawn and protocol errors as credential', () => {
    expect(classifyProviderFailureMessage('ACP agent process error: spawn foo ENOENT')).toBe(
      'credential'
    );
    expect(
      classifyProviderFailureMessage(
        'Unsupported ACP protocol version: agent returned 2, client requested 1'
      )
    ).toBe('credential');
  });

  it('classifies ACP timeouts, crashes, and agent-side initialize errors as transient', () => {
    expect(classifyProviderFailureMessage('Request timed out after 10000ms: initialize')).toBe(
      'transient'
    );
    expect(classifyProviderFailureMessage('ACP agent process exited')).toBe('transient');
    expect(classifyProviderFailureMessage('Initialize failed: agent overloaded')).toBe('transient');
  });

  it('defaults unclassified errors to transient', () => {
    expect(classifyProviderFailureMessage('something unexpected happened')).toBe('transient');
  });

  it('extracts the message from thrown errors and non-error values', () => {
    expect(classifyProviderFailure(new Error('Z.ai API key rejected (HTTP 401)'))).toEqual({
      errorKind: 'credential',
      message: 'Z.ai API key rejected (HTTP 401)',
    });
    expect(classifyProviderFailure('plain string failure')).toEqual({
      errorKind: 'transient',
      message: 'plain string failure',
    });
  });
});

describe('provider failure store', () => {
  beforeEach(() => {
    resetProviderFailureStore();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('records a failure with timestamps and reports it', () => {
    const before = Date.now();
    const record = recordProviderFailure('glm', new Error('Z.ai probe failed (HTTP 503)'));

    expect(record.errorKind).toBe('transient');
    expect(record.providerId).toBe('glm');
    expect(record.message).toBe('Z.ai probe failed (HTTP 503)');
    expect(record.firstRecordedAt).toBeGreaterThanOrEqual(before);
    expect(record.lastRecordedAt).toBeGreaterThanOrEqual(before);
    expect(getProviderFailure('glm')).toEqual(record);
    expect(getAllProviderFailures()).toEqual([record]);
  });

  it('keeps the first-recorded timestamp when the same kind is re-recorded', () => {
    const first = recordProviderFailure('glm', new Error('Z.ai probe failed (HTTP 503)'));
    const second = recordProviderFailure('glm', new Error('Z.ai probe failed (HTTP 500)'));

    expect(second.errorKind).toBe('transient');
    expect(second.firstRecordedAt).toBe(first.firstRecordedAt);
    expect(second.lastRecordedAt).toBeGreaterThanOrEqual(first.lastRecordedAt);
    expect(second.message).toBe('Z.ai probe failed (HTTP 500)');
  });

  it('resets the first-recorded timestamp when the failure kind changes', () => {
    jest.setSystemTime(T0);
    const transient = recordProviderFailure('glm', new Error('Z.ai probe failed (HTTP 503)'));
    jest.setSystemTime(T0 + 10_000);
    const credential = recordProviderFailure('glm', new Error('Z.ai API key rejected (HTTP 401)'));

    expect(transient.firstRecordedAt).toBe(T0);
    expect(credential.errorKind).toBe('credential');
    expect(credential.firstRecordedAt).toBe(T0 + 10_000);
    expect(getProviderFailure('glm')?.errorKind).toBe('credential');
  });

  it('notifies listeners on first record but not on same-kind re-record', () => {
    const changes: ProviderFailureChange[] = [];
    subscribeProviderFailureChanges((change) => changes.push(change));

    recordProviderFailure('glm', new Error('Z.ai probe failed (HTTP 503)'));
    recordProviderFailure('glm', new Error('Z.ai probe failed (HTTP 500)'));

    expect(changes).toHaveLength(1);
    expect(changes[0]?.providerId).toBe('glm');
    expect(changes[0]?.record?.errorKind).toBe('transient');
  });

  it('notifies listeners when the failure kind changes', () => {
    const changes: ProviderFailureChange[] = [];
    subscribeProviderFailureChanges((change) => changes.push(change));

    recordProviderFailure('glm', new Error('Z.ai probe failed (HTTP 503)'));
    recordProviderFailure('glm', new Error('Z.ai API key rejected (HTTP 401)'));

    expect(changes).toHaveLength(2);
    expect(changes[1]?.record?.errorKind).toBe('credential');
  });

  it('notifies listeners with a null record when a failure clears', () => {
    const changes: ProviderFailureChange[] = [];
    subscribeProviderFailureChanges((change) => changes.push(change));

    recordProviderFailure('glm', new Error('Z.ai probe failed (HTTP 503)'));
    expect(clearProviderFailure('glm')).toBe(true);
    expect(clearProviderFailure('glm')).toBe(false);

    expect(changes).toHaveLength(2);
    expect(changes[1]).toEqual({ providerId: 'glm', record: null });
    expect(getProviderFailure('glm')).toBeUndefined();
  });

  it('removes a failure record silently without notifying listeners', () => {
    const changes: ProviderFailureChange[] = [];
    subscribeProviderFailureChanges((change) => changes.push(change));

    recordProviderFailure('glm', new Error('Z.ai probe failed (HTTP 503)'));
    expect(removeProviderFailure('glm')).toBe(true);
    expect(removeProviderFailure('glm')).toBe(false);

    expect(changes).toHaveLength(1);
    expect(getProviderFailure('glm')).toBeUndefined();
  });

  it('stops delivering changes after unsubscribing', () => {
    const changes: ProviderFailureChange[] = [];
    const unsubscribe = subscribeProviderFailureChanges((change) => changes.push(change));

    unsubscribe();
    recordProviderFailure('glm', new Error('Z.ai probe failed (HTTP 503)'));

    expect(changes).toHaveLength(0);
    expect(getProviderFailure('glm')).toBeDefined();
  });

  it('tracks failures per provider independently', () => {
    recordProviderFailure('glm', new Error('Z.ai probe failed (HTTP 503)'));
    recordProviderFailure('kimi', new Error('Kimi API key rejected (HTTP 401)'));

    expect(getProviderFailure('glm')?.errorKind).toBe('transient');
    expect(getProviderFailure('kimi')?.errorKind).toBe('credential');
    expect(getAllProviderFailures()).toHaveLength(2);
  });
});
