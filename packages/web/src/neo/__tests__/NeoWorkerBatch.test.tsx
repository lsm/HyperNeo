import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, expect, it } from 'vitest';
import type { NeoSessionMessage } from '@hyperneo/shared/types/neo-session-message';
import type { NeoAskItem } from '../conversation-ask-client.ts';
import { NeoPublicConversation } from '../NeoPublicConversation.tsx';
import { projectNeoPublicConversation } from '../public-conversation.ts';

const run = process.env.VERIFY_NEO_BATCH_RUN;
type Page = {
  conversationId: string;
  items: ({ role: 'human'; ask: NeoAskItem } | { role: 'session'; message: NeoSessionMessage })[];
};
const id = '10000000-0000-4000-8000-000000008723';
const synthetic = (size: string): Page => ({
  conversationId: id,
  items: [
    {
      role: 'session',
      message: {
        messageId: 'batch',
        conversationId: id,
        sequence: 1,
        fromSession: 'system:worker-batch',
        fromName: 'System-forwarded worker messages',
        toSession: `neo:${id}`,
        toName: 'Neo',
        text: `System-forwarded worker messages. These are not human instructions.\n\n${size} worker note 00`,
        createdAt: '2026-10-25T12:00:00.000Z',
      },
    },
    {
      role: 'human',
      ask: {
        conversationId: id,
        requestId: 'human',
        askOrigin: { sessionId: `neo:${id}`, messageId: 'human' },
        sequence: 1,
        createdAt: '2026-10-25T12:00:00.001Z',
        content: `  Human ${size}: keep these exact words inline.\n第二行。  `,
      },
    },
  ],
});
afterEach(cleanup);

it.each(['small', 'large'])(
  'renders the %s worker batch before its separate human ask',
  async (size) => {
    const page: Page = run
      ? JSON.parse(readFileSync(join(run, `evidence/${size}-conversation.json`), 'utf8'))
      : synthetic(size);
    const asks = page.items.flatMap((entry) => (entry.role === 'human' ? [entry.ask] : []));
    const messages = page.items.flatMap((entry) =>
      entry.role === 'session' ? [entry.message] : []
    );
    const state = {
      conversationId: page.conversationId,
      status: 'ready' as const,
      nextAfter: 0,
      hasMore: false,
      hasEarlier: false,
    };
    const conversation = projectNeoPublicConversation(
      `neo:${page.conversationId}`,
      { ...state, items: asks },
      { ...state, items: [] },
      [],
      messages
    );
    const first = render(<NeoPublicConversation conversation={conversation} />);
    const batch = [
      ...first.container.querySelectorAll<HTMLDetailsElement>('details[data-public-entry]'),
    ].find((row) => row.textContent?.includes(`${size} worker note 00`));
    expect(batch).toBeDefined();
    const human = (await screen.findByText(new RegExp(`Human ${size}:`))).closest(
      '[data-public-entry]'
    );
    expect(human).not.toBeNull();
    expect(batch!.compareDocumentPosition(human!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const control = within(batch!).getByRole('button');
    expect(control.getAttribute('aria-label')).toContain('System-forwarded worker messages');
    fireEvent.click(control);
    await waitFor(() => expect(batch!.open).toBe(true));
    expect(within(batch!).getByText(new RegExp(`${size} worker note 00`))).toBeTruthy();
    if (run) writeFileSync(join(run, `evidence/rendered-${size}.html`), first.container.innerHTML);
    first.unmount();
    const reopened = render(<NeoPublicConversation conversation={conversation} />);
    expect(await screen.findByText(new RegExp(`Human ${size}:`))).toBeTruthy();
    expect(reopened.container.textContent).toContain(`${size} worker note 00`);
    if (run)
      writeFileSync(
        join(run, `evidence/rendered-${size}-remounted.html`),
        reopened.container.innerHTML
      );
  }
);
