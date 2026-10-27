import type { AgentProcessingState, ChatMessage, SessionState } from '@hyperneo/shared';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import { signal } from '@preact/signals';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  artifactPreviewStack,
  artifactPreviewWorkspace,
  closeArtifactPreview,
} from '../../lib/artifact-preview-store.ts';
import type { SessionStore } from '../../lib/session-store.ts';
import { connectionState } from '../../lib/state.ts';
import { NeoConversation } from '../NeoConversation.tsx';
import { NeoPublicConversation, PendingAsk, publicAskText } from '../NeoPublicConversation.tsx';
import { projectNeoPublicConversation } from '../public-conversation.ts';
import { neoMessageAnchor } from '../reply-context.ts';

const clipboard = vi.hoisted(() => vi.fn(async () => true));
const initialConnectionState = connectionState.value;
vi.mock('../../lib/utils.ts', async (original) => ({
  ...(await original<typeof import('../../lib/utils.ts')>()),
  copyToClipboard: clipboard,
}));
const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const holder = 'neo:holder:fictional';
const original = { sessionId: root, messageId: 'original' };
const photo = {
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'YWJj' },
};
const ask = (fields: Partial<NeoConversationAsk> = {}): NeoConversationAsk => ({
  conversationId,
  requestId: 'original',
  askOrigin: original,
  content: 'Compare **fictional sources**.',
  sequence: 1,
  createdAt: '2026-09-30T12:00:00Z',
  ...fields,
});
const publication = (fields: Partial<NeoPublication> = {}): NeoPublication => ({
  conversationId,
  publicationId: '20000000-0000-4000-8000-000000000001',
  askOrigin: original,
  producerInput: { sessionId: holder, messageId: 'neo-consult:fictional:request' },
  shortText:
    '## Evidence\n\n| Source | Finding |\n| --- | --- |\n| A | Different |\n\n> Reported evidence, not verified completion.\n\n```text\nFictional detail\n```',
  fullText:
    '## Evidence\n\n| Source | Finding |\n| --- | --- |\n| A | Different |\n\n> Reported evidence, not verified completion.\n\n```text\nFictional detail\n```',
  links: [
    { kind: 'project', id: 'fictional', label: 'Source context' },
    { kind: 'consultation', id: 'fictional-check', label: 'Read comparison' },
    { kind: 'work', id: 'fictional-work', label: 'Read work detail' },
  ],
  sequence: 1,
  createdAt: '2026-09-30T12:00:01Z',
  ...fields,
});
const conversation = (asks = [ask()], publications = [publication()]) =>
  projectNeoPublicConversation(
    root,
    {
      conversationId,
      status: 'ready',
      items: asks,
      nextAfter: asks.length,
      hasMore: false,
      hasEarlier: false,
    },
    {
      conversationId,
      status: 'ready',
      items: publications,
      nextAfter: publications.length,
      hasMore: false,
      hasEarlier: false,
    }
  );

afterEach(() => {
  cleanup();
  closeArtifactPreview();
  connectionState.value = initialConnectionState;
  vi.clearAllMocks();
});

describe('message preview references', () => {
  const previewContext = {
    artifactId: 'registered-report',
    snapshot: 'a'.repeat(64),
    displayName: 'Synthetic report',
    state: 'available' as const,
  };
  it.each([false, true])('opens an exact available reference from pending: %s', (pending) => {
    if (pending)
      render(
        <PendingAsk
          ask={{
            requestId: 'bound',
            sessionId: root,
            text: 'About this report',
            images: [],
            createdAt: '2026-10-25T12:00:00Z',
            state: 'sending',
            previewContext,
          }}
        />
      );
    else
      render(<NeoPublicConversation conversation={conversation([ask({ previewContext })], [])} />);
    const button = screen.getByRole('button', { name: /Preview.*Synthetic report.*aaaaaaaa/ });
    fireEvent.click(button);
    expect(artifactPreviewStack.value.at(-1)).toEqual({
      kind: 'artifact',
      artifactId: previewContext.artifactId,
    });
    fireEvent.click(button);
    expect(
      artifactPreviewWorkspace.state.value.files.filter(
        (file) => file.artifactId === previewContext.artifactId
      )
    ).toHaveLength(1);
  });
  it('shows an unavailable snapshot without opening a replacement', () => {
    render(
      <NeoPublicConversation
        conversation={conversation(
          [ask({ previewContext: { ...previewContext, state: 'unavailable' } })],
          []
        )}
      />
    );
    const button = screen.getByRole('button', {
      name: /Preview unavailable.*Synthetic report.*aaaaaaaa/,
    });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(artifactPreviewStack.value).toHaveLength(0);
  });
});

