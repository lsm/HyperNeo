import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { SessionStore } from '../../lib/session-store.ts';
vi.mock('../../components/chat/MarkdownRenderer.tsx', () => ({
  default: ({ content }: { content: string }) => <p>{content}</p>,
}));

import { NeoConversation, inflightWorkByOrigin } from '../NeoConversation.tsx';
import { NeoConcerns } from '../NeoConcerns.tsx';

function makeStore(messages: ChatMessage[]): SessionStore {
  return {
    sdkMessages: signal(messages),
    agentState: signal({ status: 'idle' }),
    sessionInfo: signal({ metadata: {} }),
    hasMoreMessages: signal(false),
    error: signal(null),
    isWorking: signal(false),
    refresh: vi.fn(),
  } as unknown as SessionStore;
}

function userMessage(uuid: string, text: string): ChatMessage {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: text },
  } as unknown as ChatMessage;
}

function reply(uuid: string, text: string): ChatMessage {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as ChatMessage;
}

function synthetic(uuid: string, text: string): ChatMessage {
  return {
    type: 'user',
    uuid,
    inputKind: 'system',
    message: { role: 'user', content: text },
  } as unknown as ChatMessage;
}

function makeWork(overrides: Partial<NeoWork> = {}): NeoWork {
  return {
    id: 'work-1',
    requestKey: 'rk',
    concernId: null,
    originSessionId: 'neo-1',
    originMessageId: 'ask-one',
    title: 'Draft the agenda',
    instruction: 'Eight people, Sunday.',
    sessionId: 'worker-1',
    status: 'proposed',
    report: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as NeoWork;
}

const conversation = [
  userMessage('ask-one', 'Draft the offsite agenda'),
  reply('reply-one', 'On it.'),
  { type: 'result', uuid: 'result-one', subtype: 'success' } as unknown as ChatMessage,
  userMessage('ask-two', 'Check the passport'),
  reply('reply-two', 'Queued.'),
  { type: 'result', uuid: 'result-two', subtype: 'success' } as unknown as ChatMessage,
];

afterEach(cleanup);

describe('inflightWorkByOrigin', () => {
  it('groups proposed and queued work by visible origin, excluding terminal work', () => {
    const map = inflightWorkByOrigin(
      [
        makeWork(),
        makeWork({ id: 'work-2', status: 'queued', originMessageId: 'ask-two' }),
        makeWork({ id: 'work-3', status: 'reported', originMessageId: 'ask-one' }),
        makeWork({ id: 'work-4', status: 'cancelled', originMessageId: 'ask-one' }),
      ],
      'neo-1',
      new Set(['ask-one', 'ask-two'])
    );
    expect(map.get('ask-one')?.map((work) => work.id)).toEqual(['work-1']);
    expect(map.get('ask-two')?.map((work) => work.id)).toEqual(['work-2']);
    expect(map.size).toBe(2);
  });

  it('refuses an origin no visible message of this session can carry', () => {
    const map = inflightWorkByOrigin(
      [
        makeWork({ id: 'holder', originMessageId: 'neo-consult:one:request' }),
        makeWork({ id: 'legacy', originMessageId: null }),
        makeWork({ id: 'other-view', originSessionId: 'neo-2', originMessageId: 'ask-one' }),
        makeWork({ id: 'unloaded', originMessageId: 'ask-old' }),
      ],
      'neo-1',
      new Set(['ask-one'])
    );
    expect(map.size).toBe(0);
    expect(map.has('ask-one')).toBe(false);
  });
});

describe('inline in-flight cards', () => {
  it('renders each in-flight card beneath its originating message only', () => {
    render(
      <NeoConversation
        store={makeStore(conversation)}
        sessionId="neo-1"
        works={[
          makeWork(),
          makeWork({ id: 'work-2', status: 'queued', originMessageId: 'ask-two' }),
        ]}
      />
    );
    const first = document.getElementById('inline-work-work-1');
    const second = document.getElementById('inline-work-work-2');
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    const region = screen.getByRole('region', { name: 'Conversation with Neo' });
    expect(within(region).getByText('Draft the offsite agenda')).toBeTruthy();
    expect(within(region).getByText('Check the passport')).toBeTruthy();
    const firstAsk = within(region).getByText('Draft the offsite agenda') as HTMLElement;
    const secondAsk = within(region).getByText('Check the passport') as HTMLElement;
    expect(
      (firstAsk as HTMLElement).compareDocumentPosition(first as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      (first as Node).compareDocumentPosition(secondAsk as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      (secondAsk as HTMLElement).compareDocumentPosition(second as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(document.querySelectorAll('#inline-work-work-1 article')).toHaveLength(1);
    expect(document.querySelectorAll('#inline-work-work-2 article')).toHaveLength(1);
    expect(document.querySelectorAll('[id^="inline-work-"]')).toHaveLength(2);
  });

  it('passes actions from the inline card through the wired handler', () => {
    const onWorkAction = vi.fn();
    render(
      <NeoConversation
        store={makeStore(conversation)}
        sessionId="neo-1"
        works={[makeWork()]}
        onWorkAction={onWorkAction}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }));
    expect(onWorkAction).toHaveBeenCalledWith('work-1', 'start');
  });

  it('never attributes a hidden, null or cross-view origin to a visible message', () => {
    render(
      <NeoConversation
        store={makeStore([
          ...conversation,
          synthetic('neo-consult:one:request', 'Internal consultation question'),
        ])}
        sessionId="neo-1"
        works={[
          makeWork({ id: 'holder', originMessageId: 'neo-consult:one:request' }),
          makeWork({ id: 'legacy', originMessageId: null }),
          makeWork({ id: 'other-view', originSessionId: 'neo-2', originMessageId: 'ask-one' }),
          makeWork({ id: 'unloaded', originMessageId: 'ask-old' }),
        ]}
      />
    );
    expect(screen.queryByText('Internal consultation question')).toBeNull();
    const ask = screen.getByText('Draft the offsite agenda');
    expect(ask.closest('[id^="inline-work-"]')).toBeNull();
    const unplaced = screen.getByRole('region', { name: 'Work without a message here' });
    expect(within(unplaced).getAllByRole('article')).toHaveLength(4);
    for (const id of ['holder', 'legacy', 'other-view', 'unloaded'])
      expect(document.getElementById(`inline-work-${id}`)).toBeTruthy();
  });

  it('gives every in-flight work one card, never a duplicate of a placed one', () => {
    render(
      <NeoConversation
        store={makeStore(conversation)}
        sessionId="neo-1"
        works={[makeWork(), makeWork({ id: 'hidden', originMessageId: null })]}
      />
    );
    expect(document.querySelectorAll('#inline-work-work-1 article')).toHaveLength(1);
    expect(document.querySelectorAll('#inline-work-hidden article')).toHaveLength(1);
    expect(document.querySelectorAll('[id^="inline-work-"] article')).toHaveLength(2);
    expect(screen.queryByRole('region', { name: 'Work without a message here' })).toBeTruthy();
  });

  it('keeps the full brief inspectable on an unplaced card before Start', () => {
    const onWorkAction = vi.fn();
    render(
      <NeoConversation
        store={makeStore(conversation)}
        sessionId="neo-1"
        works={[makeWork({ id: 'legacy', originMessageId: null })]}
        onWorkAction={onWorkAction}
      />
    );
    const card = screen.getByRole('article', { name: 'Draft the agenda' });
    const brief = within(card).getByText('Review the work brief');
    expect(brief.closest('details')?.open).toBe(false);
    fireEvent.click(brief);
    expect(within(card).getByText('Eight people, Sunday.')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Start work' }));
    expect(onWorkAction).toHaveBeenCalledWith('legacy', 'start');
  });
});

describe('global work surface rows', () => {
  function renderPanel(works: NeoWork[], onJumpImpl: (id: string) => boolean = () => true) {
    const onWorkAction = vi.fn();
    const onJumpToWork = vi.fn(onJumpImpl);
    const view = render(
      <NeoConcerns
        concerns={[]}
        works={works}
        selectedId={null}
        onOpen={() => {}}
        onWorkAction={onWorkAction}
        onJumpToWork={onJumpToWork}
      />
    );
    return { onWorkAction, onJumpToWork, ...view };
  }

  it('exposes status, Start, Stop, Inspect, and jump from compact rows', () => {
    const { onWorkAction, onJumpToWork } = renderPanel([
      makeWork(),
      makeWork({
        id: 'work-2',
        status: 'queued',
        originMessageId: 'ask-two',
        title: 'Passport check',
      }),
    ]);
    const surface = screen.getByTestId('neo-work-surface');
    expect(within(surface).getByText('Your call')).toBeTruthy();
    expect(within(surface).getByText('Handed to HyperNeo')).toBeTruthy();
    expect(within(surface).queryByText('Running')).toBeNull();
    expect(within(surface).getAllByRole('link', { name: /Inspect/ })).toHaveLength(2);

    fireEvent.click(within(surface).getByRole('button', { name: 'Start' }));
    expect(onWorkAction).toHaveBeenCalledWith('work-1', 'start');
    fireEvent.click(within(surface).getByRole('button', { name: 'Stop work' }));
    expect(onWorkAction).toHaveBeenCalledWith('work-2', 'cancel');
    fireEvent.click(within(surface).getByRole('button', { name: 'Draft the agenda' }));
    expect(onJumpToWork).toHaveBeenCalledWith('work-1');
  });

  it('stops waiting for an existing chat and stops only a fresh execution', () => {
    const { onWorkAction } = renderPanel([
      makeWork({ id: 'fresh', status: 'queued', targetSessionId: null }),
      makeWork({ id: 'existing', status: 'queued', targetSessionId: 'project-chat' }),
    ]);
    const surface = screen.getByTestId('neo-work-surface');
    expect(within(surface).getAllByRole('button', { name: 'Stop work' })).toHaveLength(1);
    fireEvent.click(within(surface).getByRole('button', { name: 'Stop waiting' }));
    expect(onWorkAction).toHaveBeenCalledWith('existing', 'cancel');
    expect(onWorkAction).not.toHaveBeenCalledWith('fresh', 'cancel');
  });

  it('keeps the panel as compact rows, never duplicate full cards', () => {
    renderPanel([makeWork()]);
    expect(screen.queryByRole('article', { name: 'Draft the agenda' })).toBeNull();
    expect(screen.getByTestId('neo-work-row-work-1')).toBeTruthy();
  });

  it('shows the full brief before Start without leaving the panel', () => {
    renderPanel([makeWork()]);
    const row = screen.getByTestId('neo-work-row-work-1');
    const brief = within(row).getByText('Review the work brief');
    expect(brief.closest('details')?.open).toBe(false);
    fireEvent.click(brief);
    expect(within(row).getByText('Eight people, Sunday.')).toBeTruthy();
  });

  it('shows no work surface when nothing is in flight', () => {
    renderPanel([makeWork({ status: 'reported' })]);
    expect(screen.queryByTestId('neo-work-surface')).toBeNull();
  });
});

describe('counts and jump', () => {
  function renderPanel(works: NeoWork[], onJumpImpl: (id: string) => boolean) {
    const onWorkAction = vi.fn();
    const view = render(
      <NeoConcerns
        concerns={[]}
        works={works}
        selectedId={null}
        onOpen={() => {}}
        onWorkAction={onWorkAction}
        onJumpToWork={vi.fn(onJumpImpl)}
      />
    );
    const trigger = view.container.querySelector(
      'button[aria-controls="neo-concerns-list"]'
    ) as HTMLButtonElement;
    return { onWorkAction, trigger, ...view };
  }

  it('counts work with no concern instead of reporting zero things', () => {
    render(
      <NeoConcerns
        concerns={[]}
        works={[
          makeWork({ id: 'a' }),
          makeWork({ id: 'b', status: 'queued' }),
          makeWork({ id: 'done', status: 'reported' }),
        ]}
        selectedId={null}
        onOpen={() => {}}
      />
    );
    const list = screen.getByRole('complementary', { name: 'Your concerns and work' });
    expect(within(list).getByText('2 things I’m holding for you')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Work in flight · 2 · 1 thing needs your call' })
    ).toBeTruthy();
  });

  it('closes the panel on a successful jump without approving the work', () => {
    const { onWorkAction, trigger } = renderPanel([makeWork()], () => true);
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Draft the agenda' }));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(onWorkAction).not.toHaveBeenCalled();
  });

  it('keeps the panel open and says so when the jump found no destination', () => {
    const { trigger } = renderPanel([makeWork()], () => false);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Draft the agenda' }));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe(
      '“Draft the agenda” isn’t shown in this view — its brief is here, above.'
    );
  });

  it('clears the unresolved hint once a later jump succeeds', () => {
    let reachable = false;
    const { trigger } = renderPanel([makeWork()], () => reachable);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Draft the agenda' }));
    expect(screen.queryByRole('status')).toBeTruthy();
    reachable = true;
    fireEvent.click(screen.getByRole('button', { name: 'Draft the agenda' }));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
