import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useNeo } from '../useNeo.ts';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () => ({ request, onEvent: () => () => {}, onConnection: () => () => {} }),
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
});

function Probe() {
  const neo = useNeo();
  return (
    <>
      <button
        disabled={!neo.sessionId || !!neo.busyWork}
        onClick={() => void neo.act('check', 'stop-waiting')}
      >
        Stop waiting
      </button>
      {neo.error && <p role="alert">{neo.error}</p>}
      <p>Pending: {neo.snapshot?.consultations?.length ?? 0}</p>
    </>
  );
}

describe('useNeo stop waiting', () => {
  it('uses the consultation operation, exposes failure, and refreshes after a successful retry', async () => {
    let pending = true;
    let settle: (value: unknown) => void = () => {};
    request.mockImplementation(async (_method: string, { name }: { name: string }) => {
      if (name === 'neo.concern.cancel')
        return new Promise((resolve) => {
          settle = resolve;
        });
      return {
        ok: true,
        sessionId: 'root',
        concerns: [],
        work: [],
        consultations: pending ? [{ id: 'check' }] : [],
      };
    });
    render(<Probe />);
    await waitFor(() => expect(screen.getByRole('button').hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('operation.invoke', {
        name: 'neo.concern.cancel',
        input: { id: 'check' },
      })
    );
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true);
    await act(async () => {
      settle({ ok: false, reason: 'Try again' });
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Try again'));
    expect(screen.getByText('Pending: 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(
        request.mock.calls.filter((call) => call[1].name === 'neo.concern.cancel')
      ).toHaveLength(2)
    );
    pending = false;
    await act(async () => {
      settle({ ok: true });
    });
    await waitFor(() => expect(screen.getByText('Pending: 0')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
