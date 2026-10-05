import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceHistoryRepository } from '../../storage/repositories/workspace-history-repository.ts';
import { getDataDir } from '../data-dir.ts';

export function neoFolderPath(): string {
  return join(getDataDir(), 'Neo');
}

export function neoFolder(): string {
  const folder = neoFolderPath();
  mkdirSync(folder, { recursive: true });
  return folder;
}

export function neoTaskFolderName(title: string, sessionId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return `${slug || 'task'}-${sessionId.slice(0, 8)}`;
}

export function ensureNeoProject(
  history: Pick<WorkspaceHistoryRepository, 'get' | 'upsert'>,
  folder: () => string = neoFolder
): string {
  const path = folder();
  if (!history.get(path)) history.upsert(path);
  return path;
}
