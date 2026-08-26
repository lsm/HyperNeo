import type { Session, SessionContext, SessionType } from '@hyperneo/shared';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import type { SQLiteValue } from '../types.ts';
import {
  MESSAGE_SEARCH_TERMINAL_SESSION_TTL_MS,
  ROOM_SESSION_PREFIXES,
  ROOM_SESSION_TYPES,
  SEARCHABLE_MESSAGE_TYPES,
  TERMINAL_SPACE_TASK_STATUSES,
} from './message-search-admission.ts';

function toSqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ');
}

export class SessionRepository {
  constructor(private db: BunDatabase) {}

  private tableExists(tableName: string): boolean {
    try {
      const row = this.db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(tableName);
      return !!row;
    } catch {
      return false;
    }
  }

  private workspaceTablesExist(): boolean {
    return this.tableExists('space_workspaces') && this.tableExists('spaces');
  }

  private guardSpaceWorkspaceOwnership(spaceId: string, workspacePath: string): void {
    const owner = this.db
      .prepare(
        `SELECT space_id AS spaceId FROM (
          SELECT space_id FROM space_workspaces WHERE space_id = ? AND path = ?
          UNION ALL
          SELECT id AS space_id FROM spaces WHERE id = ? AND workspace_path = ?
        ) LIMIT 1`
      )
      .get(spaceId, workspacePath, spaceId, workspacePath) as { spaceId: string } | undefined;
    if (!owner) {
      throw new Error(
        `Workspace ${workspacePath} is not registered to space ${spaceId}; session creation blocked`
      );
    }
  }

  isWorkspaceRegisteredToSpace(spaceId: string, workspacePath: string): boolean {
    if (!this.workspaceTablesExist()) return true;
    const owner = this.db
      .prepare(
        `SELECT 1 FROM (
          SELECT space_id FROM space_workspaces WHERE space_id = ? AND path = ?
          UNION ALL
          SELECT id AS space_id FROM spaces WHERE id = ? AND workspace_path = ?
        ) LIMIT 1`
      )
      .get(spaceId, workspacePath, spaceId, workspacePath) as { '1': number } | undefined;
    return !!owner;
  }

  createSession(session: Session, options?: { enforceWorkspaceOwnership?: boolean }): void {
    const stmt = this.db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch, sdk_session_id, acp_session_id, sdk_origin_path, available_commands, processing_state, archived_at, type, session_context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const values = [
      session.id,
      session.title,
      session.workspacePath,
      session.createdAt,
      session.lastActiveAt,
      session.status,
      JSON.stringify(session.config, (key, val) => {
        if (key === 'mcpServers') return undefined;
        if (typeof val === 'function') return undefined;
        return val;
      }),
      JSON.stringify(session.metadata),
      session.worktree?.isWorktree ? 1 : 0,
      session.worktree?.worktreePath ?? null,
      session.worktree?.mainRepoPath ?? null,
      session.worktree?.branch ?? null,
      session.gitBranch ?? null,
      session.sdkSessionId ?? null,
      session.acpSessionId ?? null,
      session.sdkOriginPath ?? null,
      session.availableCommands ? JSON.stringify(session.availableCommands) : null,
      session.processingState ?? null,
      session.archivedAt ?? null,
      session.type ?? 'worker',
      session.context ? JSON.stringify(session.context) : null,
    ];

    const spaceId = session.context?.spaceId;
    const registeredPath = session.worktree?.mainRepoPath ?? session.workspacePath;
    if (
      options?.enforceWorkspaceOwnership &&
      spaceId &&
      registeredPath &&
      this.workspaceTablesExist()
    ) {
      const tx = this.db.transaction(() => {
        this.guardSpaceWorkspaceOwnership(spaceId, registeredPath);
        stmt.run(...values);
      });
      tx();
    } else {
      stmt.run(...values);
    }
  }

