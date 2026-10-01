import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { NeoWorkCard } from '../NeoWorkCard.tsx';
import { SessionStore } from '../../lib/session-store.ts';
import { connectionState } from '../../lib/state.ts';

const transport = vi.hoisted(() => ({ hub: null as unknown }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () => transport.hub,
    getHubIfConnected: () => transport.hub,
  },
}));
const work = (status: NeoWork['status'] = 'queued'): NeoWork => ({
  id: 'fictional-work',
  requestKey: 'fictional-work',
  concernId: null,
  originSessionId: 'neo',
  originMessageId: 'ask',
  title: 'A bounded fictional task',
  instruction: 'Keep the full native brief in detail.',
  sessionId: 'fictional-worker',
  status,
  report: status === 'reported' ? 'A reported response, not verified completion.' : null,
  createdAt: 1,
  updatedAt: 2,
});
let join: ReturnType<typeof vi.fn>;
let leave: ReturnType<typeof vi.fn>;
beforeEach(() => {
  connectionState.value = 'connected';
  join = vi.fn();
  leave = vi.fn();
  transport.hub = {
    joinChannel: join,
    leaveChannel: leave,
    onEvent: () => () => {},
    onConnection: () => () => {},
    request: vi.fn(async (method: string, input: { subscriptionId?: string }) => {
      if (method === 'state.session')
        return {
          sessionInfo: { id: 'fictional-worker', metadata: {} },
          agentState: { status: 'idle' },
          revision: 1,
          daemonEpoch: 'fictional',
        };
      if (method === 'liveQuery.subscribe') return { subscriptionId: input.subscriptionId };
      if (method === 'message.count') return { count: 0 };
      return { success: true };
    }),
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('NeoWorkCard summary presentation', () => {
  it.each([
    ['proposed', 'Your call'],
    ['queued', 'Handed to HyperNeo'],
    ['reported', 'Response ready'],
    ['failed', 'Needs attention'],
    ['cancelled', 'Stopped'],
  ] as const)(
    'renders recorded %s truth without native action or question ownership',
    async (status, label) => {
      const select = vi.spyOn(SessionStore.prototype, 'select');
      const open = vi.fn();
      const action = vi.fn();
      const item = work(status);
      const view = render(
        <NeoWorkCard
          work={item}
          busy={true}
          disabled={true}
          onAction={action}
          onOpen={open}
          presentation="summary"
        />
      );
      await act(async () => {});
      const button = screen.getByRole('button', { name: `View details for ${item.title}` });
      expect(button.getAttribute('type')).toBe('button');
      expect(button.getAttribute('disabled')).toBeNull();
      expect(button.getAttribute('data-scene-open')).toBe(item.id);
      expect(screen.getByText(label)).toBeTruthy();
      expect(screen.getByText(item.title)).toBeTruthy();
      expect(view.container.querySelector('details, article, textarea, input, a')).toBeNull();
      expect(screen.queryByText('A quick choice')).toBeNull();
      expect(select).not.toHaveBeenCalled();
      expect(join).not.toHaveBeenCalled();
      fireEvent.click(button.querySelector('svg')!);
      expect(open).toHaveBeenCalledExactlyOnceWith(item.id);
      expect(action).not.toHaveBeenCalled();
    }
  );
  it('creates a native observer only after switching to full detail and destroys it on returning', async () => {
    const select = vi.spyOn(SessionStore.prototype, 'select');
    const destroy = vi.spyOn(SessionStore.prototype, 'destroy');
    const props = {
      work: work(),
      busy: false,
      disabled: false,
      onAction: vi.fn(),
      onOpen: vi.fn(),
    };
    const view = render(<NeoWorkCard {...props} presentation="summary" />);
    expect(select).not.toHaveBeenCalled();
    view.rerender(<NeoWorkCard {...props} presentation="detail" />);
    await waitFor(() => expect(select).toHaveBeenCalledExactlyOnceWith('fictional-worker'));
    expect(screen.getByRole('button', { name: 'Stop work' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Inspect execution ↗' })).toBeTruthy();
    view.rerender(<NeoWorkCard {...props} presentation="summary" />);
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    await Promise.all(destroy.mock.results.map((result) => result.value));
    expect(leave).toHaveBeenCalledWith('session:fictional-worker');
    expect(select).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Stop work' })).toBeNull();
  });
  it('preserves full native actions when no detail opener is available', () => {
    const action = vi.fn();
    render(
      <NeoWorkCard
        work={{ ...work('proposed'), sessionId: null }}
        busy={false}
        disabled={false}
        onAction={action}
        presentation="summary"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(action).toHaveBeenNthCalledWith(1, 'fictional-work', 'start');
    expect(action).toHaveBeenNthCalledWith(2, 'fictional-work', 'cancel');
  });
});
