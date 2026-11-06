import type { SpaceDaemonModule } from './space/daemon-module.ts';

const SPACE_MODULE_PATH = ['.', 'space', 'daemon-module.ts'].join('/');

export async function loadSpaceDaemonModule(): Promise<SpaceDaemonModule> {
  try {
    const loaded = (await import(SPACE_MODULE_PATH)) as { spaceDaemonModule: SpaceDaemonModule };
    return loaded.spaceDaemonModule;
  } catch (error) {
    throw new Error('This build does not include Space. Unset HYPERNEO_SPACE to start.', {
      cause: error,
    });
  }
}
