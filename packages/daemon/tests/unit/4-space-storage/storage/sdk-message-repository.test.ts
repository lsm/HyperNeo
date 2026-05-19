/**
 * SDK Message Repository Tests
 *
 * Tests for SDK message CRUD operations, pagination, and query mode tracking.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	SDKMessageRepository,
	type SendStatus,
} from '../../../../src/storage/repositories/sdk-message-repository';
import type { SDKMessage } from '@neokai/shared/sdk';

describe('SDKMessageRepository', () => {
	let db: Database;
	let repository: SDKMessageRepository;

	// Helper to create a user message
	function createUserMessage(content: string, uuid: string = crypto.randomUUID()): SDKMessage {
		return {
			type: 'user',
			uuid,
			message: {
				role: 'user',
				content: [{ type: 'text', text: content }],
			},
		} as SDKMessage;
	}

	// Helper to create an assistant message
	function createAssistantMessage(content: string, toolUseId?: string): SDKMessage {
		const blocks: Array<{ type: string; text?: string; id?: string }> = [
			{ type: 'text', text: content },
		];
		if (toolUseId) {
			blocks.push({ type: 'tool_use', id: toolUseId });
		}
		return {
			type: 'assistant',
			message: {
				role: 'assistant',
				content: blocks,
			},
		} as SDKMessage;
	}

	// Helper to create a subagent message
	function createSubagentMessage(content: string, parentToolUseId: string): SDKMessage {
		return {
			type: 'assistant',
			parent_tool_use_id: parentToolUseId,
			message: {
				role: 'assistant',
				content: [{ type: 'text', text: content }],
			},
		} as SDKMessage;
	}

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(`
			CREATE TABLE sdk_messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				message_type TEXT NOT NULL,
				message_subtype TEXT,
				sdk_message TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				send_status TEXT,
				origin TEXT DEFAULT NULL CHECK(origin IS NULL OR origin IN ('human', 'system')),
				is_renderable INTEGER NOT NULL DEFAULT 1,
				is_terminal INTEGER NOT NULL DEFAULT 0,
				parent_tool_use_id TEXT,
				task_id TEXT
			);
			CREATE INDEX idx_sdk_messages_session ON sdk_messages(session_id);
			CREATE INDEX idx_sdk_messages_timestamp ON sdk_messages(timestamp);
			CREATE INDEX idx_sdk_messages_task_id ON sdk_messages(task_id);
		`);
		repository = new SDKMessageRepository(db as any);
	});

	afterEach(() => {
		db.close();
	});

	function createSearchIndex(): void {
		db.exec(`
			CREATE VIRTUAL TABLE message_search_fts USING fts5(
				kind UNINDEXED,
				source_id UNINDEXED,
				message_id UNINDEXED,
				session_id UNINDEXED,
				task_id UNINDEXED,
				space_id UNINDEXED,
				task_number UNINDEXED,
				message_type UNINDEXED,
				title,
				body,
				timestamp UNINDEXED,
				tokenize = 'unicode61'
			)
		`);
	}

	function createSearchPolicyTables(): void {
		db.exec(`
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				status TEXT NOT NULL,
				type TEXT,
				last_active_at TEXT NOT NULL,
				session_context TEXT
			);
			CREATE TABLE space_tasks (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				task_number INTEGER NOT NULL,
				status TEXT NOT NULL,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL
			);
		`);
	}

	function insertSession(
		id: string,
		params: { status?: string; type?: string | null; context?: unknown; lastActiveAt?: string } = {}
	): void {
		db.prepare(
			`INSERT INTO sessions (id, title, status, type, last_active_at, session_context)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).run(
			id,
			id,
			params.status ?? 'active',
			params.type ?? 'worker',
			params.lastActiveAt ?? new Date().toISOString(),
			params.context ? JSON.stringify(params.context) : null
		);
	}

	describe('saveSDKMessage', () => {
		it('should save a user message and return true', () => {
			const message = createUserMessage('Hello world');

			const result = repository.saveSDKMessage('session-1', message);

			expect(result).toBe(true);
		});

		it('should save an assistant message and return true', () => {
			const message = createAssistantMessage('Hello back');

			const result = repository.saveSDKMessage('session-1', message);

			expect(result).toBe(true);
		});

		it('should save message with subtype if present', () => {
			const message = {
				type: 'result',
				subtype: 'success',
				data: 'some data',
			} as SDKMessage;

			const result = repository.saveSDKMessage('session-1', message);

			expect(result).toBe(true);
		});

		it('should save messages for different sessions independently', () => {
			const msg1 = createUserMessage('Session 1 message');
			const msg2 = createUserMessage('Session 2 message');

			repository.saveSDKMessage('session-1', msg1);
			repository.saveSDKMessage('session-2', msg2);

			const { messages: session1Messages } = repository.getSDKMessages('session-1');
			const { messages: session2Messages } = repository.getSDKMessages('session-2');

			expect(session1Messages.length).toBe(1);
			expect(session2Messages.length).toBe(1);
		});
	});

	describe('getSDKMessages', () => {
		it('should return messages in chronological order', async () => {
			repository.saveSDKMessage('session-1', createUserMessage('First'));
			await new Promise((r) => setTimeout(r, 5));
			repository.saveSDKMessage('session-1', createUserMessage('Second'));
			await new Promise((r) => setTimeout(r, 5));
			repository.saveSDKMessage('session-1', createUserMessage('Third'));

			const { messages } = repository.getSDKMessages('session-1');

			expect(messages.length).toBe(3);
			// Messages should be in chronological order (oldest first)
			const content0 = (
				messages[0] as { message?: { content?: Array<{ type: string; text?: string }> } }
			).message?.content;
			const content1 = (
				messages[1] as { message?: { content?: Array<{ type: string; text?: string }> } }
			).message?.content;
			const content2 = (
				messages[2] as { message?: { content?: Array<{ type: string; text?: string }> } }
			).message?.content;
			expect(content0?.[0]?.text).toBe('First');
			expect(content1?.[0]?.text).toBe('Second');
			expect(content2?.[0]?.text).toBe('Third');
		});

		it('should return empty array for non-existent session', () => {
			const { messages } = repository.getSDKMessages('non-existent');

			expect(messages).toEqual([]);
		});

		it('should respect the limit parameter', () => {
			for (let i = 0; i < 150; i++) {
				repository.saveSDKMessage('session-1', createUserMessage(`Message ${i}`));
			}

			const { messages } = repository.getSDKMessages('session-1', 50);

			expect(messages.length).toBe(50);
		});

		it('should return messages before a timestamp (cursor pagination)', async () => {
			repository.saveSDKMessage('session-1', createUserMessage('First'));
			await new Promise((r) => setTimeout(r, 10));
			const middleTime = Date.now();
			await new Promise((r) => setTimeout(r, 10));
			repository.saveSDKMessage('session-1', createUserMessage('Second'));
			await new Promise((r) => setTimeout(r, 10));
			repository.saveSDKMessage('session-1', createUserMessage('Third'));

			const { messages } = repository.getSDKMessages('session-1', 100, middleTime);

			// Should only get messages before middleTime
			expect(messages.length).toBe(1);
			const content = (
				messages[0] as { message?: { content?: Array<{ type: string; text?: string }> } }
			).message?.content;
			expect(content?.[0]?.text).toBe('First');
		});

		it('should return messages after a timestamp', async () => {
			repository.saveSDKMessage('session-1', createUserMessage('First'));
			await new Promise((r) => setTimeout(r, 10));
			const middleTime = Date.now();
			await new Promise((r) => setTimeout(r, 10));
			repository.saveSDKMessage('session-1', createUserMessage('Second'));
			await new Promise((r) => setTimeout(r, 10));
			repository.saveSDKMessage('session-1', createUserMessage('Third'));

			const { messages } = repository.getSDKMessages('session-1', 100, undefined, middleTime);

			// Should only get messages after middleTime
			expect(messages.length).toBe(2);
		});

		it('should include subagent messages for matching tool use IDs', () => {
			const toolUseId = 'tool-use-123';
			repository.saveSDKMessage('session-1', createAssistantMessage('Task started', toolUseId));
			repository.saveSDKMessage('session-1', createSubagentMessage('Subagent work', toolUseId));
			repository.saveSDKMessage('session-1', createSubagentMessage('Another subagent', toolUseId));

			const { messages } = repository.getSDKMessages('session-1');

			// Should include both top-level and subagent messages
			expect(messages.length).toBe(3);
			expect(messages.every((message) => (message as { id?: string }).id)).toBe(true);
		});

		it('should exclude subagent messages without matching parent', () => {
			repository.saveSDKMessage('session-1', createAssistantMessage('No tool use'));
			repository.saveSDKMessage(
				'session-1',
				createSubagentMessage('Orphan subagent', 'non-existent-tool')
			);

			const { messages } = repository.getSDKMessages('session-1');

			// Only top-level message should be returned
			expect(messages.length).toBe(1);
		});

		it('should inject id and timestamp into returned messages', () => {
			repository.saveSDKMessage('session-1', createUserMessage('Test'));

			const { messages } = repository.getSDKMessages('session-1');

			expect(messages.length).toBe(1);
			expect((messages[0] as { id?: string }).id).toBeDefined();
			expect((messages[0] as { timestamp?: number }).timestamp).toBeDefined();
			expect(typeof (messages[0] as { timestamp?: number }).timestamp).toBe('number');
		});

		it('should return hasMore=true when there are more messages', () => {
			// Create more than limit messages
			for (let i = 0; i < 110; i++) {
				repository.saveSDKMessage('session-1', createUserMessage(`Message ${i}`));
			}

			const { messages, hasMore } = repository.getSDKMessages('session-1', 100);

			expect(messages.length).toBe(100);
			expect(hasMore).toBe(true);
		});

		it('should return hasMore=false when there are no more messages', () => {
			// Create fewer messages than limit
			for (let i = 0; i < 50; i++) {
				repository.saveSDKMessage('session-1', createUserMessage(`Message ${i}`));
			}

			const { messages, hasMore } = repository.getSDKMessages('session-1', 100);

			expect(messages.length).toBe(50);
			expect(hasMore).toBe(false);
		});

		it('should return hasMore=true when exactly limit messages exist', () => {
			// Create exactly limit messages
			for (let i = 0; i < 100; i++) {
				repository.saveSDKMessage('session-1', createUserMessage(`Message ${i}`));
			}

			const { messages, hasMore } = repository.getSDKMessages('session-1', 100);

			expect(messages.length).toBe(100);
			expect(hasMore).toBe(true); // Can't know for sure, so assume there might be more
		});

		it('should exclude unconsumed user messages from transcript query', () => {
			repository.saveUserMessage('session-1', createUserMessage('Saved user message'), 'deferred');
			repository.saveUserMessage('session-1', createUserMessage('Queued user message'), 'enqueued');
			repository.saveUserMessage('session-1', createUserMessage('Sent user message'), 'consumed');
			repository.saveSDKMessage('session-1', createAssistantMessage('Assistant response'));

			const { messages } = repository.getSDKMessages('session-1');
			expect(messages.length).toBe(2);

			const userContent = (
				messages.find((m) => m.type === 'user') as {
					message?: { content?: Array<{ type: string; text?: string }> };
				}
			).message?.content?.[0]?.text;
			expect(userContent).toBe('Sent user message');
		});
	});

	describe('getSDKMessagesByType', () => {
		it('should return only messages of specified type', () => {
			repository.saveSDKMessage('session-1', createUserMessage('User msg'));
			repository.saveSDKMessage('session-1', createAssistantMessage('Assistant msg'));

			const userMessages = repository.getSDKMessagesByType('session-1', 'user');

			expect(userMessages.length).toBe(1);
		});

		it('should filter by subtype when provided', () => {
			const successMessage = {
				type: 'result',
				subtype: 'success',
				data: 'success data',
			} as SDKMessage;
			const errorMessage = {
				type: 'result',
				subtype: 'error',
				error: 'error message',
			} as SDKMessage;

			repository.saveSDKMessage('session-1', successMessage);
			repository.saveSDKMessage('session-1', errorMessage);

			const successMessages = repository.getSDKMessagesByType('session-1', 'result', 'success');
			const errorMessages = repository.getSDKMessagesByType('session-1', 'result', 'error');

			expect(successMessages.length).toBe(1);
			expect(errorMessages.length).toBe(1);
		});

		it('should respect limit parameter', () => {
			for (let i = 0; i < 150; i++) {
				repository.saveSDKMessage('session-1', createUserMessage(`Message ${i}`));
			}

			const messages = repository.getSDKMessagesByType('session-1', 'user', undefined, 50);

			expect(messages.length).toBe(50);
		});

		it('should return empty array for non-existent type', () => {
			repository.saveSDKMessage('session-1', createUserMessage('User msg'));

			const messages = repository.getSDKMessagesByType('session-1', 'nonexistent');

			expect(messages).toEqual([]);
		});
	});

	describe('getSDKMessageCount', () => {
		it('should return count of top-level messages', () => {
			repository.saveSDKMessage('session-1', createUserMessage('Msg 1'));
			repository.saveSDKMessage('session-1', createUserMessage('Msg 2'));
			repository.saveSDKMessage('session-1', createUserMessage('Msg 3'));

			const count = repository.getSDKMessageCount('session-1');

			expect(count).toBe(3);
		});

		it('should exclude subagent messages from count', () => {
			repository.saveSDKMessage('session-1', createAssistantMessage('Top level', 'tool-1'));
			repository.saveSDKMessage('session-1', createSubagentMessage('Subagent', 'tool-1'));

			const count = repository.getSDKMessageCount('session-1');

			expect(count).toBe(1);
		});

		it('should return 0 for non-existent session', () => {
			const count = repository.getSDKMessageCount('non-existent');

			expect(count).toBe(0);
		});

		it('should not count unconsumed user messages', () => {
			repository.saveUserMessage('session-1', createUserMessage('Saved'), 'deferred');
			repository.saveUserMessage('session-1', createUserMessage('Queued'), 'enqueued');
			repository.saveUserMessage('session-1', createUserMessage('Sent'), 'consumed');

			const count = repository.getSDKMessageCount('session-1');
			expect(count).toBe(1);
		});
	});

	describe('saveUserMessage', () => {
		it('should save user message with consumed status by default', () => {
			const message = createUserMessage('Test message');

			const id = repository.saveUserMessage('session-1', message);

			expect(id).toBeDefined();
			const deferredMessages = repository.getMessagesByStatus('session-1', 'consumed');
			expect(deferredMessages.length).toBe(1);
		});

		it('should save user message with specified status', () => {
			const message = createUserMessage('Test message');

			repository.saveUserMessage('session-1', message, 'deferred');

			const deferredMessages = repository.getMessagesByStatus('session-1', 'deferred');
			expect(deferredMessages.length).toBe(1);
		});

		it('should save user message with enqueued status', () => {
			const message = createUserMessage('Test message');

			repository.saveUserMessage('session-1', message, 'enqueued');

			const enqueuedMessages = repository.getMessagesByStatus('session-1', 'enqueued');
			expect(enqueuedMessages.length).toBe(1);
		});

		it('should return unique message ID', () => {
			const message1 = createUserMessage('Message 1');
			const message2 = createUserMessage('Message 2');

			const id1 = repository.saveUserMessage('session-1', message1);
			const id2 = repository.saveUserMessage('session-1', message2);

			expect(id1).not.toBe(id2);
		});
	});

	describe('getMessagesByStatus', () => {
		it('should return messages with specified status', () => {
			const msg1 = createUserMessage('Saved message');
			const msg2 = createUserMessage('Sent message');
			repository.saveUserMessage('session-1', msg1, 'deferred');
			repository.saveUserMessage('session-1', msg2, 'consumed');

			const deferredMessages = repository.getMessagesByStatus('session-1', 'deferred');
			const consumedMessages = repository.getMessagesByStatus('session-1', 'consumed');

			expect(deferredMessages.length).toBe(1);
			expect(consumedMessages.length).toBe(1);
		});

		it('should return messages in chronological order', async () => {
			repository.saveUserMessage('session-1', createUserMessage('First'), 'deferred');
			await new Promise((r) => setTimeout(r, 5));
			repository.saveUserMessage('session-1', createUserMessage('Second'), 'deferred');
			await new Promise((r) => setTimeout(r, 5));
			repository.saveUserMessage('session-1', createUserMessage('Third'), 'deferred');

			const messages = repository.getMessagesByStatus('session-1', 'deferred');

			expect(messages.length).toBe(3);
			// Chronological order means oldest first
			const text0 = (
				(messages[0] as { message?: { content?: Array<{ type: string; text?: string }> } }).message
					?.content?.[0] as { text?: string }
			)?.text;
			const text1 = (
				(messages[1] as { message?: { content?: Array<{ type: string; text?: string }> } }).message
					?.content?.[0] as { text?: string }
			)?.text;
			const text2 = (
				(messages[2] as { message?: { content?: Array<{ type: string; text?: string }> } }).message
					?.content?.[0] as { text?: string }
			)?.text;
			expect(text0).toBe('First');
			expect(text1).toBe('Second');
			expect(text2).toBe('Third');
		});

		it('should include dbId and timestamp in returned messages', () => {
			repository.saveUserMessage('session-1', createUserMessage('Test'), 'deferred');

			const messages = repository.getMessagesByStatus('session-1', 'deferred');

			expect(messages.length).toBe(1);
			expect(messages[0].dbId).toBeDefined();
			expect(messages[0].timestamp).toBeDefined();
		});

		it('should return empty array for non-matching status', () => {
			repository.saveUserMessage('session-1', createUserMessage('Test'), 'deferred');

			const enqueuedMessages = repository.getMessagesByStatus('session-1', 'enqueued');

			expect(enqueuedMessages).toEqual([]);
		});
	});

	describe('updateMessageStatus', () => {
		it('should update status for specified message IDs', () => {
			const id1 = repository.saveUserMessage('session-1', createUserMessage('Msg 1'), 'deferred');
			const id2 = repository.saveUserMessage('session-1', createUserMessage('Msg 2'), 'deferred');

			repository.updateMessageStatus([id1, id2], 'enqueued');

			const enqueuedMessages = repository.getMessagesByStatus('session-1', 'enqueued');
			expect(enqueuedMessages.length).toBe(2);
		});

		it('should not throw when given empty array', () => {
			expect(() => repository.updateMessageStatus([], 'consumed')).not.toThrow();
		});

		it('should transition from deferred to enqueued to consumed', () => {
			const id = repository.saveUserMessage('session-1', createUserMessage('Test'), 'deferred');

			repository.updateMessageStatus([id], 'enqueued');
			expect(repository.getMessagesByStatus('session-1', 'enqueued').length).toBe(1);

			repository.updateMessageStatus([id], 'consumed');
			expect(repository.getMessagesByStatus('session-1', 'consumed').length).toBe(1);
			expect(repository.getMessagesByStatus('session-1', 'enqueued').length).toBe(0);
		});
	});

	describe('getMessageCountByStatus', () => {
		it('should return count of messages with specified status', () => {
			repository.saveUserMessage('session-1', createUserMessage('Msg 1'), 'deferred');
			repository.saveUserMessage('session-1', createUserMessage('Msg 2'), 'deferred');
			repository.saveUserMessage('session-1', createUserMessage('Msg 3'), 'consumed');

			const deferredCount = repository.getMessageCountByStatus('session-1', 'deferred');
			const consumedCount = repository.getMessageCountByStatus('session-1', 'consumed');

			expect(deferredCount).toBe(2);
			expect(consumedCount).toBe(1);
		});

		it('should return 0 for non-matching status', () => {
			repository.saveUserMessage('session-1', createUserMessage('Test'), 'deferred');

			const count = repository.getMessageCountByStatus('session-1', 'enqueued');

			expect(count).toBe(0);
		});
	});

	describe('deleteMessagesAfter', () => {
		it('should delete messages after specified timestamp', async () => {
			repository.saveSDKMessage('session-1', createUserMessage('First'));
			await new Promise((r) => setTimeout(r, 10));
			const middleTime = Date.now();
			await new Promise((r) => setTimeout(r, 10));
			repository.saveSDKMessage('session-1', createUserMessage('Second'));
			repository.saveSDKMessage('session-1', createUserMessage('Third'));

			const deletedCount = repository.deleteMessagesAfter('session-1', middleTime);

			expect(deletedCount).toBe(2);
			expect(repository.getSDKMessageCount('session-1')).toBe(1);
		});

		it('should return 0 when no messages to delete', () => {
			repository.saveSDKMessage('session-1', createUserMessage('First'));
			const futureTime = Date.now() + 10000;

			const deletedCount = repository.deleteMessagesAfter('session-1', futureTime);

			expect(deletedCount).toBe(0);
		});

		it('should only delete from specified session', async () => {
			repository.saveSDKMessage('session-1', createUserMessage('Session 1'));
			await new Promise((r) => setTimeout(r, 10));
			const middleTime = Date.now();
			await new Promise((r) => setTimeout(r, 10));
			repository.saveSDKMessage('session-2', createUserMessage('Session 2'));

			repository.deleteMessagesAfter('session-1', middleTime);

			expect(repository.getSDKMessageCount('session-2')).toBe(1);
		});
	});

	describe('deleteMessagesAtAndAfter', () => {
		it('should delete messages at and after specified timestamp (inclusive)', async () => {
			repository.saveSDKMessage('session-1', createUserMessage('First'));
			await new Promise((r) => setTimeout(r, 10));
			const middleTime = Date.now();
			await new Promise((r) => setTimeout(r, 10));
			repository.saveSDKMessage('session-1', createUserMessage('Second'));

			const deletedCount = repository.deleteMessagesAtAndAfter('session-1', middleTime);

			expect(deletedCount).toBe(1);
		});

		it('should return 0 when no messages to delete', () => {
			const futureTime = Date.now() + 10000;

			const deletedCount = repository.deleteMessagesAtAndAfter('session-1', futureTime);

			expect(deletedCount).toBe(0);
		});
	});

	describe('getUserMessages', () => {
		it('should return user messages with uuid, timestamp, and content', () => {
			const uuid = 'test-uuid-123';
			repository.saveSDKMessage('session-1', createUserMessage('Test message', uuid));

			const userMessages = repository.getUserMessages('session-1');

			expect(userMessages.length).toBe(1);
			expect(userMessages[0].uuid).toBe(uuid);
			expect(userMessages[0].content).toBe('Test message');
			expect(userMessages[0].timestamp).toBeDefined();
		});

		it('should return messages in chronological order', async () => {
			repository.saveSDKMessage('session-1', createUserMessage('First'));
			await new Promise((r) => setTimeout(r, 5));
			repository.saveSDKMessage('session-1', createUserMessage('Second'));
			await new Promise((r) => setTimeout(r, 5));
			repository.saveSDKMessage('session-1', createUserMessage('Third'));

			const userMessages = repository.getUserMessages('session-1');

			expect(userMessages.length).toBe(3);
			expect(userMessages[0].content).toBe('First');
			expect(userMessages[1].content).toBe('Second');
			expect(userMessages[2].content).toBe('Third');
		});

		it('should return empty array for non-existent session', () => {
			const userMessages = repository.getUserMessages('non-existent');

			expect(userMessages).toEqual([]);
		});

		it('should only return user messages', () => {
			repository.saveSDKMessage('session-1', createUserMessage('User msg'));
			repository.saveSDKMessage('session-1', createAssistantMessage('Assistant msg'));

			const userMessages = repository.getUserMessages('session-1');

			expect(userMessages.length).toBe(1);
		});

		it('should handle string content', () => {
			const message: SDKMessage = {
				type: 'user',
				uuid: 'uuid-string-content',
				message: {
					role: 'user',
					content: 'Simple string content',
				},
			} as SDKMessage;
			repository.saveSDKMessage('session-1', message);

			const userMessages = repository.getUserMessages('session-1');

			expect(userMessages[0].content).toBe('Simple string content');
		});
	});

	describe('getUserMessageByUuid', () => {
		it('should return message by UUID', () => {
			const uuid = 'specific-uuid-456';
			repository.saveSDKMessage('session-1', createUserMessage('Target message', uuid));

			const message = repository.getUserMessageByUuid('session-1', uuid);

			expect(message).toBeDefined();
			expect(message?.uuid).toBe(uuid);
			expect(message?.content).toBe('Target message');
		});

		it('should return undefined for non-existent UUID', () => {
			const message = repository.getUserMessageByUuid('session-1', 'non-existent-uuid');

			expect(message).toBeUndefined();
		});

		it('should return undefined for wrong session', () => {
			const uuid = 'session-specific-uuid';
			repository.saveSDKMessage('session-1', createUserMessage('Session 1 message', uuid));

			const message = repository.getUserMessageByUuid('session-2', uuid);

			expect(message).toBeUndefined();
		});

		// Regression: the original implementation loaded every user row for the
		// session and scanned in JS — O(N) per lookup. The current impl uses
		// indexed seeks against (session_id, send_status, json_extract uuid)
		// for messages saved via saveUserMessage (the production path), with a
		// fallback scan for legacy NULL-send_status rows. The test schema
		// mirrors the core migrations but omits idx_sdk_messages_uuid_status;
		// correctness is still validated here.
		it('should find the right message among many user rows in the same session', () => {
			const sessionId = 'session-busy';
			for (let i = 0; i < 50; i++) {
				repository.saveSDKMessage(sessionId, createUserMessage(`Message ${i}`, `uuid-${i}`));
			}

			const message = repository.getUserMessageByUuid(sessionId, 'uuid-37');

			expect(message).toBeDefined();
			expect(message?.uuid).toBe('uuid-37');
			expect(message?.content).toBe('Message 37');
		});

		// Exercises the fast indexed-seek path: messages persisted via
		// saveUserMessage have send_status set ('consumed' by default), which
		// is what production rewind targets always look like.
		it('should find consumed user messages via the indexed path', () => {
			const sessionId = 'session-consumed';
			repository.saveUserMessage(
				sessionId,
				createUserMessage('Consumed message', 'uuid-consumed'),
				'consumed'
			);

			const message = repository.getUserMessageByUuid(sessionId, 'uuid-consumed');

			expect(message).toBeDefined();
			expect(message?.uuid).toBe('uuid-consumed');
			expect(message?.content).toBe('Consumed message');
		});

		// Exercises the fast path for the failed-send_status branch — also a
		// valid rewind target (see the `(send_status, 'consumed') IN
		// ('consumed', 'failed')` predicate used elsewhere).
		it('should find failed user messages via the indexed path', () => {
			const sessionId = 'session-failed';
			repository.saveUserMessage(
				sessionId,
				createUserMessage('Failed message', 'uuid-failed'),
				'failed'
			);

			const message = repository.getUserMessageByUuid(sessionId, 'uuid-failed');

			expect(message).toBeDefined();
			expect(message?.uuid).toBe('uuid-failed');
			expect(message?.content).toBe('Failed message');
		});

		// Coverage must match getUserMessages (which returns user rows of
		// every send_status), otherwise rewind would surface a checkpoint
		// from a manual/queued flow that it then can't resolve.
		it('should find enqueued user messages via the indexed path', () => {
			const sessionId = 'session-enqueued';
			repository.saveUserMessage(
				sessionId,
				createUserMessage('Enqueued message', 'uuid-enqueued'),
				'enqueued'
			);

			const message = repository.getUserMessageByUuid(sessionId, 'uuid-enqueued');

			expect(message).toBeDefined();
			expect(message?.uuid).toBe('uuid-enqueued');
		});

		it('should find deferred user messages via the indexed path', () => {
			const sessionId = 'session-deferred';
			repository.saveUserMessage(
				sessionId,
				createUserMessage('Deferred message', 'uuid-deferred'),
				'deferred'
			);

			const message = repository.getUserMessageByUuid(sessionId, 'uuid-deferred');

			expect(message).toBeDefined();
			expect(message?.uuid).toBe('uuid-deferred');
		});

		// If duplicate user rows share a uuid across different send_status
		// buckets within the same session (no DB-level uniqueness on the
		// json_extract'd uuid), the function must return the
		// chronologically earliest row — rewind's deletion-bound math
		// depends on the timestamp being the earliest occurrence.
		it('should return the earliest match across send_status buckets', async () => {
			const sessionId = 'session-dup';

			// 'failed' message persisted first (earliest timestamp)
			repository.saveUserMessage(
				sessionId,
				createUserMessage('Earliest failed copy', 'shared-uuid'),
				'failed'
			);

			// Force a later timestamp on the second insert
			await new Promise((r) => setTimeout(r, 5));

			repository.saveUserMessage(
				sessionId,
				createUserMessage('Later consumed copy', 'shared-uuid'),
				'consumed'
			);

			const message = repository.getUserMessageByUuid(sessionId, 'shared-uuid');

			expect(message).toBeDefined();
			expect(message?.content).toBe('Earliest failed copy');
		});
	});

	describe('origin field persistence and retrieval', () => {
		it('should save and retrieve origin=system on saveSDKMessage', () => {
			const message = createAssistantMessage('System message');

			repository.saveSDKMessage('session-1', message, 'system');

			const { messages } = repository.getSDKMessages('session-1');
			expect(messages.length).toBe(1);
			expect((messages[0] as { origin?: string }).origin).toBe('system');
		});

		it('should not inject origin field when origin is NULL (default human)', () => {
			const message = createUserMessage('Normal human message');

			repository.saveUserMessage('session-1', message, 'consumed');

			const { messages } = repository.getSDKMessages('session-1');
			expect(messages.length).toBe(1);
			expect((messages[0] as { origin?: string }).origin).toBeUndefined();
		});

		it('should persist origin independently for each message', async () => {
			repository.saveUserMessage('session-1', createUserMessage('Human msg'), 'consumed');
			await new Promise((r) => setTimeout(r, 5));
			repository.saveSDKMessage('session-1', createAssistantMessage('System msg'), 'system');

			const { messages } = repository.getSDKMessages('session-1');
			expect(messages.length).toBe(2);

			// Human message — no origin field
			expect((messages[0] as { origin?: string }).origin).toBeUndefined();
			// System message — origin='system'
			expect((messages[1] as { origin?: string }).origin).toBe('system');
		});

		it('should reject invalid origin values at the DB constraint level', () => {
			expect(() => {
				db.prepare(
					`INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, origin)
					 VALUES (?, ?, ?, ?, ?, ?)`
				).run('bad-origin-id', 'session-1', 'user', '{}', new Date().toISOString(), 'invalid');
			}).toThrow();
		});
	});

	describe('countMessagesAfter', () => {
		it('should count messages after timestamp', async () => {
			repository.saveSDKMessage('session-1', createUserMessage('First'));
			await new Promise((r) => setTimeout(r, 10));
			const middleTime = Date.now();
			await new Promise((r) => setTimeout(r, 10));
			repository.saveSDKMessage('session-1', createUserMessage('Second'));
			repository.saveSDKMessage('session-1', createUserMessage('Third'));

			const count = repository.countMessagesAfter('session-1', middleTime);

			expect(count).toBe(2);
		});

		it('should return 0 when no messages after timestamp', () => {
			repository.saveSDKMessage('session-1', createUserMessage('Only message'));
			const futureTime = Date.now() + 10000;

			const count = repository.countMessagesAfter('session-1', futureTime);

			expect(count).toBe(0);
		});

		it('should only count messages from specified session', async () => {
			repository.saveSDKMessage('session-1', createUserMessage('Session 1'));
			await new Promise((r) => setTimeout(r, 10));
			const middleTime = Date.now();
			await new Promise((r) => setTimeout(r, 10));
			repository.saveSDKMessage('session-2', createUserMessage('Session 2'));

			const count = repository.countMessagesAfter('session-1', middleTime);

			expect(count).toBe(0);
		});
	});

	describe('searchMessages', () => {
		it('returns scoped matches with snippets', () => {
			createSearchIndex();
			repository.saveSDKMessage('session-1', createUserMessage('alpha regression bug'));
			repository.saveSDKMessage('session-2', createUserMessage('alpha unrelated'));

			const result = repository.searchMessages({ query: 'alpha', sessionId: 'session-1' });

			expect(result.results.length).toBe(1);
			expect(result.results[0].sessionId).toBe('session-1');
			expect(result.results[0].snippet).toContain('<mark>alpha</mark>');
		});

		it('ignores search terms shorter than three characters', () => {
			createSearchIndex();
			repository.saveSDKMessage('session-1', createUserMessage('ui marker'));

			const result = repository.searchMessages({ query: 'ui' });

			expect(result.results).toEqual([]);
		});

		it('returns cross-session matches when no session filter is provided', () => {
			createSearchIndex();
			repository.saveSDKMessage('session-1', createUserMessage('global comet marker'));
			repository.saveSDKMessage('session-2', createUserMessage('global comet marker'));

			const result = repository.searchMessages({ query: 'comet' });

			expect(result.results.map((row) => row.sessionId).sort()).toEqual(['session-1', 'session-2']);
		});

		it('filters by message type and date range', async () => {
			createSearchIndex();
			const oldId = repository.saveUserMessage(
				'session-1',
				createUserMessage('filter beacon old'),
				'consumed'
			);
			repository.updateMessageTimestamp(oldId, Date.now() - 10_000);
			const from = Date.now() - 1_000;
			repository.saveSDKMessage('session-1', createAssistantMessage('filter beacon current'));
			repository.saveSDKMessage('session-1', createUserMessage('filter beacon user'));

			const result = repository.searchMessages({
				query: 'beacon',
				messageType: 'assistant',
				from,
				to: Date.now() + 1_000,
			});

			expect(result.results).toHaveLength(1);
			expect(result.results[0].messageType).toBe('assistant');
			expect(result.results[0].snippet).toContain('<mark>beacon</mark>');
			expect(result.results[0].loadTarget).toMatchObject({ sessionId: 'session-1' });
			expect(result.results[0].loadTarget?.before).toBeGreaterThan(result.results[0].timestamp);
		});

		it('indexes only searchable message types', () => {
			createSearchIndex();
			repository.saveSDKMessage('session-1', createAssistantMessage('type marker assistant'));
			repository.saveSDKMessage('session-1', {
				type: 'result',
				result: 'type marker result',
			} as SDKMessage);

			const result = repository.searchMessages({ query: 'type marker' });

			expect(result.results.map((row) => row.messageType)).toEqual(['assistant']);
		});

		it('indexes only normal and Space sessions', () => {
			createSearchIndex();
			createSearchPolicyTables();
			insertSession('session-1');
			insertSession('space:space-1:task:task-1:exec:exec-1', {
				context: { spaceId: 'space-1', taskId: 'task-1' },
			});
			insertSession('coder:room-1:task-1:exec-1', { type: 'coder' });
			insertSession('archived-session', { status: 'archived' });
			db.prepare(
				`INSERT INTO space_tasks (id, space_id, task_number, status, completed_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
			).run('task-1', 'space-1', 1, 'in_progress', null, Date.now());

			repository.saveSDKMessage('session-1', createUserMessage('policy marker normal'));
			repository.saveSDKMessage(
				'space:space-1:task:task-1:exec:exec-1',
				createUserMessage('policy marker space')
			);
			repository.saveSDKMessage(
				'coder:room-1:task-1:exec-1',
				createUserMessage('policy marker room')
			);
			repository.saveSDKMessage('archived-session', createUserMessage('policy marker archived'));

			const result = repository.searchMessages({ query: 'policy marker' });

			expect(result.results.map((row) => row.sessionId).sort()).toEqual([
				'session-1',
				'space:space-1:task:task-1:exec:exec-1',
			]);
		});

		it('keeps terminal Space task session messages only within the retention window', () => {
			createSearchIndex();
			createSearchPolicyTables();
			const recent = Date.now() - 2 * 24 * 60 * 60 * 1000;
			const old = Date.now() - 45 * 24 * 60 * 60 * 1000;
			insertSession('space:space-1:task:recent:exec:exec-1', {
				context: { spaceId: 'space-1', taskId: 'recent' },
			});
			insertSession('space:space-1:task:old:exec:exec-1', {
				context: { spaceId: 'space-1', taskId: 'old' },
			});
			db.prepare(
				`INSERT INTO space_tasks (id, space_id, task_number, status, completed_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
			).run('recent', 'space-1', 1, 'done', recent, recent);
			db.prepare(
				`INSERT INTO space_tasks (id, space_id, task_number, status, completed_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
			).run('old', 'space-1', 2, 'cancelled', old, old);

			repository.saveSDKMessage(
				'space:space-1:task:recent:exec:exec-1',
				createUserMessage('retention marker recent')
			);
			repository.saveSDKMessage(
				'space:space-1:task:old:exec:exec-1',
				createUserMessage('retention marker old')
			);

			const result = repository.searchMessages({ query: 'retention marker' });

			expect(result.results.map((row) => row.sessionId)).toEqual([
				'space:space-1:task:recent:exec:exec-1',
			]);
		});

		it('returns task search rows from indexed titles and descriptions', () => {
			createSearchIndex();
			db.prepare(
				`INSERT INTO message_search_fts (
					kind, source_id, task_id, space_id, task_number, title, body, timestamp
				) VALUES ('task', ?, ?, ?, ?, ?, ?, ?)`
			).run('task-1', 'task-1', 'space-1', 12, 'Orion title', 'Task description', Date.now());

			const titleResult = repository.searchMessages({ query: 'orion' });
			const bodyResult = repository.searchMessages({ query: 'description' });

			expect(titleResult.results).toHaveLength(1);
			expect(bodyResult.results).toHaveLength(1);
			expect(titleResult.results[0]).toMatchObject({
				kind: 'task',
				taskId: 'task-1',
				spaceId: 'space-1',
				taskNumber: 12,
				title: 'Orion title',
			});
		});

		it('removes deleted messages from search index', () => {
			createSearchIndex();
			const before = Date.now() - 1000;
			repository.saveSDKMessage('session-1', createUserMessage('temporary rollback marker'));

			expect(repository.searchMessages({ query: 'rollback' }).results.length).toBe(1);
			repository.deleteMessagesAfter('session-1', before);

			expect(repository.searchMessages({ query: 'rollback' }).results.length).toBe(0);
		});
	});
});
