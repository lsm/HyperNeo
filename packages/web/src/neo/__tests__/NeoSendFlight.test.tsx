import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoSendFlight } from '../NeoSendFlight.tsx';
import { neoFlightBox } from '../neo-send-flight.ts';

const from = { x: 20, y: 700, width: 300, height: 100 };
const to = { x: 180, y: 400, width: 160, height: 140 };

describe('neoFlightBox', () => {
  it('starts at the composer without chrome and finishes at the bubble with its inset', () => {
    expect(neoFlightBox(from, to, 0)).toEqual({ ...from, chrome: 0 });
    expect(neoFlightBox(from, to, 1)).toEqual({ ...to, chrome: 1 });
  });
  it('lands exactly on native browser rectangle bounds at both endpoints', () => {
    const nativeFrom = new DOMRect(from.x, from.y, from.width, from.height);
    const nativeTo = new DOMRect(to.x, to.y, to.width, to.height);
    expect(neoFlightBox(nativeFrom, nativeTo, 0)).toEqual({ ...from, chrome: 0 });
    expect(neoFlightBox(nativeFrom, nativeTo, 1)).toEqual({ ...to, chrome: 1 });
  });
  it('follows the phone easing and bows to the right while size changes linearly', () => {
    const box = neoFlightBox(from, to, 0.5);
    expect(box.chrome).toBeCloseTo(0.77556, 4);
    const t = box.chrome,
      u = 1 - t;
    const width = from.width * u + to.width * t;
    const height = from.height * u + to.height * t;
    const center = u * u * 170 + 2 * u * t * 284 + t * t * 260;
    expect(box.width).toBeCloseTo(width);
    expect(box.height).toBeCloseTo(height);
    expect(box.x).toBeCloseTo(center - width / 2);
    expect(box.y + height / 2).toBeCloseTo(750 * u + 470 * t);
  });
});

let time = 0;
let frame: FrameRequestCallback | undefined;
const request = vi.fn((callback: FrameRequestCallback) => {
  frame = callback;
  return 1;
});
const cancel = vi.fn();
const tick = (ms: number) =>
  act(() => {
    time = ms;
    const next = frame;
    frame = undefined;
    next?.(time);
  });
const row = (kind: 'pending' | 'accepted') => {
  const article = document.createElement('article');
  article.setAttribute(kind === 'pending' ? 'data-pending-ask' : 'data-message-ref', 'flight');
  article.style.height = '150px';
  Object.defineProperty(article, 'scrollHeight', { value: 150 });
  const bubble = document.createElement('div');
  bubble.className = 'neo-message-bubble';
  bubble.getBoundingClientRect = () => new DOMRect(to.x, to.y, to.width, to.height);
  article.append(bubble);
  document.body.append(article);
  return article;
};
beforeEach(() => {
  time = 0;
  frame = undefined;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});
afterEach(() => {
  cleanup();
  document.querySelectorAll('article').forEach((node) => node.remove());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('NeoSendFlight', () => {
  const flight = {
    id: 'flight',
    from,
    words: 'The blue lamp',
    quote: { author: 'Neo' as const, text: 'Which lamp?', anchor: 'lamp' },
  };
  it('flies words and quote together across pending replacement, then reveals the row', () => {
    const pending = row('pending');
    const done = vi.fn();
    render(<NeoSendFlight flight={flight} onDone={done} />);
    tick(0);
    tick(100);
    const ghost = document.querySelector('[data-send-flight]')!;
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.textContent).toContain('The blue lamp');
    expect(ghost.textContent).toContain('Which lamp?');
    expect(pending.style.visibility).toBe('hidden');
    pending.remove();
    const accepted = row('accepted');
    expect(getComputedStyle(accepted).visibility).toBe('hidden');
    tick(300);
    expect(pending.style.height).toBe('150px');
    expect(pending.style.visibility).toBe('');
    expect(accepted.style.visibility).toBe('hidden');
    tick(550);
    expect((ghost as HTMLElement).style.lineHeight).toBe('1.7');
    expect(accepted.style.height).toBe('150px');
    expect(accepted.style.visibility).toBe('');
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('restores the row and cancels its frame on unmount', () => {
    const target = row('pending');
    const view = render(<NeoSendFlight flight={flight} onDone={vi.fn()} />);
    tick(100);
    view.unmount();
    expect(target.style.height).toBe('150px');
    expect(target.style.visibility).toBe('');
    expect(cancel).toHaveBeenCalled();
  });
  it('ends if no destination arrives and skips flight with reduced motion', () => {
    const done = vi.fn();
    const view = render(<NeoSendFlight flight={flight} onDone={done} />);
    tick(2100);
    expect(done).toHaveBeenCalledTimes(1);
    view.unmount();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const target = row('accepted');
    render(<NeoSendFlight flight={flight} onDone={done} />);
    expect(document.querySelector('[data-send-flight]')).toBeNull();
    expect(target.style.visibility).toBe('');
  });
});
