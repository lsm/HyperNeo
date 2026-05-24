import { stat } from 'fs/promises';
import { homedir } from 'os';
import { resolve } from 'path';

export function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error('path is required');
  }
  if (trimmed === '~') {
    return homedir();
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

export async function validateWorkspaceDirectory(path: string): Promise<string> {
  const normalizedPath = normalizeWorkspacePath(path);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(normalizedPath);
  } catch {
    throw new Error(`Workspace path does not exist on the daemon machine: ${normalizedPath}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Workspace path is not a directory on the daemon machine: ${normalizedPath}`);
  }
  return normalizedPath;
}
