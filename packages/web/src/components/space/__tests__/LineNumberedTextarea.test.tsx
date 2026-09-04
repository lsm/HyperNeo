import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { LineNumberedTextarea } from '../LineNumberedTextarea';

const noop = () => {};

function gutterNumbers(container: Element): string[] {
  return Array.from(container.querySelectorAll('span')).map((s) => s.textContent ?? '');
}

afterEach(() => {
  cleanup();
});

describe('LineNumberedTextarea — gutter sizing', () => {
  it('renders one gutter number per line of a multi-line value', () => {
    const { container } = render(
      <LineNumberedTextarea value={'line one\nline two\nline three'} onChange={noop} rows={3} />
    );
    expect(gutterNumbers(container)).toEqual(['1', '2', '3']);
  });

  it('defaults to 10 gutter numbers for an empty value', () => {
    const { container } = render(<LineNumberedTextarea value="" onChange={noop} />);
    const numbers = gutterNumbers(container);
    expect(numbers).toHaveLength(10);
    expect(numbers[0]).toBe('1');
    expect(numbers[9]).toBe('10');
  });

  it('uses the value line count when it exceeds rows', () => {
    const value = Array.from({ length: 13 }, (_, i) => `l${i}`).join('\n');
    const { container } = render(<LineNumberedTextarea value={value} onChange={noop} rows={5} />);
    expect(gutterNumbers(container)).toHaveLength(13);
  });

  it('caps gutter rendering for very large values', () => {
    const value = Array.from({ length: 1002 }, (_, i) => `l${i}`).join('\n');
    const { container } = render(<LineNumberedTextarea value={value} onChange={noop} />);
    const numbers = gutterNumbers(container);
    expect(numbers).toHaveLength(1000);
    expect(numbers[999]).toBe('1000');
  });

  it('falls back to a custom rows minimum when the value has fewer lines', () => {
    const { container } = render(<LineNumberedTextarea value="one" onChange={noop} rows={4} />);
    expect(gutterNumbers(container)).toHaveLength(4);
  });
});

describe('LineNumberedTextarea — textarea passthrough', () => {
  it('forwards rows to the textarea element', () => {
    const { container } = render(<LineNumberedTextarea value="one" onChange={noop} rows={6} />);
    const textarea = container.querySelector('textarea');
    expect(textarea?.getAttribute('rows')).toBe('6');
  });

  it('forwards placeholder to the textarea', () => {
    const { container } = render(
      <LineNumberedTextarea value="" onChange={noop} placeholder="System prompt" />
    );
    const textarea = container.querySelector('textarea');
    expect(textarea?.getAttribute('placeholder')).toBe('System prompt');
  });

  it('marks the gutter aria-hidden', () => {
    const { container } = render(<LineNumberedTextarea value="one" onChange={noop} />);
    const gutter = (container.firstElementChild as Element).firstElementChild as Element;
    expect(gutter.getAttribute('aria-hidden')).toBe('true');
  });

  it('disables soft wrapping so gutter numbers stay aligned with long lines', () => {
    const value = 'a line long enough to wrap once rendered\nsecond logical line';
    const { container } = render(<LineNumberedTextarea value={value} onChange={noop} rows={2} />);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.getAttribute('wrap')).toBe('off');
    expect(gutterNumbers(container)).toEqual(['1', '2']);
  });

  it('reports the typed value through onChange on input', () => {
    const onChange = vi.fn();
    const { container } = render(<LineNumberedTextarea value="" onChange={onChange} />);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'typed\ntext' } });
    expect(onChange).toHaveBeenCalledWith('typed\ntext');
  });
});
