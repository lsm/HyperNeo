import { afterEach, describe, expect, it, vi } from 'vitest';
import { cursorDesktopStatePath } from '../../../../src/lib/drivers/cursor-desktop-discovery.ts';

describe('Cursor Desktop catalog path', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    ['D:\\profiles\\roaming', 'D:\\profiles\\roaming'],
    [undefined, 'C:\\Users\\fixture\\AppData\\Roaming'],
  ])('resolves Windows roaming storage when APPDATA=%s', (appData, expected) => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
    vi.stubEnv('APPDATA', appData);
    vi.stubEnv('XDG_CONFIG_HOME', '/unexpected-xdg');

    expect(cursorDesktopStatePath('C:\\Users\\fixture')).toBe(
      `${expected}\\Cursor\\User\\globalStorage\\state.vscdb`
    );
  });
});
