/**
 * Project derivation
 *
 * A "project" is a folder. The set of projects shown in the UI is the union of
 * every folder that has sessions and every explicitly-registered workspace
 * history folder. Shared so the sidebar and the empty-state composer agree.
 */

import type { Session, WorkspaceHistoryEntry } from '@neokai/shared';

/** The project root a session belongs to: the main repo for worktree sessions. */
export function projectRootOf(session: Session): string | null {
  return (
    session.worktree?.mainRepoPath ??
    session.metadata.archivedWorktree?.mainRepoPath ??
    session.workspacePath ??
    null
  );
}

/** Folder basename of an absolute path, used as the project display name. */
export function projectName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return (idx >= 0 ? trimmed.slice(idx + 1) : trimmed) || trimmed;
}

/**
 * Distinct project folder paths: every folder that has sessions, merged with
 * explicitly-registered workspace-history folders. Sorted by display name.
 */
export function listProjectPaths(sessions: Session[], history: WorkspaceHistoryEntry[]): string[] {
  const paths = new Set<string>();
  for (const session of sessions) {
    const root = projectRootOf(session);
    if (root) paths.add(root);
  }
  for (const entry of history) paths.add(entry.path);
  return [...paths].sort((a, b) => projectName(a).localeCompare(projectName(b)));
}
