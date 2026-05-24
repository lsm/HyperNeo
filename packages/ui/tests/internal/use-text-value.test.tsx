import { cleanup, renderHook } from '@testing-library/preact';
import { useRef } from 'preact/hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { useTextValue } from '../../src/internal/use-text-value.ts';

afterEach(() => {
  cleanup();
});

describe('useTextValue', () => {
  it('returns empty string when ref is null', () => {
    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(null);
      return useTextValue(ref);
    });
    expect(result.current()).toBe('');
  });

  it('extracts text content from element', () => {
    const el = document.createElement('div');
    el.textContent = 'Hello World';
    document.body.appendChild(el);

    const { result } = renderHook(() => {
      const ref = { current: el };
      return useTextValue(ref);
    });

    expect(result.current()).toBe('hello world');

    document.body.removeChild(el);
  });

  it('returns lowercased text', () => {
    const el = document.createElement('div');
    el.textContent = 'UPPERCASE TEXT';
    document.body.appendChild(el);

    const { result } = renderHook(() => {
      const ref = { current: el };
      return useTextValue(ref);
    });

    expect(result.current()).toBe('uppercase text');

    document.body.removeChild(el);
  });

  it('trims leading and trailing whitespace', () => {
    const el = document.createElement('div');
    el.textContent = '   trimmed   ';
    document.body.appendChild(el);

    const { result } = renderHook(() => {
      const ref = { current: el };
      return useTextValue(ref);
    });

    expect(result.current()).toBe('trimmed');

    document.body.removeChild(el);
  });

  it('handles nested elements by collecting all text nodes', () => {
    const el = document.createElement('div');
    const span1 = document.createElement('span');
    span1.textContent = 'Hello';
    const span2 = document.createElement('span');
    span2.textContent = ' World';
    el.appendChild(span1);
    el.appendChild(span2);
    document.body.appendChild(el);

    const { result } = renderHook(() => {
      const ref = { current: el };
      return useTextValue(ref);
    });

    expect(result.current()).toBe('hello world');

    document.body.removeChild(el);
  });

  it('returns empty string for element with no text', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);

    const { result } = renderHook(() => {
      const ref = { current: el };
      return useTextValue(ref);
    });

    expect(result.current()).toBe('');

    document.body.removeChild(el);
  });

  it('handles deeply nested text nodes', () => {
    const el = document.createElement('div');
    el.innerHTML = '<p><strong>Deep</strong> <em>Nested</em> Text</p>';
    document.body.appendChild(el);

    const { result } = renderHook(() => {
      const ref = { current: el };
      return useTextValue(ref);
    });

    expect(result.current()).toBe('deep nested text');

    document.body.removeChild(el);
  });
});
