import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Session } from '@hyperneo/shared';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import type { WorkspaceHistoryRepository } from '../../storage/repositories/workspace-history-repository.ts';
import { neoDerivedId } from './derived-id.ts';
import { getDataDir } from '../data-dir.ts';

export const neoUserFolder = (workspaceRoot?: string) =>
  resolve(workspaceRoot ?? join(homedir(), 'HyperNeo'));

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

export async function fileNeoSessions(
  db: {
    getSession(
      id: string
    ): (Pick<Session, 'id' | 'workspacePath'> & Partial<Pick<Session, 'metadata'>>) | null;
    updateSession(id: string, updates: Partial<Session>): Promise<unknown>;
  },
  repo: Pick<NeoRepository, 'defaultBinding'> & Partial<Pick<NeoRepository, 'readConversationId'>>,
  folder: string
): Promise<void> {
  const root = repo.defaultBinding();
  const sessions = [root ? db.getSession(root.sessionId) : null];
  for (const id of planNeoSessionFiling(sessions))
    await db.updateSession(id, { workspacePath: folder });
  const conversationId = repo.readConversationId?.();
  const front = conversationId
    ? db.getSession(neoDerivedId(`front-session:${conversationId}`))
    : null;
  if (front?.metadata) {
    const neo = sessions[0];
    await db.updateSession(front.id, {
      title: 'Neo fast replies',
      metadata: {
        ...front.metadata,
        executionProjectPath: neo?.metadata?.executionProjectPath ?? neo?.workspacePath ?? folder,
      },
    });
  }
}
