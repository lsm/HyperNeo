import { expect, test } from 'bun:test';
import {
  DesktopAppsSchema,
  resolveDesktopApps,
  unnamedDesktopApp,
} from '../../../../src/lib/desktop/app-scope.ts';

const names: Record<string, string> = {
  'com.google.Chrome': 'Google Chrome',
  'com.apple.mail': 'Mail',
};
const name = async (bundleId: string) => names[bundleId] ?? null;

test('apps are bundle ids, and their names come from the system, not the caller', async () => {
  expect(DesktopAppsSchema.safeParse(['com.google.Chrome']).success).toBe(true);
  expect(DesktopAppsSchema.safeParse(['Chrome']).success).toBe(false);
  expect(await resolveDesktopApps(['com.google.Chrome'], name)).toEqual({
    value: [{ bundleId: 'com.google.Chrome', name: 'Google Chrome' }],
  });
  expect(await resolveDesktopApps(['com.example.missing'], name)).toEqual({
    missing: 'com.example.missing',
  });
});

test('a human message names an app only by its system name or bundle name, as a whole word', () => {
  const chrome = { bundleId: 'com.google.Chrome', name: 'Google Chrome' };
  const mail = { bundleId: 'com.apple.mail', name: 'Mail' };
  expect(unnamedDesktopApp('Use chrome to find the March invoice', [chrome])).toBeUndefined();
  expect(unnamedDesktopApp('用 Chrome 找三月的发票', [chrome])).toBeUndefined();
  expect(unnamedDesktopApp('Find the invoice in Chromebook notes', [chrome])).toEqual(chrome);
  expect(unnamedDesktopApp('Email the March invoice', [mail])).toEqual(mail);
  expect(unnamedDesktopApp('Find the March invoice in Chrome', [chrome, mail])).toEqual(mail);
});
