import { describe, expect, it } from 'vitest';
import {
  getMessagesBottomPaddingPx,
  MAX_MESSAGES_BOTTOM_PADDING_PX,
  MIN_MESSAGES_BOTTOM_PADDING_PX,
} from '../layout-metrics';

describe('layout-metrics', () => {
  it('clamps to the floor when the footer is shorter than the baseline clearance', () => {
    expect(getMessagesBottomPaddingPx(48)).toBe(MIN_MESSAGES_BOTTOM_PADDING_PX);
    expect(getMessagesBottomPaddingPx(110)).toBe(MIN_MESSAGES_BOTTOM_PADDING_PX);
  });

  it('keeps the last message fully above the composer when it grows', () => {
    expect(getMessagesBottomPaddingPx(134)).toBe(150);
    expect(getMessagesBottomPaddingPx(158)).toBe(174);
  });

  it('caps very tall footer padding at the hard maximum', () => {
    expect(getMessagesBottomPaddingPx(900)).toBe(MAX_MESSAGES_BOTTOM_PADDING_PX);
  });

  it('falls back to minimum for invalid heights', () => {
    expect(getMessagesBottomPaddingPx(Number.NaN)).toBe(MIN_MESSAGES_BOTTOM_PADDING_PX);
    expect(getMessagesBottomPaddingPx(0)).toBe(MIN_MESSAGES_BOTTOM_PADDING_PX);
  });
});
