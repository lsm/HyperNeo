import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoMessageMenu, neoMessageMenuActions, useNeoMessageMenu } from '../NeoMessageMenu.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('neoMessageMenuActions', () => {
  it('offers Share only where the browser can share, and Reply only where replies work', () => {
    expect(neoMessageMenuActions({ canShare: true, canReply: true })).toEqual([
      'select',
      'copy',
      'share',
      'reply',
    ]);
    expect(neoMessageMenuActions({ canShare: false, canReply: false })).toEqual(['select', 'copy']);
  });
});

describe('useNeoMessageMenu', () => {
  function Probe() {
    const menu = useNeoMessageMenu();
    return (
      <div data-testid="message" {...menu.bind}>
        {menu.at && (
          <NeoMessageMenu at={menu.at} actions={['copy']} onPick={() => {}} onClose={menu.close} />
        )}
      </div>
    );
  }

  it('opens on a long press and not on a short tap, and closes on Escape', () => {
    vi.useFakeTimers();
    render(<Probe />);
    const message = screen.getByTestId('message');
    fireEvent.touchStart(message, { touches: [{ clientX: 5, clientY: 5 }] });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.touchEnd(message);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.touchStart(message, { touches: [{ clientX: 5, clientY: 5 }] });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByRole('menu', { name: 'Message actions' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
