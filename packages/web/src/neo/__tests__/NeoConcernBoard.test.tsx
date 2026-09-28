import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import type { DaemonInventoryLink, DaemonSnapshot } from '@hyperneo/shared/types/daemon-snapshot';
import { NeoConcernBoardPanel, NeoConcernBoardView } from '../NeoConcernBoard.tsx';
import { projectNeoConcernBoard } from '../neo-concern-board.ts';

const request = vi.hoisted(() => vi.fn());
const connected = signal('connected');
vi.mock('../../lib/state.ts', () => ({
  get connectionState() {
    return connected;
  },
}));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHub: async () => ({ request }) },
}));
const ref = (kind: string, id: string): DaemonInventoryLink => ({ kind, id });
const snapshot: NeoSnapshot = {
  ok: true,
  sessionId: 'root',
  concerns: ['a', 'b'].map((id) => ({
    id,
    title: `Concern ${id}`,
    summary: '',
    context: '',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
  })),
  work: ['a', 'b'].map((id) => ({
    id: `work-${id}`,
    requestKey: id,
    concernId: id,
    originSessionId: 'root',
    originMessageId: `ask-${id}`,
    title: `Work ${id}`,
    instruction: `Draft ${id}, do not send.`,
    sessionId: `worker-${id}`,
    status: 'queued',
    report: null,
    createdAt: 2,
    updatedAt: 3,
  })),
  consultations: [
    {
      id: 'check-a',
      requestKey: 'check',
      concernId: 'a',
      originSessionId: 'root',
      originMessageId: 'ask-a',
      sessionId: 'holder-a',
      question: 'What changed?',
      status: 'pending',
      answer: null,
      createdAt: 1,
    },
  ],
};
type Row = { kind: string; id: string; name: string; links?: DaemonInventoryLink[] };
function inventory(workerName = 'Draft worker'): DaemonSnapshot {
  const rows: Row[] = [
    { kind: 'session', id: 'root', name: 'Neo' },
    { kind: 'session', id: 'holder-a', name: 'Research context' },
    { kind: 'session', id: 'worker-a', name: workerName, links: [ref('future-kind', 'future')] },
    { kind: 'session', id: 'worker-b', name: 'Other worker' },
    {
      kind: 'task',
      id: 'task-a',
      name: 'Actual task',
      links: [ref('session', 'worker-a'), ref('space', 'shared')],
    },
    {
      kind: 'task',
      id: 'task-b',
      name: 'Unrelated task',
      links: [ref('session', 'worker-b'), ref('space', 'shared')],
    },
    { kind: 'space', id: 'shared', name: 'Shared Space' },
    { kind: 'future-kind', id: 'future', name: 'New primitive', links: [ref('goal', 'missing')] },
  ];
  return {
    capturedAt: 123,
    capabilities: ['daemon.snapshot'],
    resources: [...new Set(rows.map((row) => row.kind))].map((kind) => ({
      kind,
      total: rows.filter((row) => row.kind === kind).length + 1,
      truncated: true,
      entries: rows
        .filter((row) => row.kind === kind)
        .map((row) => ({
          id: row.id,
          name: row.name,
          status: 'active',
          updatedAt: 100,
          workspacePath: row.id === 'task-a' ? '/project/research' : null,
          links: row.links ?? [],
        })),
    })),
  };
}
function pending() {
  let resolve!: (value: DaemonSnapshot) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<DaemonSnapshot>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function expand() {
  fireEvent.click(screen.getByText(/How (Neo is handling things|this is being handled)/));
}
beforeEach(() => {
  request.mockReset().mockResolvedValue(inventory());
  connected.value = 'connected';
});
afterEach(cleanup);

describe('NeoConcernBoardView', () => {
  it('renders actual scoped receipts, unknown references and outgoing relationships', () => {
    const board = projectNeoConcernBoard(snapshot, 'a', inventory())!;
    render(<NeoConcernBoardView board={board} />);
    expect(screen.getByText(/For Concern a/)).toBeTruthy();
    expect(screen.getByText('Work a')).toBeTruthy();
    expect(screen.queryByText('Work b')).toBeNull();
    expect(screen.getByText('Handed to HyperNeo')).toBeTruthy();
    expect(screen.getByText('Checking context')).toBeTruthy();
    expect(screen.getAllByText('Input: root / ask-a')).toHaveLength(2);
    const participants = within(screen.getByRole('list', { name: 'Linked participants' }));
    expect(participants.getByText('Actual task')).toBeTruthy();
    expect(participants.getByText('Shared Space')).toBeTruthy();
    expect(participants.getByText('New primitive')).toBeTruthy();
    expect(participants.queryByText('Unrelated task')).toBeNull();
    expect(participants.queryByText('Other worker')).toBeNull();
    const task = participants.getByText('Actual task').closest('li')!;
    expect(within(task).getByText('→ Shared Space · space')).toBeTruthy();
    expect(within(task).getByText('Workspace: /project/research')).toBeTruthy();
    expect(screen.getByText('Details unavailable in this snapshot.')).toBeTruthy();
    expect(screen.getByText(/Missing details do not mean a resource was deleted/)).toBeTruthy();
    expect(screen.getByText(/Partial inventory: future-kind, session, space, task/)).toBeTruthy();
    expect(screen.getByText(/Resource details captured/)).toBeTruthy();
    expect(screen.getByText(/older receipts may be omitted/)).toBeTruthy();
    expect(screen.getByText(/Session state describes its lifecycle/)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
  it('labels returned claims as response ready, not completed work', () => {
    const source: NeoSnapshot = {
      ...snapshot,
      work: [{ ...snapshot.work[0], status: 'reported', report: 'Draft ready, not sent.' }],
      consultations: [
        { ...snapshot.consultations![0], status: 'reported', answer: 'Awaiting your decision.' },
      ],
    };
    render(<NeoConcernBoardView board={projectNeoConcernBoard(source, 'a', null)!} />);
    expect(screen.getAllByText('Response ready')).toHaveLength(2);
    expect(screen.getByText('Draft ready, not sent.')).toBeTruthy();
    expect(screen.getByText('Awaiting your decision.')).toBeTruthy();
    expect(screen.queryByText('Completed')).toBeNull();
    expect(screen.getByText(/not verified completion/)).toBeTruthy();
    expect(screen.getByText(/Resource details have not been captured/)).toBeTruthy();
  });
  it.each([
    ['proposed', 'Your call'],
    ['failed', 'Needs attention'],
    ['cancelled', 'Stopped'],
  ] as const)('shows the recorded %s status', (status, label) => {
    render(
      <NeoConcernBoardView
        board={
          projectNeoConcernBoard(
            {
              ...snapshot,
              work: [{ ...snapshot.work[0], status, originMessageId: null }],
              consultations: [],
            },
            null,
            null
          )!
        }
      />
    );
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText(/Across your concerns/)).toBeTruthy();
    expect(screen.getByText('Input: root / not recorded')).toBeTruthy();
  });
});

describe('NeoConcernBoardPanel', () => {
  it('does no reads until opened and closes from the bottom without a second transcript', async () => {
    render(<NeoConcernBoardPanel snapshot={snapshot} concernId="a" />);
    expect(request).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Concern board' })).toBeNull();
    expand();
    await screen.findByText('Draft worker');
    expect(request).toHaveBeenCalledExactlyOnceWith('operation.invoke', {
      name: 'daemon.snapshot',
      input: { limit: 50, includeArchived: false },
    });
    fireEvent.click(screen.getAllByText('Request details')[0]);
    expect(request).toHaveBeenCalledTimes(1);
    const summary = screen.getByText('How this is being handled');
    fireEvent.click(screen.getByRole('button', { name: 'Close board' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Concern board' })).toBeNull());
    expect(summary.closest('details')?.open).toBe(false);
    expect(document.activeElement).toBe(summary);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([null, 'missing'])('renders no misleading board for missing scope %s', async (scope) => {
    render(<NeoConcernBoardPanel snapshot={scope ? snapshot : null} concernId={scope} />);
    expect(screen.queryByText(/How /)).toBeNull();
    await act(async () => {});
    expect(request).not.toHaveBeenCalled();
  });
  it('refreshes receipt changes without a polling loop', async () => {
    const view = render(<NeoConcernBoardPanel snapshot={snapshot} concernId="a" />);
    expand();
    await screen.findByText('Draft worker');
    request.mockResolvedValue(inventory('Updated worker'));
    view.rerender(
      <NeoConcernBoardPanel
        snapshot={{
          ...snapshot,
          work: [{ ...snapshot.work[0], status: 'reported', report: 'A returned claim.' }],
        }}
        concernId="a"
      />
    );
    await screen.findByText('Updated worker');
    expect(screen.getByText('Response ready')).toBeTruthy();
    expect(screen.getByText('A returned claim.')).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => {});
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each(['success', 'failure'])(
    'ignores a late %s after closing and reopening',
    async (outcome) => {
      const old = pending();
      request.mockImplementationOnce(() => old.promise);
      render(<NeoConcernBoardPanel snapshot={snapshot} concernId="a" />);
      expand();
      await screen.findByText('Checking linked resources…');
      fireEvent.click(screen.getByRole('button', { name: 'Close board' }));
      expand();
      await screen.findByText('Draft worker');
      await act(async () => {
        if (outcome === 'success') old.resolve(inventory('Obsolete worker'));
        else old.reject(new Error('Obsolete failure'));
      });
      expect(screen.queryByText('Obsolete worker')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByText('Draft worker')).toBeTruthy();
      expect(request).toHaveBeenCalledTimes(2);
    }
  );
  it.each(['success', 'failure'])(
    'does not apply an old %s to a different concern',
    async (outcome) => {
      const old = pending();
      request.mockImplementationOnce(() => old.promise);
      const view = render(<NeoConcernBoardPanel snapshot={snapshot} concernId="a" />);
      expand();
      await screen.findByText('Checking linked resources…');
      view.rerender(<NeoConcernBoardPanel snapshot={snapshot} concernId="b" />);
      await screen.findByText('Other worker');
      await act(async () => {
        if (outcome === 'success') old.resolve(inventory('Obsolete worker'));
        else old.reject(new Error('Obsolete failure'));
      });
      expect(screen.queryByText('Obsolete worker')).toBeNull();
      expect(screen.queryByText('Work a')).toBeNull();
      expect(screen.getByText('Work b')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    }
  );
  it('does not resurrect an unmounted board when a read fails', async () => {
    const old = pending();
    request.mockImplementationOnce(() => old.promise);
    const view = render(<NeoConcernBoardPanel snapshot={snapshot} concernId="a" />);
    expand();
    await screen.findByText('Checking linked resources…');
    view.unmount();
    await act(async () => old.reject(new Error('Late failure')));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(['rejection', 'transport'])(
    'keeps receipts visible on %s, then permits explicit refresh',
    async (fault) => {
      if (fault === 'rejection')
        request.mockResolvedValueOnce({ accepted: false, reason: 'daemon_inventory_forbidden' });
      else request.mockRejectedValueOnce(new Error('Disconnected'));
      render(<NeoConcernBoardPanel snapshot={snapshot} concernId="a" />);
      expand();
      await screen.findByRole('alert');
      expect(screen.getByText('Work a')).toBeTruthy();
      expect(screen.queryByText(/Resource details captured/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Refresh details' }));
      await screen.findByText('Draft worker');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(request).toHaveBeenCalledTimes(2);
    }
  );
  it('refreshes only an open board after reconnection', async () => {
    connected.value = 'disconnected';
    render(<NeoConcernBoardPanel snapshot={snapshot} concernId="a" />);
    expand();
    expect(screen.getByText('Work a')).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByText('Reconnect to refresh resource details.')).toBeTruthy();
    act(() => {
      connected.value = 'connected';
    });
    await screen.findByText('Draft worker');
    fireEvent.click(screen.getByRole('button', { name: 'Close board' }));
    act(() => {
      connected.value = 'disconnected';
    });
    act(() => {
      connected.value = 'connected';
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('invalidates in-flight metadata on disconnection without polling', async () => {
    const old = pending();
    request.mockImplementationOnce(() => old.promise);
    render(<NeoConcernBoardPanel snapshot={snapshot} concernId="a" />);
    expand();
    await screen.findByText('Checking linked resources…');
    act(() => {
      connected.value = 'disconnected';
    });
    await act(async () => old.resolve(inventory('Disconnected worker')));
    expect(screen.queryByText('Disconnected worker')).toBeNull();
    expect(screen.queryByText(/Resource details captured/)).toBeNull();
    expect(screen.getByText('Work a')).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
