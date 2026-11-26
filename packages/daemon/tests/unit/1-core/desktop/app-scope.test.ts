import { expect, test } from 'bun:test';
import {
  DesktopAppsSchema,
  macDesktopAppName,
  resolveDesktopApps,
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

test.skipIf(process.platform !== 'darwin')(
  'the real resolver names installed system apps without Spotlight and refuses unknown ids',
  async () => {
    expect(
      await resolveDesktopApps(
        ['com.apple.finder', 'com.apple.Terminal', 'com.apple.mail', 'com.apple.Notes'],
        macDesktopAppName
      )
    ).toEqual({
      value: [
        { bundleId: 'com.apple.finder', name: 'Finder' },
        { bundleId: 'com.apple.Terminal', name: 'Terminal' },
        { bundleId: 'com.apple.mail', name: 'Mail' },
        { bundleId: 'com.apple.Notes', name: 'Notes' },
      ],
    });
    expect(await macDesktopAppName('com.example.missing')).toBeNull();
  }
);
