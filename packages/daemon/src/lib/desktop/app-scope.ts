import type { NeoDesktopApp } from '@hyperneo/shared/types/neo-ask';
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const run = promisify(execFile);
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export const DesktopAppsSchema = z.array(z.string().regex(BUNDLE_ID)).min(1).max(5);

export type DesktopAppName = (bundleId: string) => Promise<string | null>;

const LAUNCH_SERVICES = `function run(argv) {
  ObjC.import('AppKit');
  const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(argv[0]);
  return url.isNil() ? '' : url.path.js;
}`;

export const macDesktopAppName: DesktopAppName = async (bundleId) => {
  if (process.platform !== 'darwin' || !BUNDLE_ID.test(bundleId)) return null;
  const found = await run('osascript', ['-l', 'JavaScript', '-e', LAUNCH_SERVICES, bundleId], {
    timeout: 5000,
  }).catch(() => null);
  const path = found?.stdout.trim() ?? '';
  return path.endsWith('.app') ? basename(path, '.app') : null;
};

export async function resolveDesktopApps(
  bundleIds: readonly string[],
  name: DesktopAppName = macDesktopAppName
): Promise<{ value: NeoDesktopApp[] } | { missing: string }> {
  const apps: NeoDesktopApp[] = [];
  for (const bundleId of new Set(bundleIds)) {
    const found = await name(bundleId);
    if (!found) return { missing: bundleId };
    apps.push({ bundleId, name: found });
  }
  return { value: apps };
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const spoken = (app: NeoDesktopApp) => [app.name, app.bundleId.split('.').at(-1) ?? app.name];

export function unnamedDesktopApp(
  message: string,
  apps: readonly NeoDesktopApp[]
): NeoDesktopApp | undefined {
  return apps.find(
    (app) =>
      !spoken(app).some((name) =>
        new RegExp(`(^|[^\\p{L}\\p{N}])${escape(name)}($|[^\\p{L}\\p{N}])`, 'iu').test(message)
      )
  );
}

export const desktopAppsLine = (apps: readonly NeoDesktopApp[]) =>
  `🖥 ${apps.map((app) => app.name).join(', ')}`;
