import { cleanup, render, screen, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { ChatMessage } from '@hyperneo/shared';
import type { SessionStore } from '../../lib/session-store.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoConversation } from '../NeoConversation.tsx';
import { neoMessageAnchor } from '../reply-context.ts';

vi.mock('../../components/chat/MarkdownRenderer.tsx', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('../../components/QuestionPrompt.tsx', () => ({ QuestionPrompt: () => null }));

const pngData =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/e4kAAAAASUVORK5CYII=';
const supportedImage = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: pngData },
};

function userMessage(uuid: string, content: unknown, fields: Record<string, unknown> = {}) {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    message: { role: 'user', content },
    ...fields,
  } as unknown as ChatMessage;
}

function makeStore(messages: ChatMessage[]): SessionStore {
  return {
    sdkMessages: signal(messages),
    agentState: signal({ status: 'idle' }),
    hasMoreMessages: signal(false),
    error: signal(null),
    refresh: vi.fn(),
  } as unknown as SessionStore;
}

afterEach(cleanup);

describe('Neo image-only conversation visibility', () => {
  it('renders supported photos while preserving ordinary text and hiding excluded rows', () => {
    const photoOnly = userMessage('photo-only', [supportedImage]);
    const textAndPhoto = userMessage('text-and-photo', [
      { type: 'text', text: 'Please inspect this sample.' },
      supportedImage,
    ]);
    const ordinaryText = userMessage('ordinary-text', 'Keep the existing text message.');
    const empty = userMessage('empty', '');
    const unsupported = userMessage('unsupported-image', [
      { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'inert' } },
    ]);
    const emptyImage = userMessage('empty-image-data', [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ' \t ' } },
    ]);
    const malformedImage = userMessage('malformed-image', [{ type: 'image', source: null }]);
    const synthetic = userMessage('synthetic-image', [supportedImage], { inputKind: 'system' });
    const child = userMessage('parent-tool-image', [supportedImage], {
      parent_tool_use_id: 'inert-parent-tool',
    });

    render(
      <NeoConversation
        store={makeStore([
          photoOnly,
          textAndPhoto,
          ordinaryText,
          empty,
          unsupported,
          emptyImage,
          malformedImage,
          synthetic,
          child,
        ])}
        sessionId="neo"
      />
    );

    const photoArticle = document.getElementById(neoMessageAnchor('neo', 'photo-only'))!;
    const photo = within(photoArticle).getByRole('img', { name: 'Attached photo 1' });
    expect(photo.getAttribute('src')).toBe(`data:image/png;base64,${pngData}`);
    expect(within(photoArticle).getByRole('button', { name: 'Copy your message' })).toBeTruthy();
    expect(within(photoArticle).queryByText('Please inspect this sample.')).toBeNull();

    const mixedArticle = document.getElementById(neoMessageAnchor('neo', 'text-and-photo'))!;
    expect(within(mixedArticle).getByText('Please inspect this sample.')).toBeTruthy();
    expect(
      within(mixedArticle).getByRole('img', { name: 'Attached photo 1' }).getAttribute('src')
    ).toBe(`data:image/png;base64,${pngData}`);
    expect(screen.getByText('Keep the existing text message.')).toBeTruthy();

    for (const id of [
      'empty',
      'unsupported-image',
      'empty-image-data',
      'malformed-image',
      'synthetic-image',
      'parent-tool-image',
    ])
      expect(document.getElementById(neoMessageAnchor('neo', id))).toBeNull();
    expect(screen.getAllByRole('img', { name: 'Attached photo 1' })).toHaveLength(2);
  });
});
