import type { AgentProcessingState, ChatMessage, SessionState } from '@hyperneo/shared';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import { signal } from '@preact/signals';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '../../lib/session-store.ts';
import { connectionState } from '../../lib/state.ts';
import { NeoConversation } from '../NeoConversation.tsx';
import { NeoPublicConversation, publicAskText } from '../NeoPublicConversation.tsx';
import { projectNeoProcessingActivity } from '../processing-activity.ts';
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
  shortText: 'The comparison is ready. Nothing has been executed.',
  fullText:
    '## Evidence\n\n| Source | Finding |\n| --- | --- |\n| A | Different |\n\n> Reported evidence, not verified completion.\n\n```text\nFictional detail\n```',
  links: [
    { kind: 'concern', id: 'fictional', label: 'Source context' },
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
  connectionState.value = initialConnectionState;
  vi.clearAllMocks();
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

  it('shows the full reply inline and copies it without adding scene labels', async () => {
    const value = publication();
    const { container } = render(
      <NeoPublicConversation conversation={conversation([], [value])} />
    );
    expect(container.querySelector('details')).toBeNull();
    await waitFor(() => expect(container.querySelector('table')).toBeTruthy());
    expect(container.querySelector('blockquote')?.textContent).toContain('not verified completion');
    expect(container.querySelector('pre code')?.textContent).toContain('Fictional detail');
    expect(screen.queryByText(value.shortText)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy Neo’s message' }));
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(value.fullText));
    expect(container.querySelector('script')).toBeNull();
  });

  it('opens only work references through the owning callback, never as native actions', () => {
    const open = vi.fn();
    render(<NeoPublicConversation conversation={conversation()} onOpenScene={open} />);
    const refs = screen.getByRole('list', { name: 'Related Neo scenes' });
    fireEvent.click(within(refs).getByRole('button', { name: 'Read work detail' }));
    expect(open).toHaveBeenCalledExactlyOnceWith({ kind: 'work', id: 'fictional-work' });
    expect(within(refs).queryByText('Source context')).toBeNull();
    expect(within(refs).queryByText('Read comparison')).toBeNull();
    for (const name of ['Start', 'Stop', 'Decline'])
      expect(screen.queryByRole('button', { name, exact: true })).toBeNull();
    expect(refs.querySelector('a')).toBeNull();
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

  it.each(['loading', 'unavailable'] as const)(
    'shows %s state while preserving retained rows and honest window limits',
    async (status) => {
      render(
        <NeoPublicConversation conversation={{ ...conversation(), status, hasEarlier: true }} />
      );
      expect(screen.getByRole('status').textContent).toContain(
        status === 'loading' ? 'Loading saved' : 'unavailable'
      );
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

  it.each([
    [{ status: 'processing', phase: 'thinking' }, 'Neo is working on a reply…'],
    [{ status: 'rate_limit_cooldown' }, 'Neo is waiting to retry…'],
    [{ status: 'queued' }, 'Neo is getting ready…'],
  ] as const)(
    'preserves anchored public activity for %j without a legacy duplicate',
    async (state, label) => {
      connectionState.value = 'connected';
      const messages = [
        {
          type: 'user',
          uuid: original.messageId,
          session_id: root,
          parent_tool_use_id: null,
          inputKind: 'human',
          message: { role: 'user', content: 'Private SDK ask text' },
        },
      ] as unknown as ChatMessage[];
      const agentState = { ...state, messageId: original.messageId } as AgentProcessingState;
      const native = signal<SessionState | null>({
        sessionInfo: { id: root },
        agentState,
        error: null,
        timestamp: 1,
        commandsData: { availableCommands: [] },
      } as unknown as SessionState);
      const store = {
        sdkMessages: signal(messages),
        sessionState: native,
        agentState: signal(agentState),
        activeSessionId: signal(root),
        isRecovering: signal(false),
        hasMoreMessages: signal(false),
        error: signal(null),
        refresh: vi.fn(),
      } as unknown as SessionStore;
      expect(
        projectNeoProcessingActivity(root, root, native.value, agentState, true, false, messages)
      ).toEqual({ messageId: original.messageId, label });
      const view = render(
        <NeoConversation store={store} sessionId={root} publicConversation={conversation()} />
      );
      expect(screen.getAllByRole('status')).toHaveLength(1);
      expect(screen.getByRole('status').textContent).toContain(label);
      expect(screen.queryByText('Private SDK ask text')).toBeNull();
      expect(document.getElementById(neoMessageAnchor(root, original.messageId))).toBeTruthy();
      view.rerender(
        <NeoConversation store={store} sessionId={root} publicConversation={conversation([], [])} />
      );
      expect(screen.getAllByRole('status')).toHaveLength(1);
      expect(screen.getByRole('status').textContent).toContain(label);
      await act(() => {
        native.value = { ...native.value!, agentState: { status: 'idle' } };
      });
      expect(screen.queryByRole('status')).toBeNull();
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
