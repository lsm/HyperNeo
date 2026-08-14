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

  test('defaults to immediate for deliveryMode:immediate; prefix', () => {
    expect(deliveryModeFromFailureReason('deliveryMode:immediate; some failure')).toBe('immediate');
    expect(deliveryModeFromFailureReason('deliveryMode:immediate;')).toBe('immediate');
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

  test('only the explicit immediate prefix recovers immediate (look-alike stems defer)', () => {
    expect(deliveryModeFromFailureReason('deliveryMode:deferred; …')).toBe('defer');
    expect(deliveryModeFromFailureReason('deliveryMode:deferrible; …')).toBe('defer');
  });
});
