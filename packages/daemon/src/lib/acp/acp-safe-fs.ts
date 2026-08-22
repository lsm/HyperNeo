import type { SafeFsBackendModule, SafeFsReadOptions } from './acp-safe-fs-backend';

// knip-ignore-next-line
export { decodeStatMode, isSafeFsSupported, locateStatModeOffset } from './acp-safe-fs-backend';

let backendPromise: Promise<SafeFsBackendModule> | undefined;

function getSafeFsBackend(): Promise<SafeFsBackendModule> {
  backendPromise ??= import('./acp-safe-fs-backend');
  return backendPromise;
}

// knip-ignore-next-line
export async function readFileWithinWorkspace(
  workspace: string,
  segments: string[],
  options: SafeFsReadOptions
): Promise<string> {
  const backend = await getSafeFsBackend();
  return backend.readFileWithinWorkspace(workspace, segments, options);
}

// knip-ignore-next-line
export async function writeFileWithinWorkspace(
  workspace: string,
  segments: string[],
  content: string,
  signal: AbortSignal
): Promise<void> {
  const backend = await getSafeFsBackend();
  return backend.writeFileWithinWorkspace(workspace, segments, content, signal);
}
