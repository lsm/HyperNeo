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

  it('supports keyboard folding while preserving link clicks and selected text', () => {
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
    expect(container.querySelector('[data-clamped]')).toBeTruthy();
    const selected = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue({ toString: () => 'long' } as Selection);
    fireEvent.click(screen.getByText('long'));
    expect(container.querySelector('[data-clamped]')).toBeTruthy();
    selected.mockReturnValue(null);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Show more' }), { key: 'Enter' });
    expect(container.querySelector('[data-clamped]')).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Show less' }), { key: ' ' });
    expect(container.querySelector('[data-clamped]')).toBeTruthy();
  });

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
