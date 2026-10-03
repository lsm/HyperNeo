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
      <button onClick={() => void neo.open('a')}>Open A</button>
      <button onClick={() => void neo.open('b')}>Open B</button>
      <button onClick={() => void neo.open(null)}>Open Neo</button>
      <p>Overview work: {neo.snapshot?.work.map((item) => item.id).join(',') ?? 'loading'}</p>
      <p>View work: {neo.viewSnapshot?.work.map((item) => item.id).join(',') ?? 'loading'}</p>
      <p>View checks: {neo.viewSnapshot?.consultations?.map((item) => item.id).join(',') ?? ''}</p>
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

describe('useNeo selected concern', () => {
  it('keeps the global overview while refreshing scoped work and ignores a late prior concern', async () => {
    let aVersion = 'a-old';
    let deferA = false;
    let rejectA: ((reason: Error) => void) | null = null;
    const result = (sessionId: string, workId: string, checkId: string) => ({
      ok: true,
      sessionId,
      concerns: ['a', 'b'].map((id) => ({
        id,
        title: id,
        summary: 'Summary',
        context: 'Context',
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      })),
      work: [
        {
          id: workId,
          requestKey: workId,
          concernId: sessionId === 'root' ? null : sessionId,
          originSessionId: 'root',
          sessionId: workId,
          title: workId,
          instruction: 'Do this',
          status: 'queued',
          report: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      consultations: [
        {
          id: checkId,
          requestKey: checkId,
          concernId: sessionId,
          originSessionId: 'root',
          sessionId: `${sessionId}-holder`,
          question: 'Next?',
          status: 'pending',
          answer: null,
          createdAt: 1,
        },
      ],
    });
    request.mockImplementation(
      async (_method: string, { name, input }: { name: string; input: { concernId?: string } }) => {
        if (name === 'neo.open') return result(input.concernId ?? 'root', 'unused', 'unused');
        if (input.concernId === 'a') {
          if (deferA)
            return new Promise((_resolve, reject) => {
              rejectA = reject;
            });
          return result('a', aVersion, 'a-check');
        }
        if (input.concernId === 'b') return result('b', 'b-old', 'b-check');
        return result('root', 'global', 'global-check');
      }
    );
    render(<ViewProbe />);
    await waitFor(() => expect(screen.getByText('View work: global')).toBeTruthy());
    expect(screen.getByText('Board work: global')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open A' }));
    await waitFor(() => expect(screen.getByText('View work: a-old')).toBeTruthy());
    expect(screen.getByText('Board work: a-old')).toBeTruthy();
    expect(screen.getByText('Overview work: global')).toBeTruthy();
    expect(screen.getByText('View checks: a-check')).toBeTruthy();
    aVersion = 'a-refreshed';
    act(() => neoEvents.changed?.());
    await waitFor(() => expect(screen.getByText('View work: a-refreshed')).toBeTruthy());
    expect(screen.getByText('Board work: a-refreshed')).toBeTruthy();
    deferA = true;
    act(() => neoEvents.changed?.());
    await waitFor(() => expect(rejectA).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Open B' }));
    await waitFor(() => expect(screen.getByText('View work: b-old')).toBeTruthy());
    await act(async () => rejectA?.(new Error('Stale A failure')));
    expect(screen.getByText('View work: b-old')).toBeTruthy();
    expect(screen.getByText('Board work: b-old')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Neo' }));
    await waitFor(() => expect(screen.getByText('View work: global')).toBeTruthy());
    expect(screen.getByText('Board work: global')).toBeTruthy();
    expect(screen.getByText('View checks: global-check')).toBeTruthy();
  });
});
