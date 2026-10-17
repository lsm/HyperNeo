import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { NeoClampedText, neoTextOverLines } from '../NeoClampedText.tsx';

afterEach(() => cleanup());

const lines = (count: number) =>
  Array.from({ length: count }, (_, n) => `line ${n + 1}`).join('\n');

describe('NeoClampedText', () => {
  it('clamps text over ten lines and lets the human expand and collapse it', () => {
    const text = lines(12);
    const { container } = render(
      <NeoClampedText text={text}>
        <p>{text}</p>
      </NeoClampedText>
    );
    const box = container.querySelector('[data-clamped]');
    expect(box?.className).toBe('line-clamp-10');
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(container.querySelector('[data-clamped]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
      'true'
    );
  });

  it('shows short text without a toggle', () => {
    render(
      <NeoClampedText text={lines(10)}>
        <p>{lines(10)}</p>
      </NeoClampedText>
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('neoTextOverLines', () => {
  it('counts written lines against the ten-line limit', () => {
    expect(neoTextOverLines(lines(10))).toBe(false);
    expect(neoTextOverLines(lines(11))).toBe(true);
  });
});
