/**
 * SDK Message Repository
 *
 * Responsibilities:
 * - Save and retrieve SDK messages
 * - Pagination support (before/since cursors)
 * - Message query mode tracking (deferred/enqueued/consumed status)
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { MessageOrigin, NeokaiActionMessage, ChatMessage } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import { Logger } from '../../lib/logger';
import {
	buildFtsQuery,
	extractVisibleSearchText,
	isBroadMessageSearchQuery,
	type MessageSearchParams,
	type MessageSearchResponse,
	type MessageSearchResult,
} from '../message-search';
import type { SQLiteValue } from '../types';

export type SendStatus = 'deferred' | 'enqueued' | 'consumed' | 'failed';

const MESSAGE_SEARCH_TERMINAL_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ROOM_SESSION_PREFIXES = ['room:chat:', 'planner:', 'coder:', 'leader:', 'general:'];
const ROOM_SESSION_TYPES = new Set(['room_chat', 'planner', 'coder', 'leader', 'general']);
const TERMINAL_SPACE_TASK_STATUSES = new Set(['done', 'cancelled', 'completed']);
const SEARCHABLE_MESSAGE_TYPES = new Set(['system', 'user', 'assistant']);

function isOlderThanMessageSearchTtl(value: string | number | null | undefined): boolean {
	if (value === null || value === undefined) return false;
	const timestamp = typeof value === 'number' ? value : Date.parse(value);
	if (!Number.isFinite(timestamp)) return false;
	return timestamp < Date.now() - MESSAGE_SEARCH_TERMINAL_SESSION_TTL_MS;
}

/**
 * Compute the materialised value for `sdk_messages.is_renderable` from a parsed
 * SDK message.
 *
 * Mirrors the predicate the live-query handlers used to evaluate inline:
 *   - `user` rows whose content array carries any `tool_result` block render as
 *     null in the compact UI → 0
 *   - `assistant` rows with no `tool_use`, no non-empty `text`, and no
 *     non-empty `thinking` blocks have nothing to display → 0
 *   - everything else → 1
 *
 * Keeping the logic in one helper means {@link saveSDKMessage} and
 * {@link saveUserMessage} stamp the column the same way.
 */
export function computeIsRenderable(message: SDKMessage): 0 | 1 {
	const messageType = message.type;
	const content = (message as { message?: { content?: unknown } }).message?.content;
	if (!Array.isArray(content)) {
		return 1;
	}

	if (messageType === 'user') {
		const hasToolResult = content.some(
			(block) =>
				typeof block === 'object' &&
				block !== null &&
				(block as { type?: unknown }).type === 'tool_result'
		);
		return hasToolResult ? 0 : 1;
	}

	if (messageType === 'assistant') {
		const hasRenderable = content.some((block) => {
			if (typeof block !== 'object' || block === null) return false;
			const blockObj = block as { type?: unknown; text?: unknown; thinking?: unknown };
			if (blockObj.type === 'tool_use') return true;
			if (blockObj.type === 'text') {
				const text = typeof blockObj.text === 'string' ? blockObj.text : '';
				return text.trim().length > 0;
			}
			if (blockObj.type === 'thinking') {
				const thinking = typeof blockObj.thinking === 'string' ? blockObj.thinking : '';
				return thinking.trim().length > 0;
			}
			return false;
		});
		return hasRenderable ? 1 : 0;
	}

	return 1;
}

/** Compute `sdk_messages.is_terminal` — `1` for SDK result messages. */
export function computeIsTerminal(message: SDKMessage): 0 | 1 {
	return message.type === 'result' ? 1 : 0;
}

/** Extract `sdk_messages.parent_tool_use_id` from the SDK message, if any. */
export function extractParentToolUseId(message: SDKMessage): string | null {
	const candidate = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
	return typeof candidate === 'string' ? candidate : null;
}

export class SDKMessageRepository {
	private logger = new Logger('Database');

	constructor(private db: BunDatabase) {}

	private hasMessageSearchIndex(): boolean {
		return this.tableExists('message_search_fts');
	}

	private tableExists(tableName: string): boolean {
		try {
			const row = this.db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(tableName);
			return !!row;
		} catch {
			return false;
		}
	}

