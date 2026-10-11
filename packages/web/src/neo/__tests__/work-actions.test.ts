import { describe, expect, it } from 'vitest';
import { neoWorkPresentation } from '../work-actions.ts';
import { testCard } from './neo-test-views.ts';

const card = (status: 'queued' | 'failed' | 'reported') =>
  testCard({ id: 'w1', status, sessionId: null });

describe('neoWorkPresentation', () => {
  it('keeps a card whose lead action is Close or Retry in detail so it stays reachable', () => {
    const compact = { compact: true, attention: false };
    expect(
      neoWorkPresentation(
        { ...card('queued'), primary: { kind: 'close', label: 'Close', link: null } },
        compact
      )
    ).toBe('detail');
    expect(
      neoWorkPresentation(
        { ...card('failed'), primary: { kind: 'retry', label: 'Retry', link: null } },
        compact
      )
    ).toBe('detail');
    expect(neoWorkPresentation(card('reported'), compact)).toBe('summary');
    expect(neoWorkPresentation(card('failed'), compact)).toBe('summary');
  });

  it('shows detail outside the compact list and for attention cards', () => {
    expect(neoWorkPresentation(card('queued'), { compact: true, attention: true })).toBe('detail');
    expect(neoWorkPresentation(card('reported'), { compact: false, attention: false })).toBe(
      'detail'
    );
  });
});
