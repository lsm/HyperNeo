import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import type { AgentProcessingState, ChatMessage, SessionState } from '@hyperneo/shared';
import type { SessionStore } from '../../lib/session-store.ts';
import { connectionState } from '../../lib/state.ts';
import { NeoPublicConversation, publicAskText } from '../NeoPublicConversation.tsx';
import { NeoConversation } from '../NeoConversation.tsx';
import { projectNeoPublicConversation } from '../public-conversation.ts';
import { neoMessageAnchor } from '../reply-context.ts';
import { projectNeoProcessingActivity } from '../processing-activity.ts';

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

  it('keeps short and full authored content separate and copies each without adding scene labels', async () => {
    const value = publication();
    const { container } = render(
      <NeoPublicConversation conversation={conversation([], [value])} />
    );
    await waitFor(() => expect(container.querySelector('table')).toBeTruthy());
    const details = container.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(screen.getByText(value.shortText)).toBeTruthy();
    expect(details.querySelector('table')).toBeTruthy();
    expect(details.querySelector('blockquote')?.textContent).toContain('not verified completion');
    expect(details.querySelector('pre code')?.textContent).toContain('Fictional detail');
    fireEvent.click(screen.getByRole('button', { name: 'Copy Neo’s message' }));
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(value.shortText));
    fireEvent.click(screen.getByRole('button', { name: 'Copy full response' }));
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(value.fullText));
    expect(container.querySelector('script')).toBeNull();
  });

  it('opens labelled scene references only through the owning callback, never as native actions', () => {
    const open = vi.fn();
    render(<NeoPublicConversation conversation={conversation()} onOpenScene={open} />);
    const refs = screen.getByRole('list', { name: 'Related Neo scenes' });
    for (const ref of publication().links) {
      fireEvent.click(within(refs).getByRole('button', { name: ref.label }));
      expect(open).toHaveBeenLastCalledWith({ kind: ref.kind, id: ref.id });
    }
    expect(open).toHaveBeenCalledTimes(3);
    for (const name of ['Start', 'Stop', 'Not now'])
      expect(screen.queryByRole('button', { name, exact: true })).toBeNull();
    expect(refs.querySelector('a')).toBeNull();
  });

  it('leaves references as text when the scene owner is absent instead of creating inert controls', () => {
    render(<NeoPublicConversation conversation={conversation()} />);
    const refs = screen.getByRole('list', { name: 'Related Neo scenes' });
    expect(within(refs).getByText('Read comparison')).toBeTruthy();
    expect(within(refs).queryAllByRole('button')).toEqual([]);
  });

  it('attributes actual producers and opens their Neo conversation without printing private session ids', () => {
    const open = vi.fn();
    const reply = publication({
      publicationId: '20000000-0000-4000-8000-000000000002',
      producerInput: { sessionId: root, messageId: original.messageId },
      sequence: 2,
    });
    const { container } = render(
      <NeoPublicConversation
        conversation={conversation([], [publication(), reply])}
        authors={new Map([[holder, 'Source context']])}
        onOpenAuthor={open}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Source context', exact: true }));
    expect(open).toHaveBeenLastCalledWith(holder);
    fireEvent.click(screen.getByRole('button', { name: 'Neo', exact: true }));
    expect(open).toHaveBeenLastCalledWith(root);
    expect(open).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain(holder);
  });

  it('does not mislabel an unknown holder as root or infer its name from unrelated scene labels', () => {
    render(
      <NeoPublicConversation
        conversation={conversation()}
        authors={new Map([['unrelated-session', 'Wrong author']])}
      />
    );
    expect(screen.getByText('Context holder', { exact: true })).toBeTruthy();
    expect(screen.queryByText('Neo', { exact: true })).toBeNull();
    expect(screen.queryByText('Wrong author')).toBeNull();
  });

  it('returns to the original session/message pair rather than a newer ask', () => {
    const newer = ask({
      requestId: 'newer',
      askOrigin: { sessionId: root, messageId: 'newer' },
      content: 'Unrelated newer request',
      sequence: 2,
      createdAt: '2026-09-30T12:00:00.500Z',
    });
    render(<NeoPublicConversation conversation={conversation([ask(), newer])} />);
    const originalArticle = document.getElementById(neoMessageAnchor(root, 'original'))!;
    const latestArticle = document.getElementById(neoMessageAnchor(root, 'newer'))!;
    const originalScroll = vi.fn();
    const latestScroll = vi.fn();
    originalArticle.scrollIntoView = originalScroll;
    latestArticle.scrollIntoView = latestScroll;
    fireEvent.click(screen.getByRole('button', { name: 'Return to your request' }));
    expect(originalScroll).toHaveBeenCalledWith({ block: 'nearest' });
    expect(latestScroll).not.toHaveBeenCalled();
  });

  it('marks an unavailable original honestly instead of jumping to a matching message in another session', () => {
    const other = ask({ askOrigin: { sessionId: holder, messageId: original.messageId } });
    render(<NeoPublicConversation conversation={conversation([other])} />);
    expect(screen.getByText('Original request is outside this view.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Return to your request' })).toBeNull();
  });

  it('retains stable entry nodes and expanded detail across reloads with the same durable ids', () => {
    const first = conversation();
    const { container, rerender } = render(<NeoPublicConversation conversation={first} />);
    const entries = Array.from(container.querySelectorAll('article'));
    const detail = container.querySelector('details')!;
    detail.open = true;
    rerender(<NeoPublicConversation conversation={conversation([ask()], [publication()])} />);
    expect(container.querySelectorAll('article')[0]).toBe(entries[0]);
    expect(container.querySelectorAll('article')[1]).toBe(entries[1]);
    expect(container.querySelector('details')).toBe(detail);
    expect(detail.open).toBe(true);
    rerender(<NeoPublicConversation conversation={conversation([], [publication()])} />);
    expect(container.querySelector('article')).toBe(entries[1]);
    expect(container.querySelector('details')?.open).toBe(true);
    expect(screen.getByText('Original request is outside this view.')).toBeTruthy();
  });

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
      expect(await screen.findByText(publication().shortText)).toBeTruthy();
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
    expect(await screen.findByText(publication().shortText)).toBeTruthy();
    expect(screen.queryByText('Private execution transcript')).toBeNull();
    expect(store.sdkMessages.value).toBe(messages);
    rerender(<NeoConversation store={store} sessionId={root} />);
    expect(await screen.findByText('Private execution transcript')).toBeTruthy();
    expect(screen.queryByText(publication().shortText)).toBeNull();
  });

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
    const submit = screen.getByRole('button', { name: 'Submit Response' });
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
    expect(screen.getByRole('button', { name: 'Submit Response' })).toBe(submit);
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