  getSession(id: string): Session | null {
    const stmt = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`);
    const row = stmt.get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return this.rowToSession(row);
  }

  listSessions(options?: {
    status?: string;
    includeArchived?: boolean;
    includeSpaceSessions?: boolean;
  }): Session[] {
    let sql = `SELECT * FROM sessions
				WHERE type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
				AND room_id IS NULL`;
    const params: string[] = [];
    if (!options?.includeSpaceSessions) {
      sql += ` AND space_id IS NULL`;
    }

    if (options?.status) {
      sql += ` AND status = ?`;
      params.push(options.status);
    } else if (!options?.includeArchived) {
      sql += ` AND status != 'archived'`;
    }

    sql += ` ORDER BY last_active_at DESC`;

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Record<string, unknown>[];

    return rows.map((r) => this.rowToSession(r));
  }

  clearAcpSessionIds(): void {
    this.db
      .prepare(
        `UPDATE sessions
         SET acp_session_id = NULL,
             metadata = CASE
           WHEN json_valid(metadata) THEN json_remove(metadata, '$.acpContextUsageEstimate')
           ELSE metadata
         END
         WHERE acp_session_id IS NOT NULL
           AND json_valid(config)
           AND json_extract(config, '$.provider') = 'acp'`
      )
      .run();
  }

  listAcpSessionIds(): Array<{ sessionId: string; acpSessionId: string }> {
    const rows = this.db
      .prepare(
        `SELECT id, acp_session_id FROM sessions
         WHERE acp_session_id IS NOT NULL
           AND json_valid(config)
           AND json_extract(config, '$.provider') = 'acp'`
      )
      .all() as Array<{ id: string; acp_session_id: string }>;
    return rows.map((row) => ({ sessionId: row.id, acpSessionId: row.acp_session_id }));
  }

  updateSession(id: string, updates: Partial<Session>, now: number = Date.now()): void {
    const fields: string[] = [];
    const values: SQLiteValue[] = [];

    if (updates.title) {
      fields.push('title = ?');
      values.push(updates.title);
    }
    if ('workspacePath' in updates) {
      fields.push('workspace_path = ?');
      values.push(updates.workspacePath ?? null);
    }
    if (updates.status) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.lastActiveAt) {
      fields.push('last_active_at = ?');
      values.push(updates.lastActiveAt);
    }
    if (updates.metadata) {
      const existing = this.getSession(id);
      const mergedMetadata = existing ? { ...existing.metadata } : {};
      for (const [key, value] of Object.entries(updates.metadata)) {
        if (value === undefined || value === null) {
          delete mergedMetadata[key as keyof typeof mergedMetadata];
        } else {
          (mergedMetadata as Record<string, unknown>)[key] = value;
        }
      }
      fields.push('metadata = ?');
      values.push(JSON.stringify(mergedMetadata));
    }
    if (updates.config) {
      const existing = this.getSession(id);
      const mergedConfig = existing ? { ...existing.config, ...updates.config } : updates.config;
      let serializedConfig: string;
      try {
        serializedConfig = JSON.stringify(mergedConfig, (key, val) => {
          if (key === 'mcpServers') return undefined;
          if (typeof val === 'function') return undefined;
          return val;
        });
      } catch (err) {
        throw new Error(
          `updateSession: failed to serialize config for session "${id}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
      fields.push('config = ?');
      values.push(serializedConfig);
    }
    if ('sdkSessionId' in updates) {
      fields.push('sdk_session_id = ?');
      values.push(updates.sdkSessionId ?? null);
    }
    if ('acpSessionId' in updates) {
      fields.push('acp_session_id = ?');
      values.push(updates.acpSessionId ?? null);
    }
    if ('sdkOriginPath' in updates) {
      fields.push('sdk_origin_path = ?');
      values.push(updates.sdkOriginPath ?? null);
    }
    if (updates.availableCommands !== undefined) {
      fields.push('available_commands = ?');
      values.push(updates.availableCommands ? JSON.stringify(updates.availableCommands) : null);
    }
    if (updates.processingState !== undefined) {
      fields.push('processing_state = ?');
      values.push(updates.processingState ?? null);
    }
    if (updates.archivedAt !== undefined) {
      fields.push('archived_at = ?');
      values.push(updates.archivedAt ?? null);
    }
    if ('worktree' in updates) {
      if (updates.worktree === undefined || updates.worktree === null) {
        fields.push(
          'is_worktree = ?',
          'worktree_path = ?',
          'main_repo_path = ?',
          'worktree_branch = ?'
        );
        values.push(0, null, null, null);
      } else {
        fields.push(
          'is_worktree = ?',
          'worktree_path = ?',
          'main_repo_path = ?',
          'worktree_branch = ?'
        );
        values.push(
          1,
          updates.worktree.worktreePath,
          updates.worktree.mainRepoPath,
          updates.worktree.branch
        );
      }
    }

    if (updates.type !== undefined) {
      fields.push('type = ?');
      values.push(updates.type);
    }

    if ('context' in updates) {
      fields.push('session_context = ?');
      values.push(updates.context ? JSON.stringify(updates.context) : null);
    }

