import type { ChatMessage } from '@hyperneo/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { combineVoiceSubmission } from '../../lib/voice/voice-audio-outbox.ts';
import { NeoMessage } from '../NeoMessage.tsx';
import { NeoPublicConversation, PendingAsk } from '../NeoPublicConversation.tsx';
import {
  attachmentDocuments,
  attachmentMessage,
  neoSplitSentMessage,
  type NeoAttachment,
} from '../neo-attachments.ts';
import { projectNeoPublicConversation } from '../public-conversation.ts';

const clipboard = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../lib/utils.ts', async (original) => ({
  ...(await original<typeof import('../../lib/utils.ts')>()),
  copyToClipboard: clipboard,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const file: NeoAttachment = {
  id: 'notes',
  kind: 'text',
  name: 'notes.txt',
  text: 'First line\nSecond line',
  size: 22,
};
const message = attachmentMessage('', [file]);
const conversationId = '10000000-0000-4000-8000-000000000002';
const root = `neo:${conversationId}`;
const page = { conversationId, status: 'ready' as const, hasMore: false, hasEarlier: false };
function publicView(text: string) {
  return projectNeoPublicConversation(
    root,
    {
      ...page,
      nextAfter: 1,
      items: [
        {
          conversationId,
          requestId: 'sent-file',
          askOrigin: { sessionId: root, messageId: 'sent-file' },
          content: [{ type: 'text', text }],
          sequence: 1,
          createdAt: '2026-11-06T10:00:00Z',
        },
      ],
    },
    { ...page, nextAfter: 0, items: [] }
  );
}

describe('neoSplitSentMessage', () => {
  it.each(['', 'Please read this', 'Attached files', 'Spoken words\n\nAttached files'])(
    'splits the web writer with draft %j',
    (draft) => {
      const files: Array<Extract<NeoAttachment, { kind: 'text' }>> = [
        file,
        {
          ...file,
          id: 'code',
          name: '报告 [v1]_*\\`{}<>.txt',
          text: 'before\n````js\ncode\n````\nafter',
        },
      ];
      expect(neoSplitSentMessage(attachmentMessage(draft, files))).toEqual({
        words: draft === 'Attached files' || !draft ? '' : draft.replace(/\n\nAttached files$/, ''),
        files: files.map(({ name, text }) => ({ name, text })),
      });
    }
  );
  it('splits the actual voice suffix path', () => {
    const text = combineVoiceSubmission(
      'Draft',
      'Spoken words',
      attachmentDocuments([file]).join('\n\n')
    );
    expect(neoSplitSentMessage(text)).toEqual({
      words: 'Draft\nSpoken words',
      files: [{ name: file.name, text: file.text }],
    });
  });
  it('reads the phone writer form without leading words', () => {
    expect(
      neoSplitSentMessage('### Attached file: notes.txt\n\n```text\nFirst line\nSecond line\n```')
    ).toEqual({ words: '', files: [{ name: file.name, text: file.text }] });
  });
  it('keeps a fence-like line inside the file when it is not a closing boundary', () => {
    const text = '### Attached file: notes.txt\n\n```text\nstart\n```\nstill text\n```';
    expect(neoSplitSentMessage(text)).toEqual({
      words: '',
      files: [{ name: file.name, text: 'start\n```\nstill text' }],
    });
  });
  it('keeps a long phone file whole across thousands of fence-like lines', () => {
    const body = 'Notes\n' + '```\nmore notes\n'.repeat(8_000);
    const text = '### Attached file: notes.txt\n\n```text\n' + body + '\n```';
    expect(neoSplitSentMessage(text)).toEqual({
      words: '',
      files: [{ name: file.name, text: body }],
    });
  });
  it.each([
    'ordinary words',
    'Attached files',
    'words ### Attached file: notes.txt\n\n```text\nbody\n```',
    '### Attached file: notes.txt\n```text\nbody\n```',
    '### Attached file: notes.txt\n\n```js\nbody\n```',
    '### Attached file: notes.txt\n\n```text\nbody',
    '### Attached file: notes.txt\n\n````text\nbody\n```',
    '### Attached file: notes.txt\n\n```text\nbody\n```\nextra',
    '### Attached file: notes.txt\n\n```text\nbody\n```\n',
    message + '\n\n### Attached file: broken.txt\n\n```text\nmissing close',
  ])('keeps malformed or ordinary text whole: %j', (text) => {
    expect(neoSplitSentMessage(text)).toEqual({ words: text, files: [] });
  });
});

describe('sent file cards', () => {
  it('puts the card above the words and opens selectable plain text', async () => {
    const { container } = render(
      <NeoPublicConversation
        conversation={publicView(attachmentMessage('Please read this', [file]))}
      />
    );
    const card = screen.getByRole('button', { name: 'Open file: notes.txt' });
    const bubble = container.querySelector('.neo-message-bubble')!;
    expect(bubble.contains(card)).toBe(false);
    expect(card.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await screen.findByText('Please read this')).toBeTruthy();
    expect(screen.queryByText(file.text)).toBeNull();
    fireEvent.click(card);
    const dialog = await screen.findByRole('dialog', { name: file.name });
    const reader = dialog.querySelector('pre')!;
    expect(reader.textContent).toBe(file.text);
    expect(reader.className).toContain('select-text');
    expect(reader.className).toContain('whitespace-pre-wrap');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close modal' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('keeps copy and reply quoting the full original file-only message', () => {
    const onQuote = vi.fn();
    const { container } = render(
      <NeoPublicConversation conversation={publicView(message)} onQuote={onQuote} />
    );
    expect(container.querySelector('.neo-message-bubble')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy your message' }));
    expect(clipboard).toHaveBeenCalledWith(message);
    fireEvent.click(screen.getByRole('button', { name: 'Reply to your message' }));
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ text: message }));
  });
  it('keeps a failed pending file card and its recovery controls without a bubble', () => {
    const { container } = render(
      <PendingAsk
        ask={{
          requestId: 'pending-file',
          sessionId: root,
          text: message,
          images: [],
          createdAt: '2026-11-06T10:00:00Z',
          state: 'failed',
        }}
      />
    );
    expect(screen.getByRole('button', { name: 'Open file: notes.txt' })).toBeTruthy();
    expect(container.querySelector('.neo-message-bubble')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
  });
  it('shows a session user file card without a bubble and still copies the original', () => {
    const { container } = render(
      <NeoMessage message={{ type: 'user' } as ChatMessage} text={message} />
    );
    expect(screen.getByRole('button', { name: 'Open file: notes.txt' })).toBeTruthy();
    expect(container.querySelector('.neo-message-bubble')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy your message' }));
    expect(clipboard).toHaveBeenCalledWith(message);
  });
  it('keeps Neo’s own attachment-shaped words as words', async () => {
    render(<NeoMessage message={{ type: 'assistant' } as ChatMessage} text={message} />);
    expect(screen.queryByRole('button', { name: 'Open file: notes.txt' })).toBeNull();
    expect(await screen.findByText('Attached file: notes.txt')).toBeTruthy();
  });
});
