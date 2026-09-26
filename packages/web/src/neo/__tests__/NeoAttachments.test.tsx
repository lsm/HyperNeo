import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '../../lib/session-store.ts';
import { NeoComposer } from '../NeoComposer.tsx';
import { NeoLive } from '../NeoLive.tsx';
import { readNeoAttachment, attachmentMessage } from '../neo-attachments.ts';

const sendMessage = vi.hoisted(() => vi.fn(async () => true));
const useNeoMock = vi.hoisted(() => vi.fn());
vi.mock('../useNeo.ts', () => ({ useNeo: useNeoMock }));
vi.mock('../NeoConversation.tsx', () => ({ NeoConversation: () => null }));
vi.mock('../NeoWorkCard.tsx', () => ({ NeoWorkCard: () => null }));
vi.mock('../../islands/ToastContainer.tsx', () => ({ default: () => null }));
vi.mock('../../hooks/useSendMessage.ts', () => ({
  useSendMessage: () => ({ sendMessage, clearSendTimeout: vi.fn() }),
}));
vi.mock('../../hooks/useInterrupt.ts', () => ({
  useInterrupt: () => ({ handleInterrupt: vi.fn(), interrupting: false }),
}));
vi.mock('../NeoPreferences.tsx', () => ({ NeoPreferences: () => null }));
vi.mock('../NeoVoice.tsx', () => ({ NeoVoice: () => null }));
vi.mock('../../lib/state.ts', () => ({ connectionState: { value: 'connected' } }));
beforeEach(() => {
  sendMessage.mockReset();
  sendMessage.mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function composer(sessionId = crypto.randomUUID(), onError = vi.fn()) {
  const store = {
    sessionInfo: signal(null),
    isWorking: signal(false),
    agentState: signal({ status: 'idle' }),
  } as unknown as SessionStore;
  return (
    <NeoComposer
      sessionId={sessionId}
      store={store}
      draft=""
      onDraft={vi.fn()}
      onError={onError}
      onTranscript={vi.fn()}
    />
  );
}
async function attach(
  file = new File(['# Hello\nA file, not a typed message.'], 'notes.md', { type: 'text/markdown' })
) {
  fireEvent.change(screen.getByLabelText('Attach photos or files', { selector: 'input' }), {
    target: { files: [file] },
  });
  await screen.findByRole('button', { name: `Remove ${file.name}` });
}

describe('Neo attachments', () => {
  it('accepts drops on the header, not just the composer, without navigating away', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
    const id = crypto.randomUUID();
    useNeoMock.mockReturnValue({
      sessionId: id,
      selectedId: null,
      snapshot: { concerns: [], work: [] },
      error: null,
      setError: vi.fn(),
      open: vi.fn(),
      store: {
        sessionInfo: signal({ metadata: {} }),
        sdkMessages: signal([]),
        messagesLoaded: signal(true),
        activeSessionId: signal(id),
        loadErrorKind: signal(null),
        agentState: signal({ status: 'idle' }),
        error: signal(null),
        hasMoreMessages: signal(false),
        isWorking: signal(false),
      },
    });
    render(<NeoLive />);
    const header = screen.getByRole('banner');
    const dataTransfer = {
      types: ['Files'],
      files: [new File(['Dropped file'], 'drop.txt', { type: 'text/plain' })],
    };
    const drag = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      fireEvent(header, event);
      return event;
    };
    drag('dragenter');
    expect(screen.getByText('Drop photos or files here')).toBeTruthy();
    drag('dragleave');
    expect(screen.queryByText('Drop photos or files here')).toBeNull();
    drag('dragenter');
    expect(drag('drop').defaultPrevented).toBe(true);
    await screen.findByRole('button', { name: 'Remove drop.txt' });
    expect(screen.queryByText('Drop photos or files here')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled
    ).toBe(false);
    vi.unstubAllGlobals();
  });
  it('reads supported photos and text while rejecting unsupported, oversized and binary files', async () => {
    expect(
      await readNeoAttachment(new File(['hello'], 'note.txt', { type: 'text/plain' }))
    ).toMatchObject({ kind: 'text', text: 'hello' });
    expect(
      await readNeoAttachment(new File(['photo'], 'photo.png', { type: 'image/png' }))
    ).toMatchObject({ kind: 'image', image: { media_type: 'image/png', data: 'cGhvdG8=' } });
    expect(
      await readNeoAttachment(new File(['pdf'], 'file.pdf', { type: 'application/pdf' }))
    ).toContain('not supported');
    expect(
      await readNeoAttachment(
        new File(['x'.repeat(128 * 1024 + 1)], 'large.txt', { type: 'text/plain' })
      )
    ).toContain('128 KB');
    await expect(
      readNeoAttachment(new File(['a\0b'], 'binary.txt', { type: 'text/plain' }))
    ).rejects.toThrow('UTF-8');
  });
  it('preserves Markdown fences inside a text attachment', async () => {
    const file = await readNeoAttachment(
      new File(['```js\nhello\n```'], 'example.md', { type: 'text/markdown' })
    );
    expect(typeof file).toBe('object');
    if (typeof file === 'string') throw new Error(file);
    expect(attachmentMessage('', [file])).toContain('````text\n```js\nhello\n```\n````');
  });
  it('opens the picker and sends files without any typed message', async () => {
    const onError = vi.fn();
    render(composer(undefined, onError));
    const input = screen.getByLabelText('Attach photos or files', { selector: 'input' });
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Attach photos or files' }));
    expect(click).toHaveBeenCalled();
    fireEvent.change(input, {
      target: {
        files: [
          new File(['# Hello\nA file, not a typed message.'], 'notes.md', {
            type: 'text/markdown',
          }),
        ],
      },
    });
    await waitFor(() => {
      expect(onError.mock.calls).toEqual([]);
      expect(screen.queryByRole('button', { name: 'Remove notes.md' })).not.toBeNull();
    });
    fireEvent.submit(screen.getByRole('textbox').closest('form')!);
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('A file, not a typed message.')
      )
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove notes.md' })).toBeNull()
    );
  });
  it('sends photo-only messages through the existing image payload', async () => {
    render(composer());
    await attach(new File(['photo'], 'photo.png', { type: 'image/png' }));
    fireEvent.submit(screen.getByRole('textbox').closest('form')!);
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith('Attached files', [
        { data: 'cGhvdG8=', media_type: 'image/png' },
      ])
    );
  });
  it('keeps attachments on failure and isolates drafts across conversation remounts', async () => {
    const id = crypto.randomUUID();
    const view = render(composer(id));
    await attach();
    sendMessage.mockResolvedValueOnce(false);
    fireEvent.submit(screen.getByRole('textbox').closest('form')!);
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Remove notes.md' })).toBeTruthy();
    view.unmount();
    const other = render(composer());
    expect(screen.queryByRole('button', { name: 'Remove notes.md' })).toBeNull();
    other.unmount();
    render(composer(id));
    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.md' }));
    expect(screen.queryByRole('button', { name: 'Remove notes.md' })).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });
  it('does not clear a new attachment added while sending or submit twice', async () => {
    let accept: (value: boolean) => void = () => {};
    sendMessage.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve;
        })
    );
    render(composer());
    await attach();
    const form = screen.getByRole('textbox').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await attach(new File(['later'], 'later.txt', { type: 'text/plain' }));
    accept(true);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove notes.md' })).toBeNull()
    );
    expect(screen.getByRole('button', { name: 'Remove later.txt' })).toBeTruthy();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
