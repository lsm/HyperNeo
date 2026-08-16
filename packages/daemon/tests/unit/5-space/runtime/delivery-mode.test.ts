import { describe, expect, test } from 'bun:test';
import { deliveryModeFromFailureReason } from '../../../../src/lib/space/runtime/delivery-mode';

describe('deliveryModeFromFailureReason', () => {
  test('returns defer for a deliveryMode:defer; prefix with a trailing reason', () => {
    expect(
      deliveryModeFromFailureReason('deliveryMode:defer; digest requeued after session loss')
    ).toBe('defer');
    expect(
      deliveryModeFromFailureReason('deliveryMode:defer; retry rescheduled after runtime restart')
    ).toBe('defer');
  });

  test('returns defer for the bare prefix with no trailing reason', () => {
    expect(deliveryModeFromFailureReason('deliveryMode:defer;')).toBe('defer');
  });

  test('normalizes legacy immediate-prefixed rows to defer', () => {
    // The prefix records how a PRE-upgrade dispatch was attempted, not an
    // intent that survives the always-next-idle behavior — recovered rows
    // must never inject mid-work regardless of their historical encoding.
    expect(deliveryModeFromFailureReason('deliveryMode:immediate; some failure')).toBe('defer');
    expect(deliveryModeFromFailureReason('deliveryMode:immediate;')).toBe('defer');
  });

  test('defaults to defer for null or undefined (in-flight / no encoded mode)', () => {
    // An unmarked pending delivery must not replay as 'immediate' — that
    // would steer an already-processing kickoff mid-turn. This also
    // normalizes durable rows persisted by pre-upgrade code (whose reasons
    // predate the deliveryMode: prefixes).
    expect(deliveryModeFromFailureReason(null)).toBe('defer');
    expect(deliveryModeFromFailureReason(undefined)).toBe('defer');
  });

  test('defaults to defer for an unrelated failure reason (legacy rows)', () => {
    expect(deliveryModeFromFailureReason('node_execution_not_active')).toBe('defer');
    expect(deliveryModeFromFailureReason('')).toBe('defer');
  });

  test('look-alike stems also recover defer (uniform)', () => {
    expect(deliveryModeFromFailureReason('deliveryMode:deferred; …')).toBe('defer');
    expect(deliveryModeFromFailureReason('deliveryMode:deferrible; …')).toBe('defer');
  });
});
