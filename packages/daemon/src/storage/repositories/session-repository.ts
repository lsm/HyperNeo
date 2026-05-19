/**
 * Session Repository
 *
 * Responsibilities:
 * - Session create/read/update/delete operations
 * - Row-to-Session object mapping
 * - Partial update merging (metadata, config)
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { Session, SessionType, SessionContext } from '@neokai/shared';
import type { SQLiteValue } from '../types';

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

	/**
	 * Create a new session
	 */
	createSession(session: Session): void {
		const stmt = this.db.prepare(
			`INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch, sdk_session_id, sdk_origin_path, available_commands, processing_state, archived_at, type, session_context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		stmt.run(
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
			session.sdkOriginPath ?? null,
			session.availableCommands ? JSON.stringify(session.availableCommands) : null,
			session.processingState ?? null,
			session.archivedAt ?? null,
			session.type ?? 'worker',
			session.context ? JSON.stringify(session.context) : null
		);
	}

	/**
	 * Get a session by ID
	 */
	getSession(id: string): Session | null {
		const stmt = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`);
		const row = stmt.get(id) as Record<string, unknown> | undefined;

		if (!row) return null;

		return this.rowToSession(row);
	}

	/**
	 * List sessions ordered by last active time (most recent first)
	 *
	 * @param options.status - Filter by status ('active', 'archived'). If omitted, excludes archived.
	 * @param options.includeArchived - If true, returns all sessions regardless of status.
	 */
	listSessions(options?: { status?: string; includeArchived?: boolean }): Session[] {
		let sql = `SELECT * FROM sessions
				WHERE type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
				AND json_extract(session_context, '$.roomId') IS NULL
				AND json_extract(session_context, '$.spaceId') IS NULL`;
		const params: string[] = [];

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

	/**
	 * Update a session with partial updates
	 *
	 * Supports merging partial metadata and config updates with existing values.
	 */
	updateSession(id: string, updates: Partial<Session>): void {
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
			// Merge partial metadata updates with existing metadata
			// Filter out undefined/null values to allow clearing fields
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
			// Merge partial config updates with existing config
			const existing = this.getSession(id);
			const mergedConfig = existing ? { ...existing.config, ...updates.config } : updates.config;
			// Strip runtime-only fields that must not be persisted:
			// - mcpServers: may contain live Server instances with circular references
			//   (attached via AgentSession.mergeRuntimeMcpServers(), intentionally not serialized)
			// - function values (runtime-only fields like spawnClaudeCodeProcess)
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
		// Handle worktree update (including clearing it when archiving)
		if ('worktree' in updates) {
			if (updates.worktree === undefined || updates.worktree === null) {
				// Clear worktree fields
				fields.push(
					'is_worktree = ?',
					'worktree_path = ?',
					'main_repo_path = ?',
					'worktree_branch = ?'
				);
				values.push(0, null, null, null);
			} else {
				// Update worktree fields
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

		// Handle type update (for unified session architecture)
		if (updates.type !== undefined) {
			fields.push('type = ?');
			values.push(updates.type);
		}

		// Handle context update (for unified session architecture)
		if ('context' in updates) {
			fields.push('session_context = ?');
			values.push(updates.context ? JSON.stringify(updates.context) : null);
		}

		if (fields.length > 0) {
			values.push(id);
			const stmt = this.db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`);
			stmt.run(...values);
			if (updates.status === 'archived') {
				this.deleteMessageSearchRows(id);
			} else if (updates.title !== undefined) {
				this.updateMessageSearchSessionTitle(id, updates.title);
			}
		}
	}

	private updateMessageSearchSessionTitle(sessionId: string, title: string): void {
		if (!this.tableExists('message_search_fts')) return;
		this.db
			.prepare(`UPDATE message_search_fts SET title = ? WHERE kind = 'message' AND session_id = ?`)
			.run(title, sessionId);
	}

	private deleteMessageSearchRows(sessionId: string): void {
		if (!this.tableExists('message_search_fts')) return;
		this.db
			.prepare(`DELETE FROM message_search_fts WHERE kind = 'message' AND session_id = ?`)
			.run(sessionId);
	}

	/**
	 * Delete a session by ID.
	 *
	 * Also drops any `mcp_enablement` rows targeting this session (scope_type =
	 * 'session', scope_id = id) in the same transaction. Per-session MCP
	 * overrides from MCP M6 would otherwise become orphan rows on hard-delete:
	 * harmless (no code reads overrides for a non-existent session), but they
	 * accumulate forever on workloads with many short-lived sessions. Doing
	 * this here — rather than in session-lifecycle.ts — keeps the invariant
	 * "no session row ⇒ no session-scope override rows" true regardless of
	 * which delete path (UI, tests, explicit RPC, …) is used.
	 *
	 * Note: `mcp_enablement` has no FK on `sessions.id` (the column is generic
	 * `scope_id TEXT`), so cascade must be done explicitly.
	 */
	deleteSession(id: string): void {
		const deleteOverrides = this.db.prepare(
			`DELETE FROM mcp_enablement WHERE scope_type = 'session' AND scope_id = ?`
		);
		const deleteSearchRows = this.tableExists('message_search_fts')
			? this.db.prepare(`DELETE FROM message_search_fts WHERE kind = 'message' AND session_id = ?`)
			: null;
		const deleteSession = this.db.prepare(`DELETE FROM sessions WHERE id = ?`);
		const tx = this.db.transaction((sessionId: string) => {
			deleteOverrides.run(sessionId);
			deleteSearchRows?.run(sessionId);
			deleteSession.run(sessionId);
		});
		tx(id);
	}

	/**
	 * Archive a session by ID (soft delete)
	 */
	archiveSession(id: string): void {
		const stmt = this.db.prepare(`UPDATE sessions SET status = 'archived' WHERE id = ?`);
		stmt.run(id);
		this.deleteMessageSearchRows(id);
	}

	/**
	 * Convert a database row to a Session object
	 * Shared helper for getSession and listSessions
	 */
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

		// Parse session_context JSON if present
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
			sdkOriginPath: (row.sdk_origin_path as string | null) ?? undefined,
			availableCommands,
			processingState: (row.processing_state as string | null) ?? undefined,
			archivedAt: (row.archived_at as string | null) ?? undefined,
			type: (row.type as SessionType) ?? 'worker',
			context: sessionContext,
		};
	}

	/**
	 * Find a room session by room ID
	 * Returns the room's session if it exists
	 */
	findByRoomId(roomId: string): Session | null {
		const stmt = this.db.prepare(
			`SELECT * FROM sessions WHERE type = 'room' AND json_extract(session_context, '$.roomId') = ?`
		);
		const row = stmt.get(roomId) as Record<string, unknown> | undefined;

		if (!row) return null;

		return this.rowToSession(row);
	}

	/**
	 * Find the lobby session
	 * Returns the lobby session if it exists
	 */
	findLobbySession(): Session | null {
		const stmt = this.db.prepare(`SELECT * FROM sessions WHERE type = 'lobby' LIMIT 1`);
		const row = stmt.get() as Record<string, unknown> | undefined;

		if (!row) return null;

		return this.rowToSession(row);
	}

	/**
	 * List sessions by type
	 */
	listSessionsByType(type: SessionType): Session[] {
		const stmt = this.db.prepare(
			`SELECT * FROM sessions WHERE type = ? ORDER BY last_active_at DESC`
		);
		const rows = stmt.all(type) as Record<string, unknown>[];

		return rows.map((r) => this.rowToSession(r));
	}

	/**
	 * Batch-fetch sessions by their IDs.
	 * Returns a Map<id, Session> for the found sessions.
	 * Uses a single SQL query with IN clause to avoid N+1 lookups.
	 * Falls back to individual queries when the list is empty or too large
	 * for SQLite's variable limit (999).
	 */
	getSessionsByIds(ids: string[]): Map<string, Session> {
		const result = new Map<string, Session>();
		if (ids.length === 0) return result;

		// SQLite has a default limit of 999 variables per statement.
		// Batch in chunks to stay within this limit.
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
}
