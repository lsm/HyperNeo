import { cleanup, renderHook } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { useTrackedPointer } from '../../src/internal/use-tracked-pointer.ts';

afterEach(() => {
  cleanup();
});

function makePointerEvent(x: number, y: number): PointerEvent {
  return { screenX: x, screenY: y } as unknown as PointerEvent;
}

describe('useTrackedPointer', () => {
  it('returns wasMoved and update functions', () => {
    const { result } = renderHook(() => useTrackedPointer());
    expect(typeof result.current.wasMoved).toBe('function');
    expect(typeof result.current.update).toBe('function');
  });

  it('wasMoved returns false on first event (initialization)', () => {
    const { result } = renderHook(() => useTrackedPointer());
    const event = makePointerEvent(100, 200);
    expect(result.current.wasMoved(event)).toBe(false);
  });

  it('wasMoved returns true when pointer position changes', () => {
    const { result } = renderHook(() => useTrackedPointer());
    result.current.wasMoved(makePointerEvent(100, 200));
    expect(result.current.wasMoved(makePointerEvent(150, 250))).toBe(true);
  });

  it('wasMoved returns false when pointer stays at same position', () => {
    const { result } = renderHook(() => useTrackedPointer());
    result.current.wasMoved(makePointerEvent(100, 200));
    expect(result.current.wasMoved(makePointerEvent(100, 200))).toBe(false);
  });

  it('update stores new position, making subsequent wasMoved accurate', () => {
    const { result } = renderHook(() => useTrackedPointer());
    result.current.wasMoved(makePointerEvent(10, 20));
    result.current.update(makePointerEvent(50, 60));
    expect(result.current.wasMoved(makePointerEvent(50, 60))).toBe(false);
    expect(result.current.wasMoved(makePointerEvent(100, 100))).toBe(true);
  });

  it('wasMoved updates position after detecting move', () => {
    const { result } = renderHook(() => useTrackedPointer());
    result.current.wasMoved(makePointerEvent(10, 10));
    result.current.wasMoved(makePointerEvent(20, 20));
    expect(result.current.wasMoved(makePointerEvent(20, 20))).toBe(false);
  });
});
