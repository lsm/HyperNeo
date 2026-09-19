import { describe, expect, it } from 'bun:test';
import { decideRefreshDue } from '../../../../src/lib/credentials/refresh-due-gate';

const base = { now: 0, refreshWindowMs: 10_000 };

describe('decideRefreshDue', () => {
  it('refreshes a credential expiring inside the window', () => {
    expect(decideRefreshDue({ ...base, expiresAt: 1_000, failureKind: undefined })).toEqual({
      value: 'expiring',
    });
  });

  it('refreshes a credential already past its expiry', () => {
    expect(decideRefreshDue({ ...base, expiresAt: -5_000, failureKind: undefined })).toEqual({
      value: 'expiring',
    });
  });

  it('treats the window boundary as due', () => {
    expect(decideRefreshDue({ ...base, expiresAt: 10_000, failureKind: undefined })).toEqual({
      value: 'expiring',
    });
  });

  it('leaves a credential expiring outside the window alone', () => {
    expect(decideRefreshDue({ ...base, expiresAt: 10_001, failureKind: undefined })).toEqual({
      reason: 'not_due',
    });
  });

  it('lets a recorded expiry win over a credential failure', () => {
    expect(decideRefreshDue({ ...base, expiresAt: 10_001, failureKind: 'credential' })).toEqual({
      reason: 'not_due',
    });
  });

  it('refreshes a credential with no expiry once a credential failure is recorded', () => {
    expect(decideRefreshDue({ ...base, expiresAt: undefined, failureKind: 'credential' })).toEqual({
      value: 'credential_failure',
    });
  });

  it('leaves a credential with no expiry alone while nothing has failed', () => {
    expect(decideRefreshDue({ ...base, expiresAt: undefined, failureKind: undefined })).toEqual({
      reason: 'no_expiry_without_credential_failure',
    });
  });

  it('leaves a credential with no expiry alone on a transient failure', () => {
    expect(decideRefreshDue({ ...base, expiresAt: undefined, failureKind: 'transient' })).toEqual({
      reason: 'no_expiry_without_credential_failure',
    });
  });
});
