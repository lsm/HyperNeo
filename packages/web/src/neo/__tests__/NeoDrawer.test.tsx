import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoDrawer } from '../NeoDrawer.tsx';
import { setTheme, themeSetting, resolveTheme } from '../../lib/theme.ts';
import { locale } from '../../lib/i18n/index.ts';

const { invoke, hub } = vi.hoisted(() => ({ invoke: vi.fn(), hub: {} }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHubIfConnected: () => hub,
  },
}));
vi.mock('../../lib/operations.ts', () => ({ invokeOperation: invoke }));
beforeEach(() => {
  setTheme('system');
  locale.value = 'en';
});
afterEach(() => {
  cleanup();
  setTheme('system');
  locale.value = 'en';
  vi.resetAllMocks();
});
const changeTheme = (select: HTMLElement, value: string) =>
  act(() => {
    (select as HTMLSelectElement).value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
const drawer = (connection: 'connected' | 'disconnected' = 'connected') =>
  render(
    <NeoDrawer
      open
      onClose={() => {}}
      connection={connection}
      onReconnect={() => {}}
      onRefresh={() => {}}
    />
  );

describe('NeoDrawer', () => {
  it('lists pending devices after Connection and approves through the existing operation', async () => {
    const pending = { id: 'pending', kind: 'relay', name: 'Synthetic relay', expiresAt: 4e12 };
    invoke
      .mockResolvedValueOnce({ ok: true, pending: [pending] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, pending: [] });
    drawer();
    const allow = await screen.findByRole('button', { name: 'Allow Synthetic relay' });
    expect(
      [...document.querySelectorAll('section')].map((section) => section.getAttribute('aria-label'))
    ).toEqual(['Connection', 'Appearance', 'Pending devices']);
    fireEvent.click(allow);
    await waitFor(() => expect(screen.queryByText('Synthetic relay')).toBeNull());
    expect(invoke).toHaveBeenCalledWith(hub, 'device.pair.approve', { codeId: 'pending' });
    expect(screen.queryByText('Projects')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Theme' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: /Move under/ })).toBeNull();
  });

  it('shows a refusal without pretending the device was allowed', async () => {
    invoke
      .mockResolvedValueOnce({
        ok: true,
        pending: [{ id: 'pending', kind: 'daemon', name: 'Test daemon', expiresAt: 4e12 }],
      })
      .mockResolvedValueOnce({ ok: false, reason: 'not_pending: code expired' });
    drawer();
    fireEvent.click(await screen.findByRole('button', { name: 'Allow Test daemon' }));
    expect((await screen.findByRole('alert')).textContent).toContain('code expired');
    expect(screen.getByText('Test daemon')).toBeTruthy();
  });

  it('keeps disconnected drawers usable without fetching protected data', () => {
    drawer('disconnected');
    expect(screen.getByText('Disconnected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('uses the shared theme store while offline and retains the choice when reopened', () => {
    const view = drawer('disconnected');
    const select = screen.getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement;
    expect(select.value).toBe('system');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Light',
      'Dark',
      'Follow system',
    ]);
    select.focus();
    for (const value of ['light', 'dark', 'system'] as const) {
      changeTheme(select, value);
      expect(themeSetting.value).toBe(value);
      expect(document.documentElement.dataset.theme).toBe(resolveTheme(value));
      expect(localStorage.setItem).toHaveBeenLastCalledWith('theme', value);
      expect(document.activeElement).toBe(select);
      expect(screen.getByRole('dialog')).toBeTruthy();
    }
    changeTheme(select, 'dark');
    view.unmount();
    drawer('disconnected');
    expect((screen.getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement).value).toBe(
      'dark'
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reflects changes from other theme controls and another tab', () => {
    drawer('disconnected');
    const select = screen.getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement;
    act(() => setTheme('light'));
    expect(select.value).toBe('light');
    vi.spyOn(localStorage, 'getItem').mockReturnValue('dark');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: 'dark' }));
    });
    expect(select.value).toBe('dark');
    expect(themeSetting.value).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('localizes the theme selector without changing stored theme values', () => {
    locale.value = 'zh-Hans';
    drawer('disconnected');
    const select = screen.getByRole('combobox', { name: '主题' });
    expect(screen.getByRole('region', { name: '外观' })).toBeTruthy();
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      '浅色',
      '深色',
      '跟随系统',
    ]);
    changeTheme(select, 'light');
    expect(themeSetting.value).toBe('light');
  });

  it('explains pairing refusal and keeps platform-only controls out of web', async () => {
    invoke.mockResolvedValue({ ok: false, reason: 'not_paired: denied' });
    drawer();
    expect((await screen.findByRole('alert')).textContent).toContain('Settings → Devices');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText('Demo data (offline)')).toBeNull();
  });
});
