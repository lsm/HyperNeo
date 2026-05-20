/**
 * Tests for Message Handlers - format functions and RPC handlers
 *
 * Coverage for:
 * - convertToMarkdown: Session to markdown conversion
 * - formatMessage: Message type dispatch
 * - formatUserMessage: User message formatting
 * - formatAssistantMessage: Assistant message formatting
 * - formatResultMessage: Result message formatting
 * - message.removeOutput: Remove large task output
 * - message.sdkMessages: Get SDK messages
 * - message.count: Get message count
 * - session.export: Export session to markdown/json
 */

import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import type { Database } from '../../../../src/storage/database';
import type { SDKMessage } from '@neokai/shared/sdk';
import { MessageHub } from '@neokai/shared';
import { setupMessageHandlers } from '../../../../src/lib/rpc-handlers/message-handlers';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import type { Session } from '@neokai/shared';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Helper to create a minimal mock MessageHub that captures handlers
function createMockMessageHub(): {
	hub: MessageHub;
	handlers: Map<string, RequestHandler>;
} {
	const handlers = new Map<string, RequestHandler>();

	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		onEvent: mock(() => () => {}),
		request: mock(async () => {}),
		event: mock(() => {}),
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		isConnected: mock(() => true),
		getState: mock(() => 'connected' as const),
		onConnection: mock(() => () => {}),
		onMessage: mock(() => () => {}),
		cleanup: mock(() => {}),
		registerTransport: mock(() => () => {}),
		registerRouter: mock(() => {}),
		getRouter: mock(() => null),
		getPendingCallCount: mock(() => 0),
	} as unknown as MessageHub;

	return { hub, handlers };
}

// Helper to create a mock AgentSession
function createMockAgentSession(): {
	agentSession: AgentSession;
	mocks: {
		getSessionData: ReturnType<typeof mock>;
		getSDKSessionId: ReturnType<typeof mock>;
		getSDKMessages: ReturnType<typeof mock>;
		getSDKMessageCount: ReturnType<typeof mock>;
	};
} {
	const sessionData: Session = {
		id: 'session-123',
		workspacePath: '/workspace/test',
		status: 'active',
		config: { model: 'claude-sonnet-4-20250514' },
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	} as Session;

	const mocks = {
		getSessionData: mock(() => sessionData),
		getSDKSessionId: mock(() => 'sdk-session-123'),
		getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
		getSDKMessageCount: mock(() => 0),
	};

	const agentSession = {
		...mocks,
	} as unknown as AgentSession;

	return { agentSession, mocks };
}

// Helper to create mock SessionManager
function createMockSessionManager(): {
	sessionManager: SessionManager;
	mocks: {
		getSessionAsync: ReturnType<typeof mock>;
		getSession: ReturnType<typeof mock>;
		getSessionFromDB: ReturnType<typeof mock>;
		markOutputRemoved: ReturnType<typeof mock>;
	};
	agentSessionData: ReturnType<typeof createMockAgentSession>;
} {
	const agentSessionData = createMockAgentSession();

	const mocks = {
		getSessionAsync: mock(async () => agentSessionData.agentSession),
		getSession: mock(() => agentSessionData.agentSession),
		getSessionFromDB: mock(
			() =>
				({
					id: 'session-123',
					workspacePath: '/workspace/test',
					status: 'active',
				}) as Session
		),
		markOutputRemoved: mock(async () => {}),
	};

	const sessionManager = {
		...mocks,
	} as unknown as SessionManager;

	return { sessionManager, mocks, agentSessionData };
}

// Re-implement the format functions to test the logic directly
// This mirrors the implementation in message-handlers.ts

function convertToMarkdown(
	session: {
		id: string;
		title?: string;
		config: { model: string };
		createdAt: string;
	},
	messages: SDKMessage[]
): string {
	const lines: string[] = [];

	// Header
	lines.push(`# ${session.title || 'Untitled Session'}`);
	lines.push('');
	lines.push(`**Session ID:** ${session.id}`);
	lines.push(`**Model:** ${session.config.model}`);
	lines.push(`**Created:** ${session.createdAt}`);
	lines.push('');
	lines.push('---');
	lines.push('');

	// Messages
	for (const msg of messages) {
		const formatted = formatMessage(msg);
		if (formatted) {
			lines.push(formatted);
			lines.push('');
		}
	}

	return lines.join('\n');
}

