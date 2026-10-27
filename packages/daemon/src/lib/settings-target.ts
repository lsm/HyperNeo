import { realpath, readlink } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';

export async function resolveSettingsTarget(candidate: string): Promise<string> {
  const directory = await realpath(dirname(candidate));
  const path = join(directory, basename(candidate));
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let target: string;
  try {
    target = await readlink(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EINVAL') return path;
    throw error;
  }
  return resolveSettingsTarget(resolve(directory, target));
}
