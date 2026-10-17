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
  it('clamps text that overflows ten lines and lets the human expand and collapse it', () => {
    sized(500, 272);
    const { container } = render(
      <NeoClampedText text="long">
        <p>long</p>
      </NeoClampedText>
    );
    expect(container.querySelector('[data-clamped]')?.className).toBe('line-clamp-10');
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(container.querySelector('[data-clamped]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
      'true'
    );
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
