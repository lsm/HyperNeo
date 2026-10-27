import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoClampedText } from '../NeoClampedText.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const sized = (scroll: number, client: number) => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(scroll);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(client);
};

describe('NeoClampedText', () => {
  it('opens and folds by tapping the text, with no visible more/less label', () => {
    sized(500, 272);
    const { container } = render(
      <NeoClampedText text="long">
        <p>long</p>
      </NeoClampedText>
    );
    expect(screen.queryByText(/^(more|less)$/i)).toBeNull();
    expect(container.querySelector('[data-clamped]')).toBeTruthy();
    fireEvent.click(screen.getByText('long'));
    expect(container.querySelector('[data-clamped]')).toBeNull();
    fireEvent.click(screen.getByText('long'));
    expect(container.querySelector('[data-clamped]')).toBeTruthy();
  });

  it('provides an accessible control while preserving link clicks and selected text', () => {
    sized(500, 272);
    const onLink = vi.fn();
    const { container } = render(
      <NeoClampedText text="long link">
        <p>
          <span>long</span>
          <a href="#target" onClick={onLink}>
            link
          </a>
        </p>
      </NeoClampedText>
    );
    fireEvent.click(screen.getByRole('link', { name: 'link' }));
    expect(onLink).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'link' }).closest('[role=button],button')).toBeNull();
    expect(container.querySelector('[data-clamped]')).toBeTruthy();
    const selected = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue({ toString: () => 'long' } as Selection);
    fireEvent.click(screen.getByText('long'));
    expect(container.querySelector('[data-clamped]')).toBeTruthy();
    selected.mockReturnValue(null);
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(container.querySelector('[data-clamped]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(container.querySelector('[data-clamped]')).toBeTruthy();
  });

  it.each([
    [7, 164, false],
    [6, 236, true],
  ] as const)(
    'cuts under word-bearing row %i only when it is within three rows',
    (wordRow, height, marked) => {
      sized(500, 272);
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
      vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue(
        Array.from({ length: 12 }, (_, index) => ({
          top: index * 24,
          bottom: index * 24 + 20,
          height: 20,
          left: 0,
          right: index === wordRow - 1 ? 200 : 5,
          width: index === wordRow - 1 ? 200 : 5,
        })) as unknown as DOMRectList
      );
      const { container } = render(
        <NeoClampedText text="words">
          <p>words</p>
        </NeoClampedText>
      );
      expect(container.querySelector<HTMLElement>('[data-clamped]')?.style.maxHeight).toBe(
        `${height}px`
      );
      expect(container.textContent?.includes('⋯')).toBe(marked);
    }
  );

  it('shows text that fits without a toggle, however many newlines it has', () => {
    sized(272, 272);
    const text = Array.from({ length: 14 }, (_, n) => `line ${n}`).join('\n');
    render(
      <NeoClampedText text={text}>
        <p>{text}</p>
      </NeoClampedText>
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});
