import { existsSync } from 'node:fs';
import type { SpaceDaemonModule } from '../../../space/src/daemon-module.ts';

const SPACE_MODULE_PATH = ['..', '..', '..', 'space', 'src', 'daemon-module.ts'].join('/');

export async function loadSpaceDaemonModule(): Promise<SpaceDaemonModule> {
  const url = new URL(SPACE_MODULE_PATH, import.meta.url);
  if (!existsSync(url)) {
    throw new Error('This build does not include Space. Unset HYPERNEO_SPACE to start.');
  }
  const loaded = (await import(url.href)) as { spaceDaemonModule: SpaceDaemonModule };
  return loaded.spaceDaemonModule;
}