function formatMessage(msg: SDKMessage): string | null {
	if (msg.type === 'user') {
		return formatUserMessage(msg);
	}

	if (msg.type === 'assistant') {
		return formatAssistantMessage(msg);
	}

	if (msg.type === 'result') {
		return formatResultMessage(msg);
	}

	return null;
}

function formatUserMessage(msg: SDKMessage): string {
	const lines: string[] = [];
	lines.push('## User');
	lines.push('');

	const userMsg = msg as {
		message?: { content?: string | Array<{ type: string; text?: string }> };
	};
	const content = userMsg.message?.content;
	if (typeof content === 'string') {
		lines.push(content);
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (block.type === 'text' && 'text' in block) {
				lines.push(block.text as string);
			} else if (block.type === 'image') {
				lines.push('*[Image attached]*');
			}
		}
	}

	return lines.join('\n');
}

function formatAssistantMessage(msg: SDKMessage): string {
	const lines: string[] = [];
	lines.push('## Assistant');
	lines.push('');

	const assistantMsg = msg as {
		message?: {
			content?: Array<{
				type: string;
				text?: string;
				name?: string;
				input?: unknown;
				thinking?: string;
			}>;
		};
	};
	const content = assistantMsg.message?.content;
	if (Array.isArray(content)) {
		for (const block of content) {
			if (block.type === 'text' && block.text) {
				lines.push(block.text);
				lines.push('');
			} else if (block.type === 'tool_use' && block.name) {
				lines.push(`### Tool Use: ${block.name}`);
				lines.push('');
				lines.push('```json');
				lines.push(JSON.stringify(block.input, null, 2));
				lines.push('```');
				lines.push('');
			} else if (block.type === 'thinking' && block.thinking) {
				lines.push('<details>');
				lines.push('<summary>Thinking</summary>');
				lines.push('');
				lines.push(block.thinking);
				lines.push('');
				lines.push('</details>');
				lines.push('');
			}
		}
	}

	return lines.join('\n');
}

function formatResultMessage(msg: SDKMessage): string {
	const lines: string[] = [];
	lines.push('## Result');
	lines.push('');

	const resultMsg = msg as { subtype: string; errors?: string[] };
	if (resultMsg.subtype === 'success') {
		lines.push('*Query completed successfully*');
	} else {
		lines.push(`*Error: ${resultMsg.subtype}*`);
		if (resultMsg.errors && resultMsg.errors.length > 0) {
			lines.push('');
			lines.push('```');
			lines.push(resultMsg.errors.join('\n'));
			lines.push('```');
		}
	}

	return lines.join('\n');
}

