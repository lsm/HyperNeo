import { describe, expect, it } from 'bun:test';
import { sendStatusToDeliveryStatus, type MessageSendStatus } from '../src/types/message-delivery';

describe('sendStatusToDeliveryStatus', () => {
  it('maps pending states to queued/processing when not retrying', () => {
    expect(sendStatusToDeliveryStatus('deferred')).toBe('queued');
    expect(sendStatusToDeliveryStatus('enqueued')).toBe('queued');
    expect(sendStatusToDeliveryStatus('submitted')).toBe('processing');
  });

  it('maps pending states to retrying when an active retry is in flight', () => {
    expect(sendStatusToDeliveryStatus('deferred', { retrying: true })).toBe('retrying');
    expect(sendStatusToDeliveryStatus('enqueued', { retrying: true })).toBe('retrying');
    expect(sendStatusToDeliveryStatus('submitted', { retrying: true })).toBe('retrying');
  });

  it('maps a plain consumed message to delivered', () => {
    expect(sendStatusToDeliveryStatus('consumed')).toBe('delivered');
  });

  it('maps a CONSUMED message whose turn is being re-driven to retrying', () => {
    expect(sendStatusToDeliveryStatus('consumed', { retrying: true })).toBe('retrying');
  });

  it('maps failed terminally', () => {
    const failed: MessageSendStatus = 'failed';
    expect(sendStatusToDeliveryStatus(failed)).toBe('failed');
    expect(sendStatusToDeliveryStatus(failed, { retrying: true })).toBe('failed');
  });

  it('returns null for an unrecognised status', () => {
    expect(sendStatusToDeliveryStatus('nonsense')).toBeNull();
  });
});
