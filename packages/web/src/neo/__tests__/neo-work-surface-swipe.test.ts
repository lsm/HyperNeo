import { describe, expect, it } from 'vitest';
import { neoWorkSurfaceSwipe } from '../neo-work-surface-swipe.ts';

const at = (x: number, y = 0) => ({ x, y });
const width = 390;

describe('neoWorkSurfaceSwipe', () => {
  it('opens on a leftward swipe from the right edge', () => {
    expect(neoWorkSurfaceSwipe(at(385), at(340), { open: false, width })).toBe('open');
  });

  it('opens on a long leftward swipe anywhere in the chat', () => {
    expect(neoWorkSurfaceSwipe(at(300), at(120), { open: false, width })).toBe('open');
  });

  it('ignores a leftward swipe that is too short away from the edge', () => {
    expect(neoWorkSurfaceSwipe(at(300), at(265), { open: false, width })).toBeNull();
  });

  it('opens a short edge swipe that would be ignored mid-chat', () => {
    expect(neoWorkSurfaceSwipe(at(388), at(350), { open: false, width })).toBe('open');
    expect(neoWorkSurfaceSwipe(at(300), at(262), { open: false, width })).toBeNull();
  });

  it('closes on a rightward swipe while the panel is open', () => {
    expect(neoWorkSurfaceSwipe(at(120), at(220), { open: true, width })).toBe('close');
  });

  it('ignores a short rightward swipe while the panel is open', () => {
    expect(neoWorkSurfaceSwipe(at(120), at(160), { open: true, width })).toBeNull();
  });

  it('ignores vertical swipes in both panel states', () => {
    expect(neoWorkSurfaceSwipe(at(385), at(385, 200), { open: false, width })).toBeNull();
    expect(neoWorkSurfaceSwipe(at(120), at(200, 120), { open: true, width })).toBeNull();
  });

  it('never opens from a rightward swipe', () => {
    expect(neoWorkSurfaceSwipe(at(120), at(360), { open: false, width })).toBeNull();
  });
});
