import type { NeoDesktopApp } from '@hyperneo/shared/types/neo-ask';
import { z } from 'zod';

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

export const nameFitsBundle = ({ bundleId, name }: NeoDesktopApp) =>
  words(name).every((word) => bundleId.toLowerCase().includes(word));

export const DesktopAppsSchema = z
  .array(
    z
      .object({
        bundleId: z.string().regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/),
        name: z.string().trim().min(1).max(60),
      })
      .strict()
      .refine(nameFitsBundle, {
        message:
          'name must be the app’s English name, every word of it inside bundleId (Chrome for com.google.Chrome).',
      })
  )
  .min(1)
  .max(5);

export function unnamedDesktopApp(
  message: string,
  apps: readonly NeoDesktopApp[]
): NeoDesktopApp | undefined {
  const said = message.toLowerCase();
  return apps.find((app) => !said.includes(app.name.toLowerCase()));
}

export const desktopAppsLine = (apps: readonly NeoDesktopApp[]) =>
  `🖥 ${apps.map((app) => app.name).join(', ')}`;
