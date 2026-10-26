import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSkill, Session, SessionMcpServerEntry } from '@hyperneo/shared';
import { SessionToolChoices } from '../SessionToolChoices.tsx';

const backend = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHub: async () => ({ request: backend.request }) },
}));
afterEach(() => {
  cleanup();
  backend.request.mockReset();
});
const session: Session = {
  id: 'fixture',
  title: 'Synthetic tools',
  workspacePath: '/synthetic',
  createdAt: '2026-01-01T00:00:00Z',
  lastActiveAt: '2026-01-01T00:00:00Z',
  status: 'active',
  metadata: {
    messageCount: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalCost: 0,
    toolCallCount: 0,
  },
  config: {
    model: 'haiku',
    maxTokens: 1024,
    temperature: 0,
    toolSelection: {
      version: 1,
      choices: { 'mcp:browser': { selected: false, aliases: ['browser-alias'] } },
    },
  },
};
const wrapper = {
  id: 'wrapper',
  name: 'browser-alias',
  displayName: 'Browser',
  enabled: false,
  sourceType: 'mcp_server',
  config: { type: 'mcp_server', appMcpServerId: 'browser' },
} as AppSkill;
const servers = [
  { server: { id: 'browser', name: 'Server', enabled: false }, enabled: false },
] as SessionMcpServerEntry[];
const props = { session, skills: [wrapper], servers, inventory: null, onApplied: vi.fn() };

describe('Session tool choices', () => {
  it.each([
    ['next_query', 'Saved · applies to the next query'],
    ['restart_required', 'Saved · restart required; your session was not interrupted'],
    ['unverified', 'Saved · attachment could not be verified'],
  ])('discloses %s without claiming attachment or interrupting', async (application, text) => {
    backend.request.mockResolvedValue({
      ok: true,
      changed: true,
      application,
      reason: 'instructions_reload_unavailable',
    });
    const view = render(<SessionToolChoices {...props} />);
    fireEvent.click(view.getByRole('button', { name: 'Use here: Browser' }));
    await waitFor(() => expect(view.getByRole('status').textContent).toBe(text));
    expect(view.getByText('Saved choice: on')).toBeTruthy();
    expect(view.getByText(/running inventory unavailable/)).toBeTruthy();
    expect(backend.request).toHaveBeenCalledExactlyOnceWith('operation.invoke', {
      name: 'session.tools.setChoice',
      input: { sessionId: 'fixture', key: 'mcp:browser', selected: true },
    });
  });

  it('leaves a refused choice off and shows why', async () => {
    backend.request.mockResolvedValue({ ok: false, reason: 'space-required' });
    const view = render(<SessionToolChoices {...props} />);
    fireEvent.click(view.getByRole('button', { name: 'Use here: Browser' }));
    await waitFor(() => expect(view.getByRole('status').textContent).toContain('space required'));
    expect(view.getByText('Saved choice: off')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Use here: Browser' }).hasAttribute('disabled')).toBe(
      false
    );
  });

  it('retains the saved choice after a network failure and can retry', async () => {
    backend.request
      .mockRejectedValueOnce(new Error('Disconnected'))
      .mockResolvedValueOnce({ ok: true, application: 'live' });
    const view = render(<SessionToolChoices {...props} />);
    fireEvent.click(view.getByRole('button', { name: 'Use here: Browser' }));
    await waitFor(() => expect(view.getByRole('status').textContent).toContain('Try again'));
    expect(view.getByText('Saved choice: off')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Use here: Browser' }));
    await waitFor(() => expect(view.getByText('Saved choice: on')).toBeTruthy());
  });

  it('blocks duplicate clicks while saving, then can turn the same tool off', async () => {
    let finish!: (value: unknown) => void;
    backend.request
      .mockReturnValueOnce(
        new Promise((done) => {
          finish = done;
        })
      )
      .mockResolvedValue({ ok: true, application: 'live' });
    const view = render(<SessionToolChoices {...props} />);
    fireEvent.click(view.getByRole('button', { name: 'Use here: Browser' }));
    expect(view.getByRole('button').hasAttribute('disabled')).toBe(true);
    await act(async () => {
      finish({ ok: true, application: 'live' });
    });
    await waitFor(() =>
      expect(view.getByRole('button', { name: 'Stop using here: Browser' })).toBeTruthy()
    );
    fireEvent.click(view.getByRole('button', { name: 'Stop using here: Browser' }));
    await waitFor(() => expect(view.getByText('Saved choice: off')).toBeTruthy());
    expect(backend.request).toHaveBeenLastCalledWith('operation.invoke', {
      name: 'session.tools.setChoice',
      input: { sessionId: 'fixture', key: 'mcp:browser', selected: false },
    });
  });

  it('reloads the saved selection even when its catalog defaults are off', () => {
    const current = {
      ...session,
      config: {
        ...session.config,
        toolSelection: { version: 1 as const, choices: { 'mcp:browser': { selected: true } } },
      },
    };
    const view = render(<SessionToolChoices {...props} session={current} />);
    expect(view.getAllByRole('button')).toHaveLength(1);
    expect(view.getByRole('button', { name: 'Stop using here: Browser' })).toBeTruthy();
    expect(view.queryByText('Server')).toBeNull();
  });

  it('does not show a late reply from the previous session', async () => {
    let finish!: (value: unknown) => void;
    backend.request.mockReturnValue(
      new Promise((done) => {
        finish = done;
      })
    );
    const view = render(<SessionToolChoices key="first" {...props} />);
    fireEvent.click(view.getByRole('button', { name: 'Use here: Browser' }));
    await waitFor(() => expect(backend.request).toHaveBeenCalledTimes(1));
    view.rerender(
      <SessionToolChoices key="second" {...props} session={{ ...session, id: 'second' }} />
    );
    await act(async () => {
      finish({ ok: true, application: 'restart_required' });
    });
    expect(view.getByText('Saved choice: off')).toBeTruthy();
    expect(view.queryByRole('status')).toBeNull();
  });
});