    if (fields.length > 0) {
      values.push(id);
      const stmt = this.db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`);
      stmt.run(...values);
      const shouldRebuildSearchRows =
        updates.status !== undefined || updates.type !== undefined || 'context' in updates;
      if (updates.status === 'archived') {
        this.deleteMessageSearchRows(id);
      } else if (shouldRebuildSearchRows) {
        this.rebuildMessageSearchRows(id, now);
      }
      if (updates.title !== undefined) {
        this.updateMessageSearchSessionTitle(id, updates.title);
      }
    }
  }

  private updateMessageSearchSessionTitle(sessionId: string, title: string): void {
    if (!this.tableExists('message_search_content')) return;
    this.db
      .prepare(
        `UPDATE message_search_content SET title = ? WHERE kind = 'message' AND session_id = ?`
      )
      .run(title, sessionId);
  }

  private deleteMessageSearchRows(sessionId: string): void {
    if (!this.tableExists('message_search_content')) return;
    this.db
      .prepare(`DELETE FROM message_search_content WHERE kind = 'message' AND session_id = ?`)
      .run(sessionId);
  }

  private rebuildMessageSearchRows(sessionId: string, now: number): void {
    if (!this.tableExists('message_search_content') || !this.tableExists('sdk_messages')) return;
    const hasSpaceTasks = this.tableExists('space_tasks');
    const retentionCutoffMs = now - MESSAGE_SEARCH_TERMINAL_SESSION_TTL_MS;
    const spaceTaskColumns = hasSpaceTasks
      ? 'st.space_id, st.task_number'
      : 'NULL AS space_id, NULL AS task_number';
    const spaceTaskJoin = hasSpaceTasks ? 'LEFT JOIN space_tasks st ON st.id = sm.task_id' : '';
    const roomPrefixGuards = ROOM_SESSION_PREFIXES.map(
      (prefix) => `sm.session_id NOT LIKE '${prefix.replace(/'/g, "''")}%'`
    ).join(' AND ');
    const spaceTaskPolicy = hasSpaceTasks
      ? `AND COALESCE(st.status, '') != 'archived'
				  AND NOT (
					COALESCE(st.status, '') IN (${toSqlStringList(TERMINAL_SPACE_TASK_STATUSES)})
					AND COALESCE(COALESCE(st.completed_at, st.updated_at) < ?, 0)
				  )`
      : '';
    this.deleteMessageSearchRows(sessionId);
    const params: SQLiteValue[] = [sessionId, retentionCutoffMs];
    if (hasSpaceTasks) params.push(retentionCutoffMs);
    this.db
      .prepare(
        `INSERT INTO message_search_content (
					kind, source_id, message_id, session_id, task_id, space_id, task_number,
					message_type, title, body, timestamp
				)
				SELECT 'message', id, message_id, session_id, task_id, space_id, task_number,
					message_type, title, body, timestamp
				FROM (
					SELECT
						sm.id,
						COALESCE(CASE WHEN json_valid(sm.sdk_message) THEN json_extract(sm.sdk_message, '$.uuid') END, sm.id) AS message_id,
						sm.session_id,
						sm.task_id,
						${spaceTaskColumns},
						sm.message_type,
						s.title,
						CASE
							WHEN json_type(sm.sdk_message, '$.message.content') = 'array' THEN (
								SELECT GROUP_CONCAT(
									COALESCE(json_extract(value, '$.text'), json_extract(value, '$.thinking')),
									char(10)
								)
								FROM json_each(sm.sdk_message, '$.message.content')
								WHERE json_extract(value, '$.type') IN ('text', 'thinking')
							)
							WHEN json_type(sm.sdk_message, '$.message.content') = 'text' THEN
								json_extract(sm.sdk_message, '$.message.content')
							ELSE NULL
						END AS body,
						CAST(strftime('%s', sm.timestamp) AS INTEGER) * 1000
							+ CAST(substr(strftime('%f', sm.timestamp), 4, 3) AS INTEGER) AS timestamp
					FROM sdk_messages sm
					JOIN sessions s ON s.id = sm.session_id
					${spaceTaskJoin}
					WHERE sm.session_id = ?
					  AND json_valid(sm.sdk_message)
					  AND sm.message_type IN (${toSqlStringList(SEARCHABLE_MESSAGE_TYPES)})
					  AND NOT EXISTS (
							SELECT 1
							FROM sdk_message_replacements replacement
							WHERE replacement.session_id = sm.session_id
							  AND replacement.target_uuid = COALESCE(sm.sdk_uuid, sm.id)
							  AND replacement.source_message_id != sm.id
						  )
						  AND (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'))
					  AND COALESCE(s.status, '') != 'archived'
					  AND NOT (
							COALESCE(s.status, '') = 'ended'
							AND COALESCE(
								CAST(strftime('%s', s.last_active_at) AS INTEGER) * 1000
									+ CAST(substr(strftime('%f', s.last_active_at), 4, 3) AS INTEGER) < ?,
								0
							)
						  )
					  AND COALESCE(s.type, 'worker') NOT IN (${toSqlStringList(ROOM_SESSION_TYPES)})
					  AND COALESCE(s.room_id, '') = ''
					  AND ${roomPrefixGuards}
					  AND (
						(sm.session_id NOT LIKE '%:%' AND COALESCE(s.type, 'worker') = 'worker')
						OR sm.session_id LIKE 'space:%'
						OR s.type IN ('space_chat', 'space_task_agent')
					  )
					  ${spaceTaskPolicy}
				) projected
				WHERE TRIM(
					COALESCE(projected.body, ''),
					' ' || char(9) || char(10) || char(11) || char(12) || char(13)
				) != ''`
      )
      .run(...params);
  }

  deleteSession(id: string): void {
    const deleteOverrides = this.db.prepare(
      `DELETE FROM mcp_enablement WHERE scope_type = 'session' AND scope_id = ?`
    );
    const deleteSearchRows = this.tableExists('message_search_content')
      ? this.db.prepare(
          `DELETE FROM message_search_content WHERE kind = 'message' AND session_id = ?`
        )
      : null;
    const deleteTurnEndRows = this.tableExists('delivery_turn_end')
      ? this.db.prepare(`DELETE FROM delivery_turn_end WHERE session_id = ?`)
      : null;
    const deleteSession = this.db.prepare(`DELETE FROM sessions WHERE id = ?`);
    const tx = this.db.transaction((sessionId: string) => {
      deleteOverrides.run(sessionId);
      deleteSearchRows?.run(sessionId);
      deleteTurnEndRows?.run(sessionId);
      deleteSession.run(sessionId);
    });
    tx(id);
  }

  archiveSession(id: string): void {
    const stmt = this.db.prepare(`UPDATE sessions SET status = 'archived' WHERE id = ?`);
    stmt.run(id);
    this.deleteMessageSearchRows(id);
  }

  rowToSession(row: Record<string, unknown>): Session {
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
        ? (JSON.parse(row.session_context) as SessionContext)
        : undefined;

    return {
      id: row.id as string,
      title: row.title as string,
      workspacePath: (row.workspace_path as string | null) ?? null,
      createdAt: row.created_at as string,
      lastActiveAt: row.last_active_at as string,
      status: row.status as 'active' | 'paused' | 'ended' | 'archived',
      config: JSON.parse(row.config as string),
      metadata: JSON.parse(row.metadata as string),
      worktree,
      gitBranch: (row.git_branch as string | null) ?? undefined,
      sdkSessionId: (row.sdk_session_id as string | null) ?? undefined,
      acpSessionId: (row.acp_session_id as string | null) ?? undefined,
      sdkOriginPath: (row.sdk_origin_path as string | null) ?? undefined,
      availableCommands,
      processingState: (row.processing_state as string | null) ?? undefined,
      archivedAt: (row.archived_at as string | null) ?? undefined,
      type: (row.type as SessionType) ?? 'worker',
      context: sessionContext,
    };
  }

  findByRoomId(roomId: string): Session | null {
    const stmt = this.db.prepare(`SELECT * FROM sessions WHERE type = 'room' AND room_id = ?`);
    const row = stmt.get(roomId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return this.rowToSession(row);
  }

  findLobbySession(): Session | null {
    const stmt = this.db.prepare(`SELECT * FROM sessions WHERE type = 'lobby' LIMIT 1`);
    const row = stmt.get() as Record<string, unknown> | undefined;

    if (!row) return null;

    return this.rowToSession(row);
  }

  listSessionsByType(type: SessionType): Session[] {
    const stmt = this.db.prepare(
      `SELECT * FROM sessions WHERE type = ? ORDER BY last_active_at DESC`
    );
    const rows = stmt.all(type) as Record<string, unknown>[];

    return rows.map((r) => this.rowToSession(r));
  }

  listSessionsBySpaceAgent(spaceId: string, agentId: string): Session[] {
    const stmt = this.db.prepare(
      `SELECT * FROM sessions
			 WHERE space_id = ?
			   AND json_extract(metadata, '$.promptProvenance.agentId') = ?
			 ORDER BY last_active_at DESC`
    );
    const rows = stmt.all(spaceId, agentId) as Record<string, unknown>[];

    return rows.map((r) => this.rowToSession(r));
  }

  getSessionsByIds(ids: string[]): Map<string, Session> {
    const result = new Map<string, Session>();
    if (ids.length === 0) return result;

    const CHUNK_SIZE = 900;
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const stmt = this.db.prepare(`SELECT * FROM sessions WHERE id IN (${placeholders})`);
      const rows = stmt.all(...chunk) as Record<string, unknown>[];
      for (const row of rows) {
        const session = this.rowToSession(row);
        result.set(session.id, session);
      }
    }

    return result;
  }

  countActiveSessionsBySpaceAndWorkspacePath(spaceId: string, workspacePath: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM sessions
          WHERE space_id = ?
            AND (workspace_path = ? OR main_repo_path = ?)
            AND status NOT IN ('archived', 'ended')`
      )
      .get(spaceId, workspacePath, workspacePath) as { c: number } | undefined;
    return row?.c ?? 0;
  }
}
