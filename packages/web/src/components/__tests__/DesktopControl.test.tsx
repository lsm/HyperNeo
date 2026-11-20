import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopControl } from '../DesktopControl.tsx';
import { locale } from '../../lib/i18n/index.ts';
import { connectionState } from '../../lib/state.ts';

const { invoke, hub } = vi.hoisted(() => ({ invoke: vi.fn(), hub: {} }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHubIfConnected: () => hub },
}));
vi.mock('../../lib/operations.ts', () => ({ invokeOperation: invoke }));

const entry = (state: string) => ({ worker: 'worker-a', todo: 'Book the dentist', state });
const statuses = (...states: string[]) => {
  for (const state of states) {
    invoke.mockImplementationOnce(async (_hub, name) =>
      name === 'desktop.status' ? { workers: [entry(state)] } : { state: 'stopped' }
    );
  }
};
beforeEach(() => {
  locale.value = 'en';
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('DesktopControl', () => {
  it('shows nothing while desktop control is off', async () => {
    invoke.mockResolvedValue({ workers: [entry('off')] });
    const { container } = render(<DesktopControl worker="worker-a" />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(hub, 'desktop.status', { worker: 'worker-a' })
    );
    expect(container.textContent).toBe('');
  });

  it('stops a running driver and hands the desktop back', async () => {
    statuses('running');
    let finish: (value: unknown) => void = () => {};
    invoke.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    statuses('stopped');
    render(<DesktopControl worker="worker-a" />);
    expect(await screen.findByText('The agent can use the desktop')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop and take over' }));
    const stopping = await screen.findByRole('button', { name: 'Stopping…' });
    expect((stopping as HTMLButtonElement).disabled).toBe(true);
    expect(invoke).toHaveBeenCalledWith(hub, 'desktop.stop', { worker: 'worker-a' });
    finish({ state: 'stopped' });
    expect(await screen.findByText('Stopped. The desktop is yours.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers another stop when the last one was not confirmed', async () => {
    statuses('stop_unconfirmed');
    render(<DesktopControl worker="worker-a" />);
    expect(await screen.findByText('Stop not confirmed: the driver may still run')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try stopping again' })).toBeTruthy();
  });

  it('says when HyperNeo Desktop is not running and can still stop', async () => {
    statuses('unavailable');
    render(<DesktopControl worker="worker-a" />);
    expect(await screen.findByText('HyperNeo Desktop is not running')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop and take over' })).toBeTruthy();
  });

  it('lists every worker with desktop control and its todo', async () => {
    invoke.mockResolvedValue({
      workers: [entry('running'), { worker: 'worker-b', todo: 'File taxes', state: 'stopped' }],
    });
    render(<DesktopControl />);
    expect(await screen.findByText('Book the dentist')).toBeTruthy();
    expect(screen.getByText('File taxes')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith(hub, 'desktop.status', {});
  });

  it('shows the ask-or-not switch with no workers and saves a change', async () => {
    invoke.mockImplementation(async (_hub, name) =>
      name === 'pack.preferences.get'
        ? { preference: null }
        : name === 'pack.preferences.set'
          ? { ok: true }
          : { workers: [] }
    );
    render(<DesktopControl />);
    const toggle = await screen.findByRole('switch', { name: 'Use without asking' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(invoke).toHaveBeenCalledWith(hub, 'pack.preferences.set', {
      pack: 'core',
      scope: { kind: 'global', key: '' },
      key: 'desktopControl',
      value: true,
    });
  });

  it('shows nothing when the status read is refused', async () => {
    invoke.mockResolvedValue({ accepted: false, reason: 'not_admitted' });
    const { container } = render(<DesktopControl />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('polls a session without desktop control only rarely', async () => {
    vi.useFakeTimers();
    try {
      invoke.mockResolvedValue({ workers: [entry('off')] });
      render(<DesktopControl worker="worker-a" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(invoke).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25000);
      });
      expect(invoke).toHaveBeenCalledTimes(2);
      invoke.mockResolvedValue({ workers: [entry('running')] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(invoke).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the agent the same way in Chinese', async () => {
    locale.value = 'zh-Hans';
    statuses('running');
    render(<DesktopControl worker="worker-a" />);
    expect(await screen.findByText('智能体可以使用电脑')).toBeTruthy();
  });

  it('says so when the stop request does not reach the daemon', async () => {
    statuses('running');
    invoke.mockRejectedValueOnce(new Error('offline'));
    statuses('running');
    render(<DesktopControl worker="worker-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop and take over' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The stop request failed. Try again.'
    );
    expect(screen.getByRole('button', { name: 'Stop and take over' })).toBeTruthy();
  });

  it('opens the worker session from the drawer row', async () => {
    invoke.mockResolvedValue({ workers: [entry('running')] });
    const open = vi.fn();
    render(<DesktopControl onOpen={open} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Book the dentist' }));
    expect(open).toHaveBeenCalledWith('worker-a', 'Book the dentist');
  });

  it('keeps the last known Stop when a status read fails', async () => {
    vi.useFakeTimers();
    try {
      statuses('running');
      invoke.mockRejectedValue(new Error('offline'));
      render(<DesktopControl worker="worker-a" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole('button', { name: 'Stop and take over' })).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('button', { name: 'Stop and take over' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the status again once the connection is back', async () => {
    connectionState.value = 'disconnected';
    invoke.mockResolvedValue({ workers: [entry('running')] });
    render(<DesktopControl worker="worker-a" />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    act(() => {
      connectionState.value = 'connected';
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  });

  it('keeps each row stopping on its own', async () => {
    const two = {
      workers: [entry('running'), { worker: 'worker-b', todo: 'File taxes', state: 'running' }],
    };
    invoke.mockImplementation((_hub, name) =>
      name === 'desktop.status' ? Promise.resolve(two) : new Promise(() => {})
    );
    render(<DesktopControl />);
    const [first, second] = await screen.findAllByRole('button', { name: 'Stop and take over' });
    fireEvent.click(first);
    fireEvent.click(second);
    const stopping = await screen.findAllByRole('button', { name: 'Stopping…' });
    expect(stopping).toHaveLength(2);
    expect(stopping.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });

  it('says a stop is unconfirmed while Desktop is not running', async () => {
    statuses('unavailable');
    invoke.mockResolvedValueOnce({ state: 'stop_unconfirmed' });
    statuses('unavailable');
    render(<DesktopControl worker="worker-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop and take over' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Stop not confirmed: the driver may still run'
    );
    expect(screen.getByRole('button', { name: 'Try stopping again' })).toBeTruthy();
  });

  it('drops the failure once the status reads stopped', async () => {
    statuses('running');
    invoke.mockRejectedValueOnce(new Error('reply lost'));
    statuses('stopped');
    render(<DesktopControl worker="worker-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop and take over' }));
    expect(await screen.findByText('Stopped. The desktop is yours.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
