import { describe, expect, it, vi } from 'vitest';
import { neoWorkAnchorSelector, revealNeoWork } from '../reveal-work.ts';

describe('revealNeoWork', () => {
  it('scrolls to the linked card and flashes it briefly', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div data-neo-work="other"></div><div data-neo-work="w1"></div>';
    const target = root.querySelector<HTMLElement>(neoWorkAnchorSelector('w1'));
    if (!target) throw new Error('missing target');
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    let clear: (() => void) | undefined;
    expect(revealNeoWork(root, 'w1', (run) => (clear = run))).toBe(true);
    expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    expect(target.classList.contains('ring-2')).toBe(true);
    clear?.();
    expect(target.classList.contains('ring-2')).toBe(false);
  });

  it('does nothing when the card is not on screen', () => {
    const root = document.createElement('div');
    expect(revealNeoWork(root, 'missing', vi.fn())).toBe(false);
    expect(revealNeoWork(null, 'missing', vi.fn())).toBe(false);
  });
});

describe('neoWorkAnchorSelector', () => {
  it('escapes quotes in an id', () => {
    expect(neoWorkAnchorSelector('a"b')).toBe('[data-neo-work="a\\"b"]');
  });
});
