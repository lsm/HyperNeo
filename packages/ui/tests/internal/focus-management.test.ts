import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { focusElement, getFocusableElements } from '../../src/internal/focus-management.ts';

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  document.body.removeChild(container);
});

describe('getFocusableElements', () => {
  it('returns all focusable elements in container', () => {
    const btn = document.createElement('button');
    const input = document.createElement('input');
    const div = document.createElement('div');
    container.appendChild(btn);
    container.appendChild(input);
    container.appendChild(div);
    const result = getFocusableElements(container);
    expect(result).toContain(btn);
    expect(result).toContain(input);
    expect(result).not.toContain(div);
  });

  it('returns empty array if no focusable elements', () => {
    const div = document.createElement('div');
    container.appendChild(div);
    expect(getFocusableElements(container)).toHaveLength(0);
  });

  it('sorts elements by tabIndex', () => {
    const btn1 = document.createElement('button');
    btn1.tabIndex = 2;
    const btn2 = document.createElement('button');
    btn2.tabIndex = 1;
    const btn3 = document.createElement('button');
    btn3.tabIndex = 0;
    container.appendChild(btn1);
    container.appendChild(btn2);
    container.appendChild(btn3);
    const result = getFocusableElements(container);
    expect(result[0]).toBe(btn2);
    expect(result[1]).toBe(btn1);
    expect(result[2]).toBe(btn3);
  });

  it('excludes elements with tabindex=-1', () => {
    const btn = document.createElement('button');
    btn.setAttribute('tabindex', '-1');
    container.appendChild(btn);
    expect(getFocusableElements(container)).toHaveLength(0);
  });
});

describe('focusElement', () => {
  it('does nothing if element is null', () => {
    expect(() => focusElement(null)).not.toThrow();
  });

  it('calls focus() with scroll by default', () => {
    const btn = document.createElement('button');
    container.appendChild(btn);
    const spy = vi.spyOn(btn, 'focus');
    focusElement(btn);
    expect(spy).toHaveBeenCalledWith();
  });

  it('calls focus() without scroll when scroll=false', () => {
    const btn = document.createElement('button');
    container.appendChild(btn);
    const spy = vi.spyOn(btn, 'focus');
    focusElement(btn, false);
    expect(spy).toHaveBeenCalledWith({ preventScroll: true });
  });
});
