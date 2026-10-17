import type { MessageHub, SessionState } from '@hyperneo/shared';
import type { NeoAsk, NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { signal } from '@preact/signals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../../lib/session-store.ts';
import { connectionState } from '../../lib/state.ts';
import { NeoLive } from '../NeoLive.tsx';
import { createNeoIntakeClient, type NeoPendingAsk } from '../neo-intake.ts';
import type { NeoPublicConversation } from '../public-conversation.ts';
import { testAskView } from './neo-test-views.ts';

const useNeoMock = vi.hoisted(() => vi.fn());
const transport = vi.hoisted(() => ({ hub: null as unknown }));
vi.mock('../useNeo.ts', () => ({ useNeo: useNeoMock }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () => transport.hub,
    getHubIfConnected: () => transport.hub,
  },
}));
vi.mock('../NeoPreferences.tsx', () => ({ NeoPreferences: () => null }));
vi.mock('../NeoVoice.tsx', () => ({ NeoVoice: () => null }));
vi.mock('../../islands/ToastContainer.tsx', () => ({ default: () => null }));

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const originalConnection = connectionState.value;
const sessionId = signal<string | null>(root);
const pending = signal<readonly NeoPendingAsk[]>([]);
const originalText = 'First request\nSecond line';
const fullReply = 'Short answer\n\n## Full evidence\n\nPreserve **this detail**.';
const conversation: NeoPublicConversation = {
  conversationId,
  status: 'ready',
  hasEarlier: false,
  hasMore: false,
  entries: [
    {
      kind: 'ask',
      key: 'original-ask',
      ask: {
        conversationId,
        requestId: 'original-ask',
        askOrigin: { sessionId: root, messageId: 'original-ask' },
        content: originalText,
        sequence: 1,
        createdAt: '2026-10-01T01:00:00Z',
      },
    },
    {
      kind: 'publication',
      key: 'saved-reply',
      replyTo: null,
      publication: {
        conversationId,
        publicationId: 'saved-reply',
        askOrigin: { sessionId: root, messageId: 'original-ask' },
        producerInput: { sessionId: 'holder', messageId: 'reply' },
        shortText: 'Short answer',
        fullText: fullReply,
        links: [],
        sequence: 1,
        createdAt: '2026-10-01T01:00:01Z',
      },
    },
  ],
};
let store: SessionStore;
let request: ReturnType<typeof vi.fn>;
const calls = () => request.mock.calls.filter((call) => call[1]?.name === 'neo.message.send');
const accepted = (input: { requestId: string }) => ({
  ok: true,
  requestId: input.requestId,
  messageId: input.requestId,
  created: true,
});
const nativeState = (id: string) =>
  ({
    sessionInfo: { id, metadata: {} },
    agentState: { status: 'idle' },
    revision: 1,
    daemonEpoch: 'quote-test',
  }) as SessionState;

