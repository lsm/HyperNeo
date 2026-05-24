import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Focus,
  FocusableMode,
  focusElement,
  focusIn,
  getFocusableElements,
  isFocusableElement,
} from '../../src/internal/focus-management.ts';

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  document.body.removeChild(container);
});

describe('isFocusableElement', () => {
  it('returns false for document.body', () => {
    expect(isFocusableElement(document.body)).toBe(false);
  });

  it('returns true for a button in strict mode', () => {
    const btn = document.createElement('button');
    container.appendChild(btn);
    expect(isFocusableElement(btn, FocusableMode.Strict)).toBe(true);
  });

  it('returns true for an anchor with href in strict mode', () => {
    const a = document.createElement('a');
    a.href = '#test';
    container.appendChild(a);
    expect(isFocusableElement(a, FocusableMode.Strict)).toBe(true);
  });

  it('returns true for an input in strict mode', () => {
    const input = document.createElement('input');
    container.appendChild(input);
    expect(isFocusableElement(input, FocusableMode.Strict)).toBe(true);
  });

  it('returns false for disabled button in strict mode', () => {
    const btn = document.createElement('button');
    btn.disabled = true;
    container.appendChild(btn);
    expect(isFocusableElement(btn, FocusableMode.Strict)).toBe(false);
  });

  it('returns false for element with tabindex=-1 in strict mode', () => {
    const div = document.createElement('div');
    div.setAttribute('tabindex', '-1');
    container.appendChild(div);
    expect(isFocusableElement(div, FocusableMode.Strict)).toBe(false);
  });

  it('returns false for a plain div in strict mode', () => {
    const div = document.createElement('div');
    container.appendChild(div);
    expect(isFocusableElement(div, FocusableMode.Strict)).toBe(false);
  });

  it('returns true for element with tabindex=0 in strict mode', () => {
    const div = document.createElement('div');
    div.setAttribute('tabindex', '0');
    container.appendChild(div);
    expect(isFocusableElement(div, FocusableMode.Strict)).toBe(true);
  });

  it('returns true for child of focusable element in loose mode', () => {
    const btn = document.createElement('button');
    const span = document.createElement('span');
    btn.appendChild(span);
    container.appendChild(btn);
    expect(isFocusableElement(span, FocusableMode.Loose)).toBe(true);
  });

  it('returns false for non-focusable element and no focusable ancestor in loose mode', () => {
    const div = document.createElement('div');
    const span = document.createElement('span');
    div.appendChild(span);
    container.appendChild(div);
    expect(isFocusableElement(span, FocusableMode.Loose)).toBe(false);
  });

  it('returns true for the focusable element itself in loose mode', () => {
    const btn = document.createElement('button');
    container.appendChild(btn);
    expect(isFocusableElement(btn, FocusableMode.Loose)).toBe(true);
  });

  it('uses strict mode by default', () => {
    const btn = document.createElement('button');
    container.appendChild(btn);
    expect(isFocusableElement(btn)).toBe(true);
  });
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
    // tabIndex=1 < tabIndex=2, tabIndex=0 treated as MAX_SAFE_INTEGER
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

describe('focusIn', () => {
  it('focuses first element with Focus.First', () => {
    const btn1 = document.createElement('button');
    const btn2 = document.createElement('button');
    btn1.id = 'first';
    btn2.id = 'second';
    container.appendChild(btn1);
    container.appendChild(btn2);
    vi.spyOn(btn1, 'focus').mockImplementation(() => {
      (document as Document).activeElement;
      Object.defineProperty(document, 'activeElement', { value: btn1, configurable: true });
    });
    const result = focusIn(container, Focus.First);
    expect(result).toBe(true);
  });

  it('focuses last element with Focus.Last', () => {
    const btn1 = document.createElement('button');
    const btn2 = document.createElement('button');
    container.appendChild(btn1);
    container.appendChild(btn2);
    // Spy on btn2.focus to verify it's called (happy-dom doesn't update activeElement)
    const spy2 = vi.spyOn(btn2, 'focus').mockImplementation(() => {
      Object.defineProperty(document, 'activeElement', { value: btn2, configurable: true });
    });
    const result = focusIn(container, Focus.Last);
    expect(spy2).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('focuses next element with Focus.Next', () => {
    const btn1 = document.createElement('button');
    const btn2 = document.createElement('button');
    container.appendChild(btn1);
    container.appendChild(btn2);
    // Set active element to btn1 so Next targets btn2
    Object.defineProperty(document, 'activeElement', { value: btn1, configurable: true });
    const spy2 = vi.spyOn(btn2, 'focus').mockImplementation(() => {
      Object.defineProperty(document, 'activeElement', { value: btn2, configurable: true });
    });
    const result = focusIn(container, Focus.Next);
    expect(spy2).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('focuses previous element with Focus.Previous', () => {
    const btn1 = document.createElement('button');
    const btn2 = document.createElement('button');
    container.appendChild(btn1);
    container.appendChild(btn2);
    // Set active element to btn2 so Previous targets btn1
    Object.defineProperty(document, 'activeElement', { value: btn2, configurable: true });
    const spy1 = vi.spyOn(btn1, 'focus').mockImplementation(() => {
      Object.defineProperty(document, 'activeElement', { value: btn1, configurable: true });
    });
    const result = focusIn(container, Focus.Previous);
    expect(spy1).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('returns false when no focusable elements', () => {
    const result = focusIn(container, Focus.First);
    expect(result).toBe(false);
  });

  it('wraps around with Focus.WrapAround | Focus.Next', () => {
    const btn1 = document.createElement('button');
    const btn2 = document.createElement('button');
    container.appendChild(btn1);
    container.appendChild(btn2);
    // Set active to btn2 (last), wrapping should go to btn1
    Object.defineProperty(document, 'activeElement', { value: btn2, configurable: true });
    const spy1 = vi.spyOn(btn1, 'focus').mockImplementation(() => {
      Object.defineProperty(document, 'activeElement', { value: btn1, configurable: true });
    });
    const result = focusIn(container, Focus.Next | Focus.WrapAround);
    expect(spy1).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('wraps backwards with Focus.WrapAround | Focus.Previous when no active element', () => {
    const btn1 = document.createElement('button');
    const btn2 = document.createElement('button');
    container.appendChild(btn1);
    container.appendChild(btn2);
    // No active element → indexOf returns -1 → startIndex = max(0,-1-1) = max(0,-2) = 0
    // But with WrapAround from 0, wraps to last element (btn2)
    Object.defineProperty(document, 'activeElement', { value: document.body, configurable: true });
    const spy2 = vi.spyOn(btn2, 'focus').mockImplementation(() => {
      Object.defineProperty(document, 'activeElement', { value: btn2, configurable: true });
    });
    vi.spyOn(btn1, 'focus').mockImplementation(() => {
      // btn1 focus should NOT become active (simulate no focus change)
    });
    const result = focusIn(container, Focus.Previous | Focus.WrapAround);
    // With no active element indexOf=-1, startIndex=max(0,-2)=0 direction=-1
    // i=0: offset=(0+0+2)%2=0 → btn1 → focus, activeElement===btn1? No (mocked to not update)
    // i=1: offset=(0-1+2)%2=1 → btn2 → focus, activeElement===btn2? Yes
    expect(spy2).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('focuses without scroll when Focus.NoScroll is set', () => {
    const btn = document.createElement('button');
    container.appendChild(btn);
    const spy = vi.spyOn(btn, 'focus').mockImplementation((...args) => {
      Object.defineProperty(document, 'activeElement', { value: btn, configurable: true });
      HTMLElement.prototype.focus.call(btn, ...(args as [FocusOptions?]));
    });
    focusIn(container, Focus.First | Focus.NoScroll);
    expect(spy).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('accepts array of elements instead of container', () => {
    const btn1 = document.createElement('button');
    const btn2 = document.createElement('button');
    container.appendChild(btn1);
    container.appendChild(btn2);
    const spy1 = vi.spyOn(btn1, 'focus').mockImplementation(() => {
      Object.defineProperty(document, 'activeElement', { value: btn1, configurable: true });
    });
    const result = focusIn([btn1, btn2], Focus.First);
    expect(spy1).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('throws when focus direction is missing', () => {
    const btn = document.createElement('button');
    container.appendChild(btn);
    // Passing 0 doesn't set any direction bit
    expect(() => focusIn(container, 0 as Focus)).toThrow('Missing Focus direction');
  });
});