	private tableHasColumn(tableName: string, columnName: string): boolean {
		try {
			const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
				name?: string;
			}>;
			return rows.some((row) => row.name === columnName);
		} catch {
			return false;
		}
	}

	private upsertMessageSearchRow(rowId: string): void {
		if (!this.hasMessageSearchIndex()) return;
		const hasSessions = this.tableExists('sessions');
		const hasSpaceTasks = this.tableExists('space_tasks');
		const hasSessionTitle = hasSessions && this.tableHasColumn('sessions', 'title');
		const hasSessionStatus = hasSessions && this.tableHasColumn('sessions', 'status');
		const hasSessionType = hasSessions && this.tableHasColumn('sessions', 'type');
		const hasSessionLastActiveAt = hasSessions && this.tableHasColumn('sessions', 'last_active_at');
		const hasSessionContext = hasSessions && this.tableHasColumn('sessions', 'session_context');
		const hasTaskStatus = hasSpaceTasks && this.tableHasColumn('space_tasks', 'status');
		const hasTaskCompletedAt = hasSpaceTasks && this.tableHasColumn('space_tasks', 'completed_at');
		const hasTaskUpdatedAt = hasSpaceTasks && this.tableHasColumn('space_tasks', 'updated_at');
		const sessionTitleSelect = hasSessionTitle
			? 's.title AS session_title'
			: 'sm.session_id AS session_title';
		const sessionPolicySelect = `${hasSessionStatus ? 's.status' : 'NULL'} AS session_status,
			   ${hasSessionType ? 's.type' : 'NULL'} AS session_type,
			   ${hasSessionLastActiveAt ? 's.last_active_at' : 'NULL'} AS session_last_active_at,
			   ${hasSessionContext ? 's.session_context' : 'NULL'} AS session_context`;
		const spaceTaskSelect = hasSpaceTasks
			? `st.space_id, st.task_number,
			   ${hasTaskStatus ? 'st.status' : 'NULL'} AS task_status,
			   ${hasTaskCompletedAt ? 'st.completed_at' : 'NULL'} AS task_completed_at,
			   ${hasTaskUpdatedAt ? 'st.updated_at' : 'NULL'} AS task_updated_at`
			: `NULL AS space_id, NULL AS task_number,
			   NULL AS task_status,
			   NULL AS task_completed_at,
			   NULL AS task_updated_at`;
		const sessionJoin = hasSessions ? 'LEFT JOIN sessions s ON s.id = sm.session_id' : '';
		const spaceTaskJoin = hasSpaceTasks ? 'LEFT JOIN space_tasks st ON st.id = sm.task_id' : '';
		const row = this.db
			.prepare(
				`SELECT sm.id, sm.session_id, sm.task_id, sm.message_type, sm.sdk_message, sm.timestamp,
				        ${sessionTitleSelect}, ${sessionPolicySelect}, ${spaceTaskSelect}
				 FROM sdk_messages sm
				 ${sessionJoin}
				 ${spaceTaskJoin}
				 WHERE sm.id = ?`
			)
			.get(rowId) as
			| {
					id: string;
					session_id: string;
					task_id: string | null;
					message_type: string;
					sdk_message: string;
					timestamp: string;
					session_title: string | null;
					session_status: string | null;
					session_type: string | null;
					session_last_active_at: string | null;
					session_context: string | null;
					space_id: string | null;
					task_number: number | null;
					task_status: string | null;
					task_completed_at: number | null;
					task_updated_at: number | null;
			  }
			| undefined;
		if (!row) return;

		let parsed: SDKMessage | null = null;
		try {
			parsed = JSON.parse(row.sdk_message) as SDKMessage;
		} catch {
			return;
		}
		const body = extractVisibleSearchText(parsed);
		this.db
			.prepare(`DELETE FROM message_search_fts WHERE kind = 'message' AND source_id = ?`)
			.run(row.id);
		if (!SEARCHABLE_MESSAGE_TYPES.has(row.message_type)) return;
		if (!this.isMessageSearchIndexEligible(row)) return;
		if (!body) return;
		if (row.message_type === 'user' && !this.isSearchableUserMessageStatus(row.id)) {
			return;
		}
		this.db
			.prepare(
				`INSERT INTO message_search_fts (
					kind, source_id, message_id, session_id, task_id, space_id, task_number,
					message_type, title, body, timestamp
				) VALUES ('message', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				row.id,
				(parsed as { uuid?: string }).uuid ?? row.id,
				row.session_id,
				row.task_id,
				row.space_id,
				row.task_number,
				row.message_type,
				row.session_title ?? row.session_id,
				body,
				parseSearchTimestamp(row.timestamp)
			);
	}

	private isMessageSearchIndexEligible(row: {
		session_id: string;
		session_status: string | null;
		session_type: string | null;
		session_last_active_at: string | null;
		session_context: string | null;
		task_status: string | null;
		task_completed_at: number | null;
		task_updated_at: number | null;
	}): boolean {
		if (ROOM_SESSION_PREFIXES.some((prefix) => row.session_id.startsWith(prefix))) {
			return false;
		}

		if (row.session_status === 'archived') return false;
		if (row.session_status === 'ended' && isOlderThanMessageSearchTtl(row.session_last_active_at)) {
			return false;
		}

		if (row.session_type && ROOM_SESSION_TYPES.has(row.session_type)) return false;
		if (row.session_context) {
			try {
				const context = JSON.parse(row.session_context) as { roomId?: unknown };
				if (typeof context.roomId === 'string') return false;
			} catch {
				// Malformed historical context should not make an otherwise-normal session unsearchable.
			}
		}

		const isSpaceSession =
			row.session_id.startsWith('space:') ||
			row.session_type === 'space_chat' ||
			row.session_type === 'space_task_agent';
		const isNormalSession =
			!row.session_id.includes(':') && (!row.session_type || row.session_type === 'worker');
		if (!isSpaceSession && !isNormalSession) return false;

		if (row.task_status === 'archived') return false;
		if (
			row.task_status &&
			TERMINAL_SPACE_TASK_STATUSES.has(row.task_status) &&
			isOlderThanMessageSearchTtl(row.task_completed_at ?? row.task_updated_at)
		) {
			return false;
		}

		return true;
	}

	private deleteMessageSearchRow(rowId: string): void {
		if (!this.hasMessageSearchIndex()) return;
		this.db
			.prepare(`DELETE FROM message_search_fts WHERE kind = 'message' AND source_id = ?`)
			.run(rowId);
	}

	private isSearchableUserMessageStatus(rowId: string): boolean {
		const row = this.db
			.prepare(
				`SELECT COALESCE(send_status, 'consumed') AS send_status FROM sdk_messages WHERE id = ?`
			)
			.get(rowId) as { send_status: SendStatus } | undefined;
		return row?.send_status === 'consumed' || row?.send_status === 'failed';
	}

	/**
	 * Derive `sdk_messages.task_id` from the writing session's
	 * `session_context.taskId`. Both Task Agent and node-agent sessions stamp
	 * this at creation, so for any Space-bound session we can recover the
	 * task id directly from the `sessions` row without an extra map.
	 *
	 * Returns null when the session is missing, has no `session_context`, the
	 * context JSON is malformed, or the context simply has no `taskId` (e.g.
	 * a non-Space worker session). The column is nullable on purpose.
	 *
	 * Uses `json_valid` so a single malformed historical row can't throw at
	 * INSERT time. Tolerates the `sessions` table being absent (e.g. unit
	 * test harnesses that build a subset of the schema) by returning null.
	 */
	private resolveTaskIdForSession(sessionId: string): string | null {
		try {
			if (
				!this.tableExists('sessions') ||
				!this.tableHasColumn('sessions', 'session_context') ||
				!this.tableHasColumn('sessions', 'type')
			) {
				return null;
			}
			const row = this.db
				.prepare(
					`SELECT
						CASE
							WHEN session_context IS NULL THEN NULL
							WHEN NOT json_valid(session_context) THEN NULL
							ELSE json_extract(session_context, '$.taskId')
						END AS task_id,
						type
					 FROM sessions WHERE id = ?`
				)
				.get(sessionId) as { task_id: string | null; type: string | null } | undefined;
			if (!row) return null;
			// Only stamp task_id for sessions that are part of the Space task
			// system. Other session types (lobby, room-scoped, etc.) may
			// carry a taskId in context from transient operations but their
			// messages must not leak into task timelines.
			const allowedTypes = ['space_task_agent', 'worker'];
			if (!row.type || !allowedTypes.includes(row.type)) return null;
			return row.task_id ?? null;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (/no such table/i.test(message)) {
				this.logger.warn(
					`sessions table missing when resolving task_id for session ${sessionId}; ` +
						'message will not appear in task timelines'
				);
				return null;
			}
			throw err;
		}
	}

	/**
	 * Save a full SDK message to the database
	 *
	 * FIX: Enhanced with proper error handling and logging
	 * Returns true on success, false on failure
	 */
	saveSDKMessage(sessionId: string, message: SDKMessage, origin?: MessageOrigin): boolean {
		try {
			const id = generateUUID();
			const messageType = message.type;
			const messageSubtype = 'subtype' in message ? (message.subtype as string) : null;
			const timestamp = new Date().toISOString();

			const stmt = this.db.prepare(
				`INSERT INTO sdk_messages (
					id, session_id, message_type, message_subtype, sdk_message, timestamp, origin,
					is_renderable, is_terminal, parent_tool_use_id, task_id
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			);

			stmt.run(
				id,
				sessionId,
				messageType,
				messageSubtype,
				JSON.stringify(message),
				timestamp,
				origin ?? null,
				computeIsRenderable(message),
				computeIsTerminal(message),
				extractParentToolUseId(message),
				this.resolveTaskIdForSession(sessionId)
			);
			this.upsertMessageSearchRow(id);
			return true;
		} catch (error) {
			// Log error but don't throw - prevents stream from dying
			this.logger.error('[Database] Failed to save SDK message:', error);
			this.logger.error('[Database] Message type:', message.type, 'Session:', sessionId);
			return false;
		}
	}

	/**
	 * Get SDK messages for a session
	 *
	 * Returns messages in chronological order (oldest to newest).
	 *
	 * Pagination modes:
	 * 1. Initial load (no before): Returns the NEWEST `limit` top-level messages + their subagent messages
	 * 2. Load older (with before): Returns messages BEFORE the given timestamp
	 * 3. Load newer (with since): Returns messages AFTER the given timestamp
	 *
	 * Note: The limit applies only to top-level messages. Subagent messages (with parent_tool_use_id)
	 * are automatically included for the returned top-level messages to support SubagentBlock rendering.
	 *
	 * @param sessionId - The session ID to get messages for
	 * @param limit - Maximum number of top-level messages to return (default: 100)
	 * @param before - Cursor: get messages older than this timestamp (milliseconds)
	 * @param since - Get messages newer than this timestamp (milliseconds)
	 * @returns Object with messages array and hasMore boolean
	 */
	getSDKMessages(
		sessionId: string,
		limit?: number,
		before?: number,
		since?: number
	): {
		messages: Array<
			ChatMessage & { timestamp: number; origin?: MessageOrigin; sendStatus?: string }
		>;
		hasMore: boolean;
	} {
		return this._getSDKMessagesImpl(sessionId, limit ?? 100, before, since);
	}

	/**
	 * Internal implementation for getSDKMessages
	 * @private
	 */
	private _getSDKMessagesImpl(
		sessionId: string,
		limit: number,
		before?: number,
		since?: number
	): {
		messages: Array<
			ChatMessage & { timestamp: number; origin?: MessageOrigin; sendStatus?: string }
		>;
		hasMore: boolean;
	} {
		// Step 1: Get top-level messages (excluding subagent messages)
		// Show user messages that were consumed to SDK, plus any that failed to deliver.
		let query = `SELECT id, sdk_message, timestamp, send_status, origin FROM sdk_messages
      WHERE session_id = ?
        AND parent_tool_use_id IS NULL
        AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))`;
		const params: SQLiteValue[] = [sessionId];

		// Cursor-based pagination: get messages BEFORE a timestamp (for loading older)
		if (before !== undefined && before > 0) {
			query += ` AND timestamp < ?`;
			params.push(new Date(before).toISOString());
		}

		// Get messages AFTER a timestamp (for loading newer / real-time updates)
		if (since !== undefined && since > 0) {
			query += ` AND timestamp > ?`;
			params.push(new Date(since).toISOString());
		}

		// Order DESC to get newest messages first, then reverse for chronological display
		query += ` ORDER BY timestamp DESC LIMIT ?`;
		params.push(limit);

		const stmt = this.db.prepare(query);
		const rows = stmt.all(...params) as Record<string, unknown>[];

		// Parse SDK message and inject the timestamp, sendStatus, and origin from the database row.
		// Always explicitly set `origin` (even to undefined) so the SDK's own
		// `origin?: SDKMessageOrigin` object field — added in SDK 0.2.110 — is stripped from the
		// spread result. Without this, messages whose DB origin column is null would carry an
		// SDKMessageOrigin object instead of a NeoKai MessageOrigin string, making the field's
		// type inconsistent across messages.
		const messages = rows.map((r) => {
			const sdkMessage = JSON.parse(r.sdk_message as string) as SDKMessage;
			const timestamp = new Date(r.timestamp as string).getTime();
			const extra: Record<string, unknown> = {
				id: r.id,
				timestamp,
				// DB origin wins; undefined explicitly clears any SDK-level origin object.
				origin: r.origin != null ? (r.origin as MessageOrigin) : undefined,
			};
			if (r.send_status === 'failed') {
				extra.sendStatus = 'failed';
			}
			return { ...sdkMessage, ...extra } as SDKMessage & { timestamp: number };
		});

		// Reverse to get chronological order (oldest to newest) for display
		const topLevelMessages = messages.reverse();

		// Determine hasMore: if we got exactly `limit` top-level messages, there might be more
		const hasMore = topLevelMessages.length === limit;

		// Step 2: Get all subagent messages for the returned top-level messages
		// Extract tool use IDs from Task blocks in the top-level messages
		const toolUseIds = new Set<string>();
		topLevelMessages.forEach((msg) => {
			if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
				msg.message.content.forEach((block: unknown) => {
					const blockObj = block as Record<string, unknown>;
					if (blockObj.type === 'tool_use' && blockObj.id) {
						toolUseIds.add(blockObj.id as string);
					}
				});
			}
		});

		// Fetch subagent messages that have parent_tool_use_id matching any of the tool use IDs
		let subagentMessages: Array<SDKMessage & { timestamp: number }> = [];
		if (toolUseIds.size > 0) {
			const placeholders = Array.from(toolUseIds)
				.map(() => '?')
				.join(',');
			const subagentQuery = `SELECT id, sdk_message, timestamp FROM sdk_messages
       WHERE session_id = ?
         AND parent_tool_use_id IN (${placeholders})
         AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
        ORDER BY timestamp ASC`;
			const subagentParams: SQLiteValue[] = [sessionId, ...Array.from(toolUseIds)];

			const subagentStmt = this.db.prepare(subagentQuery);
			const subagentRows = subagentStmt.all(...subagentParams) as Record<string, unknown>[];

			subagentMessages = subagentRows.map((r) => {
				const sdkMessage = JSON.parse(r.sdk_message as string) as SDKMessage;
				const timestamp = new Date(r.timestamp as string).getTime();
				// Subagent messages have no DB origin column; explicitly set undefined to strip
				// any SDK-level origin object from the JSON blob (same reasoning as top-level).
				return {
					...sdkMessage,
					id: r.id,
					timestamp,
					origin: undefined,
				} as unknown as SDKMessage & {
					timestamp: number;
				};
			});
		}

		// Combine and return: top-level messages + their associated subagent messages
		// hasMore is based on top-level message count only (not including subagent messages)
		// Note: cast required because the new SDK added `origin?: SDKMessageOrigin` to SDKUserMessage,
		// which conflicts with our augmented `origin?: MessageOrigin` field (a different type used for
		// tracking message provenance in NeoKai). The runtime values are always correct.
		return {
			messages: [...topLevelMessages, ...subagentMessages] as Array<
				SDKMessage & { timestamp: number; origin?: MessageOrigin; sendStatus?: string }
			>,
			hasMore,
		};
	}

	/**
	 * Get SDK messages by type
	 */
	getSDKMessagesByType(
		sessionId: string,
		messageType: string,
		messageSubtype?: string,
		limit = 100
	): SDKMessage[] {
		let query = `SELECT sdk_message FROM sdk_messages WHERE session_id = ? AND message_type = ?`;
		const params: SQLiteValue[] = [sessionId, messageType];

		if (messageSubtype) {
			query += ` AND message_subtype = ?`;
			params.push(messageSubtype);
		}

		query += ` ORDER BY timestamp ASC LIMIT ?`;
		params.push(limit);

		const stmt = this.db.prepare(query);
		const rows = stmt.all(...params) as Record<string, unknown>[];

		return rows.map((r) => JSON.parse(r.sdk_message as string) as SDKMessage);
	}

	/**
	 * Get the most recently persisted top-level SDK message for a session.
	 *
	 * Excludes:
	 * - Subagent/tool-linked rows (those with a `parent_tool_use_id`).
	 * - User messages still in `deferred`/`enqueued` send_status (not yet consumed
	 *   by the SDK), so an unsent injectMessage doesn't shadow the real last message.
	 *
	 * Used by workflow runtime safety checks that need to know whether a node
	 * agent went idle after a terminal SDK result / clear end-turn, or stopped
	 * mid-turn (for example after a tool_use without a matching tool_result).
	 */
	getLastSDKMessage(sessionId: string): (SDKMessage & { dbId: string; timestamp: number }) | null {
		const stmt = this.db.prepare(
			`SELECT id, sdk_message, timestamp FROM sdk_messages
	       WHERE session_id = ?
		       AND parent_tool_use_id IS NULL
		       AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
	       ORDER BY timestamp DESC, rowid DESC
	       LIMIT 1`
		);
		const row = stmt.get(sessionId) as {
			id: string;
			sdk_message: string;
			timestamp: string;
		} | null;
		return row ? this.inflatePersistedMessage(row) : null;
	}

	/**
	 * Get the count of SDK messages for a session
	 *
	 * Only counts top-level messages (excludes nested subagent messages with parent_tool_use_id)
	 * to ensure accurate pagination.
	 */
	getSDKMessageCount(sessionId: string): number {
		const stmt = this.db.prepare(
			`SELECT COUNT(*) as count FROM sdk_messages
       WHERE session_id = ?
         AND parent_tool_use_id IS NULL
         AND (message_type != 'user' OR COALESCE(send_status, 'consumed') = 'consumed')`
		);
		const result = stmt.get(sessionId) as { count: number };
		return result.count;
	}

	// ============================================================================
	// Message Query Mode operations
	// ============================================================================
	// Message send status types for query mode feature:
	// - 'deferred': Message persisted but not yet consumed to SDK (Manual mode)
	// - 'enqueued': Message in queue waiting to be consumed (during processing)
	// - 'consumed': Message has been yielded to SDK

	/**
	 * Save a user message with explicit send status
	 *
	 * Used by query modes to track message lifecycle:
	 * - Immediate mode: saves with status 'enqueued', then flips to 'consumed'
	 *   when the SDK input generator yields the message
	 * - Auto-queue mode: saves with status 'enqueued' (pending SDK consumption)
	 * - Manual mode: saves with status 'deferred' (until user triggers send)
	 *
	 * @returns The generated message ID
	 */
	saveUserMessage(
		sessionId: string,
		message: SDKMessage,
		sendStatus: SendStatus = 'consumed',
		origin?: MessageOrigin
	): string {
		const id = generateUUID();
		const messageType = message.type;
		const messageSubtype = 'subtype' in message ? (message.subtype as string) : null;
		const timestamp = new Date().toISOString();

		const stmt = this.db.prepare(
			`INSERT INTO sdk_messages (
				id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin,
				is_renderable, is_terminal, parent_tool_use_id, task_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);

		stmt.run(
			id,
			sessionId,
			messageType,
			messageSubtype,
			JSON.stringify(message),
			timestamp,
			sendStatus,
			origin ?? null,
			computeIsRenderable(message),
			computeIsTerminal(message),
			extractParentToolUseId(message),
			this.resolveTaskIdForSession(sessionId)
		);
		this.upsertMessageSearchRow(id);
		return id;
	}

	/**
	 * Get messages by send status for a session
	 *
	 * Used to retrieve:
	 * - 'deferred' messages for manual trigger
	 * - 'enqueued' messages for auto-send on turn_end
	 *
	 * Returns messages in chronological order (oldest first).
	 */
	getMessagesByStatus(
		sessionId: string,
		status: SendStatus
	): Array<SDKMessage & { dbId: string; timestamp: number }> {
		const stmt = this.db.prepare(
			`SELECT id, sdk_message, timestamp FROM sdk_messages
       WHERE session_id = ? AND send_status = ?
       ORDER BY timestamp ASC`
		);
		const rows = stmt.all(sessionId, status) as Array<{
			id: string;
			sdk_message: string;
			timestamp: string;
		}>;

		return rows.map((row) => this.inflatePersistedMessage(row));
	}

	/**
	 * Look up a single persisted user message by UUID and status.
	 *
	 * This avoids repeatedly loading and parsing every queued/deferred/consumed
	 * message during SDK replay acknowledgment, which is on the hot streaming path.
	 */
	getMessageByStatusAndUuid(
		sessionId: string,
		status: SendStatus,
		uuid: string
	): (SDKMessage & { dbId: string; timestamp: number }) | null {
		const stmt = this.db.prepare(
			`SELECT id, sdk_message, timestamp FROM sdk_messages
	       WHERE session_id = ?
	         AND send_status = ?
	         AND json_extract(sdk_message, '$.uuid') = ?
	       ORDER BY timestamp ASC
	       LIMIT 1`
		);
		const row = stmt.get(sessionId, status, uuid) as {
			id: string;
			sdk_message: string;
			timestamp: string;
		} | null;
		return row ? this.inflatePersistedMessage(row) : null;
	}

	private inflatePersistedMessage(row: {
		id: string;
		sdk_message: string;
		timestamp: string;
	}): SDKMessage & { dbId: string; timestamp: number } {
		return {
			...(JSON.parse(row.sdk_message) as SDKMessage),
			dbId: row.id,
			// DB timestamp (epoch ms) overrides the SDK's ISO string timestamp for persisted messages
			timestamp: new Date(row.timestamp).getTime(),
		} as SDKMessage & { dbId: string; timestamp: number };
	}

	/**
	 * Update send status for messages
	 *
	 * Used to transition messages through the lifecycle:
	 * - 'deferred' -> 'enqueued' (when user triggers manual send)
	 * - 'enqueued' -> 'consumed' (when message is yielded to SDK)
	 */
	updateMessageStatus(messageIds: string[], newStatus: SendStatus): void {
		if (messageIds.length === 0) return;

		// Use parameterized query to prevent SQL injection
		const placeholders = messageIds.map(() => '?').join(',');
		const stmt = this.db.prepare(
			`UPDATE sdk_messages SET send_status = ? WHERE id IN (${placeholders})`
		);
		stmt.run(newStatus, ...messageIds);
		for (const messageId of messageIds) this.upsertMessageSearchRow(messageId);
	}

	/**
	 * Update the timestamp of a message.
	 *
	 * When timestampMs is provided, sets the timestamp to that value (used to
	 * record the moment the SDK generator yielded the message — T_consumed).
	 * Otherwise falls back to the current time.
	 */
	updateMessageTimestamp(messageId: string, timestampMs?: number): void {
		const stmt = this.db.prepare(`UPDATE sdk_messages SET timestamp = ? WHERE id = ?`);
		const ts = timestampMs !== undefined ? new Date(timestampMs) : new Date();
		stmt.run(ts.toISOString(), messageId);
		this.upsertMessageSearchRow(messageId);
	}

	/**
	 * Get count of messages by status for a session
	 * Useful for UI display (e.g., "3 messages pending")
	 */
	getMessageCountByStatus(sessionId: string, status: SendStatus): number {
		const stmt = this.db.prepare(
			`SELECT COUNT(*) as count FROM sdk_messages WHERE session_id = ? AND send_status = ?`
		);
		const result = stmt.get(sessionId, status) as { count: number };
		return result.count;
	}

	/**
	 * Delete messages after a specific timestamp
	 *
	 * Used by the rewind feature to remove messages from the conversation
	 * when rewinding to a previous checkpoint.
	 *
	 * @param sessionId - The session ID to delete messages from
	 * @param afterTimestamp - Delete messages with timestamp greater than this value (milliseconds)
	 * @returns The number of messages deleted
	 */
	deleteMessagesAfter(sessionId: string, afterTimestamp: number): number {
		const isoTimestamp = new Date(afterTimestamp).toISOString();
		const rows = this.db
			.prepare(`SELECT id FROM sdk_messages WHERE session_id = ? AND timestamp > ?`)
			.all(sessionId, isoTimestamp) as Array<{ id: string }>;
		const stmt = this.db.prepare(`DELETE FROM sdk_messages WHERE session_id = ? AND timestamp > ?`);
		const result = stmt.run(sessionId, isoTimestamp);
		for (const row of rows) this.deleteMessageSearchRow(row.id);
		return result.changes;
	}

	/**
	 * Delete messages at and after a specific timestamp (inclusive)
	 *
	 * Used by the rewind feature to remove the rewind point message itself
	 * and all subsequent messages.
	 *
	 * @param sessionId - The session ID to delete messages from
	 * @param atTimestamp - Delete messages with timestamp greater than or equal to this value (milliseconds)
	 * @returns The number of messages deleted
	 */
	deleteMessagesAtAndAfter(sessionId: string, atTimestamp: number): number {
		const isoTimestamp = new Date(atTimestamp).toISOString();
		const rows = this.db
			.prepare(`SELECT id FROM sdk_messages WHERE session_id = ? AND timestamp >= ?`)
			.all(sessionId, isoTimestamp) as Array<{ id: string }>;
		const stmt = this.db.prepare(
			`DELETE FROM sdk_messages WHERE session_id = ? AND timestamp >= ?`
		);
		const result = stmt.run(sessionId, isoTimestamp);
		for (const row of rows) this.deleteMessageSearchRow(row.id);
		return result.changes;
	}

	/**
	 * Get user messages for a session (used as rewind points)
	 *
	 * Returns user messages with their UUIDs, timestamps, and content.
	 * These serve as potential rewind checkpoints since each user message
	 * has a UUID that the SDK uses for file checkpointing.
	 *
	 * @param sessionId - The session ID to get user messages for
	 * @returns Array of user message data for rewind
	 */
	getUserMessages(sessionId: string): Array<{ uuid: string; timestamp: number; content: string }> {
		const stmt = this.db.prepare(
			`SELECT sdk_message, timestamp FROM sdk_messages
       WHERE session_id = ? AND message_type = 'user'
       ORDER BY timestamp ASC`
		);
		const rows = stmt.all(sessionId) as Array<{ sdk_message: string; timestamp: string }>;

		return rows.map((row) => {
			const message = JSON.parse(row.sdk_message) as SDKMessage;
			const timestamp = new Date(row.timestamp).getTime();

			// Extract text content from message
			// User messages have a specific structure with nested message.content
			let content = '';
			const userMessage = message as {
				message?: { content?: string | Array<{ type: string; text?: string }> };
				uuid?: string;
			};
			if (userMessage.message?.content) {
				if (typeof userMessage.message.content === 'string') {
					content = userMessage.message.content;
				} else if (Array.isArray(userMessage.message.content)) {
					// Find first text block
					const textBlock = userMessage.message.content.find(
						(block): block is { type: 'text'; text: string } => block.type === 'text'
					);
					content = textBlock?.text || '';
				}
			}

			return {
				uuid: userMessage.uuid || '',
				timestamp,
				content,
			};
		});
	}

	/**
	 * Get a single user message by UUID
	 *
	 * Used by rewind to look up a specific checkpoint/message.
	 *
	 * The previous implementation loaded every user row for the session and
	 * scanned in JS — O(N) per lookup. The current form uses
	 * `idx_sdk_messages_uuid_status (session_id, send_status,
	 * json_extract uuid)` for a full 3-column index seek.
	 *
	 * Coverage must match `getUserMessages` (which returns user rows of
	 * every `send_status`), otherwise rewind would surface a checkpoint
	 * it then can't resolve. We probe each known status in turn — the
	 * planner only picks the full 3-column seek when `send_status` is
	 * constrained to a single value, so `IN (…)` is not enough — and a
	 * final fallback covers legacy rows with NULL `send_status` (none
	 * observed in the current production DB but historically possible).
	 *
	 * Determinism: if duplicate uuids exist within the same session
	 * (no DB-level uniqueness constraint on the json_extract'd uuid),
	 * the previous implementation returned the chronologically earliest
	 * row across the whole session. We preserve that by collecting every
	 * matching row from each per-status seek (via `.all()` rather than
	 * `LIMIT 1`) and picking the overall earliest in JS. The NULL
	 * fallback is only consulted when no indexed-status seek matched,
	 * so legacy and modern data don't compete on every call — a
	 * duplicate uuid co-existing across NULL and a known status in the
	 * same session is not a real-world case.
	 *
	 * Benchmark on the largest production session (3 335 user rows in a
	 * 42 061-row table): ~294 ms (before, full-function wall-clock) →
	 * ~0.95 ms (after, full-function wall-clock) — ~310x speedup. The
	 * raw 4-seek SQLite cost is only ~0.04 ms; the remainder is
	 * JSON.parse + content extraction on the matched row. NULL fallback
	 * alone is ~220 ms but only runs when no indexed status matched,
	 * which the production DB has never been observed to need.
	 *
	 * @param sessionId - The session ID
	 * @param uuid - The message UUID
	 * @returns The message data or undefined
	 */
	getUserMessageByUuid(
		sessionId: string,
		uuid: string
	): { uuid: string; timestamp: number; content: string } | undefined {
		// Fast path: indexed seek against idx_sdk_messages_uuid_status. We
		// probe each known send_status separately because the planner only
		// picks the 3-column index when send_status is constrained to a
		// single value; `IN (…)` falls back to a session-partition scan.
		// We deliberately omit `ORDER BY` here — adding one causes the
		// planner to switch to `idx_sdk_messages_session (session_id,
		// timestamp)` and lose the indexed seek (~0.01 ms → ~200 ms).
		// In-bucket determinism is recovered by collecting all matches per
		// bucket and picking the earliest in JS below.
		const indexedStmt = this.db.prepare(
			`SELECT sdk_message, timestamp FROM sdk_messages
       WHERE session_id = ?
         AND send_status = ?
         AND message_type = 'user'
         AND json_extract(sdk_message, '$.uuid') = ?`
		);

		const STATUSES_TO_PROBE: SendStatus[] = ['consumed', 'failed', 'enqueued', 'deferred'];
		const candidates: Array<{ sdk_message: string; timestamp: string }> = [];
		for (const status of STATUSES_TO_PROBE) {
			const rows = indexedStmt.all(sessionId, status, uuid) as Array<{
				sdk_message: string;
				timestamp: string;
			}>;
			for (const r of rows) candidates.push(r);
		}

		// Fallback: legacy rows with NULL send_status. Not observed in the
		// current production DB but historically possible. This path scans
		// the session partition rather than seeking the index, so only run
		// it when no indexed status seek matched — otherwise it would
		// dominate the cost on every call.
		if (candidates.length === 0) {
			const fallbackStmt = this.db.prepare(
				`SELECT sdk_message, timestamp FROM sdk_messages
       WHERE session_id = ?
         AND send_status IS NULL
         AND message_type = 'user'
         AND json_extract(sdk_message, '$.uuid') = ?
       ORDER BY timestamp ASC
       LIMIT 1`
			);
			const nullRow = fallbackStmt.get(sessionId, uuid) as
				| { sdk_message: string; timestamp: string }
				| undefined;
			if (nullRow) candidates.push(nullRow);
		}

		if (candidates.length === 0) return undefined;

		// Pick the chronologically earliest match — matches the previous
		// full-session ORDER BY timestamp ASC scan + first-match behavior
		// that rewind timestamp math depends on.
		let earliest = candidates[0];
		for (let i = 1; i < candidates.length; i++) {
			if (candidates[i].timestamp < earliest.timestamp) earliest = candidates[i];
		}
		return this.parseUserMessageRow(earliest, uuid);
	}

	private parseUserMessageRow(
		row: { sdk_message: string; timestamp: string },
		uuid: string
	): { uuid: string; timestamp: number; content: string } {
		const message = JSON.parse(row.sdk_message) as SDKMessage;
		const timestamp = new Date(row.timestamp).getTime();

		// Extract text content from message
		// User messages have a specific structure with nested message.content
		let content = '';
		const userMessage = message as {
			message?: { content?: string | Array<{ type: string; text?: string }> };
			uuid?: string;
		};
		if (userMessage.message?.content) {
			if (typeof userMessage.message.content === 'string') {
				content = userMessage.message.content;
			} else if (Array.isArray(userMessage.message.content)) {
				// Find first text block
				const textBlock = userMessage.message.content.find(
					(block): block is { type: 'text'; text: string } => block.type === 'text'
				);
				content = textBlock?.text || '';
			}
		}

		return { uuid, timestamp, content };
	}

	/**
	 * Get assistant messages from a session since a specific message (by DB row ID).
	 *
	 * Used by Room Runtime to collect Craft output for forwarding to Lead.
	 * - If afterMessageId is null: returns all assistant messages for the session.
	 * - Otherwise: returns messages whose timestamp is after the row with afterMessageId.
	 *
	 * Returns structured objects ready for envelope formatting.
	 */
	getAssistantMessagesSince(
		sessionId: string,
		afterMessageId: string | null
	): Array<{ id: string; text: string; toolCallNames: string[] }> {
		let query: string;
		let params: Array<string>;

		if (afterMessageId) {
			// Get timestamp of the reference message, then fetch messages after it
			query = `
				SELECT id, sdk_message FROM sdk_messages
				WHERE session_id = ?
				  AND message_type = 'assistant'
				  AND timestamp > (
				      SELECT timestamp FROM sdk_messages WHERE id = ?
				  )
				ORDER BY timestamp ASC
			`;
			params = [sessionId, afterMessageId];
		} else {
			query = `
				SELECT id, sdk_message FROM sdk_messages
				WHERE session_id = ? AND message_type = 'assistant'
				ORDER BY timestamp ASC
			`;
			params = [sessionId];
		}

		const stmt = this.db.prepare(query);
		const rows = stmt.all(...params) as Array<{ id: string; sdk_message: string }>;

		return rows.map((row) => {
			const msg = JSON.parse(row.sdk_message) as Record<string, unknown>;
			const text = this.extractAssistantText(msg);
			const toolCallNames = this.extractToolCallNames(msg);
			return { id: row.id, text, toolCallNames };
		});
	}

	private extractAssistantText(msg: Record<string, unknown>): string {
		const parts: string[] = [];
		const message = msg.message as Record<string, unknown> | undefined;
		const content = message?.content;
		if (Array.isArray(content)) {
			for (const block of content as Array<Record<string, unknown>>) {
				if (block.type === 'text' && typeof block.text === 'string') {
					parts.push(block.text);
				}
			}
		} else if (typeof content === 'string') {
			parts.push(content);
		}
		// Also capture result text from SDK result messages
		if (msg.type === 'result' && typeof msg.result === 'string') {
			parts.push(msg.result);
		}
		return parts.join('\n\n').trim();
	}

	private extractToolCallNames(msg: Record<string, unknown>): string[] {
		const names: string[] = [];
		const message = msg.message as Record<string, unknown> | undefined;
		const content = message?.content;
		if (Array.isArray(content)) {
			for (const block of content as Array<Record<string, unknown>>) {
				if (block.type === 'tool_use' && typeof block.name === 'string') {
					names.push(block.name);
				}
			}
		}
		return names;
	}

	/**
	 * Count messages after a specific timestamp
	 *
	 * Used by rewind to show how many messages will be deleted.
	 *
	 * @param sessionId - The session ID
	 * @param afterTimestamp - Count messages with timestamp greater than this value (milliseconds)
	 * @returns The number of messages after the timestamp
	 */
	countMessagesAfter(sessionId: string, afterTimestamp: number): number {
		const isoTimestamp = new Date(afterTimestamp).toISOString();
		const stmt = this.db.prepare(
			`SELECT COUNT(*) as count FROM sdk_messages WHERE session_id = ? AND timestamp > ?`
		);
		const result = stmt.get(sessionId, isoTimestamp) as { count: number };
		return result.count;
	}

	// ============================================================================
	// NeoKai action messages (interactive prompts stored in the chat timeline)
	// ============================================================================

	/**
	 * Save a NeoKai-native action message to the sdk_messages table.
	 *
	 * The message is stored in the same `sdk_message` JSON column as SDK messages,
	 * but with `message_type = 'neokai_action'` so it can be distinguished during
	 * fetch.  No `send_status` is needed because action messages are never queued.
	 *
	 * @returns The generated row ID (used later to update the resolved state).
	 */
	saveNeokaiActionMessage(sessionId: string, message: NeokaiActionMessage): string {
		const id = generateUUID();
		const timestamp = new Date(message.timestamp).toISOString();

		const stmt = this.db.prepare(
			`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
		);

		stmt.run(
			id,
			sessionId,
			'neokai_action',
			message.action,
			JSON.stringify(message),
			timestamp,
			this.resolveTaskIdForSession(sessionId)
		);
		this.upsertMessageSearchRow(id);
		return id;
	}

	/**
	 * Update a NeoKai action message in-place (e.g. mark it resolved after the
	 * user has made a choice).
	 *
	 * @param rowId   The ID returned by saveNeokaiActionMessage.
	 * @param updated The full updated message object (replaces the stored JSON).
	 */
	updateNeokaiActionMessage(rowId: string, updated: NeokaiActionMessage): void {
		const stmt = this.db.prepare(`UPDATE sdk_messages SET sdk_message = ? WHERE id = ?`);
		stmt.run(JSON.stringify(updated), rowId);
		this.upsertMessageSearchRow(rowId);
	}

	/**
	 * Update a NeoKai action message by its uuid field (stored inside the JSON blob).
	 *
	 * This avoids having to carry the row ID through the RPC call.  The uuid is
	 * unique per session (generated at emit time) so the lookup is unambiguous.
	 */
	updateNeokaiActionMessageByUuid(
		sessionId: string,
		messageUuid: string,
		updated: NeokaiActionMessage
	): void {
		const row = this.db
			.prepare(
				`SELECT id FROM sdk_messages
       WHERE session_id = ?
         AND message_type = 'neokai_action'
         AND json_extract(sdk_message, '$.uuid') = ?`
			)
			.get(sessionId, messageUuid) as { id: string } | undefined;
		const stmt = this.db.prepare(
			`UPDATE sdk_messages SET sdk_message = ?
       WHERE session_id = ?
         AND message_type = 'neokai_action'
         AND json_extract(sdk_message, '$.uuid') = ?`
		);
		stmt.run(JSON.stringify(updated), sessionId, messageUuid);
		if (row) this.upsertMessageSearchRow(row.id);
	}

	searchMessages(params: MessageSearchParams): MessageSearchResponse {
		if (!this.hasMessageSearchIndex()) {
			return { results: [], limit: params.limit ?? 25, offset: params.offset ?? 0 };
		}

		const ftsQuery = buildFtsQuery(params.query);
		const limit = Math.min(Math.max(params.limit ?? 25, 1), 50);
		const offset = Math.max(params.offset ?? 0, 0);
		if (!ftsQuery) return { results: [], limit, offset };

		const broadQuery = isBroadMessageSearchQuery(params.query);
		let candidateSql = `
			SELECT
				rowid,
				${broadQuery ? '0' : 'bm25(message_search_fts)'} AS rank,
				timestamp,
				source_id
			FROM message_search_fts
			WHERE message_search_fts MATCH ?`;
		const values: SQLiteValue[] = [ftsQuery];

		if (params.sessionId) {
			candidateSql += ` AND session_id = ?`;
			values.push(params.sessionId);
		}
		if (params.messageType) {
			candidateSql += ` AND message_type = ?`;
			values.push(params.messageType);
		}
		if (params.from !== undefined) {
			candidateSql += ` AND timestamp >= ?`;
			values.push(params.from);
		}
		if (params.to !== undefined) {
			candidateSql += ` AND timestamp <= ?`;
			values.push(params.to);
		}

		candidateSql += broadQuery
			? ` ORDER BY timestamp DESC, source_id ASC LIMIT ? OFFSET ?`
			: ` ORDER BY rank ASC, timestamp DESC, source_id ASC LIMIT ? OFFSET ?`;
		values.push(limit, offset);

		const candidates = this.db.prepare(candidateSql).all(...values) as Array<{
			rowid: number;
			rank: number;
		}>;
		if (candidates.length === 0) return { results: [], limit, offset };

		const rankByRowId = new Map(candidates.map((row) => [row.rowid, row.rank]));
		const orderByRowId = new Map(candidates.map((row, index) => [row.rowid, index]));
		const placeholders = candidates.map(() => '?').join(', ');
		const rows = this.db
			.prepare(
				`
				SELECT
					rowid, kind, source_id, message_id, session_id, task_id, space_id, task_number,
					message_type, title,
					snippet(message_search_fts, 9, '<mark>', '</mark>', '…', 16) AS snippet,
					timestamp
				FROM message_search_fts
				WHERE rowid IN (${placeholders})
				  AND message_search_fts MATCH ?`
			)
			.all(...candidates.map((row) => row.rowid), ftsQuery) as Array<{
			rowid: number;
			kind: 'message' | 'task';
			source_id: string;
			message_id: string | null;
			session_id: string | null;
			task_id: string | null;
			space_id: string | null;
			task_number: number | null;
			message_type: string | null;
			title: string | null;
			snippet: string | null;
			timestamp: string | null;
		}>;

		const results: MessageSearchResult[] = rows
			.sort((a, b) => (orderByRowId.get(a.rowid) ?? 0) - (orderByRowId.get(b.rowid) ?? 0))
			.map((row) => {
				const timestamp = parseSearchTimestamp(row.timestamp);
				return {
					kind: row.kind,
					sourceId: row.source_id,
					messageId: row.message_id ?? row.source_id,
					sessionId: row.session_id ?? undefined,
					taskId: row.task_id ?? undefined,
					spaceId: row.space_id ?? undefined,
					taskNumber: row.task_number ?? undefined,
					messageType: row.message_type ?? undefined,
					title: row.title ?? (row.kind === 'task' ? 'Task' : 'Session'),
					snippet: row.snippet ?? '',
					timestamp,
					loadTarget: row.session_id
						? { sessionId: row.session_id, before: timestamp + 1 }
						: undefined,
					rank: rankByRowId.get(row.rowid) ?? 0,
				};
			});

		return { results, limit, offset };
	}
}

function parseSearchTimestamp(value: string | null): number {
	if (!value) return 0;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return numeric;
	const parsed = new Date(value).getTime();
	return Number.isFinite(parsed) ? parsed : 0;
}
