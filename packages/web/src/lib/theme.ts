import { signal } from '@preact/signals';

export type ThemeSetting = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

declare global {
  interface Window {
    __hyperneoThemeReady?: boolean;
  }
}

export const THEME_STORAGE_KEY = 'theme';

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

export const readStoredSetting = (): ThemeSetting => {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    return 'system';
  }
  return 'system';
};

export const resolveTheme = (setting: ThemeSetting): ResolvedTheme =>
  setting === 'system' ? (darkMedia.matches ? 'dark' : 'light') : setting;

export const themeSetting = signal<ThemeSetting>(readStoredSetting());
export const resolvedTheme = signal<ResolvedTheme>(resolveTheme(themeSetting.value));

const applyToDocument = (resolved: ResolvedTheme): void => {
  document.documentElement.dataset.theme = resolved;
};

export const setTheme = (setting: ThemeSetting): void => {
  themeSetting.value = setting;
  resolvedTheme.value = resolveTheme(setting);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, setting);
  } catch {}
  applyToDocument(resolvedTheme.value);
};

darkMedia.addEventListener('change', () => {
  if (themeSetting.value !== 'system') return;
  resolvedTheme.value = resolveTheme('system');
  applyToDocument(resolvedTheme.value);
});

window.addEventListener('storage', (event) => {
  if (event.key !== THEME_STORAGE_KEY) return;
  const setting = readStoredSetting();
  if (setting === themeSetting.value) return;
  themeSetting.value = setting;
  resolvedTheme.value = resolveTheme(setting);
  applyToDocument(resolvedTheme.value);
});

applyToDocument(resolvedTheme.value);

window.__hyperneoThemeReady = true;
