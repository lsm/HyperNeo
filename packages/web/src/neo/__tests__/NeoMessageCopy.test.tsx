import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { ChatMessage } from '@hyperneo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoMessage } from '../NeoMessage.tsx';

const clipboard = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../lib/utils.ts', () => ({ copyToClipboard: clipboard }));
vi.mock('../../components/chat/MarkdownRenderer.tsx', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));

const image = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'aW5lcnQ=' },
};

function userMessage(content: unknown): ChatMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
  } as unknown as ChatMessage;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('NeoMessage copy controls', () => {
  it.each(['', ' \n\t '])('keeps photo-only copy visible but disables blank text %j', (text) => {
    render(<NeoMessage message={userMessage([image])} text={text} />);
    expect(screen.getByRole('img', { name: 'Attached photo 1' })).toBeTruthy();
    const copy = screen.getByRole('button', { name: 'Copy your message' }) as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    expect(copy.className).toContain('text-fg-muted');
    expect(copy.className).toContain('opacity-50');
    expect(copy.className).not.toContain('hover:bg-fill-strong');

    fireEvent.click(copy);
    expect(clipboard).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Copied!' })).toBeNull();
  });

  it.each([
    ['text-only', '  Keep exact message text.\n', 'Keep exact message text.'],
    [
      'text-and-photo',
      '\tKeep exact mixed text. \n',
      [{ type: 'text', text: 'Keep exact mixed text.' }, image],
    ],
  ])('copies exact nonblank %s content', async (_kind, text, content) => {
    render(<NeoMessage message={userMessage(content)} text={text} />);
    const copy = screen.getByRole('button', { name: 'Copy your message' }) as HTMLButtonElement;
    expect(copy.disabled).toBe(false);
    if (Array.isArray(content))
      expect(screen.getByRole('img', { name: 'Attached photo 1' })).toBeTruthy();

    fireEvent.click(copy);
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(text));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy());
  });
});
