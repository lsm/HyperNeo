import { describe, expect, it } from 'vitest';
import { requireAccepted } from '../operations';

describe('requireAccepted', () => {
  it('returns accepted results and objects without an accepted flag unchanged', () => {
    const task = { id: 't1' };
    expect(requireAccepted(task)).toBe(task);
    const ack = { accepted: true as const, jobId: 'j1' };
    expect(requireAccepted(ack)).toBe(ack);
  });

  it('throws the detail, else the reason, or a custom message for a rejection', () => {
    expect(() => requireAccepted({ accepted: false, reason: 'denied' })).toThrow('denied');
    expect(() =>
      requireAccepted({ accepted: false, reason: 'denied', detail: 'Not yours.' })
    ).toThrow('Not yours.');
    expect(() =>
      requireAccepted(
        { accepted: false, reason: 'denied' },
        (rejection) => `No: ${rejection.reason}`
      )
    ).toThrow('No: denied');
  });
});
