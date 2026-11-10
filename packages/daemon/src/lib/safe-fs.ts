import type { SafeFsBackendModule } from './safe-fs-backend.ts';

// knip-ignore-next-line
export { decodeStatMode, isSafeFsSupported, locateStatModeOffset } from './safe-fs-backend.ts';

let backendPromise: Promise<SafeFsBackendModule> | undefined;

function getSafeFsBackend(): Promise<SafeFsBackendModule> {
  backendPromise ??= import('./safe-fs-backend.ts');
  return backendPromise;
}

export const replaceFileWithinWorkspace: SafeFsBackendModule['replaceFileWithinWorkspace'] = async (
  ...args
) => {
  const backend = await getSafeFsBackend();
  return backend.replaceFileWithinWorkspace(...args);
};

export const withArtifactDescriptor: SafeFsBackendModule['withArtifactDescriptor'] = async (
  ...args
) => {
  const backend = await getSafeFsBackend();
  return backend.withArtifactDescriptor(...args);
};

export const withStoredArtifactDescriptor: SafeFsBackendModule['withStoredArtifactDescriptor'] =
  async (...args) => {
    const backend = await getSafeFsBackend();
    return backend.withStoredArtifactDescriptor(...args);
  };
