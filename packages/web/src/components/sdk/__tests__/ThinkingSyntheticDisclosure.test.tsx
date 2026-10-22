import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatDisplayModeContext } from '../chat-display-mode.ts';
import { SyntheticMessageBlock } from '../SyntheticMessageBlock.tsx';
import { ThinkingBlock } from '../ThinkingBlock.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SDK thinking and synthetic text disclosures', () => {
  it('opens folded thinking only through the explicit control and preserves lazy reading', () => {
    const onOpen = vi.fn();
    const view = render(
      <ChatDisplayModeContext.Provider value="compact">
        <ThinkingBlock content="" thinnedChars={1200} onOpen={onOpen} />
      </ChatDisplayModeContext.Provider>
    );
    fireEvent.click(view.getByText('Thinking', { exact: true }));
    expect(view.queryByText('Loading…')).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    const more = view.getByRole('button', { name: 'more — Thinking', exact: true });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByText('Loading…'));
    const less = view.getByRole('button', { name: 'less — Thinking', exact: true });
    expect(less.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(less);
    expect(view.queryByText('Loading…')).toBeNull();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('uses explicit more and less for a long thinking preview without body toggling', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
    const content = 'A synthetic line.\n'.repeat(10) + 'Short ending.';
    const view = render(<ThinkingBlock content={content} />);
    const more = view.getByRole('button', { name: 'more — Thinking', exact: true });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(view.getByText(/Short ending\./));
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    const less = view.getByRole('button', { name: 'less — Thinking', exact: true });
    expect(less.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(view.getByText(/Short ending\./));
    expect(less.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(less);
    expect(view.getByRole('button', { name: 'more — Thinking', exact: true })).toBeTruthy();
  });

  it('uses the shared control for long synthetic text while the text remains inert', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
    const content = 'Synthetic body line.\n'.repeat(16) + 'Short ending.';
    const view = render(
      <SyntheticMessageBlock content={content} renderAsPlainText showActions={false} />
    );
    const more = view.getByRole('button', { name: 'more — Synthetic', exact: true });
    fireEvent.click(view.getByText(/Short ending\./));
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    const less = view.getByRole('button', { name: 'less — Synthetic', exact: true });
    expect(less.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(view.getByText(/Short ending\./));
    expect(less.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(less);
    expect(view.getByRole('button', { name: 'more — Synthetic', exact: true })).toBeTruthy();
  });

  it('keeps the collapse control after synthetic non-text blocks', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
    const view = render(
      <SyntheticMessageBlock
        content={[
          { type: 'tool_result', tool_use_id: 'synthetic-result', content: 'Synthetic output.' },
        ]}
        renderAsPlainText
        showActions={false}
      />
    );
    fireEvent.click(view.getByRole('button', { name: 'more — Synthetic', exact: true }));
    expect(view.getByText('Synthetic output.')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'less — Synthetic', exact: true }));
    expect(view.getByRole('button', { name: 'more — Synthetic', exact: true })).toBeTruthy();
  });

  it.each([true, false])(
    'retains focus across synthetic control moves (plain=%s)',
    async (plain) => {
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
      const view = render(
        <SyntheticMessageBlock
          content={`${'Synthetic focus line.\n'.repeat(16)}Short ending.`}
          renderAsPlainText={plain}
          showActions={false}
        />
      );
      await waitFor(() => expect(view.getByText(/Short ending\./)).toBeTruthy());
      const more = view.getByRole('button', { name: 'more — Synthetic', exact: true });
      more.focus();
      fireEvent.click(more);
      const less = await view.findByRole('button', { name: 'less — Synthetic', exact: true });
      expect(document.activeElement).toBe(less);
      fireEvent.click(less);
      expect(document.activeElement).toBe(
        view.getByRole('button', { name: 'more — Synthetic', exact: true })
      );
    }
  );
});
