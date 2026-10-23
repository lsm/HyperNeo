import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo } from '@hyperneo/shared';
import type { SessionStore } from '../../lib/session-store.ts';
import { NeoPreferences } from '../NeoPreferences.tsx';

const api = vi.hoisted(() => ({
  request: vi.fn(),
  switchModel: vi.fn(),
  mode: 'granular' as 'granular' | 'off',
}));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHubIfConnected: () => ({ request: api.request }) },
}));
vi.mock('../../lib/state.ts', () => ({ connectionState: { value: 'connected' } }));
vi.mock('../../hooks/useModelSwitcher.ts', async (original) => {
  const actual = await original<typeof import('../../hooks/useModelSwitcher.ts')>();
  const models = [
    { id: 'sonnet', name: 'Sonnet', alias: 'sonnet', provider: 'anthropic' },
    { id: 'haiku', name: 'Haiku', alias: 'haiku', provider: 'anthropic' },
    { id: 'sonnet', name: 'Sonnet', alias: 'sonnet', provider: 'anthropic' },
  ] as ModelInfo[];
  return {
    ...actual,
    useModelSwitcher: () => ({
      currentModel: 'sonnet',
      currentModelInfo: { ...models[0], thinkingModes: api.mode },
      availableModels: models,
      switching: false,
      loading: false,
      switchModel: api.switchModel,
      reload: vi.fn(),
    }),
  };
});

