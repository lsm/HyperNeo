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

  test('defaults to immediate for null or undefined (in-flight / no encoded mode)', () => {
    expect(deliveryModeFromFailureReason(null)).toBe('immediate');
    expect(deliveryModeFromFailureReason(undefined)).toBe('immediate');
  });

  test('defaults to immediate for an unrelated failure reason', () => {
    expect(deliveryModeFromFailureReason('node_execution_not_active')).toBe('immediate');
    expect(deliveryModeFromFailureReason('')).toBe('immediate');
  });

  test('does not match look-alikes that only share a stem (no semicolon boundary)', () => {
    // The parser keys on the `deliveryMode:defer;` boundary, so a longer mode
    // label that happens to start with "defer" must not be mistaken for defer.
    expect(deliveryModeFromFailureReason('deliveryMode:deferred; …')).toBe('immediate');
    expect(deliveryModeFromFailureReason('deliveryMode:deferrible; …')).toBe('immediate');
  });
});
