import { useState } from 'preact/hooks';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoPreviewResize } from '../NeoPreviewResize.tsx';

function Harness({ min = 40, max = 68, initial = 56 }) {
  const [value, setValue] = useState(initial);
  return (
    <div class="neo-shell">
      <NeoPreviewResize value={value} min={min} max={max} controls="document" onChange={setValue} />
      <section id="document">Document</section>
    </div>
  );
}
function setup(props = {}) {
  const view = render(<Harness {...props} />);
  const handle = screen.getByRole('separator', { name: 'Adjust preview width' });
  const root = view.container.querySelector<HTMLElement>('.neo-shell')!;
  const bounds = vi
    .spyOn(root, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(100, 0, 1000, 800));
  let captured: number | null = null;
  const capture = vi.fn((id: number) => {
    captured = id;
  });
  const release = vi.fn(() => {
    captured = null;
  });
  Object.defineProperties(handle, {
    setPointerCapture: { value: capture },
    releasePointerCapture: { value: release },
    hasPointerCapture: { value: (id: number) => captured === id },
  });
  const pointer = { pointerId: 7, isPrimary: true, button: 0, clientX: 546 };
  const value = () => Number(handle.getAttribute('aria-valuenow'));
  return { handle, pointer, capture, release, bounds, value };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('preview width gestures', () => {
  it('exposes the controlled panel and applies bounded keyboard adjustments', () => {
    const { handle, value } = setup();
    expect(handle.getAttribute('aria-controls')).toBe('document');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-valuetext')).toBe('56% preview width');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(value()).toBe(58);
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(value()).toBe(56);
    expect(fireEvent.keyDown(handle, { key: 'ArrowLeft', altKey: true })).toBe(true);
    expect(value()).toBe(56);
    fireEvent.keyDown(handle, { key: 'Home' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(value()).toBe(40);
    fireEvent.keyDown(handle, { key: 'End' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(value()).toBe(68);
    fireEvent.keyDown(handle, { key: 'PageDown' });
    expect(value()).toBe(68);
  });

  it('captures one pointer, preserves its grab offset and stops after release', () => {
    const { handle, pointer, capture, release, value } = setup();
    fireEvent.pointerDown(handle, pointer);
    expect(capture).toHaveBeenCalledWith(7);
    expect(document.activeElement).toBe(handle);
    fireEvent.pointerMove(handle, { ...pointer, clientX: 546 });
    expect(value()).toBe(56);
    fireEvent.pointerMove(handle, { ...pointer, pointerId: 8, clientX: 300 });
    expect(value()).toBe(56);
    fireEvent.pointerMove(handle, { ...pointer, clientX: 606 });
    expect(value()).toBe(50);
    fireEvent.pointerMove(handle, { ...pointer, clientX: -200 });
    expect(value()).toBe(68);
    fireEvent.pointerMove(handle, { ...pointer, clientX: 2000 });
    expect(value()).toBe(40);
    fireEvent.pointerUp(handle, pointer);
    expect(release).toHaveBeenCalledWith(7);
    fireEvent.pointerMove(handle, { ...pointer, clientX: 600 });
    expect(value()).toBe(40);
  });

  it.each(['Escape', 'pointercancel'])(
    'restores the drag start and releases capture through %s',
    (cancel) => {
      const { handle, pointer, release, value } = setup();
      fireEvent.pointerDown(handle, pointer);
      fireEvent.pointerMove(handle, { ...pointer, clientX: 606 });
      expect(value()).toBe(50);
      if (cancel === 'Escape') expect(fireEvent.keyDown(handle, { key: 'Escape' })).toBe(false);
      else fireEvent.pointerCancel(handle, pointer);
      expect(value()).toBe(56);
      expect(release).toHaveBeenCalledWith(7);
      fireEvent.pointerMove(handle, { ...pointer, clientX: 300 });
      expect(value()).toBe(56);
    }
  );

  it('ignores secondary pointers, zero geometry and moves after lost capture', () => {
    const { handle, pointer, capture, bounds, value } = setup();
    fireEvent.pointerDown(handle, { ...pointer, button: 2 });
    fireEvent.pointerDown(handle, { ...pointer, isPrimary: false });
    expect(capture).not.toHaveBeenCalled();
    fireEvent.pointerDown(handle, pointer);
    bounds.mockReturnValue(new DOMRect());
    fireEvent.pointerMove(handle, { ...pointer, clientX: 300 });
    expect(value()).toBe(56);
    bounds.mockReturnValue(new DOMRect(100, 0, 1000, 800));
    fireEvent.pointerMove(handle, { ...pointer, clientX: 606 });
    fireEvent(handle, new PointerEvent('lostpointercapture', { pointerId: 7, bubbles: true }));
    fireEvent.pointerMove(handle, { ...pointer, clientX: 300 });
    expect(value()).toBe(50);
  });

  it('uses the wide-screen range for keyboard and pointer input', () => {
    const { handle, pointer, value } = setup({ min: 32, max: 46, initial: 44 });
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(value()).toBe(32);
    fireEvent.pointerDown(handle, pointer);
    fireEvent.pointerMove(handle, { ...pointer, clientX: 0 });
    expect(value()).toBe(46);
  });
});