function makeStore(working = false) {
  return {
    isWorking: signal(working),
    sessionInfo: signal({ config: { thinkingLevel: 'off' } }),
    refresh: vi.fn(),
  } as unknown as SessionStore;
}
beforeEach(() => {
  vi.clearAllMocks();
  api.mode = 'granular';
  api.request.mockResolvedValue({ providers: [] });
  api.switchModel.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('Neo preferences', () => {
  it('restarts Neo after the human confirms, and offers no restart for a plain session', async () => {
    const store = makeStore();
    api.request.mockImplementation(async (method: string) =>
      method === 'operation.invoke' ? { ok: true, sessionId: 'neo:root' } : { providers: [] }
    );
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    render(<NeoPreferences sessionId="neo:root" store={store} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Model and thinking' }));
    fireEvent.click(screen.getByRole('button', { name: /Restart Neo/ }));
    expect(api.request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: /Restart Neo/ }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith('operation.invoke', {
        name: 'neo.restart',
        input: {},
      })
    );
    await waitFor(() => expect(store.refresh).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalledTimes(2);
    cleanup();
    render(<NeoPreferences sessionId="s1" store={makeStore()} onError={vi.fn()} forSession />);
    fireEvent.click(screen.getByRole('button', { name: 'Model and thinking' }));
    expect(screen.queryByRole('button', { name: /Restart Neo/ })).toBeNull();
    vi.unstubAllGlobals();
  });

  it('links to Neo model Settings without duplicating the model or thinking controls', () => {
    render(<NeoPreferences sessionId="neo:root" store={makeStore()} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Model and thinking' }));
    expect(screen.getByRole('link', { name: 'Neo model settings' }).getAttribute('href')).toBe(
      '/settings?tab=neo-model'
    );
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(api.request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
  });
  it('closes the minimal Neo menu on Escape and restores trigger focus', () => {
    render(<NeoPreferences sessionId="neo:root" store={makeStore()} onError={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Model and thinking' });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('link', { name: 'Neo model settings' }), { key: 'Escape' });
    expect(screen.queryByRole('link', { name: 'Neo model settings' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it('changes one session’s own model and thinking, ignoring Neo’s preference', async () => {
    const store = makeStore();
    api.request.mockImplementation(async (method: string) =>
      method === 'session.model.switch' ? { success: true, model: 'haiku' } : { providers: [] }
    );
    render(
      <NeoPreferences
        sessionId="s1"
        store={store}
        onError={vi.fn()}
        forSession
        preference={{ model: 'haiku', provider: 'anthropic', thinkingLevel: 'off', saved: true }}
      />
    );
    expect(screen.getByRole('button', { name: 'Model and thinking' }).textContent).toContain(
      'Sonnet'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Model and thinking' }));
    expect(screen.getByText('For this session, from its next turn')).toBeTruthy();
    fireEvent.change(screen.getByRole('slider', { name: 'Thinking' }), { target: { value: '2' } });
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith('session.thinking.set', {
        sessionId: 's1',
        level: 'think16k',
      })
    );
    expect(api.request).not.toHaveBeenCalledWith('session.model.switch', expect.anything());
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Haiku · Anthropic' }) as HTMLButtonElement).disabled
      ).toBe(false)
    );
    fireEvent.click(screen.getByRole('button', { name: 'Haiku · Anthropic' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith('session.model.switch', {
        sessionId: 's1',
        model: 'haiku',
        provider: 'anthropic',
      })
    );
    expect(api.request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
    await waitFor(() => expect(store.refresh).toHaveBeenCalled());
  });
  it('reports a session model switch the daemon refuses', async () => {
    const onError = vi.fn();
    api.request.mockImplementation(async (method: string) =>
      method === 'session.model.switch'
        ? { success: false, model: 'sonnet', error: 'Invalid model: haiku' }
        : { providers: [] }
    );
    render(<NeoPreferences sessionId="s1" store={makeStore(true)} onError={onError} forSession />);
    fireEvent.click(screen.getByRole('button', { name: 'Model and thinking' }));
    expect(screen.getByText('A new model takes over from the next turn')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Haiku · Anthropic' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Invalid model: haiku'));
  });
  it('marks a model switch waiting for the next turn, and clears it once applied', () => {
    const store = makeStore(true);
    const info = store.sessionInfo as unknown as {
      value: { config: Record<string, unknown>; metadata?: Record<string, unknown> };
    };
    info.value = {
      config: { thinkingLevel: 'off' },
      metadata: {
        pendingModelSwitch: { model: 'haiku', provider: 'anthropic', requestedAt: 1 },
      },
    };
    const view = render(
      <NeoPreferences sessionId="s1" store={store} onError={vi.fn()} forSession />
    );
    const trigger = screen.getByRole('button', { name: 'Model and thinking' });
    expect(trigger.textContent).toContain('Haiku');
    expect(trigger.textContent).toContain('switches next turn');
    info.value = { config: { thinkingLevel: 'off' }, metadata: { pendingModelSwitch: null } };
    view.rerender(<NeoPreferences sessionId="s1" store={store} onError={vi.fn()} forSession />);
    expect(trigger.textContent).not.toContain('switches next turn');
    expect(trigger.textContent).toContain('Sonnet');
  });
  it('re-picking the running model cancels a pending switch', async () => {
    const store = makeStore(true);
    (store.sessionInfo as unknown as { value: unknown }).value = {
      config: { thinkingLevel: 'off' },
      metadata: { pendingModelSwitch: { model: 'haiku', provider: 'anthropic', requestedAt: 1 } },
    };
    api.request.mockImplementation(async (method: string) =>
      method === 'session.model.switch' ? { success: true, model: 'sonnet' } : { providers: [] }
    );
    render(<NeoPreferences sessionId="s1" store={store} onError={vi.fn()} forSession />);
    const trigger = screen.getByRole('button', { name: 'Model and thinking' });
    expect(trigger.title).toContain('Haiku');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Sonnet · Anthropic' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith('session.model.switch', {
        sessionId: 's1',
        model: 'sonnet',
        provider: 'anthropic',
      })
    );
  });
  it('keeps a pending switch when only thinking changes', async () => {
    const store = makeStore(true);
    (store.sessionInfo as unknown as { value: unknown }).value = {
      config: { thinkingLevel: 'off' },
      metadata: { pendingModelSwitch: { model: 'haiku', provider: 'anthropic', requestedAt: 1 } },
    };
    api.request.mockResolvedValue({ providers: [] });
    render(<NeoPreferences sessionId="s1" store={store} onError={vi.fn()} forSession />);
    fireEvent.click(screen.getByRole('button', { name: 'Model and thinking' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Thinking' }), { target: { value: '2' } });
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith('session.thinking.set', {
        sessionId: 's1',
        level: 'think16k',
      })
    );
    expect(api.request).not.toHaveBeenCalledWith('session.model.switch', expect.anything());
  });
  it('keeps the settings link available while Neo works', () => {
    render(<NeoPreferences sessionId="neo:root" store={makeStore(true)} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Model and thinking' }));
    expect(screen.getByRole('link', { name: 'Neo model settings' })).toBeTruthy();
  });
  it('shows Neo’s saved preference rather than the session’s current model', () => {
    render(
      <NeoPreferences
        sessionId="neo:root"
        store={makeStore()}
        onError={vi.fn()}
        preference={{ model: 'haiku', provider: 'anthropic', thinkingLevel: 'off', saved: true }}
      />
    );
    expect(screen.getByRole('button', { name: 'Model and thinking' }).textContent).toContain(
      'Haiku'
    );
  });
  it('keeps every thinking level and keeps failed updates out of the label', async () => {
    const onError = vi.fn();
    const view = render(
      <NeoPreferences sessionId="s1" store={makeStore()} onError={onError} forSession />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Model and thinking' }));
    api.request.mockRejectedValue(new Error('Connection lost'));
    fireEvent.change(screen.getByRole('slider', { name: 'Thinking' }), { target: { value: '2' } });
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Connection lost'));
    expect(screen.getByRole('img', { name: 'Thinking: Off' })).toBeTruthy();
    api.mode = 'off';
    view.rerender(
      <NeoPreferences sessionId="s1" store={makeStore()} onError={onError} forSession />
    );
    expect(screen.getByRole('slider', { name: 'Thinking' })).toBeTruthy();
    expect(screen.queryByText('Not available for this model')).toBeNull();
  });
  it('filters models, shows no matches, supports arrow keys and restores focus on Escape', () => {
    render(<NeoPreferences sessionId="s1" store={makeStore()} onError={vi.fn()} forSession />);
    const trigger = screen.getByRole('button', { name: 'Model and thinking' });
    fireEvent.click(trigger);
    const search = screen.getByRole('searchbox', { name: 'Search models' });
    fireEvent.input(search, { target: { value: 'haiku' } });
    expect(screen.queryByRole('button', { name: 'Sonnet · Anthropic' })).toBeNull();
    const haiku = screen.getByRole('button', { name: 'Haiku · Anthropic' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(haiku);
    fireEvent.keyDown(haiku, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(search);
    fireEvent.input(search, { target: { value: 'not-a-model' } });
    expect(screen.getByText('No matching models. Try another name.')).toBeTruthy();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
