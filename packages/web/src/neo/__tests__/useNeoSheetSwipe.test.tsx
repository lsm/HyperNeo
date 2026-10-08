import { cleanup, fireEvent, render } from '@testing-library/preact';
import { useRef, useState } from 'preact/hooks';
import { afterEach, describe, expect, it } from 'vitest';
import {
  admitNeoSheetSwipe,
  neoSheetOffset,
  readNeoSheetSwipeAxis,
  settleNeoSheetSwipe,
  useNeoSheetSwipe,
} from '../useNeoSheetSwipe.ts';

afterEach(cleanup);

describe('admitNeoSheetSwipe', () => {
  const div = () => document.createElement('div');

  it('opens only from the right edge, clear of the browser’s own edge swipe', () => {
    const base = { width: 400, opening: true, target: div(), selecting: false };
    expect(admitNeoSheetSwipe({ ...base, x: 370 })).toBe(true);
    expect(admitNeoSheetSwipe({ ...base, x: 200 })).toBe(false);
    expect(admitNeoSheetSwipe({ ...base, x: 395 })).toBe(false);
    expect(admitNeoSheetSwipe({ ...base, opening: false, x: 200 })).toBe(true);
    expect(admitNeoSheetSwipe({ ...base, opening: false, x: 10 })).toBe(false);
  });

  it('leaves text selection, the composer and text inputs alone', () => {
    const base = { width: 400, opening: true, x: 370 };
    expect(admitNeoSheetSwipe({ ...base, target: div(), selecting: true })).toBe(false);
    const dock = div();
    dock.className = 'neo-composer-dock';
    const button = document.createElement('button');
    dock.append(button);
    expect(admitNeoSheetSwipe({ ...base, target: button, selecting: false })).toBe(false);
    expect(
      admitNeoSheetSwipe({ ...base, target: document.createElement('textarea'), selecting: false })
    ).toBe(false);
    expect(admitNeoSheetSwipe({ ...base, target: null, selecting: false })).toBe(false);
  });
});

describe('readNeoSheetSwipeAxis', () => {
  it('takes a quick sideways move in the right direction, and nothing after a long press', () => {
    expect(readNeoSheetSwipeAxis(-4, 2, 50, true)).toBe('wait');
    expect(readNeoSheetSwipeAxis(-30, 5, 50, true)).toBe('swipe');
    expect(readNeoSheetSwipeAxis(30, 5, 50, true)).toBe('ignore');
    expect(readNeoSheetSwipeAxis(-20, 30, 50, true)).toBe('ignore');
    expect(readNeoSheetSwipeAxis(-30, 5, 500, true)).toBe('ignore');
    expect(readNeoSheetSwipeAxis(30, 5, 50, false)).toBe('swipe');
  });
});

describe('neoSheetOffset', () => {
  it('follows the finger within the screen', () => {
    expect(neoSheetOffset(-100, 400, true)).toBe(300);
    expect(neoSheetOffset(-500, 400, true)).toBe(0);
    expect(neoSheetOffset(120, 400, false)).toBe(120);
    expect(neoSheetOffset(-20, 400, false)).toBe(0);
  });
});

describe('settleNeoSheetSwipe', () => {
  it('settles by distance or a quick flick', () => {
    expect(settleNeoSheetSwipe(-200, 0, 400, true)).toBe(true);
    expect(settleNeoSheetSwipe(-60, 0, 400, true)).toBe(false);
    expect(settleNeoSheetSwipe(-60, -0.8, 400, true)).toBe(true);
    expect(settleNeoSheetSwipe(200, 0, 400, false)).toBe(false);
    expect(settleNeoSheetSwipe(60, 0, 400, false)).toBe(true);
  });
});

describe('useNeoSheetSwipe', () => {
  function Harness() {
    const surface = useRef<HTMLDivElement>(null);
    const sheet = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    useNeoSheetSwipe({ enabled: true, open, setOpen, surface, sheet });
    return (
      <div ref={surface} data-testid="surface">
        <p data-testid="text">Message</p>
        <div ref={sheet} data-testid="sheet" data-open={String(open)} />
      </div>
    );
  }

  const touch = (x: number, y = 300) => ({ clientX: x, clientY: y });

  it('opens on a swipe from the right edge and closes on a swipe right', () => {
    const view = render(<Harness />);
    const text = view.getByTestId('text');
    const sheet = view.getByTestId('sheet');
    const width = window.innerWidth;
    fireEvent.touchStart(text, { touches: [touch(width - 20)] });
    fireEvent.touchMove(text, { touches: [touch(width - 120)] });
    expect(sheet.style.transform).toBe(`translateX(${width - 100}px)`);
    const surface = view.getByTestId('surface');
    expect(surface.dataset.sheetDrag).toBe('');
    expect(Number(surface.style.getPropertyValue('--neo-sheet'))).toBeCloseTo(100 / width);
    fireEvent.touchMove(text, { touches: [touch(width - 320)] });
    fireEvent.touchEnd(text, { changedTouches: [touch(width - 320)] });
    expect(sheet.dataset.open).toBe('true');
    expect(sheet.style.transform).toBe('');
    expect(surface.dataset.sheetDrag).toBeUndefined();
    expect(surface.style.getPropertyValue('--neo-sheet')).toBe('');

    fireEvent.touchStart(sheet, { touches: [touch(100)] });
    fireEvent.touchMove(sheet, { touches: [touch(200)] });
    fireEvent.touchMove(sheet, { touches: [touch(400)] });
    fireEvent.touchEnd(sheet, { changedTouches: [touch(400)] });
    expect(sheet.dataset.open).toBe('false');
  });

  it('ignores a swipe that starts mid-screen or while text is selected', () => {
    const view = render(<Harness />);
    const text = view.getByTestId('text');
    const sheet = view.getByTestId('sheet');
    fireEvent.touchStart(text, { touches: [touch(150)] });
    fireEvent.touchMove(text, { touches: [touch(20)] });
    fireEvent.touchEnd(text, { changedTouches: [touch(20)] });
    expect(sheet.dataset.open).toBe('false');

    const range = document.createRange();
    range.selectNodeContents(text);
    document.getSelection()?.addRange(range);
    const width = window.innerWidth;
    fireEvent.touchStart(text, { touches: [touch(width - 20)] });
    fireEvent.touchMove(text, { touches: [touch(width - 320)] });
    fireEvent.touchEnd(text, { changedTouches: [touch(width - 320)] });
    expect(sheet.dataset.open).toBe('false');
    expect(sheet.style.transform).toBe('');
    document.getSelection()?.removeAllRanges();
  });
});
