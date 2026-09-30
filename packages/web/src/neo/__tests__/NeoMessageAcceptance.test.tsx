import { cleanup, render, screen } from '@testing-library/preact';
import type { ChatMessage } from '@hyperneo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoMessage } from '../NeoMessage.tsx';

vi.mock('../../components/chat/MarkdownRenderer.tsx', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));

const acceptedMessage = {
  type: 'user',
  uuid: 'accepted-ask',
  session_id: 'neo:root',
  parent_tool_use_id: null,
  inputKind: 'human',
  timestamp: 1000,
  message: { role: 'user', content: 'Check the source.' },
};

afterEach(cleanup);

describe('NeoMessage acceptance receipt', () => {
  it('places the double check immediately after the time, outside the bubble and copy controls', () => {
    const { container } = render(
      <NeoMessage
        message={acceptedMessage as unknown as ChatMessage}
        text="Check the source."
        sessionId="neo:root"
      />
    );
    const receipt = screen.getByRole('img', { name: 'Message accepted' });
    const time = container.querySelector('time')!;
    expect(time.nextElementSibling).toBe(receipt);
    expect(receipt.closest('.neo-message-bubble')).toBeNull();
    expect(
      receipt.parentElement?.contains(screen.getByRole('button', { name: 'Copy your message' }))
    ).toBe(false);
    expect(receipt.getAttribute('title')).toBe(
      'Accepted by Neo. This does not mean work is complete.'
    );
    expect(receipt.querySelector('path')?.getAttribute('d')).toBe('m2 12 4 4L16 6m-4 10L22 6');
    expect(container.textContent).not.toMatch(/read|completed|finished/i);
  });

  it.each([
    ['assistant reply', { type: 'assistant' }],
    ['internal delivery', { inputKind: 'system' }],
    ['legacy input with unknown provenance', { inputKind: undefined }],
    ['missing durable identity', { uuid: undefined }],
    ['blank durable identity', { uuid: ' ' }],
    ['child tool message', { parent_tool_use_id: 'tool-call' }],
    ['another session', { session_id: 'neo:other' }],
  ])('does not mark %s as an accepted human ask', (_name, patch) => {
    render(
      <NeoMessage
        message={{ ...acceptedMessage, ...patch } as unknown as ChatMessage}
        text="Check the source."
        sessionId="neo:root"
      />
    );
    expect(screen.queryByRole('img', { name: 'Message accepted' })).toBeNull();
  });

  it.each([undefined, '', ' '])(
    'does not infer acceptance without a view session %j',
    (sessionId) => {
      render(
        <NeoMessage
          message={acceptedMessage as unknown as ChatMessage}
          text="Check the source."
          sessionId={sessionId}
        />
      );
      expect(screen.queryByRole('img', { name: 'Message accepted' })).toBeNull();
    }
  );

  it('keeps accepted photo-only asks visible even without a timestamp', () => {
    render(
      <NeoMessage
        message={
          {
            ...acceptedMessage,
            timestamp: undefined,
            message: {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'aW5lcnQ=' },
                },
              ],
            },
          } as unknown as ChatMessage
        }
        text=""
        sessionId="neo:root"
      />
    );
    expect(screen.getByRole('img', { name: 'Message accepted' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Attached photo 1' })).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Copy your message' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('preserves the receipt after a stored ask is re-rendered with its stable identity', () => {
    const props = {
      message: acceptedMessage as unknown as ChatMessage,
      text: 'Check the source.',
      sessionId: 'neo:root',
    };
    const view = render(<NeoMessage {...props} />);
    view.rerender(<NeoMessage {...props} message={{ ...props.message }} />);
    expect(screen.getAllByRole('img', { name: 'Message accepted' })).toHaveLength(1);
  });
});
