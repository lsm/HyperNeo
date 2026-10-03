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
          : { ok: true, sessionId: 'neo:root', concerns: [], work: [] }
    );
    render(<IntakeProbe />);
    fireEvent.click(screen.getByRole('button', { name: 'Send ask' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('operation.invoke', {
        name: 'neo.message.send',
        input: { sessionId: 'neo:root', requestId: expect.any(String), content: 'Project A?' },
      })
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
      concerns: [],
      work: [
        {
          id: name === 'neo.open' ? 'unused' : version,
          requestKey: version,
          concernId: null,
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
