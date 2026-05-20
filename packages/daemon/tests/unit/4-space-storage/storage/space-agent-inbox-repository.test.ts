import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceAgentInboxRepository } from '../../../../src/storage/repositories/space-agent-inbox-repository.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';

let db: Database;
let repo: SpaceAgentInboxRepository;

const SPACE_ID = 'space-1';
const AGENT_ID = 'agent-1';

function freshDb(): Database {
	const d = new Database(':memory:');
	createSpaceTables(d);
	const now = Date.now();
	d.exec(
		`INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES ('${SPACE_ID}', '${SPACE_ID}', '/tmp/test-space-agent-inbox', 'Test Space', ${now}, ${now})`
	);
	d.exec(
		`INSERT INTO space_agents (id, space_id, name, created_at, updated_at) VALUES ('${AGENT_ID}', '${SPACE_ID}', 'Task Manager', ${now}, ${now})`
	);
	return d;
}

beforeEach(() => {
	db = freshDb();
	repo = new SpaceAgentInboxRepository(db);
});

describe('SpaceAgentInboxRepository', () => {
	test('enqueue inserts a pending row and dedupes by idempotency key', () => {
		const first = repo.enqueue({
			spaceId: SPACE_ID,
			targetAgentId: AGENT_ID,
			sourceActorId: 'session:sender-1',
			sourceSessionId: 'sender-1',
			message: 'first message',
			messageRecordJson: '{"messageId":"msg-1"}',
			idempotencyKey: 'msg-1',
		});
		const second = repo.enqueue({
			spaceId: SPACE_ID,
			targetAgentId: AGENT_ID,
			sourceActorId: 'session:sender-1',
			message: 'duplicate message',
			idempotencyKey: 'msg-1',
		});

		expect(first.deduped).toBe(false);
		expect(second.deduped).toBe(true);
		expect(second.record.id).toBe(first.record.id);
		expect(second.record.message).toBe('first message');
		expect(first.record.status).toBe('pending');
		expect(first.record.sourceSessionId).toBe('sender-1');
		expect(first.record.messageRecordJson).toBe('{"messageId":"msg-1"}');
	});

	test('markDelivered records delivered status and session id', () => {
		const { record } = repo.enqueue({
			spaceId: SPACE_ID,
			targetAgentId: AGENT_ID,
			sourceActorId: 'session:sender-1',
			message: 'hello',
		});

		repo.markDelivered(record.id, 'space:agent:space-1:agent-1');

		const delivered = repo.getById(record.id);
		expect(delivered?.status).toBe('delivered');
		expect(delivered?.deliveredSessionId).toBe('space:agent:space-1:agent-1');
		expect(delivered?.deliveredAt).toBeNumber();
		expect(delivered?.lastError).toBeNull();
	});

	test('markAttemptFailed increments attempts and fails at max attempts', () => {
		const { record } = repo.enqueue({
			spaceId: SPACE_ID,
			targetAgentId: AGENT_ID,
			sourceActorId: 'worker:run:node:coder',
			message: 'wake up',
			maxAttempts: 2,
		});

		const first = repo.markAttemptFailed(record.id, 'first failure');
		expect(first?.attempts).toBe(1);
		expect(first?.status).toBe('pending');
		expect(first?.lastError).toBe('first failure');

		const second = repo.markAttemptFailed(record.id, 'second failure');
		expect(second?.attempts).toBe(2);
		expect(second?.status).toBe('failed');
		expect(second?.lastError).toBe('second failure');
	});

	test('expireStale marks expired pending rows and leaves fresh rows pending', () => {
		const now = Date.now();
		const stale = repo.enqueue({
			spaceId: SPACE_ID,
			targetAgentId: AGENT_ID,
			sourceActorId: 'session:sender-1',
			message: 'old',
			expiresAt: now - 1,
		});
		const fresh = repo.enqueue({
			spaceId: SPACE_ID,
			targetAgentId: AGENT_ID,
			sourceActorId: 'session:sender-1',
			message: 'new',
			expiresAt: now + 60_000,
		});

		expect(repo.expireStale(SPACE_ID)).toBe(1);
		expect(repo.getById(stale.record.id)?.status).toBe('expired');
		expect(repo.getById(fresh.record.id)?.status).toBe('pending');
	});
});
