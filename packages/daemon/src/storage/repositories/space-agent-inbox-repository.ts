import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';

export type SpaceAgentInboxMessageStatus = 'pending' | 'delivered' | 'expired' | 'failed';

export interface SpaceAgentInboxMessageRecord {
	id: string;
	spaceId: string;
	targetAgentId: string;
	sourceActorId: string;
	sourceSessionId: string | null;
	message: string;
	messageRecordJson: string | null;
	idempotencyKey: string | null;
	attempts: number;
	maxAttempts: number;
	lastAttemptAt: number | null;
	lastError: string | null;
	status: SpaceAgentInboxMessageStatus;
	deliveredAt: number | null;
	deliveredSessionId: string | null;
	expiresAt: number;
	createdAt: number;
}

export interface EnqueueSpaceAgentInboxMessageInput {
	spaceId: string;
	targetAgentId: string;
	sourceActorId: string;
	sourceSessionId?: string | null;
	message: string;
	messageRecordJson?: string | null;
	idempotencyKey?: string | null;
	ttlMs?: number;
	expiresAt?: number;
	maxAttempts?: number;
}

export interface SpaceAgentInboxEnqueueResult {
	record: SpaceAgentInboxMessageRecord;
	deduped: boolean;
}

export const DEFAULT_SPACE_AGENT_INBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_SPACE_AGENT_INBOX_MAX_ATTEMPTS = 5;

export class SpaceAgentInboxRepository {
	constructor(private db: BunDatabase) {}

	enqueue(input: EnqueueSpaceAgentInboxMessageInput): SpaceAgentInboxEnqueueResult {
		const idempotencyKey = input.idempotencyKey ?? null;
		if (idempotencyKey) {
			const existing = this.findByIdempotencyKey(
				input.spaceId,
				input.targetAgentId,
				idempotencyKey
			);
			if (existing) return { record: existing, deduped: true };
		}

		const now = Date.now();
		const expiresAt = input.expiresAt ?? now + (input.ttlMs ?? DEFAULT_SPACE_AGENT_INBOX_TTL_MS);
		const id = generateUUID();
		const maxAttempts = input.maxAttempts ?? DEFAULT_SPACE_AGENT_INBOX_MAX_ATTEMPTS;

		this.db
			.prepare(
				`INSERT INTO space_agent_inbox_messages (
					id, space_id, target_agent_id, source_actor_id, source_session_id,
					message, message_record_json, idempotency_key,
					attempts, max_attempts, last_attempt_at, last_error,
					status, delivered_at, delivered_session_id, expires_at, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, 'pending', NULL, NULL, ?, ?)`
			)
			.run(
				id,
				input.spaceId,
				input.targetAgentId,
				input.sourceActorId,
				input.sourceSessionId ?? null,
				input.message,
				input.messageRecordJson ?? null,
				idempotencyKey,
				maxAttempts,
				expiresAt,
				now
			);

		const record = this.getById(id);
		if (!record) {
			throw new Error(`SpaceAgentInboxRepository: failed to read back row ${id}`);
		}
		return { record, deduped: false };
	}

	getById(id: string): SpaceAgentInboxMessageRecord | null {
		const row = this.db
			.prepare('SELECT * FROM space_agent_inbox_messages WHERE id = ?')
			.get(id) as SpaceAgentInboxMessageRow | null;
		return row ? rowToRecord(row) : null;
	}

	findByIdempotencyKey(
		spaceId: string,
		targetAgentId: string,
		idempotencyKey: string
	): SpaceAgentInboxMessageRecord | null {
		if (!idempotencyKey) return null;
		const row = this.db
			.prepare(
				`SELECT * FROM space_agent_inbox_messages
				 WHERE space_id = ? AND target_agent_id = ? AND idempotency_key = ? AND status = 'pending'
				 ORDER BY created_at ASC, rowid ASC
				 LIMIT 1`
			)
			.get(spaceId, targetAgentId, idempotencyKey) as SpaceAgentInboxMessageRow | null;
		return row ? rowToRecord(row) : null;
	}

	listPendingForAgent(spaceId: string, targetAgentId: string): SpaceAgentInboxMessageRecord[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM space_agent_inbox_messages
				 WHERE space_id = ? AND target_agent_id = ? AND status = 'pending'
				 ORDER BY created_at ASC, rowid ASC`
			)
			.all(spaceId, targetAgentId) as SpaceAgentInboxMessageRow[];
		return rows.map(rowToRecord);
	}

	listPendingForSpace(spaceId: string): SpaceAgentInboxMessageRecord[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM space_agent_inbox_messages
				 WHERE space_id = ? AND status = 'pending'
				 ORDER BY created_at ASC, rowid ASC`
			)
			.all(spaceId) as SpaceAgentInboxMessageRow[];
		return rows.map(rowToRecord);
	}

	markDelivered(id: string, sessionId: string): void {
		const now = Date.now();
		this.db
			.prepare(
				`UPDATE space_agent_inbox_messages
				 SET status = 'delivered',
				     delivered_at = ?,
				     delivered_session_id = ?,
				     last_attempt_at = ?,
				     last_error = NULL
				 WHERE id = ? AND status = 'pending'`
			)
			.run(now, sessionId, now, id);
	}

	markAttemptFailed(id: string, error: string): SpaceAgentInboxMessageRecord | null {
		const now = Date.now();
		this.db
			.prepare(
				`UPDATE space_agent_inbox_messages
				 SET attempts = attempts + 1,
				     last_attempt_at = ?,
				     last_error = ?,
				     status = CASE
				       WHEN attempts + 1 >= max_attempts THEN 'failed'
				       ELSE status
				     END
				 WHERE id = ? AND status = 'pending'`
			)
			.run(now, error, id);
		return this.getById(id);
	}

	expireStale(spaceId?: string): number {
		const now = Date.now();
		const stmt = spaceId
			? this.db.prepare(
					`UPDATE space_agent_inbox_messages
					 SET status = 'expired'
					 WHERE status = 'pending' AND expires_at <= ? AND space_id = ?`
				)
			: this.db.prepare(
					`UPDATE space_agent_inbox_messages
					 SET status = 'expired'
					 WHERE status = 'pending' AND expires_at <= ?`
				);
		const result = spaceId ? stmt.run(now, spaceId) : stmt.run(now);
		return result.changes;
	}
}

interface SpaceAgentInboxMessageRow {
	id: string;
	space_id: string;
	target_agent_id: string;
	source_actor_id: string;
	source_session_id: string | null;
	message: string;
	message_record_json: string | null;
	idempotency_key: string | null;
	attempts: number;
	max_attempts: number;
	last_attempt_at: number | null;
	last_error: string | null;
	status: SpaceAgentInboxMessageStatus;
	delivered_at: number | null;
	delivered_session_id: string | null;
	expires_at: number;
	created_at: number;
}

function rowToRecord(row: SpaceAgentInboxMessageRow): SpaceAgentInboxMessageRecord {
	return {
		id: row.id,
		spaceId: row.space_id,
		targetAgentId: row.target_agent_id,
		sourceActorId: row.source_actor_id,
		sourceSessionId: row.source_session_id,
		message: row.message,
		messageRecordJson: row.message_record_json,
		idempotencyKey: row.idempotency_key,
		attempts: row.attempts,
		maxAttempts: row.max_attempts,
		lastAttemptAt: row.last_attempt_at,
		lastError: row.last_error,
		status: row.status,
		deliveredAt: row.delivered_at,
		deliveredSessionId: row.delivered_session_id,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
	};
}
