import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useNeo } from '../useNeo.ts';

const request = vi.hoisted(() => vi.fn());
const neoEvents = vi.hoisted(() => ({ changed: null as (() => void) | null }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () => ({
      request,
      onEvent: (_name: string, callback: () => void) => {
        neoEvents.changed = callback;
        return () => {
          neoEvents.changed = null;
        };
      },
      onConnection: () => () => {},
    }),
  },
}));
vi.mock('../../lib/session-store.ts', () => ({
  SessionStore: class {
    async select() {}
    async destroy() {}
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  neoEvents.changed = null;
});

function ViewProbe() {
  const neo = useNeo();
  return (
    <>
      <button onClick={() => void neo.open()}>Open Neo</button>
      <p>Overview work: {neo.snapshot?.work.map((item) => item.id).join(',') ?? 'loading'}</p>
      <p>
        Board work:{' '}
        {neo
          .projectBoard(null)
          ?.receipts.filter((item) => item.kind === 'work')
          .map((item) => item.id)
          .join(',') ?? 'loading'}
      </p>
      {neo.error && <p role="alert">{neo.error}</p>}
    </>
  );
}

function IntakeProbe() {
  const neo = useNeo();
  return (
    <button onClick={() => void neo.send({ sessionId: 'neo:root', text: 'Project A?' })}>
      Send ask
    </button>
  );
}

describe('useNeo intake client', () => {
  it('exposes the reusable durable intake path', async () => {
    request.mockImplementation(
      async (_method: string, { name, input }: { name: string; input: { requestId?: string } }) =>
        name === 'neo.message.send'
          ? { ok: true, requestId: input.requestId, messageId: input.requestId, created: true }
          : { ok: true, sessionId: 'neo:root', projects: [], work: [] }
    );
    render(<IntakeProbe />);
    fireEvent.click(screen.getByRole('button', { name: 'Send ask' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        'operation.invoke',
        {
          name: 'neo.message.send',
          input: { sessionId: 'neo:root', requestId: expect.any(String), content: 'Project A?' },
        },
        { timeout: 90_000 }
      )
    );
    expect(request.mock.calls.some((call) => call[0] === 'message.send')).toBe(false);
  });
});

describe('useNeo root conversation', () => {
  it('opens and refreshes only the root snapshot', async () => {
    let version = 'global';
    request.mockImplementation(async (_method: string, { name }: { name: string }) => ({
      ok: true,
      sessionId: 'root',
      projects: [],
      work: [
        {
          id: name === 'neo.open' ? 'unused' : version,
          requestKey: version,
          projectId: null,
          originSessionId: 'root',
          sessionId: version,
          title: version,
          instruction: 'Do this',
          status: 'queued',
          report: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }));
    render(<ViewProbe />);
    await waitFor(() => expect(screen.getByText('Overview work: global')).toBeTruthy());
    expect(screen.getByText('Board work: global')).toBeTruthy();
    version = 'refreshed';
    act(() => neoEvents.changed?.());
    await waitFor(() => expect(screen.getByText('Overview work: refreshed')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Open Neo' }));
    await waitFor(() =>
      expect(request.mock.calls.filter(([, call]) => call.name === 'neo.open')).toHaveLength(2)
    );
    expect(screen.getByText('Board work: refreshed')).toBeTruthy();
    for (const [, call] of request.mock.calls) expect(call.input).toEqual({});
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

function RevisionProbe({ action }: { action: 'approve' | 'answer' | 'tick' }) {
  const neo = useNeo();
  return (
    <>
      <button
        disabled={!neo.snapshot}
        onClick={() =>
          void (action === 'approve'
            ? neo.approveAsk('ask-1')
            : action === 'answer'
              ? neo.answerAskItem('ask-1', 'i1', 'Yes')
              : neo.tickAskItem('ask-1', 'i1'))
        }
      >
        Apply
      </button>
      {neo.error && <p role="alert">{neo.error}</p>}
    </>
  );
}

describe('useNeo revision guards', () => {
  it.each(['approve', 'answer', 'tick'] as const)(
    'sends the displayed revision with %s and exposes a stale refusal',
    async (action) => {
      request.mockImplementation(async (_method: string, { name }: { name: string }) =>
        name === `neo.ask.${action}`
          ? { ok: false, reason: 'stale_revision: refresh the ask.' }
          : {
              ok: true,
              sessionId: 'root',
              projects: [],
              work: [],
              asks: [{ id: 'ask-1', revision: 7 }],
            }
      );
      render(<RevisionProbe action={action} />);
      const button = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement;
      await waitFor(() => expect(button.disabled).toBe(false));
      fireEvent.click(button);
      await waitFor(() =>
        expect(request).toHaveBeenCalledWith('operation.invoke', {
          name: `neo.ask.${action}`,
          input: expect.objectContaining({ askId: 'ask-1', expectedRevision: 7 }),
        })
      );
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toContain('stale_revision')
      );
    }
  );
});
