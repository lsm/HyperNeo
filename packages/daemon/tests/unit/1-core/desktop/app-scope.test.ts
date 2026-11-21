import { expect, test } from 'bun:test';
import { DesktopAppsSchema, unnamedDesktopApp } from '../../../../src/lib/desktop/app-scope.ts';

test('an app name must be made of words in its bundle id', () => {
  const ok = (bundleId: string, name: string) =>
    DesktopAppsSchema.safeParse([{ bundleId, name }]).success;
  expect(ok('com.google.Chrome', 'Google Chrome')).toBe(true);
  expect(ok('com.microsoft.VSCode', 'VS Code')).toBe(true);
  expect(ok('com.apple.mail', 'Chrome')).toBe(false);
  expect(ok('com.tencent.xinWeChat', '微信')).toBe(false);
  expect(ok('not a bundle', 'Chrome')).toBe(false);
});

test('only apps the human message names count as approved', () => {
  const chrome = { bundleId: 'com.google.Chrome', name: 'Chrome' };
  const mail = { bundleId: 'com.apple.mail', name: 'Mail' };
  expect(unnamedDesktopApp('Use chrome to find the March invoice', [chrome])).toBeUndefined();
  expect(unnamedDesktopApp('用 Chrome 找三月的发票', [chrome])).toBeUndefined();
  expect(unnamedDesktopApp('Find the March invoice in Chrome', [chrome, mail])).toEqual(mail);
});