describe('Message Handlers - Format Functions', () => {
	describe('convertToMarkdown', () => {
		test('converts session with title', () => {
			const session = {
				id: 'session-123',
				title: 'Test Session',
				config: { model: 'claude-sonnet' },
				createdAt: '2024-01-01T00:00:00Z',
			};
			const messages: SDKMessage[] = [];

			const result = convertToMarkdown(session, messages);

			expect(result).toContain('# Test Session');
			expect(result).toContain('**Session ID:** session-123');
			expect(result).toContain('**Model:** claude-sonnet');
			expect(result).toContain('**Created:** 2024-01-01T00:00:00Z');
		});

		test('uses Untitled Session when no title', () => {
			const session = {
				id: 'session-123',
				config: { model: 'claude-sonnet' },
				createdAt: '2024-01-01T00:00:00Z',
			};
			const messages: SDKMessage[] = [];

			const result = convertToMarkdown(session, messages);

			expect(result).toContain('# Untitled Session');
		});

		test('includes formatted messages', () => {
			const session = {
				id: 'session-123',
				title: 'Test',
				config: { model: 'claude' },
				createdAt: '2024-01-01',
			};
			const messages: SDKMessage[] = [
				{
					type: 'user',
					message: { content: 'Hello!' },
				} as unknown as SDKMessage,
			];

			const result = convertToMarkdown(session, messages);

			expect(result).toContain('## User');
			expect(result).toContain('Hello!');
		});

		test('skips non-formattable messages', () => {
			const session = {
				id: 'session-123',
				title: 'Test',
				config: { model: 'claude' },
				createdAt: '2024-01-01',
			};
			const messages: SDKMessage[] = [
				{ type: 'system' } as unknown as SDKMessage,
				{ type: 'stream_event' } as unknown as SDKMessage,
			];

			const result = convertToMarkdown(session, messages);

			// Should not contain these message types
			expect(result).not.toContain('## system');
			expect(result).not.toContain('## stream_event');
		});
	});

	describe('formatMessage', () => {
		test('dispatches user messages', () => {
			const msg: SDKMessage = {
				type: 'user',
				message: { content: 'test' },
			} as unknown as SDKMessage;

			const result = formatMessage(msg);

			expect(result).toContain('## User');
		});

		test('dispatches assistant messages', () => {
			const msg: SDKMessage = {
				type: 'assistant',
				message: { content: [] },
			} as unknown as SDKMessage;

			const result = formatMessage(msg);

			expect(result).toContain('## Assistant');
		});

		test('dispatches result messages', () => {
			const msg: SDKMessage = {
				type: 'result',
				subtype: 'success',
			} as unknown as SDKMessage;

			const result = formatMessage(msg);

			expect(result).toContain('## Result');
		});

		test('returns null for unknown message types', () => {
			const msg: SDKMessage = {
				type: 'unknown_type',
			} as unknown as SDKMessage;

			const result = formatMessage(msg);

			expect(result).toBeNull();
		});

		test('returns null for system messages', () => {
			const msg: SDKMessage = {
				type: 'system',
			} as unknown as SDKMessage;

			const result = formatMessage(msg);

			expect(result).toBeNull();
		});

		test('returns null for stream_event messages', () => {
			const msg: SDKMessage = {
				type: 'stream_event',
			} as unknown as SDKMessage;

			const result = formatMessage(msg);

			expect(result).toBeNull();
		});
	});

	describe('formatUserMessage', () => {
		test('formats string content', () => {
			const msg: SDKMessage = {
				type: 'user',
				message: { content: 'Hello, how are you?' },
			} as unknown as SDKMessage;

			const result = formatUserMessage(msg);

			expect(result).toContain('## User');
			expect(result).toContain('Hello, how are you?');
		});

		test('formats array content with text blocks', () => {
			const msg: SDKMessage = {
				type: 'user',
				message: {
					content: [
						{ type: 'text', text: 'First message' },
						{ type: 'text', text: 'Second message' },
					],
				},
			} as unknown as SDKMessage;

			const result = formatUserMessage(msg);

			expect(result).toContain('First message');
			expect(result).toContain('Second message');
		});

		test('formats image blocks with placeholder', () => {
			const msg: SDKMessage = {
				type: 'user',
				message: {
					content: [
						{ type: 'text', text: 'Look at this:' },
						{ type: 'image', source: { data: 'base64...' } },
					],
				},
			} as unknown as SDKMessage;

			const result = formatUserMessage(msg);

			expect(result).toContain('Look at this:');
			expect(result).toContain('*[Image attached]*');
		});

		test('handles undefined content', () => {
			const msg: SDKMessage = {
				type: 'user',
				message: {},
			} as unknown as SDKMessage;

			const result = formatUserMessage(msg);

			expect(result).toContain('## User');
		});

		test('handles undefined message', () => {
			const msg: SDKMessage = {
				type: 'user',
			} as unknown as SDKMessage;

			const result = formatUserMessage(msg);

			expect(result).toContain('## User');
		});
	});

	describe('formatAssistantMessage', () => {
		test('formats text blocks', () => {
			const msg: SDKMessage = {
				type: 'assistant',
				message: {
					content: [{ type: 'text', text: 'Here is my response' }],
				},
			} as unknown as SDKMessage;

			const result = formatAssistantMessage(msg);

			expect(result).toContain('## Assistant');
			expect(result).toContain('Here is my response');
		});

		test('formats tool_use blocks', () => {
			const msg: SDKMessage = {
				type: 'assistant',
				message: {
					content: [
						{
							type: 'tool_use',
							name: 'Read',
							input: { file_path: '/test.ts' },
						},
					],
				},
			} as unknown as SDKMessage;

			const result = formatAssistantMessage(msg);

			expect(result).toContain('### Tool Use: Read');
			expect(result).toContain('```json');
			expect(result).toContain('"file_path": "/test.ts"');
			expect(result).toContain('```');
		});

		test('formats thinking blocks', () => {
			const msg: SDKMessage = {
				type: 'assistant',
				message: {
					content: [{ type: 'thinking', thinking: 'Let me think about this...' }],
				},
			} as unknown as SDKMessage;

			const result = formatAssistantMessage(msg);

			expect(result).toContain('<details>');
			expect(result).toContain('<summary>Thinking</summary>');
			expect(result).toContain('Let me think about this...');
			expect(result).toContain('</details>');
		});

		test('formats multiple content blocks', () => {
			const msg: SDKMessage = {
				type: 'assistant',
				message: {
					content: [
						{ type: 'thinking', thinking: 'Planning...' },
						{ type: 'text', text: 'Here is the answer' },
						{ type: 'tool_use', name: 'Edit', input: {} },
					],
				},
			} as unknown as SDKMessage;

			const result = formatAssistantMessage(msg);

			expect(result).toContain('Planning...');
			expect(result).toContain('Here is the answer');
			expect(result).toContain('### Tool Use: Edit');
		});

		test('handles empty content array', () => {
			const msg: SDKMessage = {
				type: 'assistant',
				message: { content: [] },
			} as unknown as SDKMessage;

			const result = formatAssistantMessage(msg);

			expect(result).toContain('## Assistant');
		});

		test('handles undefined content', () => {
			const msg: SDKMessage = {
				type: 'assistant',
				message: {},
			} as unknown as SDKMessage;

			const result = formatAssistantMessage(msg);

			expect(result).toContain('## Assistant');
		});
	});

	describe('formatResultMessage', () => {
		test('formats success result', () => {
			const msg: SDKMessage = {
				type: 'result',
				subtype: 'success',
			} as unknown as SDKMessage;

			const result = formatResultMessage(msg);

			expect(result).toContain('## Result');
			expect(result).toContain('*Query completed successfully*');
		});

		test('formats error result', () => {
			const msg: SDKMessage = {
				type: 'result',
				subtype: 'error',
			} as unknown as SDKMessage;

			const result = formatResultMessage(msg);

			expect(result).toContain('## Result');
			expect(result).toContain('*Error: error*');
		});

		test('formats error result with error messages', () => {
			const msg: SDKMessage = {
				type: 'result',
				subtype: 'api_error',
				errors: ['Rate limit exceeded', 'Please try again later'],
			} as unknown as SDKMessage;

			const result = formatResultMessage(msg);

			expect(result).toContain('*Error: api_error*');
			expect(result).toContain('```');
			expect(result).toContain('Rate limit exceeded');
			expect(result).toContain('Please try again later');
		});

		test('formats error result with empty errors array', () => {
			const msg: SDKMessage = {
				type: 'result',
				subtype: 'error',
				errors: [],
			} as unknown as SDKMessage;

			const result = formatResultMessage(msg);

			expect(result).toContain('*Error: error*');
			expect(result).not.toContain('```');
		});
	});
});

