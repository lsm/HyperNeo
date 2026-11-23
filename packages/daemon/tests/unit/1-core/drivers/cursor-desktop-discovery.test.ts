import { afterEach, describe, expect, it, vi } from 'vitest';
import { cursorDesktopStatePath } from '../../../../src/lib/drivers/cursor-desktop-discovery.ts';
import { cursorWorkspaceFolder } from '../../../../src/storage/cursor-desktop-path.ts';

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

describe('Cursor Desktop workspace folders', () => {
  it.each([
    ['/c%3A/Project%20%23%20%C3%A9', false, 'c:\\Project # é'],
    ['/C:/Project # é and %20', true, 'C:\\Project # é and %20'],
    ['/D:/Raw # Project', false, 'D:\\Raw # Project'],
    ['/no-drive/path', false, null],
    ['/C:/encoded%2Fseparator', false, null],
  ])('converts %s into a Windows workspace folder', (path, marshalled, expected) => {
    expect(cursorWorkspaceFolder(path, marshalled, true)).toBe(expected);
  });
});
