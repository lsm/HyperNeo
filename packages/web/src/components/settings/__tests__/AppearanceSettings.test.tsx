import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/preact';
import { AppearanceSettings } from '../AppearanceSettings.tsx';
import { themeSetting, resolvedTheme } from '../../../lib/theme.ts';

describe('AppearanceSettings', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the theme picker with the current setting', () => {
    render(<AppearanceSettings />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe(themeSetting.value);
    expect(screen.getByText('Appearance')).toBeTruthy();
    expect(screen.getByText('Theme')).toBeTruthy();
  });

  it('switches the theme on change', () => {
    render(<AppearanceSettings />);
    const select = screen.getByRole('combobox');

    fireEvent.change(select, { target: { value: 'light' } });
    expect(themeSetting.value).toBe('light');
    expect(resolvedTheme.value).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');

    fireEvent.change(select, { target: { value: 'dark' } });
    expect(themeSetting.value).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    fireEvent.change(select, { target: { value: 'system' } });
    expect(themeSetting.value).toBe('system');
  });
});