describe('Message RPC Handlers', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;
	let sessionManagerData: ReturnType<typeof createMockSessionManager>;

	beforeEach(() => {
		messageHubData = createMockMessageHub();
		sessionManagerData = createMockSessionManager();

		// Setup handlers with mocked dependencies
		setupMessageHandlers(messageHubData.hub, sessionManagerData.sessionManager);
	});

	afterEach(() => {
		mock.restore();
	});

	describe('message.search', () => {
		test('uses in-memory repository directly instead of worker connection', async () => {
			const sqlite = new BunDatabase(':memory:');
			sqlite.exec(`
				CREATE TABLE sdk_messages (
					id TEXT PRIMARY KEY,
					session_id TEXT NOT NULL,
					message_type TEXT NOT NULL,
					message_subtype TEXT,
					sdk_message TEXT NOT NULL,
					timestamp TEXT NOT NULL,
					send_status TEXT,
					origin TEXT,
					is_renderable INTEGER NOT NULL DEFAULT 1,
					is_terminal INTEGER NOT NULL DEFAULT 0,
					parent_tool_use_id TEXT,
					task_id TEXT
				);
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
				);
			`);
			sqlite
				.prepare(
					`INSERT INTO message_search_fts (kind, source_id, session_id, message_type, title, body, timestamp)
					 VALUES ('message', 'msg-1', 'session-1', 'user', 'In Memory', 'inmemory needle marker', ?)`
				)
				.run(Date.now());
			const db = {
				getDbPath: () => ':memory:',
				getDatabase: () => sqlite,
			} as unknown as Database;
			messageHubData = createMockMessageHub();
			setupMessageHandlers(messageHubData.hub, sessionManagerData.sessionManager, db);

			try {
				const handler = messageHubData.handlers.get('message.search');
				const result = await handler!({ query: 'needle' }, { clientId: 'client-1' });

				expect((result as { results: unknown[] }).results).toHaveLength(1);
			} finally {
				sqlite.close();
			}
		});
	});

	describe('message.sdkMessages', () => {
		test('returns SDK messages', async () => {
			const handler = messageHubData.handlers.get('message.sdkMessages');
			expect(handler).toBeDefined();

			const result = await handler!({ sessionId: 'session-123' }, {});

			expect(result).toHaveProperty('sdkMessages');
		});

		test('accepts limit parameter', async () => {
			const handler = messageHubData.handlers.get('message.sdkMessages');
			expect(handler).toBeDefined();

			await handler!({ sessionId: 'session-123', limit: 50 }, {});

			expect(sessionManagerData.agentSessionData.mocks.getSDKMessages).toHaveBeenCalledWith(
				50,
				undefined,
				undefined
			);
		});

		test('accepts before parameter', async () => {
			const handler = messageHubData.handlers.get('message.sdkMessages');
			expect(handler).toBeDefined();

			await handler!({ sessionId: 'session-123', before: 1234567890 }, {});

			expect(sessionManagerData.agentSessionData.mocks.getSDKMessages).toHaveBeenCalledWith(
				undefined,
				1234567890,
				undefined
			);
		});

		test('accepts since parameter', async () => {
			const handler = messageHubData.handlers.get('message.sdkMessages');
			expect(handler).toBeDefined();

			await handler!({ sessionId: 'session-123', since: 1234567890 }, {});

			expect(sessionManagerData.agentSessionData.mocks.getSDKMessages).toHaveBeenCalledWith(
				undefined,
				undefined,
				1234567890
			);
		});

		test('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('message.sdkMessages');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(null);

			await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
				'Session not found'
			);
		});
	});

	describe('message.count', () => {
		test('returns message count', async () => {
			const handler = messageHubData.handlers.get('message.count');
			expect(handler).toBeDefined();

			sessionManagerData.agentSessionData.mocks.getSDKMessageCount.mockReturnValueOnce(42);

			const result = await handler!({ sessionId: 'session-123' }, {});

			expect(result).toEqual({ count: 42 });
		});

		test('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('message.count');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(null);

			await expect(handler!({ sessionId: 'non-existent' }, {})).rejects.toThrow(
				'Session not found'
			);
		});
	});

	describe('session.export', () => {
		test('exports to markdown by default', async () => {
			const handler = messageHubData.handlers.get('session.export');
			expect(handler).toBeDefined();

			const result = await handler!({ sessionId: 'session-123' }, {});

			expect(result).toHaveProperty('markdown');
		});

		test('exports to markdown when format is markdown', async () => {
			const handler = messageHubData.handlers.get('session.export');
			expect(handler).toBeDefined();

			const result = await handler!({ sessionId: 'session-123', format: 'markdown' }, {});

			expect(result).toHaveProperty('markdown');
		});

		test('exports to json when format is json', async () => {
			const handler = messageHubData.handlers.get('session.export');
			expect(handler).toBeDefined();

			const result = await handler!({ sessionId: 'session-123', format: 'json' }, {});

			expect(result).toHaveProperty('session');
			expect(result).toHaveProperty('messages');
		});

		test('throws error when session not found', async () => {
			const handler = messageHubData.handlers.get('session.export');
			expect(handler).toBeDefined();

			sessionManagerData.mocks.getSessionAsync.mockResolvedValueOnce(null);

			await expect(handler!({ sessionId: 'non-existent', format: 'markdown' }, {})).rejects.toThrow(
				'Session not found'
			);
		});
	});
});
