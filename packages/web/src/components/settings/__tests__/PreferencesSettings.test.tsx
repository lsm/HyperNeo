import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { updateGlobalSettings, toastError } = vi.hoisted(() => ({
  updateGlobalSettings: vi.fn(async () => undefined),
  toastError: vi.fn(),
}));

vi.mock('../../../lib/api-helpers.ts', () => ({ updateGlobalSettings }));
vi.mock('../../../lib/toast.ts', () => ({ toast: { error: toastError } }));

import { resolvedTheme, themeSetting } from '../../../lib/theme.ts';
import { PreferencesSettings } from '../PreferencesSettings.tsx';

const selectWith = (container: Element, value: string) =>
  [...container.querySelectorAll('select')].find((element) =>
    [...element.options].some((option) => option.value === value)
  )!;

describe('PreferencesSettings', () => {
  afterEach(() => {
    cleanup();
    updateGlobalSettings.mockReset();
    updateGlobalSettings.mockResolvedValue(undefined);
    toastError.mockClear();
  });

  it('shows the four everyday items in order and saves nothing on open', () => {
    render(<PreferencesSettings />);
    expect(screen.getByText('Preferences')).toBeTruthy();
    const labels = ['Language', 'Theme', 'Default chat view', 'Show Archived Sessions'];
    const nodes = labels.map((label) => screen.getByText(label));
    nodes
      .slice(1)
      .forEach((node, index) =>
        expect(
          nodes[index].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy()
      );
    expect(document.querySelectorAll('select')).toHaveLength(3);
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });

  it('says how far Language and Theme reach', () => {
    render(<PreferencesSettings />);
    expect(
      screen.getByText(
        'Language for Neo on the web and on iOS. Most Settings labels stay in English.'
      )
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Follow your OS appearance, or pin HyperNeo to a theme. Saved in this browser only.'
      )
    ).toBeTruthy();
  });

  it('saves the language, defaulting to the browser language', () => {
    const { container } = render(<PreferencesSettings />);
    const select = selectWith(container, 'zh-Hans');
    expect(select.value).toBe('system');
    fireEvent.change(select, { target: { value: 'zh-Hans' } });
    expect(updateGlobalSettings).toHaveBeenCalledWith({ language: 'zh-Hans' });
  });

  it('saves the default chat view', () => {
    const { container } = render(<PreferencesSettings />);
    const select = selectWith(container, 'compact');
    expect(select.value).toBe('compact');
    fireEvent.change(select, { target: { value: 'full' } });
    expect(updateGlobalSettings).toHaveBeenCalledWith({ chatDisplayMode: 'full' });
  });

  it('saves Show Archived Sessions', () => {
    render(<PreferencesSettings />);
    fireEvent.click(screen.getByRole('switch'));
    expect(updateGlobalSettings).toHaveBeenCalledWith({ showArchived: true });
  });

  it('puts the language back when saving fails', async () => {
    updateGlobalSettings.mockRejectedValueOnce(new Error('offline'));
    const { container } = render(<PreferencesSettings />);
    const select = selectWith(container, 'zh-Hans');
    fireEvent.change(select, { target: { value: 'zh-Hans' } });
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to update language'));
    await waitFor(() => expect(selectWith(container, 'zh-Hans').value).toBe('system'));
  });

  it('switches the theme in this browser without saving a global setting', () => {
    const { container } = render(<PreferencesSettings />);
    const select = selectWith(container, 'dark');
    expect(select.value).toBe(themeSetting.value);

    fireEvent.change(select, { target: { value: 'light' } });
    expect(themeSetting.value).toBe('light');
    expect(resolvedTheme.value).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');

    fireEvent.change(select, { target: { value: 'dark' } });
    expect(themeSetting.value).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    fireEvent.change(select, { target: { value: 'system' } });
    expect(themeSetting.value).toBe('system');
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });
});
