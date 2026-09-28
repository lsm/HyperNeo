import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { ChatMessage } from '@hyperneo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoLive } from '../NeoLive.tsx';

const request = vi.hoisted(() => vi.fn());
const stores = vi.hoisted(
  () => [] as { isWorking: { value: boolean }; sdkMessages: { value: ChatMessage[] } }[]
);
const connected = signal('connected');
vi.mock('../../lib/state.ts', () => ({
  get connectionState() {
    return connected;
  },
}));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () => ({ request, onEvent: () => () => {}, onConnection: () => () => {} }),
    getHubIfConnected: () => ({ request }),
  },
}));
vi.mock('../../lib/session-store.ts', () => ({
  SessionStore: class {
    sessionInfo = signal({ metadata: {} });
    sdkMessages = signal<ChatMessage[]>([]);
    messagesLoaded = signal(true);
    activeSessionId = signal<string | null>(null);
    loadErrorKind = signal(null);
    agentState = signal({ status: 'processing' });
    error = signal(null);
    hasMoreMessages = signal(false);
    isWorking = signal(true);
    constructor() {
      stores.push(this);
    }
    async select(id: string) {
      this.activeSessionId.value = id;
    }
    async destroy() {}
  },
}));
vi.mock('../../components/chat/MarkdownRenderer.tsx', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('../NeoPreferences.tsx', () => ({ NeoPreferences: () => null }));
vi.mock('../NeoVoice.tsx', () => ({ NeoVoice: () => null }));
vi.mock('../../hooks/useInterrupt.ts', () => ({
  useInterrupt: () => ({ handleInterrupt: vi.fn(), interrupting: false }),
}));
vi.mock('../../islands/ToastContainer.tsx', () => ({ default: () => null }));

type IntakeInput = { sessionId: string; requestId: string; content: unknown };
const accepted = (input: IntakeInput, created = true) => ({
  ok: true,
  requestId: input.requestId,
  messageId: input.requestId,
  created,
});
const asks = () => request.mock.calls.filter((call) => call[1]?.name === 'neo.message.send');
const snapshot = (sessionId = 'neo:root') => ({
  ok: true,
  sessionId,
  concerns: [
    {
      id: 'research',
      title: 'Research',
      summary: 'Things to learn.',
      context: '',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  work: [],
  consultations: [],
});

beforeEach(() => {
  request.mockReset();
  stores.length = 0;
  connected.value = 'connected';
  request.mockImplementation(
    async (
      method: string,
      { name, input }: { name: string; input: IntakeInput & { concernId?: string } }
    ) => {
      if (method !== 'operation.invoke') throw new Error('Unexpected legacy message path');
      if (name === 'neo.message.send') return accepted(input);
      return snapshot(input.concernId ? `neo:${input.concernId}` : 'neo:root');
    }
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open() {
  render(<NeoLive />);
  const input = await screen.findByRole('textbox', { name: 'Message Neo' });
  await screen.findByRole('button', { name: /Research .*Things to learn\./ });
  await waitFor(() =>
    expect(request.mock.calls.some((call) => call[1]?.name === 'neo.snapshot')).toBe(true)
  );
  return input;
}
function submit(text?: string) {
  const input = screen.getByRole('textbox', { name: 'Message Neo' });
  if (text !== undefined) fireEvent.input(input, { target: { value: text } });
  fireEvent.submit(input.closest('form')!);
}
async function attach(name: string, content: string, type: string) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files: [new File([content], name, { type })] },
  });
  fireEvent(screen.getByRole('banner'), event);
  await screen.findByRole('button', { name: `Remove ${name}` });
}

describe('Neo live durable intake', () => {
  it('accepts unrelated C while B waits on a busy holder and B’s board inventory is unfinished', async () => {
    const queued = {
      id: 'receipt-B',
      requestKey: 'B',
      concernId: 'research',
      originSessionId: 'neo:root',
      originMessageId: 'B',
      sessionId: 'neo:research',
      question: 'Correction B',
      status: 'queued',
      createdAt: 2,
    };
    const active = {
      ...snapshot(),
      consultations: [
        { ...queued, id: 'receipt-A', originMessageId: 'A', status: 'pending', answer: null },
      ],
      consultationWaiters: [queued],
      askOrigins: ['A', 'B'].map((id) => ({
        kind: 'consultation',
        id: `receipt-${id}`,
        origin: { sessionId: 'neo:root', messageId: id },
      })),
    };
    let complete!: (value: unknown) => void;
    request.mockImplementation(
      async (
        _method: string,
        { name, input }: { name: string; input: IntakeInput & { concernId?: string } }
      ) => {
        if (name === 'daemon.snapshot')
          return new Promise((resolve) => {
            complete = resolve;
          });
        if (name === 'neo.message.send') return accepted(input);
        return input.concernId ? snapshot('neo:research') : active;
      }
    );
    await open();
    act(() => {
      stores[0].sdkMessages.value = ['A', 'B'].map((id) => ({
        type: 'user',
        uuid: id,
        parent_tool_use_id: null,
        message: { role: 'user', content: `Research request ${id}` },
      })) as ChatMessage[];
    });
    const b = screen.getByText('Research request B').closest('article')!;
    expect(within(b).getByText('Waiting for Research’s context…')).toBeTruthy();
    fireEvent.click(within(b).getByText('How this is being handled'));
    await within(b).findByRole('region', { name: 'Concern board' });
    await within(b).findByText('Checking linked resources…');
    const input = screen.getByRole('textbox', { name: 'Message Neo' });
    expect((input as HTMLTextAreaElement).disabled).toBe(false);
    submit('Unrelated family request C');
    await waitFor(() => expect(asks()).toHaveLength(1));
    expect(asks()[0][1].input.content).toBe('Unrelated family request C');
    expect(asks()[0][1].input.requestId).toBeTruthy();
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
    expect(within(b).getByText('Waiting for Research’s context…')).toBeTruthy();
    await act(async () => complete({ capturedAt: 123, resources: [], capabilities: [] }));
    expect(await within(b).findByText(/Resource details captured/)).toBeTruthy();
    expect(within(b).getByText('Receipt: receipt-B')).toBeTruthy();
    expect(within(b).queryByText('Receipt: receipt-A')).toBeNull();
  });

  it('opens A’s request board without making unrelated intake wait on inventory', async () => {
    const askA = '11111111-1111-4111-8111-111111111111';
    const active = {
      ...snapshot(),
      work: [
        {
          id: 'work-A',
          requestKey: 'work-A',
          concernId: 'research',
          originSessionId: 'neo:root',
          originMessageId: askA,
          title: 'Work for A',
          instruction: 'A bounded draft.',
          sessionId: 'executor-A',
          status: 'queued',
          report: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      askOrigins: [
        { kind: 'work', id: 'work-A', origin: { sessionId: 'neo:root', messageId: askA } },
      ],
    };
    let complete!: (value: unknown) => void;
    request.mockImplementation(
      async (
        _method: string,
        { name, input }: { name: string; input: IntakeInput & { concernId?: string } }
      ) => {
        if (name === 'daemon.snapshot')
          return new Promise((resolve) => {
            complete = resolve;
          });
        if (name === 'neo.message.send') return accepted(input);
        return input.concernId ? snapshot('neo:research') : active;
      }
    );
    await open();
    act(() => {
      stores[0].sdkMessages.value = [
        {
          type: 'user',
          uuid: askA,
          parent_tool_use_id: null,
          message: { role: 'user', content: 'Project request A' },
        },
      ] as ChatMessage[];
    });
    expect(request.mock.calls.some((call) => call[1]?.name === 'daemon.snapshot')).toBe(false);
    expect(screen.queryByText('How Neo is handling things')).toBeNull();
    fireEvent.click(screen.getByText('How this is being handled'));
    await screen.findByRole('region', { name: 'Concern board' });
    await screen.findByText('Checking linked resources…');
    submit('A separate family question');
    await waitFor(() => expect(asks()).toHaveLength(1));
    expect(asks()[0][1].input.content).toBe('A separate family question');
    await waitFor(() =>
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
    );
    await act(async () => complete({ capturedAt: 123, resources: [], capabilities: [] }));
    expect(await screen.findByText(/Resource details captured/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Research .*Things to learn\./ }));
    await screen.findByText('One part of your world · 分身');
    expect(screen.queryByText('How this is being handled')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Concern board' })).toBeNull();
    expect(request.mock.calls.filter((call) => call[1]?.name === 'daemon.snapshot')).toHaveLength(
      1
    );
  });

  it('uses durable intake while Neo works and accepts an unrelated second ask', async () => {
    const input = await open();
    submit('Project A: **what is next?**');
    await waitFor(() =>
      expect(
        request.mock.calls.some((call) => call[0] === 'message.send') || asks().length > 0
      ).toBe(true)
    );
    expect(asks()).toHaveLength(1);
    expect(asks()[0][1].input.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(asks()[0]).toEqual([
      'operation.invoke',
      {
        name: 'neo.message.send',
        input: {
          sessionId: 'neo:root',
          requestId: expect.any(String),
          content: 'Project A: **what is next?**',
        },
      },
    ]);
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
    submit('Family: plan Sunday');
    await waitFor(() => expect(asks()).toHaveLength(2));
    expect(asks()[1][1].input.requestId).not.toBe(asks()[0][1].input.requestId);
    expect(stores[0].isWorking.value).toBe(true);
    expect(
      request.mock.calls.some(
        (call) => call[0] === 'message.send' || call[1]?.name === 'neo.concern.create'
      )
    ).toBe(false);
  });

  it('sends files and photos without typed text through the real intake transform', async () => {
    await open();
    await attach('photo.png', 'photo', 'image/png');
    submit();
    await waitFor(() => expect(asks()).toHaveLength(1));
    expect(asks()[0][1].input.content).toEqual([
      { type: 'text', text: 'Attached files' },
      { type: 'image', source: { type: 'base64', data: 'cGhvdG8=', media_type: 'image/png' } },
    ]);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove photo.png' })).toBeNull()
    );
    await attach('notes.md', '```js\nhello\n```', 'text/markdown');
    submit();
    await waitFor(() => expect(asks()).toHaveLength(2));
    expect(asks()[1][1].input.content).toBe(
      'Attached files\n\n### Attached file: notes.md\n\n````text\n```js\nhello\n```\n````'
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove notes.md' })).toBeNull()
    );
  });

  it.each(['transport', 'receipt', 'rejection'])(
    'retains an unconfirmed %s draft for a same-identity retry',
    async (failure) => {
      const input = await open();
      let first = true;
      request.mockImplementation(
        async (_method: string, { name, input }: { name: string; input: IntakeInput }) => {
          if (name !== 'neo.message.send') return snapshot();
          if (first) {
            first = false;
            if (failure === 'transport') throw new Error('Connection failed');
            if (failure === 'receipt') return { ...accepted(input), messageId: 'wrong' };
            return { ok: false, reason: 'Please retry this ask.' };
          }
          return accepted(input, false);
        }
      );
      await attach('note.txt', 'Keep this attachment', 'text/plain');
      submit('Do not lose this');
      await screen.findByRole('alert');
      expect((input as HTMLTextAreaElement).value).toBe('Do not lose this');
      expect(screen.getByRole('button', { name: 'Remove note.txt' })).toBeTruthy();
      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled
        ).toBe(false)
      );
      submit();
      await waitFor(() => expect(asks()).toHaveLength(2));
      expect(asks()[1][1].input).toEqual(asks()[0][1].input);
      await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
      expect(screen.queryByRole('button', { name: 'Remove note.txt' })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    }
  );

  it('keeps later text and attachments while accepting only one repeated submit', async () => {
    await open();
    let resolve: (value: unknown) => void = () => {};
    request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    await attach('first.txt', 'First file', 'text/plain');
    submit('First ask');
    submit();
    await waitFor(() => expect(asks()).toHaveLength(1));
    fireEvent.input(screen.getByRole('textbox'), { target: { value: 'A new thought' } });
    await attach('later.txt', 'Later file', 'text/plain');
    await act(async () => resolve(accepted(asks()[0][1].input)));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove first.txt' })).toBeNull()
    );
    expect(screen.getByRole('button', { name: 'Remove later.txt' })).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('A new thought');
    expect(asks()).toHaveLength(1);
  });

  it.each(['accepted', 'failed'])(
    'does not apply a late %s completion to a reopened draft',
    async (completion) => {
      await open();
      let resolve: (value: unknown) => void = () => {};
      let reject: (reason: Error) => void = () => {};
      request.mockImplementationOnce(
        () =>
          new Promise((done, fail) => {
            resolve = done;
            reject = fail;
          })
      );
      submit('Original root ask');
      await waitFor(() => expect(asks()).toHaveLength(1));
      fireEvent.click(screen.getByRole('button', { name: 'Research Things to learn.' }));
      await screen.findByRole('heading', { name: 'Research' });
      await screen.findByRole('textbox');
      submit('Research question');
      await waitFor(() => expect(asks()).toHaveLength(2));
      expect(asks()[1][1].input.sessionId).toBe('neo:research');
      await waitFor(() =>
        expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
      );
      fireEvent.click(screen.getAllByRole('button', { name: 'Back to Neo' })[0]);
      await waitFor(() =>
        expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Original root ask')
      );
      fireEvent.input(screen.getByRole('textbox'), { target: { value: 'New root thought' } });
      await act(async () => {
        if (completion === 'accepted') resolve(accepted(asks()[0][1].input));
        else reject(new Error('Old root failure'));
      });
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('New root thought');
      expect(screen.queryByRole('alert')).toBeNull();
    }
  );

  it('keeps a disconnected draft without queuing or submitting it automatically', async () => {
    await open();
    act(() => {
      connected.value = 'disconnected';
    });
    submit('Keep this local');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep this local');
    expect(asks()).toHaveLength(0);
    act(() => {
      connected.value = 'connected';
    });
    expect(asks()).toHaveLength(0);
    submit();
    await waitFor(() => expect(asks()).toHaveLength(1));
  });
});
