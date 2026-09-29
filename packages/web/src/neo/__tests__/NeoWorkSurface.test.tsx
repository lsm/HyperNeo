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
  it('groups proposed and queued work by origin, excluding terminal work', () => {
    const map = inflightWorkByOrigin([
      makeWork(),
      makeWork({ id: 'work-2', status: 'queued', originMessageId: 'ask-two' }),
      makeWork({ id: 'work-3', status: 'reported', originMessageId: 'ask-one' }),
      makeWork({ id: 'work-4', status: 'proposed', originMessageId: null }),
    ]);
    expect(map.get('ask-one')?.map((work) => work.id)).toEqual(['work-1']);
    expect(map.get('ask-two')?.map((work) => work.id)).toEqual(['work-2']);
    expect(map.has('ask-one reported')).toBe(false);
    expect(map.size).toBe(2);
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
});

describe('global work surface rows', () => {
  function renderPanel(works: NeoWork[]) {
    const onWorkAction = vi.fn();
    const onJumpToWork = vi.fn();
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
    expect(within(surface).getByText('Running')).toBeTruthy();
    expect(within(surface).getAllByRole('link', { name: /Inspect/ })).toHaveLength(2);

    fireEvent.click(within(surface).getByRole('button', { name: 'Start' }));
    expect(onWorkAction).toHaveBeenCalledWith('work-1', 'start');
    fireEvent.click(within(surface).getByRole('button', { name: 'Stop work' }));
    expect(onWorkAction).toHaveBeenCalledWith('work-2', 'cancel');
    fireEvent.click(within(surface).getByRole('button', { name: 'Draft the agenda' }));
    expect(onJumpToWork).toHaveBeenCalledWith('work-1');
  });

  it('keeps the panel as compact rows, never duplicate full cards', () => {
    renderPanel([makeWork()]);
    expect(screen.queryByRole('article', { name: 'Draft the agenda' })).toBeNull();
    expect(screen.getByTestId('neo-work-row-work-1')).toBeTruthy();
  });

  it('shows no work surface when nothing is in flight', () => {
    renderPanel([makeWork({ status: 'reported' })]);
    expect(screen.queryByTestId('neo-work-surface')).toBeNull();
  });
});
