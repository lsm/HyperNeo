import { act, cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { locale } from '../../lib/i18n/index.ts';
import { connectionState } from '../../lib/state.ts';
import MarkdownRenderer from '../../components/chat/MarkdownRenderer.tsx';
import { globalStore } from '../../lib/global-store.ts';
import { useNeoLanguageSetting } from '../useNeoLanguageSetting.ts';

const hub = vi.hoisted(() => ({
  request: vi.fn(),
  listeners: [] as Array<(state: { settings?: { language?: string } }) => void>,
}));

vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHubIfConnected: () => ({
      request: hub.request,
      onEvent: (_channel: string, listener: (typeof hub.listeners)[number]) => {
        hub.listeners.push(listener);
        return () => hub.listeners.splice(hub.listeners.indexOf(listener), 1);
      },
    }),
  },
}));

function Probe() {
  useNeoLanguageSetting();
  return null;
}

const snapshot = (language: string) => ({ settings: { settings: { language } } });

beforeEach(() => {
  hub.listeners.length = 0;
  hub.request.mockReset();
  connectionState.value = 'connected';
  locale.value = 'en';
  globalStore.systemState.value = null;
});

afterEach(() => {
  cleanup();
  locale.value = 'en';
  globalStore.systemState.value = null;
});

describe('useNeoLanguageSetting', () => {
  it('applies the saved language from the snapshot, then follows updates', async () => {
    hub.request.mockResolvedValue(snapshot('zh-Hans'));
    render(<Probe />);
    await waitFor(() => expect(locale.value).toBe('zh-Hans'));
    act(() => hub.listeners[0]({ settings: { language: 'en' } }));
    expect(locale.value).toBe('en');
  });

  it('re-reads the snapshot after reconnecting', async () => {
    hub.request.mockResolvedValue(snapshot('en'));
    render(<Probe />);
    await waitFor(() => expect(hub.request).toHaveBeenCalledTimes(1));
    act(() => {
      connectionState.value = 'disconnected';
    });
    expect(hub.listeners).toHaveLength(0);
    hub.request.mockResolvedValue(snapshot('zh-Hans'));
    act(() => {
      connectionState.value = 'connected';
    });
    await waitFor(() => expect(locale.value).toBe('zh-Hans'));
    expect(hub.listeners).toHaveLength(1);
  });

  it('keeps an update that arrives before the snapshot answer', async () => {
    let answer: (value: unknown) => void = () => {};
    hub.request.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<Probe />);
    act(() => hub.listeners[0]({ settings: { language: 'zh-Hans' } }));
    await act(async () => answer(snapshot('en')));
    expect(locale.value).toBe('zh-Hans');
  });
});

it('makes the existing lightweight snapshot available to Neo path labels', async () => {
  hub.request.mockResolvedValue({ ...snapshot('en'), system: { homeDirectory: '/home/owner' } });
  function HomePath() {
    useNeoLanguageSetting();
    return <MarkdownRenderer content="`/home/owner/report.md`" />;
  }
  render(<HomePath />);
  expect(await screen.findByText('~/report.md')).toBeTruthy();
  expect(hub.request).toHaveBeenCalledTimes(1);
});
