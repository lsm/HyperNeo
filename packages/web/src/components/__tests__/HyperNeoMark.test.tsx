import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import mark from '../../../../../docs/branding/hyperneo-visual-identity/assets/logo-mark-06-jade.svg';
import { HyperNeoMark } from '../HyperNeoMark.tsx';

afterEach(cleanup);

describe('HyperNeoMark', () => {
  it('uses the approved asset on a fixed night tile without recoloring or animation', () => {
    const { container } = render(<HyperNeoMark />);
    const image = container.querySelector('img')!;
    expect(image.getAttribute('src')).toBe(mark);
    expect(image.getAttribute('height')).toBe('32');
    expect(image.className).toBe('h-8 w-auto');
    expect(image.getAttribute('width')).toBeNull();
    expect(image.getAttribute('alt')).toBe('');
    const tile = image.parentElement!;
    expect(tile.className).toBe(
      'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl'
    );
    expect(tile.style.background).toBe('var(--hn-color-night)');
    expect(tile.classList.contains('neo-mark')).toBe(false);
  });
  it('does not duplicate an adjacent control name or alter its interaction', () => {
    const back = vi.fn();
    render(
      <button type="button" aria-label="Back to Neo" onClick={back}>
        <HyperNeoMark />
        neo
      </button>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back to Neo' }));
    expect(back).toHaveBeenCalledOnce();
    expect(screen.queryByRole('img')).toBeNull();
  });
  it('can name a standalone placement explicitly', () => {
    render(<HyperNeoMark label="HyperNeo" />);
    expect(screen.getByRole('img', { name: 'HyperNeo' }).getAttribute('src')).toBe(mark);
  });
});
