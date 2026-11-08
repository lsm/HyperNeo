import 'preact/compat';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoModelMenu } from '../NeoModelMenu.tsx';

afterEach(cleanup);

describe('Neo model menu thinking slider', () => {
  it('previews a drag without saving, then commits its final value once', () => {
    const onThinking = vi.fn();
    render(
      <NeoModelMenu
        models={[]}
        level="off"
        busy={false}
        loading={false}
        working={false}
        onModel={vi.fn()}
        onThinking={onThinking}
        onClose={vi.fn()}
      />
    );
    const slider = screen.getByRole('slider', { name: 'Thinking' });
    fireEvent.input(slider, { target: { value: '2' } });
    expect(screen.getByTestId('thinking-slider-label').textContent).toBe('Medium');
    expect(onThinking).not.toHaveBeenCalled();
    fireEvent.input(slider, { target: { value: '4' } });
    expect(screen.getByTestId('thinking-slider-label').textContent).toBe('Extra High');
    expect(onThinking).not.toHaveBeenCalled();
    fireEvent.change(slider, { target: { value: '4' } });
    expect(onThinking).toHaveBeenCalledExactlyOnceWith('think32k');
  });
});