describe('durable public conversation presentation', () => {
  it('renders authored Markdown, attachment photos, timestamps and acceptance without SDK messages', async () => {
    const value = ask({
      content: [
        {
          type: 'text',
          text: 'Compare **fictional sources**.\n\n### Attached file: notes.txt\n\n```text\nUnchanged attached text\n```',
        },
        photo,
      ],
    });
    const { container } = render(<NeoPublicConversation conversation={conversation([value])} />);
    await waitFor(() => expect(container.querySelector('table')).toBeTruthy());
    const article = document.getElementById(neoMessageAnchor(root, 'original'))!;
    expect(within(article).getByRole('img', { name: 'Attached photo 1' }).getAttribute('src')).toBe(
      'data:image/png;base64,YWJj'
    );
    expect(within(article).getByRole('img', { name: 'Message accepted' }).title).toContain(
      'does not mean work is complete'
    );
    expect(article.querySelector('strong')?.textContent).toBe('fictional sources');
    expect(article.querySelector('pre code')?.textContent).toContain('Unchanged attached text');
    expect(article.querySelector('time')?.dateTime).toBe(new Date(value.createdAt).toISOString());
    expect(article.querySelector('time')?.closest('.neo-message-bubble')).toBeNull();
    expect(within(article).getByText('You').closest('.neo-message-bubble')).toBeNull();
    expect(container.querySelectorAll('[aria-label="Message accepted"]')).toHaveLength(1);
    expect(container.querySelectorAll('article')).toHaveLength(2);
  });

  it('marks an ask Neo never got and hands it back for editing', () => {
    const failed = ask({
      content: [{ type: 'text', text: 'drop it' }, photo],
      delivery: { state: 'failed' },
    });
    const onEditUndelivered = vi.fn();
    render(
      <NeoPublicConversation
        conversation={conversation([failed], [])}
        onEditUndelivered={onEditUndelivered}
      />
    );
    expect(screen.queryByLabelText('Message accepted')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'more — Not delivered: Neo never got this message.' })
    );
    expect(screen.getByText('Not delivered: Neo never got this message.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Edit and send again'));
    expect(onEditUndelivered).toHaveBeenCalledWith(failed);
    expect(screen.queryByLabelText('Edit and send again')).toBeNull();
    expect(localStorage.setItem).toHaveBeenCalledWith(
      'neo:restored-undelivered',
      JSON.stringify([failed.requestId])
    );
    vi.mocked(localStorage.getItem).mockReturnValueOnce(JSON.stringify([failed.requestId]));
    cleanup();
    render(
      <NeoPublicConversation
        conversation={conversation([failed], [])}
        onEditUndelivered={onEditUndelivered}
      />
    );
    expect(screen.queryByLabelText('Edit and send again')).toBeNull();
  });

  it('keeps the edit action when the composer refuses the photos', () => {
    const failed = ask({ delivery: { state: 'failed' } });
    render(
      <NeoPublicConversation
        conversation={conversation([failed], [])}
        onEditUndelivered={() => false}
      />
    );
    fireEvent.click(screen.getByLabelText('Edit and send again'));
    expect(screen.getByLabelText('Edit and send again')).toBeTruthy();
  });

  it('shows no edit action on a delivered ask', () => {
    render(
      <NeoPublicConversation conversation={conversation([ask()], [])} onEditUndelivered={vi.fn()} />
    );
    expect(screen.getByLabelText('Message accepted')).toBeTruthy();
    expect(screen.queryByLabelText('Edit and send again')).toBeNull();
  });

  it.each(['Short ending.', 'A long ending that fills the available line. '.repeat(16)])(
    'keeps collapsed and expanded controls right-aligned for %s without body toggles',
    async (ending) => {
      const value = publication({
        shortText: `Preview ${ending}`,
        fullText: `Full details\n\n${ending}`,
      });
      const { container } = render(
        <NeoPublicConversation conversation={conversation([], [value])} />
      );
      const more = await screen.findByRole('button', { name: /more$/ });
      expect(getComputedStyle(more).getPropertyValue('float')).toBe('right');
      fireEvent.click(screen.getByText((value.shortText ?? '').trim()));
      expect(container.querySelector('[data-publication-details]')).toBeNull();
      fireEvent.click(more);
      const less = await screen.findByRole('button', { name: /less$/ });
      expect(getComputedStyle(less).getPropertyValue('float')).toBe('right');
      fireEvent.click(screen.getByText(ending.trim(), { exact: true }));
      expect(container.querySelector('[data-publication-details]')).toBeTruthy();
      expect(less.getAttribute('aria-expanded')).toBe('true');
    }
  );

  it('copies the whole Markdown message while Details copy stays block-only', async () => {
    const value = publication({ shortText: 'The comparison is ready. Nothing has been executed.' });
    const { container } = render(
      <NeoPublicConversation conversation={conversation([], [value])} />
    );
    expect(container.querySelector('details')).toBeNull();
    const more = await screen.findByRole('button', { name: /^more$/ });
    expect(more.closest('p')?.textContent).toContain(value.shortText);
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('table')).toBeNull();
    fireEvent.click(more);
    await waitFor(() => expect(container.querySelector('table')).toBeTruthy());
    expect(container.querySelector('blockquote')?.textContent).toContain('not verified completion');
    expect(container.querySelector('pre code')?.textContent).toContain('Fictional detail');
    expect(screen.queryByRole('button', { name: /^more$/ })).toBeNull();
    expect(container.querySelector('[data-publication-details] table')).toBeTruthy();
    const copyDetails = screen.getByRole('button', { name: 'Copy details' });
    expect(copyDetails.closest('[data-publication-details]')).toBeTruthy();
    expect(copyDetails.parentElement?.textContent).toBe('Details');
    fireEvent.click(copyDetails);
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(value.fullText));
    const copyMessage = screen.getByRole('button', { name: 'Copy Neo’s message' });
    fireEvent.click(copyMessage);
    await waitFor(() =>
      expect(clipboard).toHaveBeenLastCalledWith(`${value.shortText}\n\n${value.fullText}`)
    );
    const less = await screen.findByRole('button', { name: /^less$/ });
    expect(less.closest('[data-publication-details]')).toBeTruthy();
    fireEvent.click(less);
    expect(container.querySelector('[data-publication-details]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy details' })).toBeNull();
    expect(await screen.findByRole('button', { name: /^more$/ })).toBeTruthy();
    fireEvent.click(copyMessage);
    await waitFor(() =>
      expect(clipboard).toHaveBeenLastCalledWith(`${value.shortText}\n\n${value.fullText}`)
    );
    expect(container.querySelector('script')).toBeNull();
  });

  it.each([
    ['Only **short** source', '', 'Only **short** source'],
    [undefined, 'Only **full** source', 'Only **full** source'],
    ['Same **source**', 'Same **source**', 'Same **source**'],
  ])('copies single-part source once: %s', async (shortText, fullText, expected) => {
    render(
      <NeoPublicConversation
        conversation={conversation([], [publication({ shortText, fullText })])}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy Neo’s message' }));
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(expected));
  });

  it('renders a verbatim publication in full with no more control and copies the whole content', async () => {
    const value = publication({
      verbatim: true,
      shortText: undefined,
      fullText:
        '## Sent as is\n\nThe entire message arrives uncollapsed.\n\n| Source | Finding |\n| --- | --- |\n| A | Different |\n\n> Reported evidence, not verified completion.\n\n```text\nFictional detail\n```',
    });
    const { container } = render(
      <NeoPublicConversation conversation={conversation([], [value])} />
    );
    await waitFor(() => expect(container.querySelector('table')).toBeTruthy());
    expect(container.querySelector('blockquote')?.textContent).toContain('not verified completion');
    expect(container.querySelector('pre code')?.textContent).toContain('Fictional detail');
    expect(screen.queryByRole('button', { name: /^more$/ })).toBeNull();
    expect(container.querySelector('[data-publication-details]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy Neo’s message' }));
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(value.fullText));
  });

  it('renders a verbatim publication in full even when a short text arrives too', async () => {
    const value = publication({
      verbatim: true,
      shortText: 'A short preview that must not collapse the message.',
      fullText: 'The entire message arrives uncollapsed, from first line to last line.',
    });
    const { container } = render(
      <NeoPublicConversation conversation={conversation([], [value])} />
    );
    await waitFor(() => expect(container.textContent).toContain('from first line to last line'));
    expect(screen.queryByRole('button', { name: /^more$/ })).toBeNull();
    expect(container.querySelector('[data-publication-details]')).toBeNull();
  });

  it.each(['ask', 'publication'])(
    'preserves native right-click on a text %s and the Reply button',
    (kind) => {
      const quote = vi.fn();
      const { container } = render(
        <NeoPublicConversation
          conversation={
            kind === 'ask' ? conversation([ask()], []) : conversation([], [publication()])
          }
          onQuote={quote}
        />
      );
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      fireEvent(container.querySelector('[data-public-entry]')!, event);
      expect(event.defaultPrevented).toBe(false);
      expect(screen.queryByRole('menu')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /Reply to .*message/ }));
      expect(quote).toHaveBeenCalledOnce();
    }
  );

  it('offers select, copy and reply on a touch long press, and copying flips the footer icon', async () => {
    const quote = vi.fn();
    const value = publication({ shortText: 'Short.', links: [] });
    const { container } = render(
      <NeoPublicConversation conversation={conversation([], [value])} onQuote={quote} />
    );
    const entry = container.querySelector('[data-public-entry]')!;
    fireEvent.touchStart(entry, { touches: [{ clientX: 10, clientY: 10 }] });
    await screen.findByRole('menu', { name: 'Message actions' });
    const menu = screen.getByRole('menu', { name: 'Message actions' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['Select text', 'Copy', 'Reply']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy' }));
    await waitFor(() =>
      expect(clipboard).toHaveBeenLastCalledWith(`${value.shortText}\n\n${value.fullText}`)
    );
    await waitFor(() => expect(screen.getByTitle('Copied!')).toBeTruthy());
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.touchStart(entry, { touches: [{ clientX: 10, clientY: 10 }] });
    await screen.findByRole('menu', { name: 'Message actions' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reply' }));
    expect(quote).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ author: 'Neo', text: value.shortText })
    );
  });

  it('leaves the native menu alone on a message with no text to copy', () => {
    const { container } = render(
      <NeoPublicConversation conversation={conversation([ask({ content: [photo] })], [])} />
    );
    fireEvent.contextMenu(container.querySelector('[data-public-entry]')!, {
      clientX: 1,
      clientY: 1,
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows each message status with what it means', () => {
    render(
      <NeoPublicConversation
        conversation={conversation([ask()], [])}
        statuses={new Map([['original', 'working' as const]])}
      />
    );
    const status = screen.getByText('Working');
    expect(status.getAttribute('title')).toBe('Neo is working on this message now.');
  });

  it.each(['received', 'queued', 'working', 'read', 'answered', 'failed'] as const)(
    'renders daemon status %s without guessing from an unrelated active turn',
    (messageStatus) => {
      connectionState.value = 'connected';
      const state: AgentProcessingState = {
        status: 'processing',
        messageId: 'unrelated-system-input',
        phase: 'thinking',
      };
      const store = {
        sdkMessages: signal([]),
        agentState: signal(state),
        activeSessionId: signal(root),
        sessionState: signal({ sessionInfo: { id: root }, agentState: state } as SessionState),
        isRecovering: signal(false),
        hasMoreMessages: signal(false),
        error: signal(null),
        refresh: vi.fn(),
      } as unknown as SessionStore;
      const { container } = render(
        <NeoConversation
          store={store}
          sessionId={root}
          publicConversation={conversation([ask({ messageStatus })], [])}
        />
      );
      const shown = container.querySelector('[data-message-status]');
      expect(shown?.getAttribute('data-message-status')).toBe(messageStatus);
      expect(shown?.textContent).toBe(messageStatus[0].toUpperCase() + messageStatus.slice(1));
    }
  );

  it('revises one stable bubble and opens the saved versions without changing copy or reply', async () => {
    const onQuote = vi.fn();
    const initial = publication({ shortText: 'Original summary', fullText: 'Original **detail**' });
    const view = render(
      <NeoPublicConversation conversation={conversation([ask()], [initial])} onQuote={onQuote} />
    );
    const bubble = view.container.querySelector('.neo-message-assistant')!;
    const originalTime = bubble.querySelector('time')!.dateTime;
    expect(screen.queryByRole('button', { name: /Edited/ })).toBeNull();
    const revised = {
      ...initial,
      revisionId: '30000000-0000-4000-8000-000000000003',
      editedAt: '2026-09-30T12:10:00Z',
      shortText: 'Latest summary',
      fullText: 'Latest **detail**',
      revisions: [
        {
          revisionId: initial.publicationId,
          shortText: initial.shortText,
          fullText: initial.fullText,
          createdAt: initial.createdAt,
          producerInput: initial.producerInput,
        },
        {
          revisionId: '30000000-0000-4000-8000-000000000002',
          shortText: 'Middle summary',
          fullText: 'Middle detail',
          createdAt: '2026-09-30T12:05:00Z',
          producerInput: initial.producerInput,
        },
      ],
    };
    view.rerender(
      <NeoPublicConversation conversation={conversation([ask()], [revised])} onQuote={onQuote} />
    );
    expect(view.container.querySelector('.neo-message-assistant')).toBe(bubble);
    expect(view.container.querySelectorAll('article')).toHaveLength(2);
    expect(bubble.querySelector('time')!.dateTime).toBe(originalTime);
    await screen.findByText('Latest summary');
    expect(screen.queryByRole('region', { name: 'Revision history' })).toBeNull();
    const edited = screen.getByRole('button', { name: 'more — Edited: show revision history' });
    fireEvent.click(edited);
    expect(edited.getAttribute('aria-expanded')).toBe('true');
    const history = screen.getByRole('region', { name: 'Revision history' });
    expect(edited.getAttribute('aria-controls')).toBe(history.id);
    await waitFor(() => expect(within(history).getByText('Middle detail')).toBeTruthy());
    await waitFor(() => expect(history.querySelectorAll('strong')).toHaveLength(2));
    expect(
      within(history)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual([
      expect.stringContaining('Original detail'),
      expect.stringContaining('Middle detail'),
      expect.stringContaining('Latest detail'),
    ]);
    expect(within(history).getByText('Original', { selector: 'span' })).toBeTruthy();
    expect(within(history).getByText('Current')).toBeTruthy();
    expect([...history.querySelectorAll('time')].map((time) => time.dateTime)).toEqual([
      new Date(initial.createdAt).toISOString(),
      '2026-09-30T12:05:00.000Z',
      '2026-09-30T12:10:00.000Z',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Copy Neo’s message' }));
    await waitFor(() =>
      expect(clipboard).toHaveBeenCalledWith('Latest summary\n\nLatest **detail**')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reply to Neo’s message' }));
    expect(onQuote).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Latest summary', anchor: bubble.id })
    );
    fireEvent.click(edited);
    expect(edited.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Revision history' })).toBeNull();
  });

  it('keeps legacy edited messages readable without inventing missing versions', () => {
    render(
      <NeoPublicConversation
        conversation={conversation(
          [ask()],
          [
            publication({
              editedAt: '2026-09-30T12:05:00Z',
              shortText: 'Saved reply',
              fullText: 'Saved reply',
            }),
          ]
        )}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Edited/ }));
    const history = screen.getByRole('region', { name: 'Revision history' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(1);
    expect(within(history).getByText('Current')).toBeTruthy();
    expect(within(history).queryByText('Original')).toBeNull();
  });

  it('leaves references as text when the scene owner is absent instead of creating inert controls', () => {
    render(<NeoPublicConversation conversation={conversation()} />);
    const refs = screen.getByRole('list', { name: 'Related Neo scenes' });
    expect(within(refs).getByText('Read work detail')).toBeTruthy();
    expect(within(refs).queryAllByRole('button')).toEqual([]);
  });

  it('labels every producer as Neo without holder names or private session ids', () => {
    const reply = publication({
      publicationId: '20000000-0000-4000-8000-000000000002',
      producerInput: { sessionId: root, messageId: original.messageId },
      sequence: 2,
    });
    const { container } = render(
      <NeoPublicConversation conversation={conversation([], [publication(), reply])} />
    );
    expect(screen.getAllByText('Neo', { exact: true })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Neo', exact: true })).toBeNull();
    expect(screen.queryByText('Fictional holder name')).toBeNull();
    expect(screen.queryByText('Context holder')).toBeNull();
    expect(container.textContent).not.toContain(holder);
  });

  it('does not quote the original ask inside a reply', () => {
    render(<NeoPublicConversation conversation={conversation()} />);
    expect(screen.queryByRole('button', { name: 'Return to your request' })).toBeNull();
    expect(screen.queryByText('Original request is outside this view.')).toBeNull();
  });

  it('retains stable entry nodes across reloads with the same durable ids', () => {
    const first = conversation();
    const { container, rerender } = render(<NeoPublicConversation conversation={first} />);
    const entries = Array.from(container.querySelectorAll('article'));
    rerender(<NeoPublicConversation conversation={conversation([ask()], [publication()])} />);
    expect(container.querySelectorAll('article')[0]).toBe(entries[0]);
    expect(container.querySelectorAll('article')[1]).toBe(entries[1]);
    rerender(<NeoPublicConversation conversation={conversation([], [publication()])} />);
    expect(container.querySelector('article')).toBe(entries[1]);
  });

  it.each(['foreign-root', 'duplicate-publication'])(
    'does not claim retained messages after the %s projection gate rejects',
    (reason) => {
      const value =
        reason === 'foreign-root'
          ? projectNeoPublicConversation(
              'native-execution-session',
              {
                conversationId,
                status: 'ready',
                items: [],
                nextAfter: 0,
                hasMore: false,
                hasEarlier: false,
              },
              {
                conversationId,
                status: 'ready',
                items: [],
                nextAfter: 0,
                hasMore: false,
                hasEarlier: false,
              }
            )
          : conversation([], [publication(), publication()]);
      expect(value.status).toBe('unavailable');
      expect(value.entries).toEqual([]);
      const store = {
        sdkMessages: signal([]),
        agentState: signal({ status: 'idle' }),
        hasMoreMessages: signal(false),
        error: signal(null),
        refresh: vi.fn(),
      } as unknown as SessionStore;
      const { container } = render(
        <NeoConversation store={store} sessionId={root} publicConversation={value} />
      );
      expect(screen.getByRole('status').textContent).toBe('Saved conversation is unavailable.');
      expect(container.querySelectorAll('[data-public-entry]')).toHaveLength(0);
      expect(screen.queryByText(/Showing retained messages/)).toBeNull();
    }
  );

  it('does not insert a transient loading row above retained messages during a refresh', async () => {
    const { rerender } = render(<NeoPublicConversation conversation={conversation()} />);
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<NeoPublicConversation conversation={{ ...conversation(), status: 'loading' }} />);
    expect(await screen.findByText('Fictional detail')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    rerender(
      <NeoPublicConversation conversation={{ ...conversation([], []), status: 'loading' }} />
    );
    expect(screen.getByRole('status').textContent).toContain('Loading saved');
  });

  it.each(['loading', 'unavailable'] as const)(
    'shows %s state while preserving retained rows and honest window limits',
    async (status) => {
      render(
        <NeoPublicConversation conversation={{ ...conversation(), status, hasEarlier: true }} />
      );
      if (status === 'loading') expect(screen.queryByRole('status')).toBeNull();
      else expect(screen.getByRole('status').textContent).toContain('unavailable');
      expect(screen.getByText('Showing part of your saved conversation.')).toBeTruthy();
      expect(await screen.findByText('Fictional detail')).toBeTruthy();
      if (status === 'unavailable')
        expect(screen.getByRole('status').textContent).toContain('Showing retained messages.');
      expect(screen.queryByText('Work complete')).toBeNull();
    }
  );

  it('keeps image-only asks visible and disables copying absent text', () => {
    render(<NeoPublicConversation conversation={conversation([ask({ content: [photo] })], [])} />);
    expect(screen.getByRole('img', { name: 'Attached photo 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy your message' }).hasAttribute('disabled')).toBe(
      true
    );
    expect(screen.getByRole('img', { name: 'Message accepted' })).toBeTruthy();
  });

  it('treats scene labels as text, not markup or external paths', () => {
    const label = '<img src=x onerror=alert(1)>';
    const { container } = render(
      <NeoPublicConversation
        conversation={conversation(
          [],
          [publication({ links: [{ kind: 'work', id: 'fictional', label }] })]
        )}
      />
    );
    expect(screen.getByText(label)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });

  it('uses the optional native conversation seam without showing SDK execution text or fabricated messages', async () => {
    const messages = [
      {
        type: 'assistant',
        uuid: 'execution',
        message: { role: 'assistant', content: 'Private execution transcript' },
      },
      { type: 'result', uuid: 'finished' },
    ] as unknown as ChatMessage[];
    const store = {
      sdkMessages: signal(messages),
      agentState: signal({ status: 'idle' }),
      hasMoreMessages: signal(false),
      error: signal(null),
      refresh: vi.fn(),
    } as unknown as SessionStore;
    const { rerender } = render(
      <NeoConversation store={store} sessionId={root} publicConversation={conversation()} />
    );
    expect(await screen.findByText('Fictional detail')).toBeTruthy();
    expect(screen.queryByText('Private execution transcript')).toBeNull();
    expect(store.sdkMessages.value).toBe(messages);
    rerender(<NeoConversation store={store} sessionId={root} />);
    expect(screen.queryByText('Private execution transcript')).toBeNull();
    expect(screen.queryByText('Fictional detail')).toBeNull();
  });

  it.each([false, true])(
    'uses only durable history limits in public mode (partial=%s)',
    (partial) => {
      const store = {
        sdkMessages: signal([]),
        agentState: signal({ status: 'idle' }),
        hasMoreMessages: signal(true),
        error: signal(null),
        refresh: vi.fn(),
      } as unknown as SessionStore;
      const value = { ...conversation([], []), hasEarlier: partial, hasMore: partial };
      const view = render(
        <NeoConversation store={store} sessionId={root} publicConversation={value} />
      );
      expect(screen.queryByText(/Showing recent conversation/)).toBeNull();
      expect(screen.queryByRole('link', { name: 'Open full history ↗' })).toBeNull();
      expect(!!screen.queryByText('Showing part of your saved conversation.')).toBe(partial);
      expect(store.hasMoreMessages.value).toBe(true);
      view.rerender(<NeoConversation store={store} sessionId={root} />);
      expect(screen.queryByText(/Showing recent conversation/)).toBeNull();
      expect(screen.queryByRole('link', { name: 'Open full history ↗' })).toBeNull();
      expect(screen.queryByText('Showing part of your saved conversation.')).toBeNull();
    }
  );

  it('keeps the same native question owner and local selection when the public view reloads', () => {
    const pendingQuestion = {
      toolUseId: 'fictional-choice',
      askedAt: 1,
      questions: [
        {
          question: 'Which draft?',
          header: 'Draft',
          multiSelect: false,
          options: [{ label: 'Keep draft', description: 'No execution' }],
        },
      ],
    };
    const store = {
      sdkMessages: signal([]),
      agentState: signal({ status: 'waiting_for_input', pendingQuestion }),
      hasMoreMessages: signal(false),
      error: signal(null),
      refresh: vi.fn(),
    } as unknown as SessionStore;
    const { rerender } = render(
      <NeoConversation store={store} sessionId={root} publicConversation={conversation()} />
    );
    const option = screen.getByRole('button', { name: /Keep draft/ });
    const submit = screen.getByRole('button', { name: 'Send answer' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(option);
    expect(submit.hasAttribute('disabled')).toBe(false);
    rerender(
      <NeoConversation
        store={store}
        sessionId={root}
        publicConversation={conversation([], [publication()])}
      />
    );
    expect(screen.getAllByRole('button', { name: /Keep draft/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Keep draft/ })).toBe(option);
    expect(screen.getByRole('button', { name: 'Send answer' })).toBe(submit);
    expect(submit.hasAttribute('disabled')).toBe(false);
  });

  it('selects only authored text blocks while preserving their contents', () => {
    expect(publicAskText('13.')).toBe('13.');
    expect(
      publicAskText([{ type: 'text', text: 'First' }, photo, { type: 'text', text: 'Second' }])
    ).toBe('First\n\nSecond');
    expect(publicAskText([photo])).toBe('');
  });
});

describe('PendingAsk', () => {
  const pending = (state: 'sending' | 'accepted' | 'failed') => ({
    requestId: 'pending-1',
    sessionId: root,
    text: 'Re-run the research',
    images: [],
    createdAt: '2026-10-07T13:58:00.000Z',
    state,
    ...(state === 'failed' ? { reason: 'Neo is busy.' } : {}),
  });

  it('shows a spinner while sending and the double check once accepted', () => {
    const view = render(<PendingAsk ask={pending('sending')} />);
    expect(screen.getByRole('img', { name: 'Sending' })).toBeTruthy();
    view.rerender(<PendingAsk ask={pending('accepted')} />);
    expect(screen.queryByRole('img', { name: 'Sending' })).toBeNull();
    expect(screen.getByRole('img', { name: 'Message accepted' })).toBeTruthy();
  });

  it('marks a failed ask with a reason on tap, a red border, and icon-only Retry and Edit', () => {
    const onRetry = vi.fn();
    const onEdit = vi.fn();
    const { container } = render(
      <PendingAsk ask={pending('failed')} onRetry={onRetry} onEdit={onEdit} />
    );
    expect(container.querySelector('.neo-message-bubble')?.className).toContain('!border-danger');
    expect(screen.queryByText('Not sent: Neo is busy.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'more — Not sent: Neo is busy.' }));
    expect(screen.getByText('Not sent: Neo is busy.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onRetry).toHaveBeenCalledWith('pending-1');
    expect(onEdit).toHaveBeenCalledWith('pending-1');
  });
});

describe('session notice rows', () => {
  const notice = (n: number, kind: 'needs_you' | 'finished', link?: string) => ({
    key: `claude-desktop::s${n}`,
    ref: { adapter: 'claude-desktop', id: `s${n}` },
    title: `Session ${n}`,
    kind,
    at: 1_790_000_000_000 + n,
    ...(link ? { link } : {}),
  });

  it('shows each session with its own Open link, and the rest behind a more button', () => {
    const notices = [
      notice(1, 'needs_you', 'claude://resume?session=s1'),
      notice(2, 'finished', 'javascript:alert(1)'),
      ...[3, 4, 5, 6, 7].map((n) => notice(n, 'finished')),
    ];
    render(
      <NeoPublicConversation
        conversation={{
          conversationId: 'c1',
          status: 'ready',
          hasEarlier: false,
          hasMore: false,
          entries: [
            {
              kind: 'notices',
              key: 'notices:1',
              group: { id: 'g1', at: notices[0].at, line: '', notices },
            },
          ],
        }}
      />
    );
    const row = screen.getByRole('note');
    expect(row.textContent).toContain('Claude · Session 1 needs you');
    expect(
      within(row)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href'))
    ).toEqual(['claude://resume?session=s1']);
    expect(row.textContent).not.toContain('Session 6');
    fireEvent.click(within(row).getByRole('button', { name: '2 more' }));
    expect(row.textContent).toContain('Session 7 finished');
  });

  it('mutes a session from its row, and offers to unmute one already muted', () => {
    const onMute = vi.fn();
    const notices = [notice(1, 'finished'), notice(2, 'needs_you')];
    render(
      <NeoPublicConversation
        mute={{ muted: new Set([notices[1].key]), onMute }}
        conversation={{
          conversationId: 'c1',
          status: 'ready',
          hasEarlier: false,
          hasMore: false,
          entries: [
            {
              kind: 'notices',
              key: 'notices:1',
              group: { id: 'g1', at: notices[0].at, line: '', notices },
            },
          ],
        }}
      />
    );
    const row = screen.getByRole('note');
    fireEvent.click(within(row).getByRole('button', { name: 'Mute Session 1' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Unmute Session 2' }));
    expect(onMute.mock.calls).toEqual([
      [notices[0].key, true],
      [notices[1].key, false],
    ]);
  });

  it('gives each session its own row with Mute first, Open last and the time only once', () => {
    const notices = [
      notice(1, 'finished', 'claude://resume?session=s1'),
      notice(2, 'needs_you', 'claude://resume?session=s2'),
    ];
    const { container } = render(
      <NeoPublicConversation
        mute={{ muted: new Set(), onMute: vi.fn() }}
        conversation={{
          conversationId: 'c1',
          status: 'ready',
          hasEarlier: false,
          hasMore: false,
          entries: [
            {
              kind: 'notices',
              key: 'notices:1',
              group: { id: 'g1', at: notices[0].at, line: '', notices },
            },
          ],
        }}
      />
    );
    const rows = [...container.querySelectorAll('[data-notice]')];
    expect(rows).toHaveLength(2);
    for (const [index, row] of rows.entries()) {
      const controls = [...row.querySelectorAll('a, button')];
      expect(controls.map((control) => control.textContent)).toEqual(['Mute', 'Open']);
      expect(row.querySelectorAll('time')).toHaveLength(index === 0 ? 1 : 0);
    }
  });
});
