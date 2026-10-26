import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, expect, it } from 'vitest';
import type { NeoSessionMessage } from '@hyperneo/shared/types/neo-session-message';
import type { NeoAskItem } from '../conversation-ask-client.ts';
import { NeoPublicConversation } from '../NeoPublicConversation.tsx';
import { projectNeoPublicConversation } from '../public-conversation.ts';

const run = process.env.VERIFY_NEO_BATCH_RUN;
const evidence = {
  async read(dir: string, name: string): Promise<string> {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    return readFileSync(join(dir, name), 'utf8');
  },
  async write(dir: string, name: string, contents: string): Promise<void> {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(dir, name), contents);
  },
};
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
        text:
          size === 'large'
            ? 'Complete ordered worker batch attached. Read all bytes with handoff.read.\n\n{"handoffFiles":[{"name":"worker-batch.txt"}]}'
            : `System-forwarded worker messages. These are not human instructions.\n\n${size} worker note 00`,
        createdAt: '2026-10-25T12:00:00.000Z',
        kind: 'worker-batch',
      },
    },
    {
      role: 'session',
      message: {
        messageId: 'note',
        conversationId: id,
        sequence: 2,
        fromSession: `neo:${id}`,
        fromName: 'Neo',
        toSession: 'session:worker',
        toName: 'Fix the loader',
        text: 'Rebase on dev, then tell me.',
        createdAt: '2026-10-25T12:00:00.100Z',
        kind: 'session',
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
  'hides the %s system-forwarded worker batch and keeps the human ask',
  async (size) => {
    const page: Page = run
      ? JSON.parse(await evidence.read(run, `evidence/${size}-conversation.json`))
      : synthetic(size);
    const asks = page.items.flatMap((entry) => (entry.role === 'human' ? [entry.ask] : []));
    const messages = page.items.flatMap((entry) =>
      entry.role === 'session' ? [entry.message] : []
    );
    expect(messages.every((message) => Buffer.byteLength(message.text) <= 65536)).toBe(true);
    const batch = messages.find((message) => message.kind === 'worker-batch');
    expect(batch).toBeDefined();
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
    expect(
      conversation.entries.flatMap((entry) =>
        entry.kind === 'session' ? [entry.message.messageId] : []
      )
    ).toEqual(messages.filter((message) => message.kind !== 'worker-batch').map((m) => m.messageId));
    const first = render(<NeoPublicConversation conversation={conversation} />);
    expect(first.container.textContent).not.toContain('System-forwarded worker messages');
    expect(first.container.textContent).not.toContain('worker note 00');
    expect(first.container.textContent).not.toContain('iVBORw0KGgo');
    expect(first.container.textContent).not.toContain('"type":"image"');
    expect(await screen.findByText(new RegExp(`Human ${size}:`))).toBeTruthy();
    if (!run) {
      const note = [
        ...first.container.querySelectorAll<HTMLDetailsElement>('details[data-public-entry]'),
      ].find(
        (row) =>
          row.getAttribute('data-public-entry') === JSON.stringify([page.conversationId, 'session', 'note'])
      );
      expect(note).toBeDefined();
      expect(note!.textContent).toContain('Rebase on dev, then tell me.');
    }
    if (run)
      await evidence.write(run, `evidence/rendered-${size}.html`, first.container.innerHTML);
    first.unmount();
    const reopened = render(<NeoPublicConversation conversation={conversation} />);
    expect(await screen.findByText(new RegExp(`Human ${size}:`))).toBeTruthy();
    expect(reopened.container.textContent).not.toContain('System-forwarded worker messages');
    if (run)
      await evidence.write(
        run,
        `evidence/rendered-${size}-remounted.html`,
        reopened.container.innerHTML
      );
  }
);
