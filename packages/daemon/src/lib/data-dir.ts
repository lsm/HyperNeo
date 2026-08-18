import { homedir } from 'node:os';
import { join } from 'node:path';

export const DATA_DIR_NAME = '.hyperneo';

export function resolveDataDir(home: string = homedir()): string {
  return join(home, DATA_DIR_NAME);
}

export function getDataDir(): string {
  return resolveDataDir();
}
