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
  it('uses a borderless model pill without a separator', () => {
    render(<NeoPreferences sessionId="neo:root" store={makeStore()} onError={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Model and thinking' });
    expect(trigger.className.split(' ')).not.toContain('border');
    expect(trigger.textContent).not.toContain('·');
  });

  it.each([
    ['off', 0],
    ['think8k', 1],
    ['think16k', 2],
    ['think24k', 3],
    ['think32k', 4],
    ['think48k', 5],
    ['think64k', 6],
  ] as const)('shows the bulb glass filled by sixths for %s', (thinkingLevel, step) => {
    const { container } = render(
      <NeoPreferences
        sessionId="neo:root"
        store={makeStore()}
        onError={vi.fn()}
        preference={{ model: 'sonnet', provider: 'anthropic', thinkingLevel, saved: true }}
      />
    );
    const icon = container.querySelector('[data-thinking-level]')!;
    expect(icon.querySelector('circle')).toBeNull();
    expect(icon.querySelectorAll('svg')).toHaveLength(1);
    expect(icon.querySelector('svg')?.style.filter.includes('drop-shadow')).toBe(step === 6);
    if (step === 0) expect(icon.querySelector('clipPath')).toBeNull();
    else {
      const fill = icon.querySelector('clipPath rect')!;
      expect(Number(fill.getAttribute('height'))).toBeCloseTo((10 * step) / 6);
      expect(Number(fill.getAttribute('y'))).toBeCloseTo(17 - (10 * step) / 6);
    }
  });

  it('lists models and thinking on /neo, with no settings link or restart', () => {
    render(<NeoPreferences sessionId="neo:root" store={makeStore()} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Model and thinking' }));
    const menu = screen.getByRole('group', { name: 'Model and thinking settings' });
    expect(screen.getByRole('button', { name: 'Haiku · Anthropic' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Thinking' })).toBeTruthy();
    expect(screen.getByText('For Neo and all its projects')).toBeTruthy();
    expect(menu.querySelector('a')).toBeNull();
    expect(screen.queryByText('Neo model settings')).toBeNull();
    expect(screen.queryByText(/Restart Neo/)).toBeNull();
  });
  it('saves a model or thinking pick on /neo as Neo’s preference', async () => {
    const store = makeStore();
    const onSaved = vi.fn();
    api.request.mockImplementation(async (method: string, params: { input?: unknown }) =>
      method === 'operation.invoke' ? { ok: true, preferences: params.input } : { providers: [] }
    );
    render(
      <NeoPreferences
        sessionId="neo:root"
        store={store}
        onError={vi.fn()}
        onSaved={onSaved}
        preference={{ model: 'sonnet', provider: 'anthropic', thinkingLevel: 'off', saved: true }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Model and thinking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Haiku · Anthropic' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith('operation.invoke', {
        name: 'neo.preferences.set',
        input: { model: 'haiku', provider: 'anthropic', thinkingLevel: 'off' },
      })
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('slider', { name: 'Thinking' }), { target: { value: '2' } });
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith('operation.invoke', {
        name: 'neo.preferences.set',
        input: { model: 'haiku', provider: 'anthropic', thinkingLevel: 'think16k' },
      })
    );
    expect(api.request).not.toHaveBeenCalledWith('session.model.switch', expect.anything());
    expect(api.request).not.toHaveBeenCalledWith('session.thinking.set', expect.anything());
  });
  it('keeps each model’s saved auto-compact percent across /neo picks', async () => {
    const fallbacks = [
      {
        model: 'haiku',
        provider: 'anthropic',
        thinkingLevel: 'off' as const,
        autoCompactPercent: 60,
      },
    ];
    api.request.mockImplementation(async (method: string, params: { input?: object }) =>
      method === 'operation.invoke'
        ? { ok: true, preferences: { ...params.input, fallbacks } }
        : { providers: [] }
    );
    render(
      <NeoPreferences
        sessionId="neo:root"
        store={makeStore()}
        onError={vi.fn()}
        preference={{
          model: 'sonnet',
          provider: 'anthropic',
          thinkingLevel: 'off',
          autoCompactPercent: 70,
          fallbacks,
          saved: true,
        }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Model and thinking' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Thinking' }), { target: { value: '2' } });
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith('operation.invoke', {
        name: 'neo.preferences.set',
        input: {
          model: 'sonnet',
          provider: 'anthropic',
          thinkingLevel: 'think16k',
          autoCompactPercent: 70,
        },
      })
    );
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Haiku · Anthropic' }) as HTMLButtonElement).disabled
      ).toBe(false)
    );
    fireEvent.click(screen.getByRole('button', { name: 'Haiku · Anthropic' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith('operation.invoke', {
        name: 'neo.preferences.set',
        input: {
          model: 'haiku',
          provider: 'anthropic',
          thinkingLevel: 'think16k',
          autoCompactPercent: 60,
        },
      })
    );
  });
  it('a thinking change right after a /neo model pick keeps the picked model', async () => {
    api.request.mockImplementation(async (method: string, params: { input?: unknown }) =>
      method === 'operation.invoke' ? { ok: true, preferences: params.input } : { providers: [] }
    );
    render(
      <NeoPreferences
        sessionId="neo:root"
        store={makeStore()}
        onError={vi.fn()}
        preference={{ model: 'sonnet', provider: 'anthropic', thinkingLevel: 'off', saved: true }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Model and thinking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Haiku · Anthropic' }));
    const slider = screen.getByRole('slider', { name: 'Thinking' }) as HTMLInputElement;
    await waitFor(() => expect(slider.disabled).toBe(false));
    fireEvent.change(slider, { target: { value: '2' } });
    await waitFor(() =>
      expect(api.request).toHaveBeenLastCalledWith('operation.invoke', {
        name: 'neo.preferences.set',
        input: { model: 'haiku', provider: 'anthropic', thinkingLevel: 'think16k' },
      })
    );
  });
  it('closes the Neo menu on Escape and restores trigger focus', () => {
    render(<NeoPreferences sessionId="neo:root" store={makeStore()} onError={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Model and thinking' });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search models' }), {
      key: 'Escape',
    });
    expect(screen.queryByRole('searchbox')).toBeNull();
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
  it('tells the human a Neo pick applies after the current reply', () => {
    render(<NeoPreferences sessionId="neo:root" store={makeStore(true)} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Model and thinking' }));
    expect(screen.getByText('Neo switches after this reply')).toBeTruthy();
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
