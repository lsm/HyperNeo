import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@hyperneo/shared';
import { NeoMessage, messageTime } from '../NeoMessage.tsx';
import { NeoExamples, markdownExamples } from '../NeoExamples.tsx';

const clipboard = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../lib/utils.ts', () => ({ copyToClipboard: clipboard }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Neo message presentation', () => {
  it('previews both themes locally without changing the app theme', () => {
    const appTheme = document.documentElement.getAttribute('data-theme');
    const { container } = render(<NeoExamples />);
    fireEvent.click(screen.getByRole('button', { name: 'Light', exact: true }));
    expect(container.querySelector('.neo-shell')?.getAttribute('data-theme')).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: 'Dark', exact: true }));
    expect(container.querySelector('.neo-shell')?.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe(appTheme);
  });
  it('opens a linked photo from its full image URL', () => {
    const url = '/api/sessions/s/messages/m/images/0';
    render(
      <NeoMessage
        message={
          {
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'YWJj' },
                  full: { url },
                },
              ],
            },
          } as unknown as ChatMessage
        }
        text=""
      />
    );
    const placeholder = screen.getByRole('img', { name: 'Attached photo 1' });
    expect(placeholder.getAttribute('src')).toBe('data:image/png;base64,YWJj');
    fireEvent.click(placeholder);
    const dialog = screen.getByRole('dialog', { name: 'Attached photo 1' });
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(url);
  });
  it.each(markdownExamples)(
    'renders rich Markdown for $type using its own theme',
    async (example) => {
      const { container } = render(
        <NeoMessage message={{ type: example.type } as ChatMessage} text={example.text} />
      );
      await waitFor(() => expect(container.querySelector('table')).toBeTruthy());
      expect(container.querySelector(`.neo-markdown-${example.type}`)).toBeTruthy();
      expect(
        container.querySelector(`.neo-message-${example.type} .neo-message-bubble`)
      ).toBeTruthy();
      expect(container.querySelector('.neo-message-bubble')?.className).not.toMatch(
        /bg-|border-accent|border-line/
      );
      for (const selector of [
        'h2',
        'strong',
        'em',
        'blockquote',
        'li',
        'pre code',
        'input[type="checkbox"]',
        'a',
      ])
        expect(container.querySelector(selector)).toBeTruthy();
      expect(container.querySelector('script')).toBeNull();
    }
  );
  it('shows a photo-only user message without a bubble and enlarges its photo', () => {
    render(
      <NeoMessage
        message={
          {
            type: 'user',
            message: {
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'YWJj' },
                },
              ],
            },
          } as unknown as ChatMessage
        }
        text="Attached files"
      />
    );
    expect(screen.getByRole('img', { name: 'Attached photo 1' }).getAttribute('src')).toBe(
      'data:image/png;base64,YWJj'
    );
    expect(document.querySelector('.neo-message-bubble')).toBeNull();
    expect(screen.queryByText('Attached files')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy your message' }).hasAttribute('disabled')).toBe(
      true
    );
    fireEvent.click(screen.getByRole('img', { name: 'Attached photo 1' }));
    expect(screen.getByRole('dialog', { name: 'Attached photo 1' })).toBeTruthy();
  });
  it.each(['user', 'assistant'] as const)(
    'keeps %s photos in their intended place beside words',
    async (type) => {
      const { container } = render(
        <NeoMessage
          message={
            {
              type,
              message: {
                content: [
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: 'YWJj' },
                  },
                ],
              },
            } as unknown as ChatMessage
          }
          text="The lamp flickers"
        />
      );
      const photo = screen.getByRole('img', { name: 'Attached photo 1' });
      const bubble = container.querySelector('.neo-message-bubble')!;
      expect(bubble.contains(photo)).toBe(type === 'assistant');
      expect(await screen.findByText('The lamp flickers')).toBeTruthy();
      if (type === 'user') {
        expect(
          photo.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
        expect(photo.closest('.justify-end')).toBeTruthy();
      }
    }
  );
  it.each(['user', 'assistant'] as const)(
    'puts %s name and time outside the bubble and copies only content',
    async (type) => {
      const timestamp = new Date(2026, 8, 26, 11, 16).getTime();
      const message = { type, timestamp } as unknown as ChatMessage;
      const { container } = render(<NeoMessage message={message} text="13." />);
      expect(
        screen.getByText(type === 'user' ? 'You' : 'Neo').closest('.neo-message-bubble')
      ).toBeNull();
      const time = container.querySelector('time')!;
      expect(time.dateTime).toBe(new Date(timestamp).toISOString());
      expect(time.closest('.neo-message-bubble')).toBeNull();
      const copy = screen.getByRole('button', {
        name: type === 'user' ? 'Copy your message' : 'Copy Neo’s message',
      });
      expect(copy.closest('.neo-message-bubble')).toBeNull();
      fireEvent.click(copy);
      await waitFor(() => expect(clipboard).toHaveBeenCalledWith('13.'));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy());
    }
  );
  it('uses local calendar boundaries, time today, date and time earlier, year when needed', () => {
    const now = new Date(2026, 8, 26, 0, 5);
    const today = new Date(2026, 8, 26, 0, 1);
    const yesterday = new Date(2026, 8, 25, 23, 59);
    const lastYear = new Date(2025, 8, 26, 11, 16);
    expect(messageTime(today.getTime(), now)?.label).toBe(
      today.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    );
    expect(messageTime(yesterday.getTime(), now)?.label).toBe(
      yesterday.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    );
    expect(messageTime(lastYear.getTime(), now)?.label).toBe(
      lastYear.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    );
    expect(messageTime(today.getTime(), new Date(2026, 8, 27))?.label).toBe(
      today.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    );
  });
  it('does not invent timestamps when metadata is absent or malformed', () => {
    for (const value of [undefined, null, '', 'not a date', NaN])
      expect(messageTime(value)).toBeNull();
    const { container } = render(
      <NeoMessage message={{ type: 'user' } as ChatMessage} text="Hello" />
    );
    expect(container.querySelector('time')).toBeNull();
  });
});
