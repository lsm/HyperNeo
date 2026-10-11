import { dirname, isAbsolute, normalize, relative, sep } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Rejected, StartRequest } from './types.ts';
import { reject } from './work-operations.ts';

export interface StartFolderDeps {
  folderExists: (folder: string) => boolean;
  makeFolder: (folder: string) => void;
  homeDir: string;
}

const PROTECTED_HOME_FOLDERS = new Set(['Library', 'Applications']);

type StartFolderFound = { exists: boolean; parentExists: boolean };

export function readStartFolder(
  folder: string,
  deps: Pick<StartFolderDeps, 'folderExists'>
): StartFolderFound {
  const exists = deps.folderExists(folder);
  return { exists, parentExists: exists || deps.folderExists(dirname(folder)) };
}

export function requireStartFolder(
  folder: string,
  createFolder: boolean | undefined,
  found: StartFolderFound,
  deps: Pick<StartFolderDeps, 'homeDir'>
): { value: { folder: string; create: boolean } } | { reason: Rejected } {
  if (found.exists) return { value: { folder, create: false } };
  if (!createFolder)
    return {
      reason: reject(
        'invalid_place',
        `${folder} does not exist. To start a new project there, pass createFolder: true.`
      ),
    };
  const refused = creatableReason(folder, found, deps);
  return refused
    ? { reason: reject('invalid_place', refused) }
    : { value: { folder, create: true } };
}

function creatableReason(
  folder: string,
  found: StartFolderFound,
  deps: Pick<StartFolderDeps, 'homeDir'>
): string | null {
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
  if (!found.parentExists) {
    return `${dirname(folder)} does not exist, so ${folder} was not created.`;
  }
  return null;
}

export function createStartFolder(
  plan: { folder: string; create: boolean },
  deps: Pick<StartFolderDeps, 'makeFolder'>
): { value: string } | { reason: Rejected } {
  if (!plan.create) return { value: plan.folder };
  try {
    deps.makeFolder(plan.folder);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { reason: reject('invalid_place', `Could not create ${plan.folder}: ${why}`) };
  }
  return { value: plan.folder };
}

const runStartFolder = (superpipe({})('drivers-start-folder') as PipelineAPI)
  .input(['path', 'createFolder', 'deps'])
  .pipe(readStartFolder, ['path', 'deps'], 'found')
  .pipe(requireStartFolder, ['path', 'createFolder', 'found', 'deps'], 'result:folder')
  .pipe(createStartFolder, ['folder', 'deps'], 'result:folder')
  .end('folder') as (
  path: string,
  createFolder: boolean | undefined,
  deps: StartFolderDeps
) => string | Rejected;

export function ensureStartFolder(
  folder: string,
  createFolder: boolean | undefined,
  deps: StartFolderDeps
): { value: string } | { reason: Rejected } {
  const result = runStartFolder(folder, createFolder, deps);
  return typeof result === 'string' ? { value: result } : { reason: result };
}

export function selectLocalStartFolder(
  request: Pick<StartRequest, 'place' | 'createFolder'>,
  deps: StartFolderDeps & { machine: string },
  noFolder: string
): { value: string } | { reason: Rejected } {
  const { place } = request;
  if (place.spaceId) {
    return { reason: reject('invalid_place', 'Spaces take work through the space adapter.') };
  }
  if (place.machine !== deps.machine) {
    return { reason: reject('invalid_place', `${place.name} is on ${place.machine}, not here.`) };
  }
  if (!place.folder) return { reason: reject('invalid_place', noFolder) };
  return ensureStartFolder(place.folder, request.createFolder, deps);
}
