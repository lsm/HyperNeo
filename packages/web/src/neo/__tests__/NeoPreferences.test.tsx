import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo } from '@hyperneo/shared';
import type { SessionStore } from '../../lib/session-store.ts';
import { NeoPreferences } from '../NeoPreferences.tsx';
import { NeoConcerns } from '../NeoConcerns.tsx';

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
  it('opens one control for both model and thinking and uses existing session updates', async () => {
    const store = makeStore();
    render(<NeoPreferences sessionId="neo:root" store={store} onError={vi.fn()} />);
    expect(screen.queryByLabelText('Thinking')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Model and thinking' }));
    expect(screen.getAllByRole('button', { name: 'Sonnet · Anthropic' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Think 16k', exact: true }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith('session.thinking.set', {
        sessionId: 'neo:root',
        level: 'think16k',
      })
    );
    await waitFor(() => expect(store.refresh).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Haiku · Anthropic' }) as HTMLButtonElement).disabled
      ).toBe(false)
    );
    fireEvent.click(screen.getByRole('button', { name: 'Haiku · Anthropic' }));
    await waitFor(() =>
      expect(api.switchModel).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'haiku', provider: 'anthropic' })
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close model settings' }));
    expect(screen.queryByLabelText('Thinking')).toBeNull();
  });
  it('does not let preference changes interrupt active work', () => {
    render(<NeoPreferences sessionId="neo:root" store={makeStore(true)} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Model and thinking' }));
    expect(
      (screen.getByRole('button', { name: 'Haiku · Anthropic' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Think 16k', exact: true }) as HTMLButtonElement).disabled
    ).toBe(true);
  });
  it('shows unsupported thinking honestly and keeps failed updates out of the label', async () => {
    const onError = vi.fn();
    const view = render(
      <NeoPreferences sessionId="neo:root" store={makeStore()} onError={onError} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Model and thinking' }));
    api.request.mockRejectedValue(new Error('Connection lost'));
    fireEvent.click(screen.getByRole('button', { name: 'Think 16k', exact: true }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Connection lost'));
    expect(screen.getByRole('img', { name: 'Thinking: Off' })).toBeTruthy();
    api.mode = 'off';
    view.rerender(<NeoPreferences sessionId="neo:root" store={makeStore()} onError={onError} />);
    expect(screen.queryByRole('button', { name: 'Think 16k', exact: true })).toBeNull();
    expect(screen.getByText('Not available for this model')).toBeTruthy();
  });
  it('opens a parked concerns card and routes into its existing context', () => {
    const onOpen = vi.fn();
    render(
      <NeoConcerns
        concerns={[
          {
            id: 'club',
            title: 'Book club',
            summary: 'Eight people',
            context: '',
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        ]}
        selectedId={null}
        onOpen={onOpen}
      />
    );
    const trigger = screen.getByRole('button', { name: 'Your concerns · 1' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Book club Eight people' }));
    expect(onOpen).toHaveBeenCalledWith('club');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
  it('filters models, shows no matches, supports arrow keys and restores focus on Escape', () => {
    render(<NeoPreferences sessionId="neo:root" store={makeStore()} onError={vi.fn()} />);
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
