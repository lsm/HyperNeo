import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listNeoMessageMenuActions,
  NeoMessageMenu,
  neoMessageMenuActions,
  requireNeoMessageMenuText,
  useNeoMessageMenu,
} from '../NeoMessageMenu.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('neoMessageMenuActions', () => {
  it('offers nothing for a message with no text, Share only where the browser can share, and Reply only where replies work', () => {
    expect(neoMessageMenuActions({ hasText: true, canShare: true, canReply: true })).toEqual([
      'select',
      'copy',
      'share',
      'reply',
    ]);
    expect(neoMessageMenuActions({ hasText: true, canShare: false, canReply: false })).toEqual([
      'select',
      'copy',
    ]);
    expect(neoMessageMenuActions({ hasText: false, canShare: true, canReply: true })).toEqual([]);
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

  it('leaves right-click to the browser without opening message actions', () => {
    render(<Probe />);
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    });
    fireEvent(screen.getByTestId('message'), event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
  });

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

describe('requireNeoMessageMenuText', () => {
  it('turns away a message with no text', () => {
    expect(requireNeoMessageMenuText({ hasText: false, canShare: true, canReply: true })).toEqual({
      reason: [],
    });
  });
});

describe('listNeoMessageMenuActions', () => {
  it('always offers select and copy, then share and reply when allowed', () => {
    expect(listNeoMessageMenuActions({ hasText: true, canShare: false, canReply: true })).toEqual([
      'select',
      'copy',
      'reply',
    ]);
  });
});

describe('NeoMessageMenu', () => {
  it('moves with the arrow keys, Home and End, and returns focus when it closes', () => {
    const message = document.createElement('div');
    message.tabIndex = -1;
    document.body.append(message);
    const { unmount } = render(
      <NeoMessageMenu
        at={{ x: 1, y: 1 }}
        actions={['select', 'copy', 'reply']}
        onPick={() => {}}
        onClose={() => {}}
        returnFocus={() => message}
      />
    );
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: 'End' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2], { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    unmount();
    expect(document.activeElement).toBe(message);
    message.remove();
  });
});
