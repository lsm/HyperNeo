import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useNeo } from '../useNeo.ts';

const request = vi.hoisted(() => vi.fn());
const neoEvents = vi.hoisted(() => ({
  changed: null as (() => void) | null,
  working: null as ((event: { working: unknown[] }) => void) | null,
}));
const selectGate = vi.hoisted(() => ({ wait: null as Promise<void> | null }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () => ({
      request,
      onEvent: (name: string, callback: (event: { working: unknown[] }) => void) => {
        if (name === 'neo.working') {
          neoEvents.working = callback;
          return () => {};
        }
        if (name !== 'neo.changed') return () => {};
        neoEvents.changed = callback as () => void;
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
    async select() {
      await selectGate.wait;
    }
    async destroy() {}
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  neoEvents.changed = null;
  selectGate.wait = null;
});

function ViewProbe() {
  const neo = useNeo();
  return (
    <>
      <button onClick={() => void neo.open()}>Open Neo</button>
      <p>Overview work: {neo.snapshot?.work.map((item) => item.id).join(',') ?? 'loading'}</p>
      <p>Session: {neo.sessionId ?? 'none'}</p>
      <p>Working: {neo.snapshot?.working?.map((item) => item.sessionId).join(',') ?? 'none'}</p>
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
  it('shows who is working from the snapshot, then from each neo.working event, which a later refresh does not undo', async () => {
    request.mockImplementation(async () => ({
      ok: true,
      sessionId: 'root',
      projects: [],
      work: [],
      working: [{ sessionId: 'root', projectId: null, title: 'Neo', status: 'processing' }],
    }));
    render(<ViewProbe />);
    await waitFor(() => expect(screen.getByText('Working: root')).toBeTruthy());
    act(() =>
      neoEvents.working?.({
        working: [{ sessionId: 'holder', projectId: 'p', title: 'App', status: 'queued' }],
      })
    );
    await waitFor(() => expect(screen.getByText('Working: holder')).toBeTruthy());
    act(() => neoEvents.changed?.());
    await waitFor(() =>
      expect(
        request.mock.calls.filter(([, call]) => call.name === 'neo.snapshot')
      ).not.toHaveLength(0)
    );
    expect(screen.getByText('Working: holder')).toBeTruthy();
  });

  it('shows the snapshot neo.open returns without reading it again, then refreshes on change', async () => {
    let version = 'global';
    request.mockImplementation(async () => ({
      ok: true,
      sessionId: 'root',
      projects: [],
      work: [
        {
          id: version,
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
    expect(request.mock.calls.filter(([, call]) => call.name === 'neo.snapshot')).toHaveLength(0);
    version = 'refreshed';
    act(() => neoEvents.changed?.());
    await waitFor(() => expect(screen.getByText('Overview work: refreshed')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Open Neo' }));
    await waitFor(() =>
      expect(request.mock.calls.filter(([, call]) => call.name === 'neo.open')).toHaveLength(2)
    );
    expect(screen.getByText('Board work: refreshed')).toBeTruthy();
    for (const [, call] of request.mock.calls) expect(call.input).toEqual({ summaries: true });
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('shows the opened snapshot while the conversation is still loading', async () => {
    let release = () => {};
    selectGate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    request.mockImplementation(async () => ({
      ok: true,
      sessionId: 'root',
      projects: [],
      work: [
        {
          id: 'first',
          requestKey: 'first',
          projectId: null,
          originSessionId: 'root',
          sessionId: 'first',
          title: 'first',
          instruction: 'Do this',
          status: 'queued',
          report: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }));
    render(<ViewProbe />);
    await waitFor(() => expect(screen.getByText('Overview work: first')).toBeTruthy());
    expect(screen.getByText('Session: none')).toBeTruthy();
    act(() => release());
    await waitFor(() => expect(screen.getByText('Session: root')).toBeTruthy());
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

function DetailProbe() {
  const neo = useNeo();
  return (
    <>
      <button onClick={() => void neo.loadAskDetail('a')}>Load detail</button>
      <p>Done when: {neo.snapshot?.asks?.[0]?.doneWhen || 'summarized'}</p>
      <p>Detail failed: {String(neo.askDetailFailed('a'))}</p>
      <p>Epoch: {neo.askDetailEpoch}</p>
      <button onClick={() => void neo.open()}>Reopen</button>
      {neo.error && <p role="alert">{neo.error}</p>}
    </>
  );
}

describe('useNeo ask detail', () => {
  it('reads a summarized ask once per revision and shows its full fields', async () => {
    let revision = 2;
    const ask = (doneWhen: string, summarized?: true) => ({
      id: 'a',
      title: 'Ask a',
      doneWhen,
      revision,
      workIds: [],
      ...(summarized ? { summarized } : {}),
    });
    request.mockImplementation(
      async (_method: string, { name, input }: { name: string; input: { askId?: string } }) => ({
        ok: true,
        sessionId: 'root',
        projects: [],
        work: [],
        cards: [],
        asks: [name === 'neo.snapshot' && input.askId ? ask('Merged to dev') : ask('', true)],
      })
    );
    render(<DetailProbe />);
    await waitFor(() => expect(screen.getByText('Done when: summarized')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Load detail' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load detail' }));
    await waitFor(() => expect(screen.getByText('Done when: Merged to dev')).toBeTruthy());
    const detailReads = () =>
      request.mock.calls.filter(([, call]) => call.name === 'neo.snapshot' && call.input.askId);
    expect(detailReads()).toEqual([
      ['operation.invoke', { name: 'neo.snapshot', input: { askId: 'a' } }],
    ]);
    revision = 3;
    act(() => neoEvents.changed?.());
    await waitFor(() => expect(screen.getByText('Done when: summarized')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Load detail' }));
    await waitFor(() => expect(screen.getByText('Done when: Merged to dev')).toBeTruthy());
    expect(detailReads()).toHaveLength(2);
  });

  it('marks a failed detail read on its ask only, and lets the next expand try again', async () => {
    let fail = true;
    request.mockImplementation(
      async (_method: string, { name, input }: { name: string; input: { askId?: string } }) =>
        name === 'neo.snapshot' && input.askId
          ? fail
            ? { ok: false, reason: 'Ask detail unavailable.' }
            : {
                ok: true,
                sessionId: 'root',
                projects: [],
                work: [],
                cards: [],
                asks: [{ id: 'a', doneWhen: 'Merged to dev', revision: 2, workIds: [] }],
              }
          : {
              ok: true,
              sessionId: 'root',
              projects: [],
              work: [],
              cards: [],
              asks: [{ id: 'a', doneWhen: '', revision: 2, workIds: [], summarized: true }],
            }
    );
    render(<DetailProbe />);
    await waitFor(() => expect(screen.getByText('Done when: summarized')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Load detail' }));
    await waitFor(() => expect(screen.getByText('Detail failed: true')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Load detail' }));
    await waitFor(() => expect(screen.getByText('Done when: Merged to dev')).toBeTruthy());
    expect(screen.getByText('Detail failed: false')).toBeTruthy();
    expect(screen.getByText('Epoch: 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(screen.getByText('Epoch: 2')).toBeTruthy());
  });

  it('keeps the newer detail when an older read for the same ask lands last', async () => {
    let revision = 2;
    const pending: ((value: unknown) => void)[] = [];
    const ask = (doneWhen: string, rev: number, summarized?: true) => ({
      id: 'a',
      doneWhen,
      revision: rev,
      workIds: [],
      ...(summarized ? { summarized } : {}),
    });
    const snap = (asks: unknown[]) => ({
      ok: true,
      sessionId: 'root',
      projects: [],
      work: [],
      cards: [],
      asks,
    });
    request.mockImplementation(
      (_method: string, { name, input }: { name: string; input: { askId?: string } }) => {
        if (name === 'neo.snapshot' && input.askId) {
          const rev = revision;
          return new Promise((resolve) =>
            pending.push(() => resolve(snap([ask(`Done at ${rev}`, rev)])))
          );
        }
        return Promise.resolve(snap([ask('', revision, true)]));
      }
    );
    render(<DetailProbe />);
    await waitFor(() => expect(screen.getByText('Done when: summarized')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Load detail' }));
    await waitFor(() => expect(pending).toHaveLength(1));
    revision = 3;
    act(() => neoEvents.changed?.());
    await waitFor(() =>
      expect(
        request.mock.calls.filter(([, call]) => call.name === 'neo.snapshot' && !call.input.askId)
      ).toHaveLength(1)
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Load detail' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[1]!(undefined));
    await waitFor(() => expect(screen.getByText('Done when: Done at 3')).toBeTruthy());
    await act(async () => pending[0]!(undefined));
    expect(screen.getByText('Done when: Done at 3')).toBeTruthy();
  });
});
