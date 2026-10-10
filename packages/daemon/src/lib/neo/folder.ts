import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '@hyperneo/shared';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';
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

export function ensureNeoProject(
  history: Pick<WorkspaceHistoryRepository, 'get' | 'upsert'>,
  folder: () => string = neoFolder
): string {
  const path = folder();
  if (!history.get(path)) history.upsert(path);
  return path;
}

export function planNeoSessionFiling(
  sessions: readonly (Pick<Session, 'id' | 'workspacePath'> | null)[]
): string[] {
  return sessions.flatMap((session) => (session && !session.workspacePath ? [session.id] : []));
}

export function fileNeoSessions(
  db: {
    getSession(id: string): Pick<Session, 'id' | 'workspacePath'> | null;
    updateSession(id: string, updates: Partial<Session>): void;
  },
  repo: Pick<NeoRepository, 'getBindingForConcern' | 'listConcernBindings'>,
  folder: string
): void {
  const bindings = [repo.getBindingForConcern(null), ...repo.listConcernBindings()];
  const sessions = bindings.map((binding) => (binding ? db.getSession(binding.sessionId) : null));
  for (const id of planNeoSessionFiling(sessions)) db.updateSession(id, { workspacePath: folder });
}
