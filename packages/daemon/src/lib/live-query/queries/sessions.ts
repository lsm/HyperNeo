import { humanSessionColumnsPredicate } from '../../../storage/schema/session-counters.ts';
import { parseJsonOptional, parseJson } from '@hyperneo/shared';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import type { TableChangeScope } from '../../../storage/reactive-database.ts';

export const DEBOUNCE_SESSION_LIST_MS = 150;

export const DEBOUNCE_SPACE_SESSIONS_MS = 150;

export const SESSION_LIST_EXCLUDED_TYPES = new Set<string>([
  'lobby',
  'spaces_global',
  'room_chat',
  'planner',
  'coder',
  'leader',
  'space_chat',
]);

export const SESSIONS_LIST_SQL = `
SELECT
  s.id as id,
  s.title as title,
  s.workspace_path as workspacePath,
  s.created_at as createdAt,
  s.last_active_at as lastActiveAt,
  s.status as status,
  s.config as config,
  s.metadata as metadata,
  s.is_worktree as is_worktree,
  s.worktree_path as worktree_path,
  s.main_repo_path as main_repo_path,
  s.worktree_branch as worktree_branch,
  s.git_branch as gitBranch,
  s.sdk_session_id as sdkSessionId,
  s.acp_session_id as acpSessionId,
  s.available_commands as available_commands,
  CASE WHEN json_valid(s.processing_state) THEN json_remove(s.processing_state, '$.heldPrompt') ELSE s.processing_state END as processingState,
  s.archived_at as archivedAt,
  s.type as type,
  s.session_context as session_context,
  s.parent_id as parentSessionId
FROM sessions s
WHERE ${humanSessionColumnsPredicate('s')}
  AND (s.status != 'archived' OR ?1 = 1)
ORDER BY s.last_active_at DESC, s.id DESC
`.trim();

export const SESSION_COUNTERS_SQL = `
SELECT total_count, archived_count FROM session_counters WHERE id = 1
`.trim();

export function mapSessionRow(row: Record<string, unknown>): Record<string, unknown> {
  const isWorktree = row.is_worktree === 1;
  const worktree = isWorktree
    ? {
        isWorktree: true as const,
        worktreePath: row.worktree_path as string,
        mainRepoPath: row.main_repo_path as string,
        branch: row.worktree_branch as string,
      }
    : undefined;

  const availableCommands =
    row.available_commands && typeof row.available_commands === 'string'
      ? (JSON.parse(row.available_commands) as string[])
      : undefined;

  const sessionContext =
    row.session_context && typeof row.session_context === 'string'
      ? parseJsonOptional(row.session_context)
      : undefined;

  return {
    id: row.id,
    title: row.title,
    workspacePath: row.workspacePath,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
    status: row.status,
    config: parseJson(row.config as string, {}),
    metadata: parseJson(row.metadata as string, {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    }),
    worktree,
    gitBranch: (row.gitBranch as string | null) ?? undefined,
    sdkSessionId: (row.sdkSessionId as string | null) ?? undefined,
    acpSessionId: (row.acpSessionId as string | null) ?? undefined,
    availableCommands,
    processingState: (row.processingState as string | null) ?? undefined,
    archivedAt: (row.archivedAt as string | null) ?? undefined,
    type: (row.type as string | null) ?? 'worker',
    context: sessionContext,
    parentSessionId: (row.parentSessionId as string | null) ?? null,
  };
}

export const SPACE_SESSIONS_BY_SPACE_SQL = `
SELECT
  s.id as id,
  s.title as title,
  s.status as status,
  CASE WHEN json_valid(s.processing_state) THEN json_remove(s.processing_state, '$.heldPrompt') ELSE s.processing_state END as processingState,
  -- Read the maintained counter directly instead of a correlated COUNT(*) over
  -- sdk_messages per session (previously ~92ms warm for dev-neokai, re-run every
  -- 150ms debounce). SDKMessageRepository keeps this in sync with the same
  -- visibility predicate (top-level rows, non-deferred user rows, non-hidden
  -- subtypes) on every sdk_messages mutation.
  s.visible_message_count as messageCount,
  (unixepoch(s.last_active_at) - 0) * 1000 as lastActiveAt,
  s.parent_id as parentSessionId,
  json_extract(s.metadata, '$.clone.returnedAt') as returnedAt,
  json_extract(s.session_context, '$.taskId') as taskId
FROM sessions s
WHERE s.space_id = ? AND s.status != 'archived' AND s.type != 'space_chat'
ORDER BY s.last_active_at DESC, s.id DESC
`.trim();

export function mapSpaceSessionRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    processingState: (row.processingState as string | null) ?? undefined,
    messageCount: Number(row.messageCount ?? 0),
    lastActiveAt: Number(row.lastActiveAt ?? 0),
    parentSessionId: (row.parentSessionId as string | null) ?? null,
    returnedAt: (row.returnedAt as string | null) ?? null,
    taskId: (row.taskId as string | null) ?? null,
  };
}

export function buildSpaceSessionsScopeFilter(
  params: ReadonlyArray<unknown>,
  db: BunDatabase
): (scope: TableChangeScope) => boolean {
  const spaceId = params[0] as string;
  const sessionSpaceStmt = db.prepare('SELECT space_id FROM sessions WHERE id = ?');

  return (scope) => {
    if (scope.spaceId === spaceId) return true;

    if (!scope.sessionId) return true;

    try {
      const row = sessionSpaceStmt.get(scope.sessionId) as { space_id: string | null } | undefined;
      return row === undefined || row.space_id === spaceId;
    } catch {
      return true;
    }
  };
}
