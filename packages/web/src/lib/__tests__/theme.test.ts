import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type MediaListener = () => void;

const stubMatchMedia = (matches: boolean) => {
  const listeners: MediaListener[] = [];
  const mediaQueryList = {
    matches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_event: string, listener: MediaListener) => listeners.push(listener),
    removeEventListener: () => {},
  };
  vi.stubGlobal('matchMedia', () => mediaQueryList);
  return {
    setMatches: (next: boolean) => {
      mediaQueryList.matches = next;
    },
    fireChange: () => listeners.forEach((listener) => listener()),
  };
};

const stubLocalStorage = () => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  });
};

const importTheme = async () => {
  vi.resetModules();
  return import('../theme.ts');
};

describe('theme', () => {
  beforeEach(() => {
    stubLocalStorage();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to system and resolves dark on a dark OS', async () => {
    stubMatchMedia(true);
    const theme = await importTheme();
    expect(theme.themeSetting.value).toBe('system');
    expect(theme.resolvedTheme.value).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('resolves light on a light OS under system', async () => {
    stubMatchMedia(false);
    const theme = await importTheme();
    expect(theme.resolvedTheme.value).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it.each(['light', 'dark'] as const)('honors a stored %s setting over the OS', async (stored) => {
    stubMatchMedia(stored === 'light');
    localStorage.setItem('theme', stored);
    const theme = await importTheme();
    expect(theme.themeSetting.value).toBe(stored);
    expect(theme.resolvedTheme.value).toBe(stored);
  });

  it('ignores invalid stored values', async () => {
    stubMatchMedia(true);
    localStorage.setItem('theme', 'solarized');
    const theme = await importTheme();
    expect(theme.themeSetting.value).toBe('system');
    expect(theme.resolvedTheme.value).toBe('dark');
  });

  it('setTheme persists, updates signals, and writes data-theme', async () => {
    stubMatchMedia(true);
    const theme = await importTheme();
    theme.setTheme('light');
    expect(localStorage.getItem('theme')).toBe('light');
    expect(theme.themeSetting.value).toBe('light');
    expect(theme.resolvedTheme.value).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('ignores OS changes under an explicit setting', async () => {
    const media = stubMatchMedia(true);
    const theme = await importTheme();
    theme.setTheme('dark');
    media.setMatches(false);
    media.fireChange();
    expect(theme.resolvedTheme.value).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('applies theme changes from another tab via the storage event', async () => {
    stubMatchMedia(true);
    localStorage.setItem('theme', 'light');
    const theme = await importTheme();
    expect(document.documentElement.dataset.theme).toBe('light');
    localStorage.setItem('theme', 'dark');
    window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: 'dark' }));
    expect(theme.themeSetting.value).toBe('dark');
    expect(theme.resolvedTheme.value).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('ignores storage events for other keys', async () => {
    stubMatchMedia(true);
    const theme = await importTheme();
    localStorage.setItem('theme', 'dark');
    window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: 'dark' }));
    expect(theme.themeSetting.value).toBe('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('follows OS changes under the system setting', async () => {
    const media = stubMatchMedia(false);
    const theme = await importTheme();
    expect(theme.resolvedTheme.value).toBe('light');
    media.setMatches(true);
    media.fireChange();
    expect(theme.resolvedTheme.value).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
