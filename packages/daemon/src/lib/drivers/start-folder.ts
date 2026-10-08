import { dirname, isAbsolute, normalize, relative, sep } from 'node:path';
import type { Rejected } from './types.ts';
import { reject } from './work-operations.ts';

export interface StartFolderDeps {
  folderExists: (folder: string) => boolean;
  makeFolder: (folder: string) => void;
  homeDir: string;
}

const PROTECTED_HOME_FOLDERS = new Set(['Library', 'Applications']);

function creatableReason(folder: string, deps: StartFolderDeps): string | null {
  if (!isAbsolute(folder) || normalize(folder) !== folder) {
    return `${folder} is not a plain absolute path.`;
  }
  const inHome = relative(deps.homeDir, folder);
  if (!inHome || inHome.startsWith('..') || isAbsolute(inHome)) {
    return `New folders can only be created inside ${deps.homeDir}.`;
  }
  const top = inHome.split(sep)[0];
  if (top.startsWith('.') || PROTECTED_HOME_FOLDERS.has(top)) {
    return `New folders cannot be created inside ${top}.`;
  }
  if (!deps.folderExists(dirname(folder))) {
    return `${dirname(folder)} does not exist, so ${folder} was not created.`;
  }
  return null;
}

export function ensureStartFolder(
  folder: string,
  createFolder: boolean | undefined,
  deps: StartFolderDeps
): { value: string } | { reason: Rejected } {
  if (deps.folderExists(folder)) return { value: folder };
  if (!createFolder) {
    return {
      reason: reject(
        'invalid_place',
        `${folder} does not exist. To start a new project there, pass createFolder: true.`
      ),
    };
  }
  const refused = creatableReason(folder, deps);
  if (refused) return { reason: reject('invalid_place', refused) };
  try {
    deps.makeFolder(folder);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { reason: reject('invalid_place', `Could not create ${folder}: ${why}`) };
  }
  return { value: folder };
}
