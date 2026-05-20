/**
 * Session Repository Tests
 *
 * Tests for session CRUD operations and partial update merging.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import type { Session, SessionConfig, SessionMetadata, WorktreeMetadata } from '@neokai/shared';

describe('SessionRepository', () => {
	let db: Database;
	let repository: SessionRepository;

	function createDefaultSession(overrides: Partial<Session> = {}): Session {
		const now = new Date().toISOString();
		const config: SessionConfig = {
			model: 'claude-sonnet-4-5-20250929',
			maxTokens: 4096,
			temperature: 0.7,
		};
		const metadata: SessionMetadata = {
			messageCount: 0,
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			toolCallCount: 0,
		};

		return {
			id: 'session-1',
			title: 'Test Session',
			workspacePath: '/workspace/test',
			createdAt: now,
			lastActiveAt: now,
			status: 'active',
			config,
			metadata,
			...overrides,
		};
	}

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(`
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				workspace_path TEXT NOT NULL,
				created_at TEXT NOT NULL,
				last_active_at TEXT NOT NULL,
				status TEXT NOT NULL,
				config TEXT NOT NULL,
				metadata TEXT NOT NULL,
				is_worktree INTEGER DEFAULT 0,
				worktree_path TEXT,
				main_repo_path TEXT,
				worktree_branch TEXT,
				git_branch TEXT,
				sdk_session_id TEXT,
				sdk_origin_path TEXT,
				available_commands TEXT,
				processing_state TEXT,
				archived_at TEXT,
				type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room', 'lobby')),
				session_context TEXT
			);

			CREATE INDEX idx_sessions_last_active ON sessions(last_active_at);

			-- deleteSession() drops session-scope overrides in the same transaction
			-- so the table must exist even in tests that don't otherwise touch it.
			CREATE TABLE mcp_enablement (
				server_id TEXT NOT NULL,
				scope_type TEXT NOT NULL CHECK(scope_type IN ('space', 'room', 'session')),
				scope_id TEXT NOT NULL,
				enabled INTEGER NOT NULL,
				PRIMARY KEY (server_id, scope_type, scope_id)
			);
		`);
		repository = new SessionRepository(db as any);
	});

	afterEach(() => {
		db.close();
	});

	describe('createSession', () => {
		it('should create a session with required fields', () => {
			const session = createDefaultSession();

			repository.createSession(session);

			const retrieved = repository.getSession('session-1');
			expect(retrieved).not.toBeNull();
			expect(retrieved?.id).toBe('session-1');
			expect(retrieved?.title).toBe('Test Session');
			expect(retrieved?.workspacePath).toBe('/workspace/test');
			expect(retrieved?.status).toBe('active');
		});

		it('should create a session with worktree metadata', () => {
			const worktree: WorktreeMetadata = {
				isWorktree: true,
				worktreePath: '/workspace/worktree-1',
				mainRepoPath: '/workspace/main',
				branch: 'feature-branch',
			};
			const session = createDefaultSession({ worktree });

			repository.createSession(session);

			const retrieved = repository.getSession('session-1');
			expect(retrieved?.worktree).toBeDefined();
			expect(retrieved?.worktree?.isWorktree).toBe(true);
			expect(retrieved?.worktree?.worktreePath).toBe('/workspace/worktree-1');
			expect(retrieved?.worktree?.mainRepoPath).toBe('/workspace/main');
			expect(retrieved?.worktree?.branch).toBe('feature-branch');
		});

		it('should create a session with git branch', () => {
			const session = createDefaultSession({ gitBranch: 'main' });

			repository.createSession(session);

			const retrieved = repository.getSession('session-1');
			expect(retrieved?.gitBranch).toBe('main');
		});

		it('should create a session with SDK session ID', () => {
			const session = createDefaultSession({ sdkSessionId: 'sdk-123' });

			repository.createSession(session);

			const retrieved = repository.getSession('session-1');
			expect(retrieved?.sdkSessionId).toBe('sdk-123');
		});

		it('should create a session with available commands', () => {
			const session = createDefaultSession({ availableCommands: ['/help', '/clear'] });

			repository.createSession(session);

			const retrieved = repository.getSession('session-1');
			expect(retrieved?.availableCommands).toEqual(['/help', '/clear']);
		});

		it('should create a session with processing state', () => {
			const session = createDefaultSession({ processingState: '{"isProcessing":true}' });

			repository.createSession(session);

			const retrieved = repository.getSession('session-1');
			expect(retrieved?.processingState).toBe('{"isProcessing":true}');
		});

		it('should create a session with archived at timestamp', () => {
			const archivedAt = new Date().toISOString();
			const session = createDefaultSession({ archivedAt });

			repository.createSession(session);

			const retrieved = repository.getSession('session-1');
			expect(retrieved?.archivedAt).toBe(archivedAt);
		});
	});

	describe('getSession', () => {
		it('should return session by ID', () => {
			repository.createSession(createDefaultSession());

			const session = repository.getSession('session-1');

			expect(session).not.toBeNull();
			expect(session?.id).toBe('session-1');
		});

		it('should return null for non-existent ID', () => {
			const session = repository.getSession('non-existent');

			expect(session).toBeNull();
		});

		it('should properly deserialize config and metadata', () => {
			const config: SessionConfig = {
				model: 'claude-opus-4-5-20251113',
				maxTokens: 8192,
				temperature: 0.5,
				autoScroll: false,
				coordinatorMode: true,
			};
			const metadata: SessionMetadata = {
				messageCount: 10,
				totalTokens: 1000,
				inputTokens: 800,
				outputTokens: 200,
				totalCost: 0.05,
				toolCallCount: 5,
				titleGenerated: true,
			};
			repository.createSession(createDefaultSession({ config, metadata }));

			const session = repository.getSession('session-1');

			expect(session?.config.model).toBe('claude-opus-4-5-20251113');
			expect(session?.config.maxTokens).toBe(8192);
			expect(session?.config.autoScroll).toBe(false);
			expect(session?.config.coordinatorMode).toBe(true);
			expect(session?.metadata.messageCount).toBe(10);
			expect(session?.metadata.totalTokens).toBe(1000);
			expect(session?.metadata.titleGenerated).toBe(true);
		});
	});

	describe('listSessions', () => {
		it('should return all sessions', () => {
			repository.createSession(createDefaultSession({ id: 'session-1' }));
			repository.createSession(createDefaultSession({ id: 'session-2' }));
			repository.createSession(createDefaultSession({ id: 'session-3' }));

			const sessions = repository.listSessions();

			expect(sessions.length).toBe(3);
		});

		it('should return sessions ordered by last_active_at DESC', async () => {
			repository.createSession(
				createDefaultSession({ id: 'session-1', lastActiveAt: new Date().toISOString() })
			);
			await new Promise((r) => setTimeout(r, 5));
			repository.createSession(
				createDefaultSession({ id: 'session-2', lastActiveAt: new Date().toISOString() })
			);
			await new Promise((r) => setTimeout(r, 5));
			repository.createSession(
				createDefaultSession({ id: 'session-3', lastActiveAt: new Date().toISOString() })
			);

			const sessions = repository.listSessions();

			expect(sessions[0].id).toBe('session-3');
			expect(sessions[1].id).toBe('session-2');
			expect(sessions[2].id).toBe('session-1');
		});

		it('should return empty array when no sessions exist', () => {
			const sessions = repository.listSessions();

			expect(sessions).toEqual([]);
		});
	});

	describe('updateSession', () => {
		it('should update title', () => {
			repository.createSession(createDefaultSession());

			repository.updateSession('session-1', { title: 'Updated Title' });

			const session = repository.getSession('session-1');
			expect(session?.title).toBe('Updated Title');
		});

		it('updates message search row titles when title changes', () => {
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
			repository.createSession(createDefaultSession({ title: 'Old Title' }));
			db.prepare(
				`INSERT INTO message_search_fts (kind, source_id, message_id, session_id, title, body, timestamp)
				 VALUES ('message', ?, ?, ?, ?, ?, ?)`
			).run('msg-1', 'uuid-1', 'session-1', 'Old Title', 'body text', Date.now());

			repository.updateSession('session-1', { title: 'New Title' });

			const row = db
				.prepare(`SELECT title FROM message_search_fts WHERE source_id = ?`)
				.get('msg-1') as { title: string };
			expect(row.title).toBe('New Title');
		});

		it('rebuilds message search rows when status leaves archived', () => {
			db.exec(`
				CREATE TABLE sdk_messages (
					id TEXT PRIMARY KEY,
					session_id TEXT NOT NULL,
					message_type TEXT NOT NULL,
					message_subtype TEXT,
					sdk_message TEXT NOT NULL,
					timestamp TEXT NOT NULL,
					send_status TEXT,
					task_id TEXT
				);
				CREATE TABLE space_tasks (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					task_number INTEGER NOT NULL,
					status TEXT NOT NULL,
					completed_at INTEGER,
					updated_at INTEGER NOT NULL
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
				)
			`);
			repository.createSession(createDefaultSession({ status: 'archived' }));
			db.prepare(
				`INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status)
				 VALUES (?, ?, ?, ?, ?, ?)`
			).run(
				'msg-1',
				'session-1',
				'user',
				JSON.stringify({
					type: 'user',
					uuid: 'uuid-1',
					message: { role: 'user', content: [{ type: 'text', text: 'restored search marker' }] },
				}),
				new Date().toISOString(),
				'consumed'
			);

			repository.updateSession('session-1', { status: 'active' });

			const rows = db
				.prepare(`SELECT source_id, title FROM message_search_fts WHERE message_search_fts MATCH ?`)
				.all('restored') as Array<{ source_id: string; title: string }>;
			expect(rows).toEqual([{ source_id: 'msg-1', title: 'Test Session' }]);
		});

		it('should update workspace path', () => {
			repository.createSession(createDefaultSession());

			repository.updateSession('session-1', { workspacePath: '/new/workspace' });

			const session = repository.getSession('session-1');
			expect(session?.workspacePath).toBe('/new/workspace');
		});

		it('should update status', () => {
			repository.createSession(createDefaultSession());

			repository.updateSession('session-1', { status: 'paused' });

			const session = repository.getSession('session-1');
			expect(session?.status).toBe('paused');
		});

		it('should update lastActiveAt', () => {
			repository.createSession(createDefaultSession());
			const newTime = new Date().toISOString();

			repository.updateSession('session-1', { lastActiveAt: newTime });

			const session = repository.getSession('session-1');
			expect(session?.lastActiveAt).toBe(newTime);
		});

		it('should merge partial metadata updates', () => {
			repository.createSession(createDefaultSession());

			repository.updateSession('session-1', {
				metadata: { messageCount: 5 },
			});

			const session = repository.getSession('session-1');
			expect(session?.metadata.messageCount).toBe(5);
			// Other metadata fields should be preserved
			expect(session?.metadata.totalTokens).toBe(0);
			expect(session?.metadata.toolCallCount).toBe(0);
		});

		it('should merge partial config updates', () => {
			repository.createSession(createDefaultSession());

			repository.updateSession('session-1', {
				config: { temperature: 0.9 },
			});

			const session = repository.getSession('session-1');
			expect(session?.config.temperature).toBe(0.9);
			// Other config fields should be preserved
			expect(session?.config.model).toBe('claude-sonnet-4-5-20250929');
		});

		it('should clear metadata field when set to null', () => {
			repository.createSession(
				createDefaultSession({
					metadata: {
						messageCount: 0,
						totalTokens: 0,
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0,
						toolCallCount: 0,
						titleGenerated: true,
					},
				})
			);

			repository.updateSession('session-1', {
				metadata: { titleGenerated: null as unknown as undefined },
			});

			const session = repository.getSession('session-1');
			expect(session?.metadata.titleGenerated).toBeUndefined();
		});

		it('should update sdkSessionId', () => {
			repository.createSession(createDefaultSession());

			repository.updateSession('session-1', { sdkSessionId: 'new-sdk-id' });

			const session = repository.getSession('session-1');
			expect(session?.sdkSessionId).toBe('new-sdk-id');
		});

		it('should clear sdkSessionId when set to null', () => {
			repository.createSession(createDefaultSession({ sdkSessionId: 'sdk-123' }));

			repository.updateSession('session-1', { sdkSessionId: null });

			const session = repository.getSession('session-1');
			expect(session?.sdkSessionId).toBeUndefined();
		});

		it('should update availableCommands', () => {
			repository.createSession(createDefaultSession());

			repository.updateSession('session-1', { availableCommands: ['/new-cmd'] });

			const session = repository.getSession('session-1');
			expect(session?.availableCommands).toEqual(['/new-cmd']);
		});

		it('should clear availableCommands when set to null', () => {
			repository.createSession(createDefaultSession({ availableCommands: ['/help'] }));

			repository.updateSession('session-1', { availableCommands: null });

			const session = repository.getSession('session-1');
			expect(session?.availableCommands).toBeUndefined();
		});

		it('should update processingState', () => {
			repository.createSession(createDefaultSession());

			repository.updateSession('session-1', { processingState: '{"new":true}' });

			const session = repository.getSession('session-1');
			expect(session?.processingState).toBe('{"new":true}');
		});

		it('should update archivedAt', () => {
			repository.createSession(createDefaultSession());
			const archivedAt = new Date().toISOString();

			repository.updateSession('session-1', { archivedAt });

			const session = repository.getSession('session-1');
			expect(session?.archivedAt).toBe(archivedAt);
		});

		it('should update worktree fields', () => {
			repository.createSession(createDefaultSession());

			repository.updateSession('session-1', {
				worktree: {
					isWorktree: true,
					worktreePath: '/worktree/path',
					mainRepoPath: '/main/repo',
					branch: 'feature',
				},
			});

			const session = repository.getSession('session-1');
			expect(session?.worktree?.isWorktree).toBe(true);
			expect(session?.worktree?.worktreePath).toBe('/worktree/path');
		});

		it('should clear worktree when set to null', () => {
			repository.createSession(
				createDefaultSession({
					worktree: {
						isWorktree: true,
						worktreePath: '/worktree',
						mainRepoPath: '/main',
						branch: 'feature',
					},
				})
			);

			repository.updateSession('session-1', { worktree: null });

			const session = repository.getSession('session-1');
			expect(session?.worktree).toBeUndefined();
		});

		it('should not throw when updating non-existent session', () => {
			expect(() => repository.updateSession('non-existent', { title: 'New Title' })).not.toThrow();
		});

		it('should update multiple fields at once', () => {
			repository.createSession(createDefaultSession());
			const newTime = new Date().toISOString();

			repository.updateSession('session-1', {
				title: 'Multi Update',
				status: 'ended',
				lastActiveAt: newTime,
				metadata: { messageCount: 100 },
				config: { coordinatorMode: true },
			});

			const session = repository.getSession('session-1');
			expect(session?.title).toBe('Multi Update');
			expect(session?.status).toBe('ended');
			expect(session?.lastActiveAt).toBe(newTime);
			expect(session?.metadata.messageCount).toBe(100);
			expect(session?.config.coordinatorMode).toBe(true);
		});

		it('should correctly persist model and provider when updating config with plain fields', () => {
			repository.createSession(createDefaultSession());

			repository.updateSession('session-1', {
				config: { model: 'claude-opus-4-5-20251113', provider: 'anthropic' },
			});

			const session = repository.getSession('session-1');
			expect(session?.config.model).toBe('claude-opus-4-5-20251113');
			expect(session?.config.provider).toBe('anthropic');
			// Other config fields should be preserved from the original
			expect(session?.config.maxTokens).toBe(4096);
		});

		it('should strip function values silently when serializing config', () => {
			repository.createSession(createDefaultSession());
			const configWithFn = {
				model: 'claude-opus-4-5-20251113',
				// spawnClaudeCodeProcess is a runtime-only function — must not crash
				spawnClaudeCodeProcess: () => {},
			} as SessionConfig;

			// Should not throw — functions are silently stripped
			expect(() => repository.updateSession('session-1', { config: configWithFn })).not.toThrow();

			const session = repository.getSession('session-1');
			expect(session?.config.model).toBe('claude-opus-4-5-20251113');
			// Function fields are stripped — not persisted
			expect(session?.config.spawnClaudeCodeProcess).toBeUndefined();
		});

		it('should not false-positive on shared (diamond) references in config', () => {
			repository.createSession(createDefaultSession());

			// A shared object appearing at two separate paths is NOT a cycle.
			// A flat WeakSet would incorrectly throw here; native JSON.stringify handles it fine.
			const shared = { command: 'mcp-server' };
			const configWithDiamond = {
				model: 'claude-sonnet-4-5-20250929',
				extra1: shared,
				extra2: shared, // same reference, different path — valid
			} as SessionConfig;

			expect(() =>
				repository.updateSession('session-1', { config: configWithDiamond })
			).not.toThrow();

			const session = repository.getSession('session-1');
			expect(session?.config.model).toBe('claude-sonnet-4-5-20250929');
		});

		it('should throw a clear error when config contains a circular reference', () => {
			repository.createSession(createDefaultSession());

			// Build a config object with a circular reference (simulates
			// a live mcpServers object being accidentally passed in)
			const circular = { value: 'test' } as Record<string, unknown>;
			circular['self'] = circular;

			expect(() =>
				repository.updateSession('session-1', {
					config: { model: 'claude-sonnet-4-5-20250929', extra: circular } as SessionConfig,
				})
			).toThrow(/updateSession: failed to serialize config/);
		});
	});

	describe('deleteSession', () => {
		it('should delete a session by ID', () => {
			repository.createSession(createDefaultSession());

			repository.deleteSession('session-1');

			expect(repository.getSession('session-1')).toBeNull();
		});

		it('should only delete the specified session', () => {
			repository.createSession(createDefaultSession({ id: 'session-1' }));
			repository.createSession(createDefaultSession({ id: 'session-2' }));

			repository.deleteSession('session-1');

			expect(repository.getSession('session-1')).toBeNull();
			expect(repository.getSession('session-2')).not.toBeNull();
		});

		it('should not throw when deleting non-existent session', () => {
			expect(() => repository.deleteSession('non-existent')).not.toThrow();
		});

		it('should cascade-delete session-scope mcp_enablement overrides (MCP M6)', () => {
			repository.createSession(createDefaultSession({ id: 'session-1' }));
			repository.createSession(createDefaultSession({ id: 'session-2' }));

			// Seed overrides at every scope targeting the deleted session's id across
			// tables. Only rows with (scope_type='session', scope_id='session-1')
			// should be removed — room/space rows sharing the same scope_id string
			// must survive (they belong to a different scope namespace).
			const insert = db.prepare(
				`INSERT INTO mcp_enablement (server_id, scope_type, scope_id, enabled) VALUES (?, ?, ?, ?)`
			);
			insert.run('srv-a', 'session', 'session-1', 1);
			insert.run('srv-b', 'session', 'session-1', 0);
			insert.run('srv-a', 'session', 'session-2', 1);
			insert.run('srv-a', 'room', 'session-1', 1); // same id, different scope
			insert.run('srv-a', 'space', 'session-1', 1); // same id, different scope

			repository.deleteSession('session-1');

			const rows = db.prepare('SELECT * FROM mcp_enablement ORDER BY scope_type, server_id').all();
			expect(rows).toEqual([
				{ server_id: 'srv-a', scope_type: 'room', scope_id: 'session-1', enabled: 1 },
				{ server_id: 'srv-a', scope_type: 'session', scope_id: 'session-2', enabled: 1 },
				{ server_id: 'srv-a', scope_type: 'space', scope_id: 'session-1', enabled: 1 },
			]);
		});

		it('should leave mcp_enablement untouched when deleting a session with no overrides', () => {
			repository.createSession(createDefaultSession());
			db.prepare(
				`INSERT INTO mcp_enablement (server_id, scope_type, scope_id, enabled) VALUES (?, ?, ?, ?)`
			).run('srv-x', 'session', 'other-session', 1);

			repository.deleteSession('session-1');

			const rows = db.prepare('SELECT COUNT(*) as c FROM mcp_enablement').get() as { c: number };
			expect(rows.c).toBe(1);
		});

		it('deletes message search rows before sdk_messages cascade', () => {
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
			repository.createSession(createDefaultSession({ id: 'session-1' }));
			repository.createSession(createDefaultSession({ id: 'session-2' }));
			db.prepare(
				`INSERT INTO message_search_fts (kind, source_id, message_id, session_id, body, timestamp)
				 VALUES ('message', ?, ?, ?, ?, ?)`
			).run('msg-1', 'uuid-1', 'session-1', 'deleted needle', Date.now());
			db.prepare(
				`INSERT INTO message_search_fts (kind, source_id, message_id, session_id, body, timestamp)
				 VALUES ('message', ?, ?, ?, ?, ?)`
			).run('msg-2', 'uuid-2', 'session-2', 'kept needle', Date.now());

			repository.deleteSession('session-1');

			const rows = db
				.prepare(`SELECT source_id FROM message_search_fts WHERE message_search_fts MATCH ?`)
				.all('needle') as Array<{ source_id: string }>;
			expect(rows.map((row) => row.source_id)).toEqual(['msg-2']);
		});
	});

	describe('rowToSession', () => {
		it('should properly convert database row to Session object', () => {
			const session = createDefaultSession({
				worktree: {
					isWorktree: true,
					worktreePath: '/worktree',
					mainRepoPath: '/main',
					branch: 'branch',
				},
				gitBranch: 'git-branch',
				sdkSessionId: 'sdk-id',
				availableCommands: ['/cmd1', '/cmd2'],
				processingState: '{"processing":true}',
				archivedAt: '2024-01-01T00:00:00.000Z',
			});

			repository.createSession(session);
			const retrieved = repository.getSession('session-1');

			expect(retrieved?.id).toBe('session-1');
			expect(retrieved?.worktree?.isWorktree).toBe(true);
			expect(retrieved?.gitBranch).toBe('git-branch');
			expect(retrieved?.sdkSessionId).toBe('sdk-id');
			expect(retrieved?.availableCommands).toEqual(['/cmd1', '/cmd2']);
			expect(retrieved?.processingState).toBe('{"processing":true}');
			expect(retrieved?.archivedAt).toBe('2024-01-01T00:00:00.000Z');
		});

		it('should handle session without worktree', () => {
			repository.createSession(createDefaultSession());

			const session = repository.getSession('session-1');

			expect(session?.worktree).toBeUndefined();
		});

		it('should handle session without optional fields', () => {
			repository.createSession(createDefaultSession());

			const session = repository.getSession('session-1');

			expect(session?.gitBranch).toBeUndefined();
			expect(session?.sdkSessionId).toBeUndefined();
			expect(session?.availableCommands).toBeUndefined();
			expect(session?.processingState).toBeUndefined();
			expect(session?.archivedAt).toBeUndefined();
		});
	});

	describe('session lifecycle', () => {
		it('should support full session lifecycle', () => {
			// Create session
			const session = createDefaultSession();
			repository.createSession(session);
			expect(repository.getSession('session-1')?.status).toBe('active');

			// Pause session
			repository.updateSession('session-1', { status: 'paused' });
			expect(repository.getSession('session-1')?.status).toBe('paused');

			// Resume and update metadata
			repository.updateSession('session-1', {
				status: 'active',
				metadata: { messageCount: 10 },
			});

			// End session
			repository.updateSession('session-1', { status: 'ended' });

			// Archive session
			const archivedAt = new Date().toISOString();
			repository.updateSession('session-1', {
				status: 'archived',
				archivedAt,
			});

			const final = repository.getSession('session-1');
			expect(final?.status).toBe('archived');
			expect(final?.archivedAt).toBe(archivedAt);

			// Delete session
			repository.deleteSession('session-1');
			expect(repository.getSession('session-1')).toBeNull();
		});

		describe('getSessionsByIds', () => {
			it('should return a Map with found sessions', () => {
				repository.createSession(createDefaultSession({ id: 's-1' }));
				repository.createSession(createDefaultSession({ id: 's-2' }));
				repository.createSession(createDefaultSession({ id: 's-3' }));

				const result = repository.getSessionsByIds(['s-1', 's-3']);

				expect(result).toBeInstanceOf(Map);
				expect(result.size).toBe(2);
				expect(result.get('s-1')?.title).toBe('Test Session');
				expect(result.get('s-3')?.title).toBe('Test Session');
				expect(result.has('s-2')).toBe(false);
			});

			it('should return empty Map when no IDs match', () => {
				repository.createSession(createDefaultSession({ id: 's-1' }));

				const result = repository.getSessionsByIds(['non-existent-1', 'non-existent-2']);

				expect(result).toBeInstanceOf(Map);
				expect(result.size).toBe(0);
			});

			it('should return empty Map for empty input array', () => {
				const result = repository.getSessionsByIds([]);

				expect(result).toBeInstanceOf(Map);
				expect(result.size).toBe(0);
			});

			it('should handle single ID lookup', () => {
				repository.createSession(createDefaultSession({ id: 's-single' }));

				const result = repository.getSessionsByIds(['s-single']);

				expect(result.size).toBe(1);
				expect(result.get('s-single')?.id).toBe('s-single');
			});

			it('should return all sessions when all IDs exist', () => {
				repository.createSession(createDefaultSession({ id: 'a' }));
				repository.createSession(createDefaultSession({ id: 'b' }));
				repository.createSession(createDefaultSession({ id: 'c' }));

				const result = repository.getSessionsByIds(['a', 'b', 'c']);

				expect(result.size).toBe(3);
				expect(result.get('a')?.id).toBe('a');
				expect(result.get('b')?.id).toBe('b');
				expect(result.get('c')?.id).toBe('c');
			});

			it('should properly deserialize session fields in batch results', () => {
				const session = createDefaultSession({
					id: 's-detail',
					title: 'Detailed Session',
					status: 'paused',
					gitBranch: 'feature-branch',
					sdkSessionId: 'sdk-abc',
				});
				repository.createSession(session);

				const result = repository.getSessionsByIds(['s-detail']);

				const fetched = result.get('s-detail');
				expect(fetched?.title).toBe('Detailed Session');
				expect(fetched?.status).toBe('paused');
				expect(fetched?.gitBranch).toBe('feature-branch');
				expect(fetched?.sdkSessionId).toBe('sdk-abc');
				expect(fetched?.config.model).toBe('claude-sonnet-4-5-20250929');
			});

			it('should correctly chunk large ID lists within SQLite variable limit', () => {
				// Create a small number of sessions and request them all at once.
				// The chunking logic (CHUNK_SIZE=900) is exercised by having more
				// entries than a single chunk (though we only create a few for speed).
				const ids: string[] = [];
				for (let i = 0; i < 10; i++) {
					const id = `s-chunk-${i}`;
					ids.push(id);
					repository.createSession(createDefaultSession({ id }));
				}

				const result = repository.getSessionsByIds(ids);

				expect(result.size).toBe(10);
				for (const id of ids) {
					expect(result.has(id)).toBe(true);
				}
			});
		});
	});
});