beforeEach(async () => {
  localStorage.clear();
  sessionId.value = root;
  pending.value = [];
  connectionState.value = 'connected';
  request = vi.fn(async (method: string, data: Record<string, unknown> = {}) => {
    if (method === 'state.session') return nativeState(String(data.sessionId));
    if (method === 'liveQuery.subscribe') return { subscriptionId: data.subscriptionId };
    if (method === 'session.get') return { session: { metadata: {} } };
    if (method === 'operation.invoke' && data.name === 'neo.message.send')
      return accepted(data.input as { requestId: string });
    return { success: true };
  });
  transport.hub = {
    request,
    joinChannel: vi.fn(),
    leaveChannel: vi.fn(),
    onEvent: () => () => {},
    onConnection: () => () => {},
  };
  store = new SessionStore();
  await store.select(root);
  store.messagesLoaded.value = true;
  const intake = createNeoIntakeClient(
    async () => transport.hub as MessageHub,
    (asks) => {
      pending.value = asks;
    }
  );
  useNeoMock.mockImplementation(() => ({
    store,
    sessionId: sessionId.value,
    snapshot: {
      ok: true,
      sessionId: sessionId.value,
      projects: [],
      cards: [],
      askViews: [],
      work: [],
      consultations: [],
      askOrigins: [],
    } as NeoSnapshot,
    viewPublicConversation: conversation,
    asks: { retry: vi.fn(), loadEarlier: vi.fn() },
    publications: { refresh: vi.fn(), loadEarlier: vi.fn() },
    pendingAsks: pending.value,
    send: intake.send,
    sendRequestId: intake.requestIdFor,
    retrySend: intake.retry,
    discardSend: intake.discard,
    error: null,
    setError: vi.fn(),
    open: vi.fn(),
    retry: vi.fn(),
    refresh: vi.fn(),
    act: vi.fn(),
    busyWork: null,
  }));
});
afterEach(async () => {
  cleanup();
  await store.destroy();
  connectionState.value = originalConnection;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function open() {
  render(<NeoLive />);
  return (await screen.findByRole('textbox', { name: 'Message Neo' })) as HTMLTextAreaElement;
}
function type(text: string) {
  fireEvent.input(screen.getByRole('textbox', { name: 'Message Neo' }), {
    target: { value: text },
  });
}
function submit() {
  fireEvent.submit(screen.getByRole('textbox', { name: 'Message Neo' }).closest('form')!);
}
function quote(author: 'You' | 'Neo') {
  const button = screen.getByRole('button', {
    name: author === 'You' ? 'Reply to your message' : 'Reply to Neo’s message',
  });
  const anchor = button.closest('article')!.id;
  fireEvent.click(button);
  return anchor;
}
const quotedText = (author: string, _anchor: string, text: string, draft: string) =>
  `Replying to ${author === 'You' ? 'my earlier message' : author}:\n${text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')}\n\n${draft}`;
function deferredSend() {
  let finish: (response: unknown) => void = () => {};
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  return async () => {
    await act(async () => finish(accepted(calls()[0][1].input)));
    await waitFor(() => expect(pending.value[0]?.state).toBe('accepted'));
    await act(async () => {});
  };
}

describe('Neo quote reply through live chat and durable intake', () => {
  it.each([
    { desktop: false, draft: '' },
    { desktop: true, draft: '' },
    { desktop: false, draft: 'My existing draft' },
    { desktop: true, draft: 'My existing draft' },
  ])(
    'replies to an open question with desktop=$desktop and draft="$draft"',
    async ({ desktop, draft }) => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(min-width: 1120px)' && desktop,
        addEventListener() {},
        removeEventListener() {},
      }));
      const ask: NeoAsk = {
        id: 'question-ask',
        requestKey: 'question-ask',
        projectId: null,
        originSessionId: root,
        originMessageId: 'original-ask',
        title: 'Choose a repo',
        ask: 'Investigate the repository',
        doneWhen: 'Repository selected',
        doneSource: 'human',
        status: 'waiting',
        outcome: null,
        workIds: [],
        createdAt: 1,
        updatedAt: 1,
        settledAt: null,
      };
      const previous = useNeoMock.getMockImplementation()!;
      useNeoMock.mockImplementation(() => {
        const model = previous();
        return {
          ...model,
          askDetailFailed: () => false,
          askDetailEpoch: 0,
          snapshot: {
            ...model.snapshot,
            asks: [ask],
            askViews: [
              testAskView(ask, {
                needsYou: true,
                humanActions: [
                  { kind: 'question', itemId: 'i3', question: 'Which repo?', options: [] },
                ],
              }),
            ],
          },
        };
      });
      sessionId.value = null;
      render(<NeoLive />);
      expect(screen.getByText('在聊天里回复').closest('button')?.disabled).toBe(true);
      sessionId.value = root;
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      type(draft);
      quote('You');
      const sheet = screen.queryByRole('button', { name: /^Your work/ });
      if (sheet) fireEvent.click(sheet);
      const scroll = desktop ? document.querySelector('.neo-chat-rail')! : screen.getByRole('main');
      Object.defineProperty(scroll, 'scrollHeight', { value: 1600 });
      const scrollTo = vi.spyOn(scroll, 'scrollTo');
      const intoView = vi.spyOn(input, 'scrollIntoView');
      fireEvent.click(screen.getByRole('button', { name: '在聊天里回复' }));
      await waitFor(() => expect(document.activeElement).toBe(input));
      expect(screen.getByRole('region', { name: /^Replying to Neo:/ }).textContent).toContain(
        'Which repo?'
      );
      expect(input.value).toBe(draft);
      expect(scrollTo).toHaveBeenCalledWith({ top: 1600, behavior: 'smooth' });
      expect(intoView).toHaveBeenCalledWith({ block: 'nearest' });
      if (sheet) expect(sheet.getAttribute('aria-expanded')).toBe('false');
      expect(calls()).toHaveLength(0);
      if (!draft) type('Use lsm/HyperNeo.');
      submit();
      await waitFor(() => expect(calls()).toHaveLength(1));
      expect(calls()[0][1].input.content).toBe(
        `Replying to Neo:\n> Which repo?\n\n${draft || 'Use lsm/HyperNeo.'}`
      );
    }
  );

  it('selects either author, keeps drafts on replacement and quotes full collapsed replies', async () => {
    const input = await open();
    type('My existing draft');
    quote('You');
    expect(screen.getByRole('region', { name: /^Replying to/ }).textContent).toContain(
      originalText
    );
    expect(input.value).toBe('My existing draft');
    expect(screen.queryByRole('heading', { name: 'Full evidence' })).toBeNull();
    const anchor = quote('Neo');
    expect(screen.getByRole('region', { name: /^Replying to/ }).textContent).toContain(fullReply);
    expect(input.value).toBe('My existing draft');
    submit();
    await waitFor(() => expect(calls()).toHaveLength(1));
    expect(calls()[0]).toEqual([
      'operation.invoke',
      {
        name: 'neo.message.send',
        input: {
          sessionId: root,
          requestId: expect.any(String),
          content: quotedText('Neo', anchor, fullReply, 'My existing draft'),
        },
      },
      { timeout: 90_000 },
    ]);
    expect(document.getElementById(anchor)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('region', { name: /^Replying to/ })).toBeNull());
    await waitFor(() => expect(input.value).toBe(''));
    type('Next message');
    submit();
    await waitFor(() => expect(calls()).toHaveLength(2));
    expect(calls()[1][1].input.content).toBe('Next message');
  });

  it('cancels without changing typed text or including context in the payload', async () => {
    const input = await open();
    type('Keep my words');
    quote('You');
    fireEvent.click(screen.getByRole('button', { name: 'Remove reply' }));
    expect(input.value).toBe('Keep my words');
    expect(screen.queryByRole('region', { name: /^Replying to/ })).toBeNull();
    submit();
    await waitFor(() => expect(calls()).toHaveLength(1));
    expect(calls()[0][1].input.content).toBe('Keep my words');
  });

  it('sends a human quote and attached image through content blocks', async () => {
    await open();
    type('About this image');
    const anchor = quote('You');
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], files: [new File(['photo'], 'photo.png', { type: 'image/png' })] },
    });
    fireEvent(screen.getByRole('banner'), event);
    await screen.findByRole('button', { name: 'Remove photo.png' });
    submit();
    await waitFor(() => expect(calls()).toHaveLength(1));
    expect(calls()[0][1].input.content).toEqual([
      { type: 'text', text: quotedText('You', anchor, originalText, 'About this image') },
      { type: 'image', source: { type: 'base64', data: 'cGhvdG8=', media_type: 'image/png' } },
    ]);
  });

  it('clears selection across session changes without reviving it on return', async () => {
    await open();
    quote('Neo');
    await act(async () => {
      sessionId.value = 'holder';
      store.activeSessionId.value = 'holder';
      store.sessionState.value = nativeState('holder');
    });
    expect(screen.queryByRole('region', { name: /^Replying to/ })).toBeNull();
    await act(async () => {
      sessionId.value = root;
      store.activeSessionId.value = root;
      store.sessionState.value = nativeState(root);
    });
    expect(screen.queryByRole('region', { name: /^Replying to/ })).toBeNull();
    type('Fresh message');
    submit();
    await waitFor(() => expect(calls()).toHaveLength(1));
    expect(calls()[0][1].input.content).toBe('Fresh message');
  });

  it('retains quote context and request identity when retrying a failed submission', async () => {
    await open();
    type('Please explain');
    const anchor = quote('Neo');
    request.mockImplementationOnce(async () => ({ ok: false, reason: 'Try again.' }));
    submit();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls()).toHaveLength(2));
    expect(calls()[0][1].input.content).toBe(
      quotedText('Neo', anchor, fullReply, 'Please explain')
    );
    expect(calls()[1][1].input).toEqual(calls()[0][1].input);
    await waitFor(() => expect(screen.queryByRole('region', { name: /^Replying to/ })).toBeNull());
  });
  it('restores failed replies as a cancellable quote with the raw draft on Edit', async () => {
    const input = await open();
    type('Please explain');
    quote('Neo');
    request.mockImplementationOnce(async () => ({ ok: false, reason: 'Try again.' }));
    submit();
    await screen.findByRole('button', { name: /^Not sent/ });
    quote('You');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(input.value).toBe('Please explain'));
    expect(screen.getByRole('region', { name: /^Replying to/ }).textContent).toContain(fullReply);
    expect(screen.getByRole('region', { name: /^Replying to/ }).textContent).toContain(
      'Replying to Neo'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove reply' }));
    submit();
    await waitFor(() => expect(calls()).toHaveLength(2));
    expect(calls()[1][1].input.content).toBe('Please explain');
    expect(calls()[1][1].input.requestId).not.toBe(calls()[0][1].input.requestId);
  });
  it.each(['rejected', 'transport', 'invalid'])(
    'retains the quote after %s failure and clears it after accepted retry',
    async (failure) => {
      await open();
      type('Please explain');
      quote('Neo');
      request.mockImplementationOnce(async () => {
        if (failure === 'transport') throw new Error('Disconnected');
        return failure === 'invalid' ? { ok: true } : { ok: false, reason: 'Try again.' };
      });
      submit();
      const retry = await screen.findByRole('button', { name: 'Retry' });
      expect(screen.getByRole('region', { name: /^Replying to/ }).textContent).toContain(fullReply);
      fireEvent.click(retry);
      await waitFor(() =>
        expect(screen.queryByRole('region', { name: /^Replying to/ })).toBeNull()
      );
      expect(calls()[1][1].input).toEqual(calls()[0][1].input);
    }
  );

  it.each(['unchanged', 'replacement', 'reselection', 'cancel', 'session'])(
    'preserves newer selection state after late success with %s',
    async (change) => {
      await open();
      type('Pending reply');
      quote('Neo');
      const finish = deferredSend();
      submit();
      await waitFor(() => expect(calls()).toHaveLength(1));
      expect(screen.getByRole('region', { name: /^Replying to/ }).textContent).toContain(fullReply);
      if (change === 'replacement') quote('You');
      if (change === 'cancel' || change === 'reselection') {
        fireEvent.click(screen.getByRole('button', { name: 'Remove reply' }));
        if (change === 'reselection') quote('Neo');
      }
      if (change === 'session') {
        await act(async () => {
          sessionId.value = 'holder';
          store.activeSessionId.value = 'holder';
          store.sessionState.value = nativeState('holder');
        });
        quote('You');
      }
      type('New draft');
      await finish();
      if (change === 'cancel' || change === 'unchanged') {
        await waitFor(() =>
          expect(screen.queryByRole('region', { name: /^Replying to/ })).toBeNull()
        );
      } else {
        expect(screen.getByRole('region', { name: /^Replying to/ }).textContent).toContain(
          change === 'reselection' ? fullReply : originalText
        );
      }
      expect(screen.getByRole('textbox', { name: 'Message Neo' })).toHaveProperty(
        'value',
        'New draft'
      );
    }
  );

  it('uses native accessible buttons and preserves the draft through keyboard cancellation', async () => {
    const input = await open();
    type('Keep my draft');
    const button = screen.getByRole('button', {
      name: 'Reply to Neo’s message',
    }) as HTMLButtonElement;
    expect(button.type).toBe('button');
    expect(button.tabIndex).toBe(0);
    button.focus();
    fireEvent.click(button, { detail: 0 });
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-describedby')).toBe('neo-quote-label');
    expect(document.getElementById('neo-quote-label')).toHaveProperty(
      'textContent',
      'Replying to Neo'
    );
    expect(document.getElementById('neo-quote-label')?.getAttribute('role')).toBe('status');
    const cancel = screen.getByRole('button', { name: 'Remove reply' }) as HTMLButtonElement;
    expect(cancel.type).toBe('button');
    expect(cancel.tabIndex).toBe(0);
    cancel.focus();
    fireEvent.click(cancel, { detail: 0 });
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Keep my draft');
    quote('Neo');
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 });
    expect(screen.getByRole('region', { name: /^Replying to/ })).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: /^Replying to/ })).toBeNull();
    expect(input.value).toBe('Keep my draft');
    expect(document.activeElement).toBe(input);
    expect(calls()).toHaveLength(0);
  });

  it('renders a two-line quote preview as literal text, capped like iOS', async () => {
    const publication = conversation.entries[1];
    if (publication.kind !== 'publication') throw new Error('Expected publication fixture');
    const previous = publication.publication;
    publication.publication = {
      ...previous,
      fullText: '<img src=x onerror=alert(1)> **literal**\r' + 'a'.repeat(4500),
    };
    try {
      await open();
      type('Keep this');
      quote('Neo');
      const region = screen.getByRole('region', { name: /^Replying to Neo/ });
      expect(region.textContent).toContain('Replying to Neo');
      const preview = region.querySelector('.line-clamp-2')!;
      expect(Array.from(preview.textContent!)).toHaveLength(501);
      expect(preview.textContent).toContain('<img src=x onerror=alert(1)> **literal**\n');
      expect(preview.textContent!.endsWith('…')).toBe(true);
      expect(preview.querySelector('img')).toBeNull();
      expect(preview.querySelector('strong')).toBeNull();
      expect(screen.getByRole('textbox', { name: 'Message Neo' })).toHaveProperty(
        'value',
        'Keep this'
      );
    } finally {
      publication.publication = previous;
    }
  });
});
