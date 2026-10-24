import { Database } from './sqlite-compat.ts';
import { runLagPhase } from '../lib/event-loop-activity.ts';
import { join } from 'node:path';
import type {
  CodexSnapshot,
  CodexRootRow,
  CodexFolderRow,
  CodexThreadRow,
} from '../lib/drivers/codex-desktop-adapter.ts';

export const OWN_THREADS = `cwd IS NOT NULL AND COALESCE(source, '') NOT LIKE '%subagent%'`;
const THREAD_TITLE = `substr(COALESCE(NULLIF(name, ''), NULLIF(title, ''), NULLIF(first_user_message, '')), 1, 200)`;
export const THREAD_COLUMNS = `id, COALESCE(NULLIF(substr(trim(replace(replace(${THREAD_TITLE}, char(13), ' '), char(10), ' ')), 1, 80), ''), 'Untitled thread') AS title,
  cwd AS folder, COALESCE(archived, 0) AS archived, COALESCE(updated_at_ms, 0) AS updatedAt`;
const CLOSED_THREADS = 500;
const BUSY_TIMEOUT_MS = 2_000;

export const codexStatePath = (home: string): string => join(home, '.codex', 'state_5.sqlite');

function readCodexStateOnce<T>(path: string, read: (db: Database) => T): T {
  const db = runLagPhase(
    'scanner:codex_desktop:open',
    () => new Database(path, { readonly: true })
  );
  try {
    runLagPhase('scanner:codex_desktop:configure', () =>
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    );
    return runLagPhase('scanner:codex_desktop:query', () => read(db));
  } finally {
    runLagPhase('scanner:codex_desktop:close', () => db.close());
  }
}

export function withCodexState<T>(statePath: string, read: (db: Database) => T): T {
  try {
    return readCodexStateOnce(statePath, read);
  } catch (error) {
    if (!/unable to open database file|readonly database/.test(String(error))) throw error;
    return readCodexStateOnce(`file:${encodeURI(statePath)}?immutable=1`, read);
  }
}

export function readCodexSnapshot(statePath: string, includeClosed: boolean): CodexSnapshot {
  return withCodexState(statePath, (db) => ({
    roots: runLagPhase(
      'scanner:codex_desktop:roots',
      () =>
        db
          .prepare(
            `SELECT p.id AS projectId, COALESCE(p.name, '') AS name, r.path AS folder,
             COALESCE(p.updated_at_ms, 0) AS lastActiveAt
             FROM projects p JOIN project_roots r ON r.project_id = p.id WHERE r.path IS NOT NULL`
          )
          .all() as CodexRootRow[]
    ),
    folders: runLagPhase(
      'scanner:codex_desktop:folders',
      () =>
        db
          .prepare(
            `SELECT cwd AS folder, SUM(COALESCE(archived, 0) = 0) AS openCount,
             SUM(COALESCE(archived, 0) != 0) AS archivedCount,
             COALESCE(MAX(updated_at_ms), 0) AS lastActiveAt FROM threads WHERE ${OWN_THREADS} GROUP BY cwd`
          )
          .all() as CodexFolderRow[]
    ),
    threads: runLagPhase(
      'scanner:codex_desktop:threads',
      () =>
        db
          .prepare(
            `SELECT * FROM (
             SELECT ${THREAD_COLUMNS} FROM threads WHERE ${OWN_THREADS} AND COALESCE(archived, 0) = 0
             UNION ALL
             SELECT * FROM (SELECT ${THREAD_COLUMNS} FROM threads
               WHERE ${OWN_THREADS} AND ? = 1 AND COALESCE(archived, 0) != 0
               ORDER BY updatedAt DESC LIMIT ${CLOSED_THREADS}))
           ORDER BY updatedAt DESC`
          )
          .all(includeClosed ? 1 : 0) as CodexThreadRow[]
    ),
  }));
}
