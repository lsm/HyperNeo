import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { HyperNeoActionMessage } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { classifyReclaimTermination } from '../../../../src/lib/agent/message-delivery';
import type {
  MessageSearchParams,
  MessageSearchResponse,
} from '../../../../src/storage/message-search';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('SDKMessageRepository', () => {
  let db: Database;
  let repository: SDKMessageRepository;

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
				conversation_turn_index INTEGER,
				consumed_seq INTEGER,
				parent_tool_use_id TEXT,
				task_id TEXT,
				sdk_uuid TEXT,
				replacement_metadata_normalized INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE sdk_message_replacements (
				source_message_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				task_id TEXT,
				target_uuid TEXT NOT NULL,
				kind TEXT NOT NULL CHECK(kind IN ('superseded', 'retracted')),
				PRIMARY KEY (source_message_id, target_uuid, kind),
				FOREIGN KEY (source_message_id) REFERENCES sdk_messages(id) ON DELETE CASCADE
			);
			CREATE TABLE delivery_turn_end (
				session_id TEXT NOT NULL,
				message_uuid TEXT NOT NULL,
				ended_at TEXT NOT NULL,
				PRIMARY KEY (session_id, message_uuid)
			);
			CREATE TABLE delivery_consumed_seq (
				singleton INTEGER PRIMARY KEY DEFAULT 1,
				next_seq INTEGER NOT NULL DEFAULT 1
			);
			INSERT OR IGNORE INTO delivery_consumed_seq (singleton, next_seq) VALUES (1, 1);
			CREATE INDEX idx_sdk_messages_session ON sdk_messages(session_id);
			CREATE INDEX idx_sdk_messages_timestamp ON sdk_messages(timestamp);
			CREATE INDEX idx_sdk_messages_task_id ON sdk_messages(task_id);
			CREATE INDEX idx_sdk_messages_session_uuid ON sdk_messages(session_id, sdk_uuid);
		`);
    repository = new SDKMessageRepository(db as any);
  });

  afterEach(() => {
    db.close();
  });

  function createSearchIndex(): void {
    db.exec(`
			CREATE TABLE message_search_content (
					id INTEGER PRIMARY KEY,
				kind TEXT NOT NULL,
				source_id TEXT NOT NULL,
				message_id TEXT,
				session_id TEXT,
				task_id TEXT,
				space_id TEXT,
				task_number INTEGER,
				message_type TEXT,
				title TEXT,
				body TEXT,
				timestamp INTEGER,
				UNIQUE (kind, source_id)
			);
			CREATE TABLE message_search_pending (
				message_id TEXT PRIMARY KEY,
				created_at INTEGER NOT NULL
			);
			CREATE VIRTUAL TABLE message_search_fts USING fts5(
				title,
				body,
				content='message_search_content',
				content_rowid='id',
				detail=column,
				tokenize = 'unicode61'
			);
			CREATE TRIGGER message_search_content_ai
			AFTER INSERT ON message_search_content BEGIN
				INSERT INTO message_search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
			END;
			CREATE TRIGGER message_search_content_ad
			AFTER DELETE ON message_search_content BEGIN
				INSERT INTO message_search_fts(message_search_fts, rowid, title, body)
				VALUES ('delete', old.id, old.title, old.body);
			END;
			CREATE TRIGGER message_search_content_au
			AFTER UPDATE OF title, body ON message_search_content BEGIN
				INSERT INTO message_search_fts(message_search_fts, rowid, title, body)
				VALUES ('delete', old.id, old.title, old.body);
				INSERT INTO message_search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
			END;
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
				session_context TEXT,
          room_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.roomId') END) VIRTUAL,
          space_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.spaceId') END) VIRTUAL,
          task_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.taskId') END) VIRTUAL
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

  describe('hasUnresolvedHyperNeoAction', () => {
    function insertActionCard(sessionId: string, resolved: boolean): void {
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
         VALUES (?, ?, 'hyperneo_action', 'sdk_resume_choice', ?, ?)`
      ).run(
        `row-${sessionId}-${resolved}`,
        sessionId,
        JSON.stringify({ type: 'hyperneo_action', action: 'sdk_resume_choice', resolved }),
        new Date().toISOString()
      );
    }

    it('returns false when no card exists (bun:sqlite .get() yields null, not undefined)', () => {
      expect(repository.hasUnresolvedHyperNeoAction('s1', 'sdk_resume_choice')).toBe(false);
    });

    it('returns true only while an unresolved card exists', () => {
      insertActionCard('s1', false);
      expect(repository.hasUnresolvedHyperNeoAction('s1', 'sdk_resume_choice')).toBe(true);
      insertActionCard('s2', true);
      expect(repository.hasUnresolvedHyperNeoAction('s2', 'sdk_resume_choice')).toBe(false);
      expect(repository.hasUnresolvedHyperNeoAction('s3', 'sdk_resume_choice')).toBe(false);
    });
  });

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

    it('materializes SDK UUID and replacement edges atomically', () => {
      const message = {
        type: 'system',
        subtype: 'model_refusal_fallback',
        uuid: 'replacement-uuid',
        supersedes: ['old-1', 'old-1', '', 42],
        retracted_message_uuids: ['old-2'],
      } as unknown as SDKMessage;

      expect(repository.saveSDKMessage('session-1', message)).toBe(true);

      const row = db
        .prepare(
          `SELECT id, sdk_uuid, replacement_metadata_normalized
             FROM sdk_messages
            WHERE session_id = ?`
        )
        .get('session-1') as {
        id: string;
        sdk_uuid: string;
        replacement_metadata_normalized: number;
      };
      expect(row.sdk_uuid).toBe('replacement-uuid');
      expect(row.replacement_metadata_normalized).toBe(1);
      expect(
        db
          .prepare(
            `SELECT source_message_id, session_id, target_uuid, kind
               FROM sdk_message_replacements
              ORDER BY kind, target_uuid`
          )
          .all()
      ).toEqual([
        {
          source_message_id: row.id,
          session_id: 'session-1',
          target_uuid: 'old-2',
          kind: 'retracted',
        },
        {
          source_message_id: row.id,
          session_id: 'session-1',
          target_uuid: 'old-1',
          kind: 'superseded',
        },
      ]);
    });

    it('ignores retraction arrays outside model refusal fallback messages', () => {
      expect(
        repository.saveSDKMessage('session-1', {
          type: 'assistant',
          uuid: 'ordinary-message',
          retracted_message_uuids: ['must-remain-visible'],
          message: { role: 'assistant', content: [] },
        } as unknown as SDKMessage)
      ).toBe(true);

      expect(db.prepare(`SELECT COUNT(*) AS count FROM sdk_message_replacements`).get()).toEqual({
        count: 0,
      });
    });

    it('normalizes HyperNeo action message UUIDs immediately', () => {
      const rowId = repository.saveHyperNeoActionMessage('session-1', {
        type: 'hyperneo_action',
        uuid: 'action-uuid',
        session_id: 'session-1',
        action: 'sdk_resume_choice',
        resolved: false,
        timestamp: Date.now(),
      });

      expect(
        db
          .prepare(
            `SELECT sdk_uuid, replacement_metadata_normalized
               FROM sdk_messages
              WHERE id = ?`
          )
          .get(rowId)
      ).toEqual({
        sdk_uuid: 'action-uuid',
        replacement_metadata_normalized: 1,
      });
    });

    it('does not write partial replacement state against the pre-migration schema', () => {
      const legacyDb = new Database(':memory:');
      try {
        legacyDb.exec(`
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
            task_id TEXT,
            consumed_seq INTEGER
          )
        `);
        const legacyRepository = new SDKMessageRepository(legacyDb as any);

        expect(
          legacyRepository.saveSDKMessage(
            'legacy-session',
            createUserMessage('still persisted', 'legacy-uuid')
          )
        ).toBe(false);
        expect(legacyDb.prepare(`SELECT COUNT(*) AS count FROM sdk_messages`).get()).toEqual({
          count: 0,
        });
      } finally {
        legacyDb.close();
      }
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

    it('returns false when the insert itself fails', () => {
      db.exec('DROP TABLE sdk_messages');

      expect(repository.saveSDKMessage('session-1', createUserMessage('never persisted'))).toBe(
        false
      );
    });

    it('returns true for a committed row when post-commit notifications fail', () => {
      const failingReactiveDb = {
        resolveTaskIdForSession: () => null,
        notifyChange: () => {
          throw new Error('reactive notify failed');
        },
      } as unknown as ReactiveDatabase;
      const repo = new SDKMessageRepository(db as any, failingReactiveDb);

      const result = repo.saveSDKMessage('session-1', createUserMessage('committed'));

      expect(result).toBe(true);
      const row = db
        .prepare(`SELECT COUNT(*) AS count FROM sdk_messages WHERE session_id = ?`)
        .get('session-1') as { count: number };
      expect(row.count).toBe(1);
    });
  });

  describe('getRenderableTextMessages', () => {
    it('continues past empty renderable rows until the text limit is reached', async () => {
      repository.saveSDKMessage('session-1', createUserMessage('Older text'));
      repository.saveSDKMessage('session-1', {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read' }] },
      } as unknown as SDKMessage);
      repository.saveSDKMessage('session-1', createAssistantMessage('Newest text'));

      const messages = repository.getRenderableTextMessages('session-1', 2);

      expect(messages.map((message) => message.text)).toEqual(['Older text', 'Newest text']);
    });

    it('filters retracted and superseded rows before collecting text messages', () => {
      repository.saveSDKMessage('session-1', createUserMessage('Visible older', 'visible-older'));
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
         VALUES (?, ?, ?, ?, ?)`
      ).run('malformed-row', 'session-1', 'assistant', '{not-json', new Date().toISOString());
      repository.saveSDKMessage(
        'session-1',
        createUserMessage('Retracted newer', 'retracted-newer')
      );
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'model_refusal_fallback',
        uuid: 'fallback-notice',
        retracted_message_uuids: ['retracted-newer'],
        session_id: 'session-1',
      } as unknown as SDKMessage);
      repository.saveSDKMessage(
        'session-1',
        createUserMessage('Superseded newer', 'superseded-newer')
      );
      repository.saveSDKMessage('session-1', {
        type: 'assistant',
        uuid: 'replacement-message',
        supersedes: ['superseded-newer'],
        message: { role: 'assistant', content: [{ type: 'text', text: 'Replacement' }] },
      } as unknown as SDKMessage);

      const messages = repository.getRenderableTextMessages('session-1', 3);

      expect(messages.map((message) => message.text)).toEqual(['Visible older', 'Replacement']);
    });
    it('caps scanned renderable rows while collecting text messages', () => {
      repository.saveSDKMessage('session-1', createUserMessage('Too old text'));
      for (let i = 0; i < 250; i++) {
        repository.saveSDKMessage('session-1', {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: `tool-${i}`, name: 'Read' }],
          },
        } as unknown as SDKMessage);
      }

      const messages = repository.getRenderableTextMessages('session-1', 1);

      expect(messages).toEqual([]);
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

    it('includes same-timestamp rows at the before cursor (inclusive boundary)', () => {
      repository.saveSDKMessage('session-1', createUserMessage('older', 'm-older'));
      repository.saveSDKMessage('session-1', createUserMessage('a', 'm-a'));
      repository.saveSDKMessage('session-1', createUserMessage('b', 'm-b'));
      const Tiso = '2026-01-01T00:00:00.000Z';
      const Tms = new Date(Tiso).getTime();
      db.prepare(
        `UPDATE sdk_messages SET timestamp = ? WHERE json_extract(sdk_message, '$.uuid') = 'm-older'`
      ).run('2025-12-31T00:00:00.000Z');
      db.prepare(
        `UPDATE sdk_messages SET timestamp = ? WHERE json_extract(sdk_message, '$.uuid') IN ('m-a', 'm-b')`
      ).run(Tiso);

      const { messages } = repository.getSDKMessages('session-1', 100, Tms);
      const texts = messages.map(
        (m) =>
          (m as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]?.text
      );
      expect(texts).toContain('b');
      expect(texts).toContain('older');
    });

    it('advances through more-than-limit same-timestamp rows via the rowid cursor', () => {
      for (let i = 0; i < 5; i += 1) {
        repository.saveSDKMessage('session-1', createUserMessage(`same-${i}`, `m-${i}`));
      }
      const Tiso = '2026-01-01T00:00:00.000Z';
      const Tms = new Date(Tiso).getTime();
      db.prepare(`UPDATE sdk_messages SET timestamp = ? WHERE session_id = 'session-1'`).run(Tiso);

      const page1 = repository.getSDKMessages('session-1', 3);
      expect(page1.hasMore).toBe(true);
      const oldest = page1.messages[0] as { rowid?: number; timestamp?: number };
      expect(oldest.rowid).toBeDefined();

      const page2 = repository.getSDKMessages('session-1', 3, Tms, undefined, oldest.rowid);
      const page2Texts = page2.messages.map(
        (m) =>
          (m as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]?.text
      );
      expect(page2Texts).toContain('same-0');
      expect(page2Texts).toContain('same-1');
      expect(page2Texts).not.toContain('same-4');
    });

    it('should exclude render-only hidden system subtypes from pagination', () => {
      repository.saveSDKMessage('session-1', createUserMessage('Visible'));
      for (const subtype of ['session_state_changed', 'commands_changed', 'task_progress']) {
        repository.saveSDKMessage('session-1', {
          type: 'system',
          subtype,
          uuid: `hidden-${subtype}`,
          session_id: 'session-1',
        } as unknown as SDKMessage);
      }

      const { messages, hasMore } = repository.getSDKMessages('session-1', 2);

      expect(messages.map((message) => (message as { subtype?: string }).subtype)).toEqual([
        undefined,
      ]);
      expect(hasMore).toBe(false);
    });

    it('should expose background task metadata separately from pagination', () => {
      for (const subtype of ['task_started', 'task_updated', 'task_notification']) {
        repository.saveSDKMessage('session-1', {
          type: 'system',
          subtype,
          uuid: `metadata-${subtype}`,
          session_id: 'session-1',
          task_id: 'task-1',
          status: subtype === 'task_notification' ? 'completed' : undefined,
        } as unknown as SDKMessage);
      }
      repository.saveSDKMessage('session-1', createUserMessage('Visible'));

      const { messages, hasMore } = repository.getSDKMessages('session-1', 2);
      const metadataMessages = repository.getBackgroundTaskMessages('session-1');

      expect(messages.map((message) => (message as { subtype?: string }).subtype).sort()).toEqual([
        'task_notification',
        undefined,
      ]);
      expect(metadataMessages.map((message) => (message as { subtype?: string }).subtype)).toEqual([
        'task_started',
        'task_updated',
        'task_notification',
      ]);
      expect(hasMore).toBe(true);
    });

    it('should include only latest task progress without counting it against metadata cap', () => {
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'task_started',
        uuid: 'metadata-task-started',
        session_id: 'session-1',
        task_id: 'task-1',
        tool_use_id: 'toolu_task123',
        description: 'Long task',
      } as unknown as SDKMessage);

      for (let i = 0; i < 305; i++) {
        repository.saveSDKMessage('session-1', {
          type: 'system',
          subtype: 'task_progress',
          uuid: `metadata-task-progress-${i}`,
          session_id: 'session-1',
          task_id: 'task-1',
          tool_use_id: 'toolu_task123',
          description: `progress ${i}`,
          usage: { total_tokens: i, tool_uses: i, duration_ms: i },
        } as unknown as SDKMessage);
      }

      const metadataMessages = repository.getBackgroundTaskMessages('session-1');
      const progressMessages = metadataMessages.filter(
        (message) => (message as { subtype?: string }).subtype === 'task_progress'
      );

      expect(
        metadataMessages.some(
          (message) => (message as { subtype?: string }).subtype === 'task_started'
        )
      ).toBe(true);
      expect(progressMessages).toHaveLength(1);
      expect((progressMessages[0] as { description?: string }).description).toBe('progress 304');
    });

    it('should retain task start rows when background task metadata is capped', () => {
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'task_started',
        uuid: 'metadata-task-started',
        session_id: 'session-1',
        task_id: 'task-1',
        description: 'Long task',
      } as unknown as SDKMessage);

      for (let i = 0; i < 301; i++) {
        repository.saveSDKMessage('session-1', {
          type: 'system',
          subtype: 'task_updated',
          uuid: `metadata-task-updated-${i}`,
          session_id: 'session-1',
          task_id: 'task-1',
          patch: { is_backgrounded: true, status: 'running' },
        } as unknown as SDKMessage);
      }

      const metadataMessages = repository.getBackgroundTaskMessages('session-1');

      expect(
        metadataMessages.some(
          (message) => (message as { subtype?: string }).subtype === 'task_started'
        )
      ).toBe(true);
      expect(metadataMessages.at(-1)).toMatchObject({ subtype: 'task_updated' });
    });

    it('should match background task starts by SDK task id before session task id', () => {
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'task_started',
        uuid: 'old-task-started',
        session_id: 'session-1',
        task_id: 'old-sdk-task',
      } as unknown as SDKMessage);
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'task_started',
        uuid: 'current-task-started',
        session_id: 'session-1',
        task_id: 'current-sdk-task',
      } as unknown as SDKMessage);
      for (let i = 0; i < 301; i++) {
        repository.saveSDKMessage('session-1', {
          type: 'system',
          subtype: 'task_updated',
          uuid: `current-task-updated-${i}`,
          session_id: 'session-1',
          task_id: 'current-sdk-task',
          patch: { is_backgrounded: true, status: 'running' },
        } as unknown as SDKMessage);
      }
      db.prepare(`UPDATE sdk_messages SET task_id = 'space-task-1'`).run();

      const metadataMessages = repository.getBackgroundTaskMessages('session-1');
      const sdkTaskIds = metadataMessages.map(
        (message) => (message as { task_id?: string }).task_id
      );

      expect(sdkTaskIds).not.toContain('old-sdk-task');
      expect(sdkTaskIds).toContain('current-sdk-task');
    });

    it('should preserve background task metadata order on timestamp ties', () => {
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'task_started',
        uuid: 'metadata-task-started',
        session_id: 'session-1',
        task_id: 'task-1',
      } as unknown as SDKMessage);
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'task_updated',
        uuid: 'metadata-task-updated',
        session_id: 'session-1',
        task_id: 'task-1',
        patch: { is_backgrounded: true, status: 'running' },
      } as unknown as SDKMessage);
      db.prepare(`UPDATE sdk_messages SET timestamp = '2024-01-01T00:00:00.000Z'`).run();

      const metadataMessages = repository.getBackgroundTaskMessages('session-1');

      expect(metadataMessages.map((message) => (message as { subtype?: string }).subtype)).toEqual([
        'task_started',
        'task_updated',
      ]);
    });

    it('should tolerate malformed background task metadata rows', () => {
      repository.saveSDKMessage('session-1', createUserMessage('Visible'));
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'task_started',
        uuid: 'metadata-task-started',
        session_id: 'session-1',
        task_id: 'task-1',
      } as unknown as SDKMessage);
      db.prepare(
        `UPDATE sdk_messages
         SET sdk_message = ?
         WHERE message_subtype = 'task_started'`
      ).run('{not-json');

      const metadataMessages = repository.getBackgroundTaskMessages('session-1');

      expect(metadataMessages).toHaveLength(1);
      expect(metadataMessages[0].type).toBe('unknown');
    });

    it('should not let background task metadata rows displace visible rows', () => {
      repository.saveSDKMessage('session-1', createUserMessage('Older visible'));
      for (let i = 0; i < 20; i++) {
        repository.saveSDKMessage('session-1', {
          type: 'system',
          subtype: i === 0 ? 'task_started' : 'task_updated',
          uuid: `metadata-${i}`,
          session_id: 'session-1',
          task_id: 'task-1',
        } as unknown as SDKMessage);
      }
      repository.saveSDKMessage('session-1', createAssistantMessage('Newer visible'));

      const { messages } = repository.getSDKMessages('session-1', 2);

      expect(messages).toHaveLength(2);
      expect(messages.map((message) => message.type).sort()).toEqual(['assistant', 'user']);
    });

    it('should include visible system rows in session pagination', () => {
      repository.saveSDKMessage('session-1', createUserMessage('Visible'));
      for (const subtype of ['permission_denied', 'api_retry']) {
        repository.saveSDKMessage('session-1', {
          type: 'system',
          subtype,
          uuid: `operational-${subtype}`,
          session_id: 'session-1',
        } as unknown as SDKMessage);
      }

      const { messages } = repository.getSDKMessages('session-1', 3);

      expect(messages.map((message) => (message as { subtype?: string }).subtype).sort()).toEqual(
        ['api_retry', 'permission_denied', undefined].sort()
      );
    });

    it('should include retracted rows in session pagination', () => {
      repository.saveSDKMessage('session-1', createUserMessage('Visible older', 'visible-older'));
      repository.saveSDKMessage(
        'session-1',
        createUserMessage('Retracted newer', 'retracted-newer')
      );
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'model_refusal_fallback',
        retracted_message_uuids: ['retracted-newer'],
        uuid: 'fallback-notice',
        session_id: 'session-1',
      } as unknown as SDKMessage);

      const { messages } = repository.getSDKMessages('session-1', 3);

      expect(messages.map((message) => (message as { uuid?: string }).uuid).sort()).toEqual([
        'fallback-notice',
        'retracted-newer',
        'visible-older',
      ]);
    });

    it('should include superseded rows in session pagination', () => {
      repository.saveSDKMessage('session-1', createUserMessage('Visible older', 'visible-older'));
      repository.saveSDKMessage(
        'session-1',
        createUserMessage('Superseded newer', 'superseded-newer')
      );
      repository.saveSDKMessage('session-1', {
        type: 'assistant',
        uuid: 'replacement-message',
        supersedes: ['superseded-newer'],
        message: { role: 'assistant', content: [{ type: 'text', text: 'replacement' }] },
      } as unknown as SDKMessage);

      const { messages } = repository.getSDKMessages('session-1', 3);

      expect(messages.map((message) => (message as { uuid?: string }).uuid).sort()).toEqual([
        'replacement-message',
        'superseded-newer',
        'visible-older',
      ]);
    });

    it('applies limit to raw rows instead of replacement-filtered rows', () => {
      repository.saveSDKMessage('session-1', createUserMessage('Visible oldest', 'visible-oldest'));
      repository.saveSDKMessage('session-1', createUserMessage('Visible older', 'visible-older'));
      repository.saveSDKMessage(
        'session-1',
        createUserMessage('Retracted newer', 'retracted-newer')
      );
      repository.saveSDKMessage(
        'session-1',
        createUserMessage('Superseded newest', 'superseded-newest')
      );
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'model_refusal_fallback',
        retracted_message_uuids: ['retracted-newer'],
        uuid: 'fallback-notice',
        session_id: 'session-1',
      } as unknown as SDKMessage);
      repository.saveSDKMessage('session-1', {
        type: 'assistant',
        uuid: 'replacement-message',
        supersedes: ['superseded-newest'],
        message: { role: 'assistant', content: [{ type: 'text', text: 'replacement' }] },
      } as unknown as SDKMessage);

      const { messages } = repository.getSDKMessages('session-1', 6);

      expect(messages.map((message) => (message as { uuid?: string }).uuid).sort()).toEqual([
        'fallback-notice',
        'replacement-message',
        'retracted-newer',
        'superseded-newest',
        'visible-older',
        'visible-oldest',
      ]);
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

      expect(messages.length).toBe(2);
    });

    it('should include subagent messages for matching tool use IDs', () => {
      const toolUseId = 'tool-use-123';
      repository.saveSDKMessage('session-1', createAssistantMessage('Task started', toolUseId));
      repository.saveSDKMessage('session-1', createSubagentMessage('Subagent work', toolUseId));
      repository.saveSDKMessage('session-1', createSubagentMessage('Another subagent', toolUseId));

      const { messages } = repository.getSDKMessages('session-1');

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

      expect(messages.length).toBe(1);
    });

    it('should filter subagent thinking token progress rows', () => {
      const toolUseId = 'tool-use-123';
      repository.saveSDKMessage('session-1', createAssistantMessage('Task started', toolUseId));
      repository.saveSDKMessage('session-1', createSubagentMessage('Subagent work', toolUseId));
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'thinking_tokens',
        parent_tool_use_id: toolUseId,
        estimated_tokens: 1,
        estimated_tokens_delta: 1,
        uuid: 'thinking-subagent',
        session_id: 'session-1',
      } as unknown as SDKMessage);

      const { messages } = repository.getSDKMessages('session-1');

      expect(messages.length).toBe(2);
      expect(
        messages.some((message) => (message as { subtype?: string }).subtype === 'thinking_tokens')
      ).toBe(false);
    });

    it('should not throw when an informational row has malformed JSON', () => {
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'informational',
        level: 'notice',
        content: 'will be corrupted',
        uuid: 'malformed-info',
        session_id: 'session-1',
      } as unknown as SDKMessage);
      db.prepare(
        `UPDATE sdk_messages
         SET sdk_message = ?
         WHERE message_subtype = 'informational'`
      ).run('{not-json');

      const { messages } = repository.getSDKMessages('session-1');

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('unknown');
      expect((messages[0] as { rawContent?: string }).rawContent).toBe('{not-json');
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
      for (let i = 0; i < 110; i++) {
        repository.saveSDKMessage('session-1', createUserMessage(`Message ${i}`));
      }

      const { messages, hasMore } = repository.getSDKMessages('session-1', 100);

      expect(messages.length).toBe(100);
      expect(hasMore).toBe(true);
    });

    it('should return hasMore=false when there are no more messages', () => {
      for (let i = 0; i < 50; i++) {
        repository.saveSDKMessage('session-1', createUserMessage(`Message ${i}`));
      }

      const { messages, hasMore } = repository.getSDKMessages('session-1', 100);

      expect(messages.length).toBe(50);
      expect(hasMore).toBe(false);
    });

    it('should return hasMore=true when exactly limit messages exist', () => {
      for (let i = 0; i < 100; i++) {
        repository.saveSDKMessage('session-1', createUserMessage(`Message ${i}`));
      }

      const { messages, hasMore } = repository.getSDKMessages('session-1', 100);

      expect(messages.length).toBe(100);
      expect(hasMore).toBe(true);
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

    describe('subagent page composition and hasMore (A1)', () => {
      function insertAssistantRow(
        sessionId: string,
        id: string,
        text: string,
        timestamp: string,
        parentToolUseId: string | null,
        toolUse?: { id: string; name: string }
      ): void {
        const blocks: Array<Record<string, string>> = [{ type: 'text', text }];
        if (toolUse) blocks.push({ type: 'tool_use', id: toolUse.id, name: toolUse.name });
        db.prepare(
          `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, parent_tool_use_id)
           VALUES (?, ?, 'assistant', ?, ?, ?)`
        ).run(
          id,
          sessionId,
          JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', content: blocks },
          }),
          timestamp,
          parentToolUseId
        );
      }

      function firstText(message: unknown): string | undefined {
        const content = (
          message as { message?: { content?: Array<{ type: string; text?: string }> } }
        ).message?.content;
        return (content ?? []).find((block) => block.type === 'text')?.text;
      }

      it('appends subagent rows after the whole top-level page even when they predate it', () => {
        const sessionId = 'session-compose';
        insertAssistantRow(sessionId, 'top-a', 'Top A', '2026-08-11T10:00:01.000Z', null, {
          id: 'tu-1',
          name: 'Task',
        });
        insertAssistantRow(sessionId, 'sub-1', 'Sub one', '2026-08-11T10:00:02.000Z', 'tu-1');
        insertAssistantRow(sessionId, 'sub-2', 'Sub two', '2026-08-11T10:00:03.000Z', 'tu-1');
        insertAssistantRow(sessionId, 'top-b', 'Top B', '2026-08-11T10:00:04.000Z', null);

        const { messages } = repository.getSDKMessages(sessionId);

        expect(messages.map(firstText)).toEqual(['Top A', 'Top B', 'Sub one', 'Sub two']);
      });

      it('orders same-timestamp subagent rows by rowid ascending', () => {
        const sessionId = 'session-compose-tie';
        insertAssistantRow(sessionId, 'top', 'Top', '2026-08-11T10:01:00.000Z', null, {
          id: 'tu-1',
          name: 'Task',
        });
        insertAssistantRow(sessionId, 'sub-1', 'Sub first', '2026-08-11T10:01:01.000Z', 'tu-1');
        insertAssistantRow(sessionId, 'sub-2', 'Sub second', '2026-08-11T10:01:01.000Z', 'tu-1');

        const { messages } = repository.getSDKMessages(sessionId);

        expect(messages.map(firstText)).toEqual(['Top', 'Sub first', 'Sub second']);
      });

      it('collects tool-use ids from the current page only — off-page tool uses fetch nothing', () => {
        const sessionId = 'session-compose-page';
        insertAssistantRow(sessionId, 'top-a', 'Top A', '2026-08-11T10:02:00.000Z', null, {
          id: 'tu-a',
          name: 'Task',
        });
        insertAssistantRow(sessionId, 'sub-a', 'Sub A', '2026-08-11T10:02:01.000Z', 'tu-a');
        insertAssistantRow(sessionId, 'top-b', 'Top B', '2026-08-11T10:03:00.000Z', null, {
          id: 'tu-b',
          name: 'Task',
        });
        insertAssistantRow(sessionId, 'sub-b', 'Sub B', '2026-08-11T10:03:01.000Z', 'tu-b');

        const { messages, hasMore } = repository.getSDKMessages(sessionId, 1);

        expect(messages.map(firstText)).toEqual(['Top B', 'Sub B']);
        expect(hasMore).toBe(true);
      });

      it('never reports hasMore from subagent fan-out alone', () => {
        const sessionId = 'session-compose-fanout';
        insertAssistantRow(sessionId, 'top', 'Top', '2026-08-11T10:04:00.000Z', null, {
          id: 'tu-1',
          name: 'Task',
        });
        for (let i = 1; i <= 5; i++) {
          insertAssistantRow(
            sessionId,
            `sub-${i}`,
            `Sub ${i}`,
            `2026-08-11T10:04:0${i}.000Z`,
            'tu-1'
          );
        }

        const { messages, hasMore } = repository.getSDKMessages(sessionId);

        expect(messages).toHaveLength(6);
        expect(hasMore).toBe(false);
      });

      it('keeps hasMore page-full semantics with subagent fan-out present', () => {
        const sessionId = 'session-compose-pagefull';
        insertAssistantRow(sessionId, 'top-a', 'Top A', '2026-08-11T10:05:00.000Z', null, {
          id: 'tu-1',
          name: 'Task',
        });
        for (let i = 1; i <= 3; i++) {
          insertAssistantRow(
            sessionId,
            `sub-${i}`,
            `Sub ${i}`,
            `2026-08-11T10:05:0${i}.000Z`,
            'tu-1'
          );
        }
        insertAssistantRow(sessionId, 'top-b', 'Top B', '2026-08-11T10:05:10.000Z', null);

        const { messages, hasMore } = repository.getSDKMessages(sessionId, 2);

        expect(messages).toHaveLength(5);
        expect(hasMore).toBe(true);
      });
    });
  });

  describe('getLastSDKMessage', () => {
    it('should return task progress rows for idle detection', () => {
      repository.saveSDKMessage('session-1', {
        type: 'result',
        subtype: 'success',
        duration_ms: 100,
        duration_api_ms: 50,
        is_error: false,
        num_turns: 1,
        result: 'Done',
        session_id: 'session-1',
        total_cost_usd: 0,
        usage: {},
      } as unknown as SDKMessage);
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'task_progress',
        uuid: 'task-progress',
        session_id: 'session-1',
        task_id: 'task-1',
      } as unknown as SDKMessage);

      const message = repository.getLastSDKMessage('session-1');

      expect(message?.type).toBe('system');
      expect((message as { subtype?: string } | null)?.subtype).toBe('task_progress');
    });

    it('should return task updated rows for idle detection', () => {
      repository.saveSDKMessage('session-1', createAssistantMessage('Done'));
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'task_updated',
        uuid: 'task-updated',
        session_id: 'session-1',
        task_id: 'task-1',
        patch: { status: 'running' },
      } as unknown as SDKMessage);

      const message = repository.getLastSDKMessage('session-1');

      expect(message?.type).toBe('system');
      expect((message as { subtype?: string } | null)?.subtype).toBe('task_updated');
    });

    it('should skip hidden state-only rows when finding the last SDK message', () => {
      repository.saveSDKMessage('session-1', {
        type: 'result',
        subtype: 'success',
        duration_ms: 100,
        duration_api_ms: 50,
        is_error: false,
        num_turns: 1,
        result: 'Done',
        session_id: 'session-1',
        total_cost_usd: 0,
        usage: {},
      } as unknown as SDKMessage);
      for (const subtype of ['session_state_changed', 'commands_changed', 'elicitation_complete']) {
        repository.saveSDKMessage('session-1', {
          type: 'system',
          subtype,
          uuid: `state-only-${subtype}`,
          session_id: 'session-1',
        } as unknown as SDKMessage);
      }

      const message = repository.getLastSDKMessage('session-1');

      expect(message?.type).toBe('result');
    });

    it('should skip model fallback notices when finding the last terminal message', () => {
      repository.saveSDKMessage('session-1', {
        type: 'result',
        subtype: 'success',
        duration_ms: 100,
        duration_api_ms: 50,
        is_error: false,
        num_turns: 1,
        result: 'Done after fallback',
        session_id: 'session-1',
        total_cost_usd: 0,
        usage: {},
      } as unknown as SDKMessage);
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'model_refusal_fallback',
        trigger: 'refusal',
        direction: 'retry',
        original_model: 'opus',
        fallback_model: 'sonnet',
        request_id: 'req-1',
        content: 'Retried with fallback model',
        uuid: 'fallback-notice',
        session_id: 'session-1',
      } as unknown as SDKMessage);

      const message = repository.getLastSDKMessage('session-1');

      expect(message?.type).toBe('result');
    });

    it('should tolerate malformed task progress rows when finding the last SDK message', () => {
      repository.saveSDKMessage('session-1', {
        type: 'result',
        subtype: 'success',
        duration_ms: 100,
        duration_api_ms: 50,
        is_error: false,
        num_turns: 1,
        result: 'Done',
        session_id: 'session-1',
        total_cost_usd: 0,
        usage: {},
      } as unknown as SDKMessage);
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'task_progress',
        uuid: 'task-progress',
        session_id: 'session-1',
        task_id: 'task-1',
      } as unknown as SDKMessage);
      db.prepare(
        `UPDATE sdk_messages
         SET sdk_message = ?
         WHERE message_subtype = 'task_progress'`
      ).run('{not-json');

      const message = repository.getLastSDKMessage('session-1');

      expect(message?.type).toBe('unknown');
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

    it('should exclude hidden system subtypes from count', () => {
      repository.saveSDKMessage('session-1', createUserMessage('Visible'));
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'session_state_changed',
        uuid: 'hidden-system',
        session_id: 'session-1',
      } as unknown as SDKMessage);

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

  describe('visible_message_count maintenance', () => {
    let badgeDb: Database;
    let badgeRepo: SDKMessageRepository;
    const SID = 'sess-badge';

    function createSession(id: string): void {
      badgeDb
        .prepare(
          `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata)
           VALUES (?, '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'active', '{}', '{}')`
        )
        .run(id);
    }

    function badgeCount(sessionId: string = SID): number {
      const row = badgeDb
        .prepare(`SELECT visible_message_count AS n FROM sessions WHERE id = ?`)
        .get(sessionId) as { n: number };
      return row.n;
    }

    function freshBadgeCount(sessionId: string = SID): number {
      const excluded = [
        'session_state_changed',
        'commands_changed',
        'task_started',
        'task_progress',
        'task_updated',
        'mirror_error',
        'elicitation_complete',
        'thinking_tokens',
      ]
        .map((s) => `'${s}'`)
        .join(',');
      const row = badgeDb
        .prepare(
          `SELECT COUNT(*) AS n FROM sdk_messages
            WHERE session_id = ?
              AND parent_tool_use_id IS NULL
              AND (message_type != 'user'
                   OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
              AND COALESCE(message_subtype, '') NOT IN (${excluded})`
        )
        .get(sessionId) as { n: number };
      return row.n;
    }

    function createActionMessage(uuid: string = crypto.randomUUID()): HyperNeoActionMessage {
      return {
        type: 'hyperneo_action',
        uuid,
        session_id: SID,
        action: 'sdk_resume_choice',
        resolved: false,
        timestamp: Date.now(),
      };
    }

    beforeEach(() => {
      badgeDb = new Database(':memory:');
      badgeDb.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_active_at TEXT NOT NULL,
          status TEXT NOT NULL,
          config TEXT NOT NULL,
          metadata TEXT NOT NULL,
          session_context TEXT,
          room_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.roomId') END) VIRTUAL,
          space_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.spaceId') END) VIRTUAL,
          task_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.taskId') END) VIRTUAL,
          type TEXT DEFAULT 'worker',
          visible_message_count INTEGER NOT NULL DEFAULT 0
        );
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
          task_id TEXT,
          conversation_turn_index INTEGER,
          consumed_seq INTEGER,
          sdk_uuid TEXT,
          replacement_metadata_normalized INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE sdk_message_replacements (
          source_message_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          task_id TEXT,
          target_uuid TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('superseded', 'retracted')),
          PRIMARY KEY (source_message_id, target_uuid, kind),
          FOREIGN KEY (source_message_id) REFERENCES sdk_messages(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_sdk_messages_session ON sdk_messages(session_id);
      `);
      badgeRepo = new SDKMessageRepository(badgeDb as any);
      createSession(SID);
    });

    afterEach(() => {
      badgeDb.close();
    });

    it('increments on a visible top-level SDK message', () => {
      badgeRepo.saveSDKMessage(SID, createAssistantMessage('hello'));
      expect(badgeCount()).toBe(1);
      expect(badgeCount()).toBe(freshBadgeCount());
    });

    it('does not increment for subagent (parent_tool_use_id) rows', () => {
      badgeRepo.saveSDKMessage(SID, createAssistantMessage('top', 'toolu_1'));
      badgeRepo.saveSDKMessage(SID, createSubagentMessage('sub', 'toolu_1'));
      expect(badgeCount()).toBe(1);
      expect(badgeCount()).toBe(freshBadgeCount());
    });

    it('does not increment for hidden system subtypes or thinking_tokens', () => {
      badgeRepo.saveSDKMessage(SID, {
        type: 'system',
        subtype: 'session_state_changed',
        uuid: 'u1',
      } as unknown as SDKMessage);
      badgeRepo.saveSDKMessage(SID, {
        type: 'system',
        subtype: 'thinking_tokens',
        uuid: 'u2',
      } as unknown as SDKMessage);
      badgeRepo.saveSDKMessage(SID, createAssistantMessage('visible'));
      expect(badgeCount()).toBe(1);
      expect(badgeCount()).toBe(freshBadgeCount());
    });

    it('counts consumed/failed user messages but not deferred/enqueued', () => {
      badgeRepo.saveUserMessage(SID, createUserMessage('sent'), 'consumed');
      badgeRepo.saveUserMessage(SID, createUserMessage('failed'), 'failed');
      badgeRepo.saveUserMessage(SID, createUserMessage('deferred'), 'deferred');
      badgeRepo.saveUserMessage(SID, createUserMessage('enqueued'), 'enqueued');
      expect(badgeCount()).toBe(2);
      expect(badgeCount()).toBe(freshBadgeCount());
    });

    it('recounts when send_status flips into or out of visibility', () => {
      const id = badgeRepo.saveUserMessage(SID, createUserMessage('queued'), 'deferred');
      expect(badgeCount()).toBe(0);
      badgeRepo.updateMessageStatus([id], 'consumed');
      expect(badgeCount()).toBe(1);
      badgeRepo.updateMessageStatus([id], 'enqueued');
      expect(badgeCount()).toBe(0);
      expect(badgeCount()).toBe(freshBadgeCount());
    });

    it('recounts when a conditional transition flips the row into visibility', () => {
      const id = badgeRepo.saveUserMessage(SID, createUserMessage('stalled'), 'enqueued');
      expect(badgeCount()).toBe(0);
      expect(badgeRepo.transitionMessageSendStatus(id, 'enqueued', 'failed')).toBe(true);
      expect(badgeCount()).toBe(1);
      expect(badgeCount()).toBe(freshBadgeCount());
    });

    it('leaves the badge untouched when a conditional transition loses', () => {
      const id = badgeRepo.saveUserMessage(SID, createUserMessage('already gone'), 'consumed');
      expect(badgeRepo.transitionMessageSendStatus(id, 'enqueued', 'failed')).toBe(false);
      expect(badgeCount()).toBe(1);
      expect(badgeCount()).toBe(freshBadgeCount());
    });

    it('increments for hyperneo_action messages', () => {
      badgeRepo.saveHyperNeoActionMessage(SID, createActionMessage());
      expect(badgeCount()).toBe(1);
      expect(badgeCount()).toBe(freshBadgeCount());
    });

    it('recomputes after rewind deletes messages', () => {
      badgeRepo.saveSDKMessage(SID, createAssistantMessage('a'));
      badgeRepo.saveSDKMessage(SID, createAssistantMessage('b'));
      badgeRepo.saveSDKMessage(SID, createAssistantMessage('c'));
      expect(badgeCount()).toBe(3);
      const earliest = badgeDb
        .prepare(`SELECT MIN(timestamp) AS t FROM sdk_messages WHERE session_id = ?`)
        .get(SID) as { t: string };
      badgeRepo.deleteMessagesAtAndAfter(SID, Date.parse(earliest.t));
      expect(badgeCount()).toBe(0);
      expect(badgeCount()).toBe(freshBadgeCount());
    });

    it('recomputeVisibleMessageCount repairs drift after a bypass insert', () => {
      const insertRaw = badgeDb.prepare(
        `INSERT INTO sdk_messages
           (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, parent_tool_use_id)
         VALUES (?, ?, ?, ?, ?, ?, 'consumed', NULL)`
      );
      insertRaw.run('raw-1', SID, 'assistant', null, '{}', '2026-01-01T00:00:00Z');
      insertRaw.run('raw-2', SID, 'user', null, '{}', '2026-01-01T00:00:01Z');
      expect(badgeCount()).toBe(0);
      expect(badgeRepo.recomputeVisibleMessageCount(SID)).toBe(true);
      expect(badgeCount()).toBe(2);
      expect(badgeCount()).toBe(freshBadgeCount());
      expect(badgeRepo.recomputeVisibleMessageCount(SID)).toBe(false);
    });

    it('stays consistent with a fresh COUNT(*) across a mixed sequence', () => {
      badgeRepo.saveSDKMessage(SID, createAssistantMessage('a'));
      badgeRepo.saveSDKMessage(SID, createSubagentMessage('sub', 'tu1'));
      const pending = badgeRepo.saveUserMessage(SID, createUserMessage('p'), 'enqueued');
      badgeRepo.saveUserMessage(SID, createUserMessage('q'), 'consumed');
      badgeRepo.updateMessageStatus([pending], 'consumed');
      badgeRepo.saveSDKMessage(SID, {
        type: 'system',
        subtype: 'task_progress',
        uuid: 'hidden',
      } as unknown as SDKMessage);
      expect(badgeCount()).toBe(freshBadgeCount());
      const mid = badgeDb
        .prepare(
          `SELECT timestamp FROM sdk_messages WHERE session_id = ? ORDER BY timestamp ASC LIMIT 1 OFFSET 2`
        )
        .get(SID) as { timestamp: string } | undefined;
      if (mid) badgeRepo.deleteMessagesAtAndAfter(SID, Date.parse(mid.timestamp));
      expect(badgeCount()).toBe(freshBadgeCount());
    });

    it('is a no-op without a sessions table (schema subset)', () => {
      const subsetDb = new Database(':memory:');
      subsetDb.exec(`
        CREATE TABLE sdk_messages (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_type TEXT NOT NULL,
          message_subtype TEXT, sdk_message TEXT NOT NULL, timestamp TEXT NOT NULL,
          send_status TEXT, origin TEXT, is_renderable INTEGER NOT NULL DEFAULT 1,
          is_terminal INTEGER NOT NULL DEFAULT 0, parent_tool_use_id TEXT, task_id TEXT,
          conversation_turn_index INTEGER, consumed_seq INTEGER,
          sdk_uuid TEXT, replacement_metadata_normalized INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE sdk_message_replacements (
          source_message_id TEXT NOT NULL, session_id TEXT NOT NULL, task_id TEXT,
          target_uuid TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('superseded','retracted')),
          PRIMARY KEY (source_message_id, target_uuid, kind)
        );
      `);
      const subsetRepo = new SDKMessageRepository(subsetDb as never);
      expect(() =>
        subsetRepo.saveSDKMessage('no-sessions', createAssistantMessage('x'))
      ).not.toThrow();
      expect(() =>
        subsetRepo.saveUserMessage('no-sessions', createUserMessage('y'), 'consumed')
      ).not.toThrow();
      subsetDb.close();
    });
  });

  describe('saveUserMessage', () => {
    it('should save user message with consumed status by default', () => {
      const message = createUserMessage('Test message');

      const id = repository.saveUserMessage('session-1', message);

      expect(id).toBeDefined();
      const deferredMessages = repository.getUserMessageIdsByStatus('session-1', 'consumed');
      expect(deferredMessages.length).toBe(1);
    });

    it('should save user message with specified status', () => {
      const message = createUserMessage('Test message');

      repository.saveUserMessage('session-1', message, 'deferred');

      const deferredMessages = repository.getUserMessageIdsByStatus('session-1', 'deferred');
      expect(deferredMessages.length).toBe(1);
    });

    it('should save user message with enqueued status', () => {
      const message = createUserMessage('Test message');

      repository.saveUserMessage('session-1', message, 'enqueued');

      const enqueuedMessages = repository.getUserMessageIdsByStatus('session-1', 'enqueued');
      expect(enqueuedMessages.length).toBe(1);
    });

    it('should return unique message ID', () => {
      const message1 = createUserMessage('Message 1');
      const message2 = createUserMessage('Message 2');

      const id1 = repository.saveUserMessage('session-1', message1);
      const id2 = repository.saveUserMessage('session-1', message2);

      expect(id1).not.toBe(id2);
    });

    it('commits the row and propagates a post-commit failure from runPostSaveSideEffects', () => {
      const failingReactiveDb = {
        resolveTaskIdForSession: () => null,
        willEmitTableChange: () => false,
        notifyChange: (table: string) => {
          if (table === 'sessions') throw new Error('sessions notify failed');
        },
      } as unknown as ReactiveDatabase;
      const repo = new SDKMessageRepository(db as any, failingReactiveDb);

      expect(() =>
        repo.saveUserMessage('session-1', createUserMessage('committed user'), 'consumed')
      ).toThrow('sessions notify failed');

      const row = db
        .prepare(`SELECT COUNT(*) AS count FROM sdk_messages WHERE session_id = ?`)
        .get('session-1') as { count: number };
      expect(row.count).toBe(1);
    });
  });

  describe('saveHyperNeoActionMessage', () => {
    function createActionMessage(uuid: string): HyperNeoActionMessage {
      return {
        type: 'hyperneo_action',
        uuid,
        session_id: 'session-1',
        action: 'sdk_resume_choice',
        resolved: false,
        timestamp: Date.now(),
      };
    }

    it('commits the row and propagates a post-commit failure from notifySessionsChanged', () => {
      const failingReactiveDb = {
        resolveTaskIdForSession: () => null,
        notifyChange: (table: string) => {
          if (table === 'sessions') throw new Error('sessions notify failed');
        },
      } as unknown as ReactiveDatabase;
      const repo = new SDKMessageRepository(db as any, failingReactiveDb);

      expect(() =>
        repo.saveHyperNeoActionMessage('session-1', createActionMessage('action-fail'))
      ).toThrow('sessions notify failed');

      const row = db
        .prepare(
          `SELECT COUNT(*) AS count FROM sdk_messages WHERE message_type = 'hyperneo_action'`
        )
        .get() as { count: number };
      expect(row.count).toBe(1);
    });
  });

  function insertStatusMessage(
    id: string,
    sessionId: string,
    messageType: string,
    sdkMessage: string,
    timestamp: string,
    status = 'consumed'
  ): void {
    db.prepare(
      `INSERT INTO sdk_messages
       (id, session_id, message_type, sdk_message, timestamp, send_status)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, sessionId, messageType, sdkMessage, timestamp, status);
  }

  describe('getUserMessagesByStatus', () => {
    function messageTexts(messages: SDKMessage[]): string[] {
      return messages.map((message) => {
        const content = (message as { message: { content: Array<{ text?: string }> } }).message
          .content;
        return content[0]?.text ?? '';
      });
    }

    it('returns the oldest bounded window and the full eligible total', () => {
      const timestamp = '2026-01-01T00:00:00.000Z';
      for (const [index, text] of ['First', 'Second', 'Third'].entries()) {
        insertStatusMessage(
          `user-${index}`,
          'session-1',
          'user',
          JSON.stringify(createUserMessage(text, `uuid-${index}`)),
          timestamp
        );
      }
      insertStatusMessage(
        'other-session',
        'session-2',
        'user',
        JSON.stringify(createUserMessage('Other session')),
        timestamp
      );
      insertStatusMessage(
        'other-status',
        'session-1',
        'user',
        JSON.stringify(createUserMessage('Other status')),
        timestamp,
        'deferred'
      );

      const result = repository.getUserMessagesByStatus('session-1', 'consumed', 2);

      expect(messageTexts(result.messages)).toEqual(['First', 'Second']);
      expect(result.messages.map((message) => message.dbId)).toEqual(['user-0', 'user-1']);
      expect(result.total).toBe(3);
    });

    it('skips malformed, mismatched, and replay user rows', () => {
      const timestamp = '2026-01-01T00:00:00.000Z';
      const rows: Array<[string, string, string]> = [
        ['user', 'user', JSON.stringify(createUserMessage('User'))],
        [
          'non-replay',
          'user',
          JSON.stringify({ ...createUserMessage('Non-replay'), isReplay: false }),
        ],
        ['replay', 'user', JSON.stringify({ ...createUserMessage('Replay'), isReplay: true })],
        ['null-replay', 'user', JSON.stringify({ ...createUserMessage('Null'), isReplay: null })],
        ['assistant', 'assistant', JSON.stringify(createAssistantMessage('Assistant'))],
        ['mismatched', 'user', JSON.stringify(createAssistantMessage('Mismatched'))],
        ['malformed', 'user', '{not-json'],
      ];
      for (const [id, messageType, sdkMessage] of rows) {
        insertStatusMessage(id, 'session-1', messageType, sdkMessage, timestamp);
      }

      const result = repository.getUserMessagesByStatus('session-1', 'consumed', 20);

      expect(result.messages.map((message) => message.dbId)).toEqual(['user', 'non-replay']);
      expect(result.total).toBe(2);
    });

    it('hydrates multiple chunks without changing projected order', () => {
      const insert = db.prepare(
        `INSERT INTO sdk_messages
         (id, session_id, message_type, sdk_message, timestamp, send_status)
         VALUES (?, 'session-1', 'user', ?, ?, 'consumed')`
      );
      db.transaction(() => {
        for (let index = 0; index < 901; index++) {
          insert.run(
            `message-${index.toString().padStart(4, '0')}`,
            JSON.stringify(createUserMessage(`Message ${index}`, `uuid-${index}`)),
            new Date(index).toISOString()
          );
        }
      })();

      const result = repository.getUserMessagesByStatus('session-1', 'consumed', 901);

      expect(result.messages).toHaveLength(901);
      expect(result.total).toBe(901);
      expect(result.messages.map((message) => message.dbId)).toEqual(
        Array.from({ length: 901 }, (_, index) => `message-${index.toString().padStart(4, '0')}`)
      );
    });

    it('returns the full eligible window when no limit is given', () => {
      const timestamp = '2026-01-01T00:00:00.000Z';
      for (const [index, text] of ['First', 'Second', 'Third'].entries()) {
        insertStatusMessage(
          `user-${index}`,
          'session-1',
          'user',
          JSON.stringify(createUserMessage(text, `uuid-${index}`)),
          timestamp,
          'deferred'
        );
      }

      const result = repository.getUserMessagesByStatus('session-1', 'deferred');

      expect(messageTexts(result.messages)).toEqual(['First', 'Second', 'Third']);
      expect(result.total).toBe(3);
    });

    it('returns an empty window and zero total for a non-matching status', () => {
      const timestamp = '2026-01-01T00:00:00.000Z';
      insertStatusMessage(
        'user',
        'session-1',
        'user',
        JSON.stringify(createUserMessage('Held back')),
        timestamp,
        'deferred'
      );

      const result = repository.getUserMessagesByStatus('session-1', 'enqueued');

      expect(result.messages).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('returns the newest bounded window when direction is desc', () => {
      const timestamp = '2026-01-01T00:00:00.000Z';
      for (const [index, text] of ['First', 'Second', 'Third'].entries()) {
        insertStatusMessage(
          `user-${index}`,
          'session-1',
          'user',
          JSON.stringify(createUserMessage(text, `uuid-${index}`)),
          timestamp
        );
      }

      const result = repository.getUserMessagesByStatus('session-1', 'consumed', 2, 'desc');

      expect(messageTexts(result.messages)).toEqual(['Third', 'Second']);
      expect(result.messages.map((message) => message.dbId)).toEqual(['user-2', 'user-1']);
      expect(result.total).toBe(3);
    });
  });

  describe('getMessageByStatusAndDbId', () => {
    it('returns the single message matching the status and db id', () => {
      const id = repository.saveUserMessage(
        'session-1',
        createUserMessage('promote me', 'uuid-promote'),
        'deferred'
      );

      const message = repository.getMessageByStatusAndDbId('session-1', 'deferred', id);

      expect(message?.dbId).toBe(id);
      expect(message?.uuid).toBe('uuid-promote');
    });

    it('returns null when the db id exists under a different status', () => {
      const id = repository.saveUserMessage(
        'session-1',
        createUserMessage('already sent', 'uuid-sent'),
        'consumed'
      );

      expect(repository.getMessageByStatusAndDbId('session-1', 'deferred', id)).toBeNull();
    });

    it('returns null when the db id does not exist', () => {
      expect(
        repository.getMessageByStatusAndDbId('session-1', 'deferred', 'no-such-id')
      ).toBeNull();
    });

    it('returns null for another session db id', () => {
      const id = repository.saveUserMessage(
        'session-2',
        createUserMessage('other session', 'uuid-other'),
        'deferred'
      );

      expect(repository.getMessageByStatusAndDbId('session-1', 'deferred', id)).toBeNull();
    });
  });

  describe('getMessageByStatusAndUuid', () => {
    it('returns the oldest row when several rows share the uuid', () => {
      const insert = db.prepare(
        `INSERT INTO sdk_messages
         (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
         VALUES (?, 'session-1', 'user', ?, ?, 'enqueued', 'dup-uuid')`
      );
      insert.run(
        'dup-new',
        JSON.stringify(createUserMessage('Newer', 'dup-uuid')),
        '2026-01-02T00:00:00.000Z'
      );
      insert.run(
        'dup-old',
        JSON.stringify(createUserMessage('Older', 'dup-uuid')),
        '2026-01-01T00:00:00.000Z'
      );

      const message = repository.getMessageByStatusAndUuid('session-1', 'enqueued', 'dup-uuid');

      expect(message?.dbId).toBe('dup-old');
    });
  });

  describe('getUserMessageIdsByStatus', () => {
    function insertIndexedStatusMessage(
      id: string,
      sessionId: string,
      sdkMessage: string,
      uuid: string,
      timestamp: string,
      status: string
    ): void {
      db.prepare(
        `INSERT INTO sdk_messages
         (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
         VALUES (?, ?, 'user', ?, ?, ?, ?)`
      ).run(id, sessionId, sdkMessage, timestamp, status, uuid);
    }

    it('returns id, uuid, and timestamp without inflating payloads, in order', () => {
      const timestamp = '2026-01-01T00:00:00.000Z';
      for (const [index, text] of ['First', 'Second'].entries()) {
        insertIndexedStatusMessage(
          `user-${index}`,
          'session-1',
          JSON.stringify(createUserMessage(text, `uuid-${index}`)),
          `uuid-${index}`,
          timestamp,
          'deferred'
        );
      }

      const rows = repository.getUserMessageIdsByStatus('session-1', 'deferred');

      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        dbId: 'user-0',
        uuid: 'uuid-0',
        timestamp: new Date(timestamp).getTime(),
      });
      expect(rows.map((row) => row.dbId)).toEqual(['user-0', 'user-1']);
      expect(Object.keys(rows[0]).sort()).toEqual(['dbId', 'timestamp', 'uuid']);
    });

    it('filters to eligible user rows and skips replays and other statuses', () => {
      const timestamp = '2026-01-01T00:00:00.000Z';
      insertStatusMessage(
        'user',
        'session-1',
        'user',
        JSON.stringify(createUserMessage('User', 'uuid-user')),
        timestamp,
        'enqueued'
      );
      insertStatusMessage(
        'replay',
        'session-1',
        'user',
        JSON.stringify({ ...createUserMessage('Replay', 'uuid-replay'), isReplay: true }),
        timestamp,
        'enqueued'
      );
      insertStatusMessage(
        'assistant',
        'session-1',
        'assistant',
        JSON.stringify(createAssistantMessage('Assistant')),
        timestamp,
        'enqueued'
      );
      insertStatusMessage(
        'other-status',
        'session-1',
        'user',
        JSON.stringify(createUserMessage('Deferred', 'uuid-deferred')),
        timestamp,
        'deferred'
      );
      insertStatusMessage(
        'other-session',
        'session-2',
        'user',
        JSON.stringify(createUserMessage('Other', 'uuid-other')),
        timestamp,
        'enqueued'
      );

      const rows = repository.getUserMessageIdsByStatus('session-1', 'enqueued');

      expect(rows.map((row) => row.dbId)).toEqual(['user']);
    });

    it('returns an empty array for a non-matching status', () => {
      repository.saveUserMessage('session-1', createUserMessage('Test'), 'deferred');

      expect(repository.getUserMessageIdsByStatus('session-1', 'enqueued')).toEqual([]);
    });
  });

  describe('updateMessageStatus', () => {
    it('should update status for specified message IDs', () => {
      const id1 = repository.saveUserMessage('session-1', createUserMessage('Msg 1'), 'deferred');
      const id2 = repository.saveUserMessage('session-1', createUserMessage('Msg 2'), 'deferred');

      repository.updateMessageStatus([id1, id2], 'enqueued');

      const enqueuedMessages = repository.getUserMessageIdsByStatus('session-1', 'enqueued');
      expect(enqueuedMessages.length).toBe(2);
    });

    it('should not throw when given empty array', () => {
      expect(() => repository.updateMessageStatus([], 'consumed')).not.toThrow();
    });

    it('should transition from deferred to enqueued to consumed', () => {
      const id = repository.saveUserMessage('session-1', createUserMessage('Test'), 'deferred');

      repository.updateMessageStatus([id], 'enqueued');
      expect(repository.getUserMessageIdsByStatus('session-1', 'enqueued').length).toBe(1);

      repository.updateMessageStatus([id], 'consumed');
      expect(repository.getUserMessageIdsByStatus('session-1', 'consumed').length).toBe(1);
      expect(repository.getUserMessageIdsByStatus('session-1', 'enqueued').length).toBe(0);
    });
  });

  describe('transitionMessageSendStatus — atomic conditional transition', () => {
    function sendStatusOf(dbId: string): string | null {
      return (
        db.prepare(`SELECT send_status FROM sdk_messages WHERE id = ?`).get(dbId) as {
          send_status: string | null;
        }
      ).send_status;
    }

    it('wins the deferred → enqueued promotion when the row is still deferred', () => {
      const dbId = repository.saveUserMessage(
        'session-cas',
        createUserMessage('promote me', 'uuid-cas-promote'),
        'deferred'
      );

      expect(repository.transitionMessageSendStatus(dbId, 'deferred', 'enqueued')).toBe(true);
      expect(sendStatusOf(dbId)).toBe('enqueued');
    });

    it('loses and leaves the row untouched when a concurrent flush already advanced it', () => {
      for (const status of ['submitted', 'consumed', 'failed', 'enqueued'] as const) {
        const dbId = repository.saveUserMessage(
          'session-cas-lost',
          createUserMessage(`already ${status}`, `uuid-cas-lost-${status}`),
          status
        );

        expect(repository.transitionMessageSendStatus(dbId, 'deferred', 'enqueued')).toBe(false);
        expect(sendStatusOf(dbId)).toBe(status);
      }
    });

    it('loses for an unknown message id', () => {
      expect(repository.transitionMessageSendStatus('no-such-id', 'deferred', 'enqueued')).toBe(
        false
      );
    });

    it('is one-shot: a second promotion attempt on the enqueued row loses', () => {
      const dbId = repository.saveUserMessage(
        'session-cas-oneshot',
        createUserMessage('once only', 'uuid-cas-oneshot'),
        'deferred'
      );

      expect(repository.transitionMessageSendStatus(dbId, 'deferred', 'enqueued')).toBe(true);
      expect(repository.transitionMessageSendStatus(dbId, 'deferred', 'enqueued')).toBe(false);
      expect(sendStatusOf(dbId)).toBe('enqueued');
    });

    it('serves the enqueued → deferred failure-revert and refuses to regress advanced rows', () => {
      const dbId = repository.saveUserMessage(
        'session-cas-revert',
        createUserMessage('revert me', 'uuid-cas-revert'),
        'enqueued'
      );

      expect(repository.transitionMessageSendStatus(dbId, 'enqueued', 'deferred')).toBe(true);
      expect(sendStatusOf(dbId)).toBe('deferred');

      repository.updateMessageStatus([dbId], 'enqueued');
      repository.updateMessageStatus([dbId], 'submitted');
      expect(repository.transitionMessageSendStatus(dbId, 'enqueued', 'deferred')).toBe(false);
      expect(sendStatusOf(dbId)).toBe('submitted');
    });
  });

  describe('markDeliveryConsumedByUuid (task #861 item 12 — synchronous consumed-flip)', () => {
    it('flips an enqueued row to consumed and returns its db id', () => {
      const id = repository.saveUserMessage(
        'session-1',
        createUserMessage('consume me', 'uuid-consume'),
        'enqueued'
      );

      const flipped = repository.markDeliveryConsumedByUuid('session-1', 'uuid-consume');

      expect(flipped).toBe(id);
      expect(repository.getUserMessageIdsByStatus('session-1', 'enqueued').length).toBe(0);
      expect(repository.getUserMessageIdsByStatus('session-1', 'consumed').length).toBe(1);
    });

    it('is idempotent: a second call returns null (already consumed, no double-flip)', () => {
      repository.saveUserMessage(
        'session-1',
        createUserMessage('once only', 'uuid-once'),
        'enqueued'
      );

      expect(repository.markDeliveryConsumedByUuid('session-1', 'uuid-once')).not.toBeNull();
      expect(repository.markDeliveryConsumedByUuid('session-1', 'uuid-once')).toBeNull();
    });

    it('does not flip a deferred row (not a consume candidate)', () => {
      repository.saveUserMessage(
        'session-1',
        createUserMessage('still deferred', 'uuid-def'),
        'deferred'
      );
      expect(repository.markDeliveryConsumedByUuid('session-1', 'uuid-def')).toBeNull();
      expect(repository.getUserMessageIdsByStatus('session-1', 'deferred').length).toBe(1);
    });

    it('returns null when the uuid is unknown', () => {
      expect(repository.markDeliveryConsumedByUuid('session-1', 'no-such-uuid')).toBeNull();
    });

    it('markDeliveryConsumedByUuids flips kickoff + members in one atomic call', () => {
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          session_context TEXT,
          room_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.roomId') END) VIRTUAL,
          space_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.spaceId') END) VIRTUAL,
          task_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.taskId') END) VIRTUAL,
          type TEXT
        );
        INSERT INTO sessions (id, session_context, type)
        VALUES ('session-1', '{"taskId":"task-1"}', 'space_task_agent');
      `);
      const kickoffId = repository.saveUserMessage(
        'session-1',
        createUserMessage('kickoff', 'uuid-kick'),
        'enqueued'
      );
      const memberId = repository.saveUserMessage(
        'session-1',
        createUserMessage('member', 'uuid-member'),
        'enqueued'
      );
      repository.saveUserMessage(
        'session-1',
        createUserMessage('deferred member', 'uuid-def-member'),
        'deferred'
      );

      const flipped = repository.markDeliveryConsumedByUuids('session-1', [
        'uuid-kick',
        'uuid-member',
        'uuid-def-member',
        'uuid-kick',
      ]);

      expect(flipped.sort()).toEqual([kickoffId, memberId].sort());
      expect(repository.getUserMessageIdsByStatus('session-1', 'enqueued').length).toBe(0);
      expect(repository.getUserMessageIdsByStatus('session-1', 'consumed').length).toBe(2);
      expect(repository.getUserMessageIdsByStatus('session-1', 'deferred').length).toBe(1);
      const turns = db
        .prepare(
          'SELECT DISTINCT conversation_turn_index AS turn FROM sdk_messages WHERE id IN (?, ?)'
        )
        .all(kickoffId, memberId) as Array<{ turn: number | null }>;
      expect(turns).toHaveLength(1);
      expect(turns[0]?.turn).not.toBeNull();
    });

    it('markDeliveryFailedByUuidInclusive does NOT fail a deferred row (user hold survives dead-letter)', () => {
      repository.saveUserMessage(
        'session-1',
        createUserMessage('excluded member', 'uuid-excl'),
        'deferred'
      );
      expect(repository.markDeliveryFailedByUuidInclusive('session-1', 'uuid-excl')).toBeNull();
      expect(repository.getUserMessageIdsByStatus('session-1', 'deferred').length).toBe(1);
    });
  });

  describe('markDeliveryFailedByUuid — exclusive dead-letter window (A1)', () => {
    function sendStatusOf(dbId: string): string | null {
      return (
        db.prepare(`SELECT send_status FROM sdk_messages WHERE id = ?`).get(dbId) as {
          send_status: string | null;
        }
      ).send_status;
    }

    it('fails enqueued, deferred, and submitted rows — the exclusive window includes deferred', () => {
      for (const status of ['enqueued', 'deferred', 'submitted'] as const) {
        const sessionId = `session-fail-${status}`;
        const dbId = repository.saveUserMessage(
          sessionId,
          createUserMessage(`held ${status}`, `uuid-fail-${status}`),
          status
        );

        expect(repository.markDeliveryFailedByUuid(sessionId, `uuid-fail-${status}`)).toBe(dbId);
        expect(sendStatusOf(dbId)).toBe('failed');
      }
    });

    it('leaves consumed and failed rows untouched — consumed is the excluded status', () => {
      for (const status of ['consumed', 'failed'] as const) {
        const sessionId = `session-keep-${status}`;
        const dbId = repository.saveUserMessage(
          sessionId,
          createUserMessage(`settled ${status}`, `uuid-keep-${status}`),
          status
        );

        expect(repository.markDeliveryFailedByUuid(sessionId, `uuid-keep-${status}`)).toBeNull();
        expect(sendStatusOf(dbId)).toBe(status);
      }
    });

    it('is a one-shot flip: a second call on the failed row returns null', () => {
      const dbId = repository.saveUserMessage(
        'session-oneshot',
        createUserMessage('flip me', 'uuid-oneshot'),
        'enqueued'
      );

      expect(repository.markDeliveryFailedByUuid('session-oneshot', 'uuid-oneshot')).toBe(dbId);
      expect(repository.markDeliveryFailedByUuid('session-oneshot', 'uuid-oneshot')).toBeNull();
      expect(sendStatusOf(dbId)).toBe('failed');
    });

    it('returns null for unknown uuids, other sessions, and non-user rows', () => {
      repository.saveUserMessage(
        'session-scope',
        createUserMessage('scoped', 'uuid-scoped'),
        'enqueued'
      );
      repository.saveSDKMessage('session-scope', {
        type: 'assistant',
        uuid: 'uuid-assistant-row',
        message: { role: 'assistant', content: [{ type: 'text', text: 'assistant row' }] },
      } as unknown as SDKMessage);

      expect(repository.markDeliveryFailedByUuid('session-scope', 'no-such-uuid')).toBeNull();
      expect(repository.markDeliveryFailedByUuid('session-other', 'uuid-scoped')).toBeNull();
      expect(repository.markDeliveryFailedByUuid('session-scope', 'uuid-assistant-row')).toBeNull();
    });
  });

  describe('markDeliveryRetryableByUuid (recoverable no-result turn → retry re-feed)', () => {
    it('flips a consumed row back to enqueued and returns its db id', () => {
      const id = repository.saveUserMessage(
        'session-1',
        createUserMessage('retry me', 'uuid-retry'),
        'enqueued'
      );
      expect(repository.markDeliveryConsumedByUuid('session-1', 'uuid-retry')).toBe(id);

      const reopened = repository.markDeliveryRetryableByUuid('session-1', 'uuid-retry');

      expect(reopened).toBe(id);
      expect(repository.getUserMessageIdsByStatus('session-1', 'enqueued').length).toBe(1);
      expect(repository.getUserMessageIdsByStatus('session-1', 'consumed').length).toBe(0);
    });

    it('leaves submitted (ACP, pending acceptance) and failed rows alone', () => {
      repository.saveUserMessage(
        'session-1',
        createUserMessage('acp prompt', 'uuid-submitted'),
        'submitted'
      );
      repository.saveUserMessage(
        'session-1',
        createUserMessage('already dead', 'uuid-failed'),
        'failed'
      );

      expect(repository.markDeliveryRetryableByUuid('session-1', 'uuid-submitted')).toBeNull();
      expect(repository.markDeliveryRetryableByUuid('session-1', 'uuid-failed')).toBeNull();
      expect(repository.getUserMessageIdsByStatus('session-1', 'submitted').length).toBe(1);
      expect(repository.getUserMessageIdsByStatus('session-1', 'failed').length).toBe(1);
    });

    it('returns null when the uuid is unknown', () => {
      expect(repository.markDeliveryRetryableByUuid('session-1', 'no-such-uuid')).toBeNull();
    });
  });

  describe('delivery-transition window matrix — accepted from-statuses for every uuid-keyed wrapper (C1)', () => {
    const ALL_STATUSES = ['deferred', 'enqueued', 'submitted', 'consumed', 'failed'] as const;
    type FromStatus = (typeof ALL_STATUSES)[number];

    function sendStatusOf(dbId: string): string | null {
      return (
        db.prepare(`SELECT send_status FROM sdk_messages WHERE id = ?`).get(dbId) as {
          send_status: string | null;
        }
      ).send_status;
    }

    function seed(status: FromStatus): { sessionId: string; uuid: string; dbId: string } {
      const key = `${status}-${crypto.randomUUID().slice(0, 8)}`;
      const sessionId = `matrix-session-${key}`;
      const uuid = `matrix-uuid-${key}`;
      const dbId = repository.saveUserMessage(
        sessionId,
        createUserMessage(`matrix member ${status}`, uuid),
        status
      );
      return { sessionId, uuid, dbId };
    }

    const CASES: Array<{
      wrapper: string;
      accepted: readonly FromStatus[];
      target: FromStatus;
      invoke: (sessionId: string, uuid: string) => string | null;
    }> = [
      {
        wrapper: 'markDeliveryFailedByUuid',
        accepted: ['enqueued', 'deferred', 'submitted'],
        target: 'failed',
        invoke: (sessionId, uuid) => repository.markDeliveryFailedByUuid(sessionId, uuid),
      },
      {
        wrapper: 'markDeliveryFailedByUuidInclusive',
        accepted: ['enqueued', 'submitted', 'consumed'],
        target: 'failed',
        invoke: (sessionId, uuid) => repository.markDeliveryFailedByUuidInclusive(sessionId, uuid),
      },
      {
        wrapper: 'markDeliveryConsumedByUuid',
        accepted: ['enqueued', 'submitted'],
        target: 'consumed',
        invoke: (sessionId, uuid) => repository.markDeliveryConsumedByUuid(sessionId, uuid),
      },
      {
        wrapper: 'markDeliverySubmittedByUuids',
        accepted: ['enqueued'],
        target: 'submitted',
        invoke: (sessionId, uuid) =>
          repository.markDeliverySubmittedByUuids(sessionId, [uuid])[0] ?? null,
      },
      {
        wrapper: 'reopenDeliveryByUuid',
        accepted: ['failed'],
        target: 'enqueued',
        invoke: (sessionId, uuid) => repository.reopenDeliveryByUuid(sessionId, uuid),
      },
      {
        wrapper: 'markDeliveryRetryableByUuid',
        accepted: ['consumed'],
        target: 'enqueued',
        invoke: (sessionId, uuid) => repository.markDeliveryRetryableByUuid(sessionId, uuid),
      },
      {
        wrapper: 'markDeliveryDeferredByUuid',
        accepted: ['enqueued'],
        target: 'deferred',
        invoke: (sessionId, uuid) => repository.markDeliveryDeferredByUuid(sessionId, uuid),
      },
    ];

    for (const { wrapper, accepted, target, invoke } of CASES) {
      it(`${wrapper}: ${accepted.join('/')} → ${target}; every other from-status is a null no-op`, () => {
        for (const status of ALL_STATUSES) {
          const { sessionId, uuid, dbId } = seed(status);
          const isAccepted = accepted.includes(status);

          expect(invoke(sessionId, uuid)).toBe(isAccepted ? dbId : null);
          expect(sendStatusOf(dbId)).toBe(isAccepted ? target : status);
        }
      });
    }

    it('markDeliverySubmittedByUuids skips per-uuid: mixed from-statuses flip only the enqueued members', () => {
      const sessionId = 'matrix-submitted-mixed';
      const enqueuedId = repository.saveUserMessage(
        sessionId,
        createUserMessage('submit me', 'uuid-mix-enq'),
        'enqueued'
      );
      const deferredId = repository.saveUserMessage(
        sessionId,
        createUserMessage('hold me', 'uuid-mix-def'),
        'deferred'
      );
      const submittedId = repository.saveUserMessage(
        sessionId,
        createUserMessage('already submitted', 'uuid-mix-sub'),
        'submitted'
      );

      expect(
        repository.markDeliverySubmittedByUuids(sessionId, [
          'uuid-mix-def',
          'uuid-mix-enq',
          'uuid-mix-sub',
          'uuid-mix-enq',
        ])
      ).toEqual([enqueuedId]);
      expect(sendStatusOf(enqueuedId)).toBe('submitted');
      expect(sendStatusOf(deferredId)).toBe('deferred');
      expect(sendStatusOf(submittedId)).toBe('submitted');
    });

    it('the previously-uncovered wrappers stay session-scoped and user-only — assistant probe rows carry in-window send_status so only the type filter excludes them', () => {
      const sessionId = 'matrix-scope';
      const scopedId = repository.saveUserMessage(
        sessionId,
        createUserMessage('scoped member', 'uuid-matrix-scope'),
        'enqueued'
      );
      const failedId = repository.saveUserMessage(
        sessionId,
        createUserMessage('failed member', 'uuid-matrix-scope-failed'),
        'enqueued'
      );
      repository.markDeliveryFailedByUuid(sessionId, 'uuid-matrix-scope-failed');
      const insertAssistantRow = (id: string, uuid: string, sendStatus: string): void => {
        db.prepare(
          `INSERT INTO sdk_messages (
             id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid,
             replacement_metadata_normalized
           ) VALUES (?, ?, 'assistant', ?, ?, ?, ?, 1)`
        ).run(
          id,
          sessionId,
          JSON.stringify({
            type: 'assistant',
            uuid,
            message: { role: 'assistant', content: [{ type: 'text', text: 'assistant row' }] },
          }),
          new Date().toISOString(),
          sendStatus,
          uuid
        );
      };
      insertAssistantRow('matrix-assistant-enq', 'uuid-matrix-assistant-enq', 'enqueued');
      insertAssistantRow('matrix-assistant-failed', 'uuid-matrix-assistant-failed', 'failed');

      expect(repository.markDeliverySubmittedByUuids(sessionId, ['no-such-uuid'])).toEqual([]);
      expect(
        repository.markDeliverySubmittedByUuids(sessionId, ['uuid-matrix-assistant-enq'])
      ).toEqual([]);
      expect(
        repository.markDeliverySubmittedByUuids('matrix-other-session', ['uuid-matrix-scope'])
      ).toEqual([]);

      expect(repository.reopenDeliveryByUuid(sessionId, 'no-such-uuid')).toBeNull();
      expect(repository.reopenDeliveryByUuid(sessionId, 'uuid-matrix-assistant-failed')).toBeNull();
      expect(
        repository.reopenDeliveryByUuid('matrix-other-session', 'uuid-matrix-scope-failed')
      ).toBeNull();
      expect(sendStatusOf(failedId)).toBe('failed');

      expect(repository.markDeliveryDeferredByUuid(sessionId, 'no-such-uuid')).toBeNull();
      expect(
        repository.markDeliveryDeferredByUuid(sessionId, 'uuid-matrix-assistant-enq')
      ).toBeNull();
      expect(
        repository.markDeliveryDeferredByUuid('matrix-other-session', 'uuid-matrix-scope')
      ).toBeNull();
      expect(sendStatusOf(scopedId)).toBe('enqueued');
    });
  });

  describe('deferEnqueuedUserMessage — dbId-keyed enqueued → deferred (C1)', () => {
    function sendStatusOf(dbId: string): string | null {
      return (
        db.prepare(`SELECT send_status FROM sdk_messages WHERE id = ?`).get(dbId) as {
          send_status: string | null;
        }
      ).send_status;
    }

    it('flips an enqueued row to deferred and returns {dbId, uuid}', () => {
      const dbId = repository.saveUserMessage(
        'session-defer-by-id',
        createUserMessage('defer by id', 'uuid-defer-by-id'),
        'enqueued'
      );

      expect(repository.deferEnqueuedUserMessage('session-defer-by-id', dbId)).toEqual({
        dbId,
        uuid: 'uuid-defer-by-id',
      });
      expect(repository.getUserMessageIdsByStatus('session-defer-by-id', 'deferred')).toHaveLength(
        1
      );
      expect(repository.getUserMessageIdsByStatus('session-defer-by-id', 'enqueued')).toHaveLength(
        0
      );
    });

    it('returns an empty-string uuid when the payload carries none', () => {
      const dbId = repository.saveUserMessage(
        'session-defer-no-uuid',
        {
          type: 'user',
          message: { role: 'user', content: 'no uuid payload' },
        } as unknown as SDKMessage,
        'enqueued'
      );

      expect(repository.deferEnqueuedUserMessage('session-defer-no-uuid', dbId)).toEqual({
        dbId,
        uuid: '',
      });
    });

    it('accepts only enqueued rows — every other from-status is a null no-op', () => {
      for (const status of ['deferred', 'submitted', 'consumed', 'failed'] as const) {
        const sessionId = `defer-window-${status}`;
        const dbId = repository.saveUserMessage(
          sessionId,
          createUserMessage(`held ${status}`, `uuid-defer-window-${status}`),
          status
        );

        expect(repository.deferEnqueuedUserMessage(sessionId, dbId)).toBeNull();
        expect(sendStatusOf(dbId)).toBe(status);
      }
    });

    it('is one-shot: a second call on the deferred row returns null', () => {
      const dbId = repository.saveUserMessage(
        'session-defer-oneshot',
        createUserMessage('once only', 'uuid-defer-oneshot'),
        'enqueued'
      );

      expect(repository.deferEnqueuedUserMessage('session-defer-oneshot', dbId)).toEqual({
        dbId,
        uuid: 'uuid-defer-oneshot',
      });
      expect(repository.deferEnqueuedUserMessage('session-defer-oneshot', dbId)).toBeNull();
      expect(sendStatusOf(dbId)).toBe('deferred');
    });

    it('looks up by dbId within the session — unknown ids, other sessions, and non-user rows return null', () => {
      const sessionId = 'session-defer-scope';
      const scopedId = repository.saveUserMessage(
        sessionId,
        createUserMessage('scoped', 'uuid-defer-scope'),
        'enqueued'
      );
      repository.saveSDKMessage(sessionId, createAssistantMessage('assistant row'));
      const assistantRowId = (
        db
          .prepare(
            `SELECT id FROM sdk_messages WHERE session_id = ? AND message_type = 'assistant'`
          )
          .get(sessionId) as { id: string }
      ).id;

      expect(repository.deferEnqueuedUserMessage(sessionId, 'no-such-id')).toBeNull();
      expect(repository.deferEnqueuedUserMessage('session-defer-other', scopedId)).toBeNull();
      expect(repository.deferEnqueuedUserMessage(sessionId, assistantRowId)).toBeNull();
      expect(sendStatusOf(scopedId)).toBe('enqueued');
    });
  });

  describe('turn-end batch semantics — result prerequisite, first-uuid all-or-nothing, shared watermark (C1)', () => {
    function rowOf(dbId: string): { status: string | null; seq: number | null } {
      return db
        .prepare(`SELECT send_status AS status, consumed_seq AS seq FROM sdk_messages WHERE id = ?`)
        .get(dbId) as { status: string | null; seq: number | null };
    }

    function seedEnqueued(sessionId: string, uuid: string): string {
      return repository.saveUserMessage(
        sessionId,
        createUserMessage(`turn-end ${uuid}`, uuid),
        'enqueued'
      );
    }

    function saveSuccessResult(sessionId: string, resultUuid: string): number {
      repository.saveSDKMessage(sessionId, {
        type: 'result',
        subtype: 'success',
        uuid: resultUuid,
        parent_tool_use_id: null,
      } as unknown as SDKMessage);
      return (
        db.prepare(`SELECT consumed_seq FROM sdk_messages WHERE sdk_uuid = ?`).get(resultUuid) as {
          consumed_seq: number;
        }
      ).consumed_seq;
    }

    it('returns empty without inspecting any delivery when the result uuid is unknown — even with eligible members', () => {
      const sessionId = 'session-te-unknown-result';
      const kickoffId = seedEnqueued(sessionId, 'te-unknown-1');

      expect(
        repository.markDeliveriesConsumedAtTurnEnd(sessionId, ['te-unknown-1'], 'no-such-result')
      ).toEqual({ ids: [], uuids: [] });
      expect(rowOf(kickoffId).status).toBe('enqueued');
    });

    it('returns empty when the success terminal result carries a NULL consumption watermark (migrated row)', () => {
      const sessionId = 'session-te-unsequenced';
      const kickoffId = seedEnqueued(sessionId, 'te-unseq-1');
      db.prepare(
        `INSERT INTO sdk_messages (
           id, session_id, message_type, message_subtype, sdk_message, timestamp,
           is_terminal, parent_tool_use_id, sdk_uuid, replacement_metadata_normalized
         ) VALUES (?, ?, 'result', 'success', ?, ?, 1, NULL, ?, 1)`
      ).run(
        'unseq-result-row',
        sessionId,
        JSON.stringify({ type: 'result', subtype: 'success', uuid: 'te-unseq-result' }),
        new Date().toISOString(),
        'te-unseq-result'
      );

      expect(
        repository.markDeliveriesConsumedAtTurnEnd(sessionId, ['te-unseq-1'], 'te-unseq-result')
      ).toEqual({ ids: [], uuids: [] });
      expect(rowOf(kickoffId).status).toBe('enqueued');
    });

    it('first-uuid all-or-nothing: a non-candidate first uuid voids the whole turn-end batch, while the bulk variant still consumes the eligible member', () => {
      const sessionId = 'session-te-first-uuid';
      const heldId = repository.saveUserMessage(
        sessionId,
        createUserMessage('held kickoff', 'te-first-held'),
        'deferred'
      );
      const memberId = seedEnqueued(sessionId, 'te-first-member');
      saveSuccessResult(sessionId, 'te-first-result');

      expect(
        repository.markDeliveriesConsumedAtTurnEnd(
          sessionId,
          ['te-first-held', 'te-first-member'],
          'te-first-result'
        )
      ).toEqual({ ids: [], uuids: [] });
      expect(rowOf(heldId).status).toBe('deferred');
      expect(rowOf(memberId).status).toBe('enqueued');

      expect(
        repository.markDeliveryConsumedByUuids(sessionId, ['te-first-held', 'te-first-member'])
      ).toEqual([memberId]);
      expect(rowOf(memberId).status).toBe('consumed');
    });

    it('shared watermark: every consumed member reuses the result boundary sequence and the global counter does not advance', () => {
      const sessionId = 'session-te-shared-seq';
      const firstId = seedEnqueued(sessionId, 'te-seq-a');
      const secondId = seedEnqueued(sessionId, 'te-seq-b');
      const resultSeq = saveSuccessResult(sessionId, 'te-seq-result');
      const nextSeqBefore = (
        db.prepare(`SELECT next_seq FROM delivery_consumed_seq`).get() as { next_seq: number }
      ).next_seq;

      expect(
        repository.markDeliveriesConsumedAtTurnEnd(
          sessionId,
          ['te-seq-a', 'te-seq-b'],
          'te-seq-result'
        )
      ).toEqual({ ids: [firstId, secondId], uuids: ['te-seq-a', 'te-seq-b'] });
      expect(new Set([rowOf(firstId).seq, rowOf(secondId).seq])).toEqual(new Set([resultSeq]));

      const nextSeqAfter = (
        db.prepare(`SELECT next_seq FROM delivery_consumed_seq`).get() as { next_seq: number }
      ).next_seq;
      expect(nextSeqAfter).toBe(nextSeqBefore);
    });
  });

  describe('hasTerminalResultAfter', () => {
    function insertMessage(
      sessionId: string,
      type: string,
      opts: {
        uuid?: string;
        timestamp: string;
        terminal?: boolean;
        subtype?: string;
        sendStatus?: string;
        sdkMessage?: string;
      }
    ): void {
      const effectiveStatus = opts.sendStatus ?? (type === 'user' ? 'consumed' : null);
      const needsSeq =
        (type === 'user' && effectiveStatus === 'consumed') || (type === 'result' && opts.terminal);
      const consumedSeq = needsSeq
        ? (
            db
              .prepare(
                `UPDATE delivery_consumed_seq SET next_seq = next_seq + 1 WHERE singleton = 1
                 RETURNING next_seq`
              )
              .get() as { next_seq: number }
          ).next_seq
        : null;
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, is_terminal, sdk_uuid, consumed_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        sessionId,
        type,
        opts.subtype ?? (type === 'result' && opts.terminal ? 'success' : null),
        opts.sdkMessage ?? '{}',
        opts.timestamp,
        effectiveStatus,
        opts.terminal ? 1 : 0,
        opts.uuid ?? null,
        consumedSeq
      );
    }

    it('is true when a SUCCESS terminal result exists after the message', () => {
      insertMessage('session-1', 'user', {
        uuid: 'msg-uuid',
        timestamp: '2026-08-11T15:25:00.000Z',
      });
      insertMessage('session-1', 'result', {
        timestamp: '2026-08-11T15:25:53.000Z',
        terminal: true,
        subtype: 'success',
      });
      expect(repository.hasTerminalResultAfter('session-1', 'msg-uuid')).toBe(true);
    });

    it("is FALSE for the internal compaction turn's stamped terminal success (#3389) — it cannot satisfy the work delivery", () => {
      insertMessage('session-1', 'user', {
        uuid: 'msg-compact-turn',
        timestamp: '2026-08-29T14:19:35.003Z',
      });
      insertMessage('session-1', 'result', {
        uuid: 'compact-result-uuid',
        timestamp: '2026-08-29T14:20:13.326Z',
        terminal: true,
        subtype: 'success',
        sdkMessage: JSON.stringify({ type: 'result', subtype: 'success', num_turns: 0 }),
      });
      expect(repository.hasTerminalResultAfter('session-1', 'msg-compact-turn')).toBe(true);

      repository.markResultInternalCompactionTurn('session-1', 'compact-result-uuid');

      expect(repository.hasTerminalResultAfter('session-1', 'msg-compact-turn')).toBe(false);
    });

    it('still completes on a later unstamped work success that follows the compact turn result', () => {
      insertMessage('session-1', 'user', {
        uuid: 'msg-after-compact',
        timestamp: '2026-08-29T14:19:35.003Z',
      });
      insertMessage('session-1', 'result', {
        uuid: 'compact-result-later',
        timestamp: '2026-08-29T14:20:13.326Z',
        terminal: true,
        subtype: 'success',
      });
      repository.markResultInternalCompactionTurn('session-1', 'compact-result-later');
      insertMessage('session-1', 'result', {
        timestamp: '2026-08-29T14:22:00.000Z',
        terminal: true,
        subtype: 'success',
      });

      expect(repository.hasTerminalResultAfter('session-1', 'msg-after-compact')).toBe(true);
    });

    it('is FALSE for an error result — a failed turn must retry, not complete (Codex #9)', () => {
      insertMessage('session-1', 'user', {
        uuid: 'msg-uuid',
        timestamp: '2026-08-11T15:25:00.000Z',
      });
      insertMessage('session-1', 'result', {
        timestamp: '2026-08-11T15:25:53.000Z',
        terminal: true,
        subtype: 'error_during_execution',
      });
      expect(repository.hasTerminalResultAfter('session-1', 'msg-uuid')).toBe(false);
    });

    it('is FALSE for a synthetic success result with is_error ONLY when recovery intercepted it', () => {
      insertMessage('session-1', 'user', {
        uuid: 'msg-uuid',
        timestamp: '2026-08-11T15:25:00.000Z',
      });
      insertMessage('session-1', 'result', {
        uuid: 'result-uuid',
        timestamp: '2026-08-11T15:25:53.000Z',
        terminal: true,
        subtype: 'success',
        sdkMessage: JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: true,
          terminal_reason: 'api_error',
        }),
      });

      expect(repository.hasTerminalResultAfter('session-1', 'msg-uuid')).toBe(true);
      expect(repository.hasRecoveryInterceptedResultAfter('session-1', 'msg-uuid')).toBe(false);

      repository.markResultRecoveryIntercepted('session-1', 'result-uuid');

      expect(repository.hasTerminalResultAfter('session-1', 'msg-uuid')).toBe(false);
      expect(repository.hasRecoveryInterceptedResultAfter('session-1', 'msg-uuid')).toBe(true);
    });

    it('reclaims intercepted error-subtype results after a restart', () => {
      insertMessage('session-1', 'user', {
        uuid: 'msg-err',
        timestamp: '2026-08-11T15:25:00.000Z',
      });
      insertMessage('session-1', 'result', {
        uuid: 'result-err-uuid',
        timestamp: '2026-08-11T15:25:53.000Z',
        terminal: true,
        subtype: 'error_during_execution',
        sdkMessage: JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['API Error: 429 rate limit exceeded'],
        }),
      });
      expect(repository.hasRecoveryInterceptedResultAfter('session-1', 'msg-err')).toBe(false);

      repository.markResultRecoveryIntercepted('session-1', 'result-err-uuid');

      expect(repository.hasRecoveryInterceptedResultAfter('session-1', 'msg-err')).toBe(true);
    });

    it('keeps billing-terminal intercepted results terminal and skips their restart reclaim', () => {
      insertMessage('session-1', 'user', {
        uuid: 'msg-billing',
        timestamp: '2026-08-11T15:25:00.000Z',
      });
      insertMessage('session-1', 'result', {
        uuid: 'result-billing-uuid',
        timestamp: '2026-08-11T15:25:53.000Z',
        terminal: true,
        subtype: 'success',
        sdkMessage: JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: true,
          terminal_reason: 'api_error',
        }),
      });

      repository.markResultRecoveryIntercepted('session-1', 'result-billing-uuid', true);

      expect(repository.hasTerminalResultAfter('session-1', 'msg-billing')).toBe(true);
      expect(repository.hasRecoveryInterceptedResultAfter('session-1', 'msg-billing')).toBe(false);
    });

    it('getErrorTerminalResultSubtypeAfter returns the error subtype (null for success/none)', () => {
      insertMessage('session-1', 'user', {
        uuid: 'msg-budget',
        timestamp: '2026-08-11T15:25:00.000Z',
      });
      insertMessage('session-1', 'result', {
        timestamp: '2026-08-11T15:25:53.000Z',
        terminal: true,
        subtype: 'error_max_budget_usd',
      });
      expect(repository.getErrorTerminalResultSubtypeAfter('session-1', 'msg-budget')).toBe(
        'error_max_budget_usd'
      );

      insertMessage('session-1', 'user', {
        uuid: 'msg-ok',
        timestamp: '2026-08-11T15:26:00.000Z',
      });
      insertMessage('session-1', 'result', {
        timestamp: '2026-08-11T15:26:53.000Z',
        terminal: true,
        subtype: 'success',
      });
      expect(repository.getErrorTerminalResultSubtypeAfter('session-1', 'msg-ok')).toBeNull();

      insertMessage('session-1', 'user', {
        uuid: 'msg-none',
        timestamp: '2026-08-11T15:27:00.000Z',
      });
      expect(repository.getErrorTerminalResultSubtypeAfter('session-1', 'msg-none')).toBeNull();
    });

    it('getErrorTerminalResultSubtypeAfter classifies the LATEST attempt outcome (Codex review)', () => {
      insertMessage('session-1', 'user', {
        uuid: 'msg-multi',
        timestamp: '2026-08-11T15:28:00.000Z',
      });
      insertMessage('session-1', 'result', {
        timestamp: '2026-08-11T15:28:53.000Z',
        terminal: true,
        subtype: 'error_during_execution',
      });
      insertMessage('session-1', 'result', {
        timestamp: '2026-08-11T15:29:53.000Z',
        terminal: true,
        subtype: 'error_max_budget_usd',
      });
      expect(repository.getErrorTerminalResultSubtypeAfter('session-1', 'msg-multi')).toBe(
        'error_max_budget_usd'
      );
    });

    it('ignores NESTED subagent results when detecting turn completion (P1)', () => {
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, is_terminal, sdk_uuid, consumed_seq, parent_tool_use_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        'session-1',
        'user',
        null,
        '{}',
        '2026-08-11T15:25:00.000Z',
        'consumed',
        0,
        'outer-msg',
        1,
        null
      );
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, is_terminal, sdk_uuid, consumed_seq, parent_tool_use_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        'session-1',
        'result',
        'subagent_result',
        '{}',
        '2026-08-11T15:26:00.000Z',
        null,
        1,
        null,
        null,
        'tool-use-123'
      );
      expect(repository.hasTerminalResultAfter('session-1', 'outer-msg')).toBe(false);
    });

    it('treats a missing consumption watermark (migrated row) as unknown/live, not completed (P1)', () => {
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, is_terminal, sdk_uuid, consumed_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        'session-1',
        'user',
        null,
        '{}',
        '2026-08-11T15:20:00.000Z',
        'consumed',
        0,
        'migrated-msg',
        null
      );
      insertMessage('session-1', 'result', {
        timestamp: '2026-08-11T15:21:00.000Z',
        terminal: true,
      });
      expect(repository.hasTerminalResultAfter('session-1', 'migrated-msg')).toBe(false);
    });

    it('duplicate-uuid rows leave the watermark pick ambiguous — either pick flips the re-claim outcome (bug-#2 characterization)', () => {
      insertMessage('session-1', 'user', {
        uuid: 'dup-msg',
        timestamp: '2026-08-11T15:20:00.000Z',
        sendStatus: 'failed',
      });
      insertMessage('session-1', 'user', {
        uuid: 'dup-msg',
        timestamp: '2026-08-11T15:21:00.000Z',
      });
      insertMessage('session-1', 'result', {
        timestamp: '2026-08-11T15:22:00.000Z',
        terminal: true,
        subtype: 'success',
      });

      const picks = db
        .prepare(`SELECT consumed_seq FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?`)
        .all('session-1', 'dup-msg') as Array<{ consumed_seq: number | null }>;
      const seqs = picks.map((pick) => pick.consumed_seq);
      expect(seqs).toContain(null);
      const consumedSeqs = seqs.filter((seq): seq is number => seq !== null);
      expect(consumedSeqs).toHaveLength(1);

      const successSeenWithWatermark = (watermark: number | null) =>
        db
          .prepare(
            `SELECT 1 FROM sdk_messages r
              WHERE r.session_id = 'session-1' AND r.message_type = 'result' AND r.is_terminal = 1
                AND r.message_subtype = 'success' AND r.parent_tool_use_id IS NULL
                AND r.consumed_seq IS NOT NULL AND r.consumed_seq >= ? LIMIT 1`
          )
          .get(watermark) != null;
      expect(successSeenWithWatermark(consumedSeqs[0])).toBe(true);
      expect(successSeenWithWatermark(null)).toBe(false);
    });

    it('the same duplicate-uuid ambiguity hides the terminal-error subtype from the error probe (bug-#2 characterization)', () => {
      insertMessage('session-1', 'user', {
        uuid: 'dup-err',
        timestamp: '2026-08-11T15:20:00.000Z',
        sendStatus: 'failed',
      });
      insertMessage('session-1', 'user', {
        uuid: 'dup-err',
        timestamp: '2026-08-11T15:21:00.000Z',
      });
      insertMessage('session-1', 'result', {
        timestamp: '2026-08-11T15:22:00.000Z',
        terminal: true,
        subtype: 'error_max_budget_usd',
      });

      const errorSubtypeWithWatermark = (watermark: number | null): string | null => {
        const row = db
          .prepare(
            `SELECT r.message_subtype AS subtype FROM sdk_messages r
              WHERE r.session_id = 'session-1' AND r.message_type = 'result' AND r.is_terminal = 1
                AND r.message_subtype IS NOT NULL AND r.message_subtype != 'success'
                AND r.parent_tool_use_id IS NULL AND r.consumed_seq IS NOT NULL
                AND r.consumed_seq >= ? ORDER BY r.consumed_seq DESC LIMIT 1`
          )
          .get(watermark) as { subtype: string | null } | undefined;
        return row?.subtype ?? null;
      };
      const consumedSeq = (
        db
          .prepare(
            `SELECT consumed_seq FROM sdk_messages
              WHERE session_id = ? AND sdk_uuid = ? AND consumed_seq IS NOT NULL LIMIT 1`
          )
          .get('session-1', 'dup-err') as { consumed_seq: number }
      ).consumed_seq;
      expect(errorSubtypeWithWatermark(consumedSeq)).toBe('error_max_budget_usd');
      expect(errorSubtypeWithWatermark(null)).toBeNull();
    });

    it('prefers the non-NULL watermark across duplicate-uuid rows — all probes deterministic (bug-#2 fix)', () => {
      insertMessage('session-1', 'user', {
        uuid: 'dup-msg',
        timestamp: '2026-08-11T15:20:00.000Z',
        sendStatus: 'failed',
      });
      insertMessage('session-1', 'user', {
        uuid: 'dup-msg',
        timestamp: '2026-08-11T15:21:00.000Z',
      });
      insertMessage('session-1', 'result', {
        uuid: 'dup-result',
        timestamp: '2026-08-11T15:22:00.000Z',
        terminal: true,
        subtype: 'success',
        sdkMessage: JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: true,
          terminal_reason: 'api_error',
        }),
      });

      expect(repository.hasTerminalResultAfter('session-1', 'dup-msg')).toBe(true);
      expect(repository.hasRecoveryInterceptedResultAfter('session-1', 'dup-msg')).toBe(false);

      repository.markResultRecoveryIntercepted('session-1', 'dup-result');

      expect(repository.hasTerminalResultAfter('session-1', 'dup-msg')).toBe(false);
      expect(repository.hasRecoveryInterceptedResultAfter('session-1', 'dup-msg')).toBe(true);
      expect(repository.getErrorTerminalResultSubtypeAfter('session-1', 'dup-msg')).toBeNull();

      insertMessage('session-1', 'result', {
        timestamp: '2026-08-11T15:23:00.000Z',
        terminal: true,
        subtype: 'error_max_budget_usd',
      });
      expect(repository.getErrorTerminalResultSubtypeAfter('session-1', 'dup-msg')).toBe(
        'error_max_budget_usd'
      );
    });

    it('follows the LATEST non-NULL watermark when duplicate rows carry different consumed_seq values — prior-attempt results stay invisible (retry layout)', () => {
      const insertDuplicate = db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, is_terminal, sdk_uuid, consumed_seq)
         VALUES (?, 'session-1', 'user', NULL, '{}', ?, 'consumed', 0, 'dup-seq-msg', ?)`
      );
      insertDuplicate.run('dup-seq-first', '2026-08-11T15:20:00.000Z', 10);
      insertDuplicate.run('dup-seq-second', '2026-08-11T15:21:00.000Z', 5);
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, is_terminal, sdk_uuid, consumed_seq, parent_tool_use_id)
         VALUES ('dup-seq-result', 'session-1', 'result', 'success', '{}', '2026-08-11T15:22:00.000Z', NULL, 1, 'dup-seq-result-uuid', 7, NULL)`
      ).run();

      expect(repository.hasTerminalResultAfter('session-1', 'dup-seq-msg')).toBe(false);

      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, is_terminal, sdk_uuid, consumed_seq, parent_tool_use_id)
         VALUES ('dup-seq-result-own', 'session-1', 'result', 'success', '{}', '2026-08-11T15:23:00.000Z', NULL, 1, 'dup-seq-result-own-uuid', 12, NULL)`
      ).run();

      expect(repository.hasTerminalResultAfter('session-1', 'dup-seq-msg')).toBe(true);
    });

    it('a stale prior-attempt recovery-intercepted result does not reopen the latest attempt (Codex P1)', () => {
      const insertDuplicate = db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, is_terminal, sdk_uuid, consumed_seq)
         VALUES (?, 'session-1', 'user', NULL, '{}', ?, 'consumed', 0, 'stale-msg', ?)`
      );
      insertDuplicate.run('stale-old', '2026-08-11T15:20:00.000Z', 5);
      insertDuplicate.run('stale-new', '2026-08-11T15:21:00.000Z', 10);
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, is_terminal, sdk_uuid, consumed_seq, parent_tool_use_id)
         VALUES ('stale-intercepted', 'session-1', 'result', 'success', ?, '2026-08-11T15:22:00.000Z', NULL, 1, 'stale-intercepted-uuid', 7, NULL)`
      ).run(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: true,
          terminal_reason: 'api_error',
          recovery_intercepted: 1,
          recovery_billing_terminal: 0,
        })
      );
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, is_terminal, sdk_uuid, consumed_seq, parent_tool_use_id)
         VALUES ('stale-success', 'session-1', 'result', 'success', '{}', '2026-08-11T15:23:00.000Z', NULL, 1, 'stale-success-uuid', 12, NULL)`
      ).run();

      expect(repository.hasTerminalResultAfter('session-1', 'stale-msg')).toBe(true);
      expect(repository.hasRecoveryInterceptedResultAfter('session-1', 'stale-msg')).toBe(false);
      expect(repository.getErrorTerminalResultSubtypeAfter('session-1', 'stale-msg')).toBeNull();
    });

    it('is true when a terminal result shares the consumption millisecond but inserts after (P2 tiebreak)', () => {
      insertMessage('session-1', 'user', {
        uuid: 'tie-msg',
        timestamp: '2026-08-11T15:25:00.000Z',
        sendStatus: 'enqueued',
      });
      const flipped = repository.markDeliveryConsumedByUuid('session-1', 'tie-msg');
      expect(flipped).not.toBeNull();
      const consumedTs = (
        db.prepare(`SELECT timestamp FROM sdk_messages WHERE id = ?`).get(flipped) as {
          timestamp: string;
        }
      ).timestamp;
      insertMessage('session-1', 'result', {
        timestamp: consumedTs,
        terminal: true,
        subtype: 'success',
      });
      expect(repository.hasTerminalResultAfter('session-1', 'tie-msg')).toBe(true);
    });

    it('is false when no terminal result exists after the message', () => {
      insertMessage('session-1', 'user', {
        uuid: 'msg-uuid',
        timestamp: '2026-08-11T15:25:00.000Z',
      });
      expect(repository.hasTerminalResultAfter('session-1', 'msg-uuid')).toBe(false);
    });

    it('is false when the only terminal result is before the message', () => {
      insertMessage('session-1', 'result', {
        timestamp: '2026-08-11T15:24:00.000Z',
        terminal: true,
      });
      insertMessage('session-1', 'user', {
        uuid: 'msg-uuid',
        timestamp: '2026-08-11T15:25:00.000Z',
      });
      expect(repository.hasTerminalResultAfter('session-1', 'msg-uuid')).toBe(false);
    });

    it('uses the CONSUMPTION boundary, not the persistence time — a queued-then-consumed message ignores the prior turn result (P1)', () => {
      insertMessage('session-1', 'user', {
        uuid: 'queued-msg',
        timestamp: '2026-08-11T15:20:00.000Z',
        sendStatus: 'enqueued',
      });
      insertMessage('session-1', 'result', {
        timestamp: '2026-08-11T15:21:00.000Z',
        terminal: true,
      });
      const flipped = repository.markDeliveryConsumedByUuid('session-1', 'queued-msg');
      expect(flipped).not.toBeNull();
      expect(repository.hasTerminalResultAfter('session-1', 'queued-msg')).toBe(false);
    });

    it('aligns the timestamp for a NON-RENDERABLE consumed message too (P1)', () => {
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, is_terminal, sdk_uuid, is_renderable)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        'session-1',
        'user',
        null,
        '{}',
        '2026-08-11T15:20:00.000Z',
        'enqueued',
        0,
        'nr-msg',
        0
      );
      insertMessage('session-1', 'result', {
        timestamp: '2026-08-11T15:21:00.000Z',
        terminal: true,
      });
      const flipped = repository.markDeliveryConsumedByUuid('session-1', 'nr-msg');
      expect(flipped).not.toBeNull();
      const ts = (
        db.prepare(`SELECT timestamp FROM sdk_messages WHERE id = ?`).get(flipped) as {
          timestamp: string;
        }
      ).timestamp;
      expect(Date.parse(ts)).toBeGreaterThan(Date.parse('2026-08-11T15:22:00.000Z'));
      expect(repository.hasTerminalResultAfter('session-1', 'nr-msg')).toBe(false);
    });

    it('orders by the CONSUMPTION watermark, not the message rowid — a prior-turn result sharing the ms is excluded (P2)', () => {
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, is_terminal, sdk_uuid, is_renderable)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        'session-1',
        'user',
        null,
        '{}',
        '2026-08-11T15:20:00.000Z',
        'enqueued',
        0,
        'promoted-msg',
        1
      );
      insertMessage('session-1', 'result', {
        timestamp: '2026-08-11T15:30:00.000Z',
        terminal: true,
      });
      const flipped = repository.markDeliveryConsumedByUuid('session-1', 'promoted-msg');
      expect(flipped).not.toBeNull();
      const seq = (
        db.prepare(`SELECT consumed_seq FROM sdk_messages WHERE id = ?`).get(flipped) as {
          consumed_seq: number;
        }
      ).consumed_seq;
      expect(seq).toBeGreaterThan(0);
      expect(repository.hasTerminalResultAfter('session-1', 'promoted-msg')).toBe(false);
      insertMessage('session-1', 'result', {
        timestamp: '2026-08-11T15:31:00.000Z',
        terminal: true,
      });
      expect(repository.hasTerminalResultAfter('session-1', 'promoted-msg')).toBe(true);
    });

    it('uses a genuinely monotonic counter — a terminal result stamped after multiple consumes is detected for all (P2)', () => {
      const seed = db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid, is_renderable)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      seed.run(
        crypto.randomUUID(),
        's',
        'user',
        '{}',
        '2026-08-11T15:00:00.000Z',
        'enqueued',
        'm1',
        1
      );
      seed.run(
        crypto.randomUUID(),
        's',
        'user',
        '{}',
        '2026-08-11T15:00:00.000Z',
        'enqueued',
        'm2',
        1
      );
      repository.markDeliveryConsumedByUuid('s', 'm1');
      repository.markDeliveryConsumedByUuid('s', 'm2');
      insertMessage('s', 'result', {
        timestamp: '2026-08-11T15:05:00.000Z',
        terminal: true,
      });
      expect(repository.hasTerminalResultAfter('s', 'm1')).toBe(true);
      expect(repository.hasTerminalResultAfter('s', 'm2')).toBe(true);
    });

    it('is true after consumption when the SAME turn later ends (its own result)', () => {
      insertMessage('session-1', 'user', {
        uuid: 'own-turn-msg',
        timestamp: '2026-08-11T15:20:00.000Z',
        sendStatus: 'enqueued',
      });
      repository.markDeliveryConsumedByUuid('session-1', 'own-turn-msg');
      insertMessage('session-1', 'result', {
        timestamp: new Date(Date.now() + 60_000).toISOString(),
        terminal: true,
      });
      expect(repository.hasTerminalResultAfter('session-1', 'own-turn-msg')).toBe(true);
    });

    it('uses the current result boundary when turn-end fallback consumes after result persistence', () => {
      const messageId = repository.saveUserMessage(
        'session-1',
        createUserMessage('yielded prompt', 'yielded-msg'),
        'enqueued'
      );
      const resultUuid = 'result-uuid';
      repository.saveSDKMessage('session-1', {
        type: 'result',
        subtype: 'success',
        uuid: resultUuid,
        parent_tool_use_id: null,
      } as unknown as SDKMessage);

      expect(repository.markDeliveryConsumedAtTurnEnd('session-1', 'yielded-msg', resultUuid)).toBe(
        messageId
      );
      expect(repository.hasTerminalResultAfter('session-1', 'yielded-msg')).toBe(true);
    });

    it('consumes a turn-end batch in one task turn at the matching result boundary', () => {
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          session_context TEXT,
          room_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.roomId') END) VIRTUAL,
          space_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.spaceId') END) VIRTUAL,
          task_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.taskId') END) VIRTUAL,
          type TEXT
        );
        INSERT INTO sessions (id, session_context, type)
        VALUES ('session-1', '{"taskId":"task-1"}', 'space_task_agent');
      `);
      const kickoffId = repository.saveUserMessage(
        'session-1',
        createUserMessage('yielded prompt', 'yielded-msg'),
        'enqueued'
      );
      const memberId = repository.saveUserMessage(
        'session-1',
        createUserMessage('batch member', 'member-msg'),
        'submitted'
      );
      const resultUuid = 'batch-result-uuid';
      repository.saveSDKMessage('session-1', {
        type: 'result',
        subtype: 'success',
        uuid: resultUuid,
        parent_tool_use_id: null,
      } as unknown as SDKMessage);
      const result = db
        .prepare('SELECT consumed_seq FROM sdk_messages WHERE sdk_uuid = ?')
        .get(resultUuid) as { consumed_seq: number };

      expect(
        repository.markDeliveriesConsumedAtTurnEnd(
          'session-1',
          ['yielded-msg', 'member-msg'],
          resultUuid
        )
      ).toEqual({
        ids: [kickoffId, memberId],
        uuids: ['yielded-msg', 'member-msg'],
      });
      const rows = db
        .prepare(
          'SELECT send_status AS status, conversation_turn_index AS turn, consumed_seq AS seq FROM sdk_messages WHERE id IN (?, ?) ORDER BY id'
        )
        .all(kickoffId, memberId) as Array<{
        status: string;
        turn: number | null;
        seq: number | null;
      }>;
      expect(rows.map((row) => row.status)).toEqual(['consumed', 'consumed']);
      expect(new Set(rows.map((row) => row.turn))).toEqual(new Set([1]));
      expect(new Set(rows.map((row) => row.seq))).toEqual(new Set([result.consumed_seq]));
    });

    it('returns only batch members actually consumed at turn end', () => {
      const kickoffId = repository.saveUserMessage(
        'session-1',
        createUserMessage('yielded prompt', 'yielded-msg'),
        'enqueued'
      );
      repository.saveUserMessage(
        'session-1',
        createUserMessage('held member', 'held-member-msg'),
        'deferred'
      );
      const resultUuid = 'partial-batch-result-uuid';
      repository.saveSDKMessage('session-1', {
        type: 'result',
        subtype: 'success',
        uuid: resultUuid,
        parent_tool_use_id: null,
      } as unknown as SDKMessage);

      expect(
        repository.markDeliveriesConsumedAtTurnEnd(
          'session-1',
          ['yielded-msg', 'held-member-msg'],
          resultUuid
        )
      ).toEqual({ ids: [kickoffId], uuids: ['yielded-msg'] });
      expect(repository.getDeliveryContent('session-1', 'held-member-msg')?.sendStatus).toBe(
        'deferred'
      );
    });

    it('does not consume at turn end without the matching successful top-level result', () => {
      repository.saveUserMessage(
        'session-1',
        createUserMessage('yielded prompt', 'yielded-msg'),
        'enqueued'
      );
      repository.saveSDKMessage('session-1', {
        type: 'result',
        subtype: 'error_during_execution',
        uuid: 'error-result-uuid',
        parent_tool_use_id: null,
      } as unknown as SDKMessage);

      expect(
        repository.markDeliveryConsumedAtTurnEnd('session-1', 'yielded-msg', 'error-result-uuid')
      ).toBeNull();
      expect(repository.getUserMessageIdsByStatus('session-1', 'enqueued')).toHaveLength(1);
    });

    it('is false when the terminal result belongs to another session', () => {
      insertMessage('session-1', 'user', {
        uuid: 'msg-uuid',
        timestamp: '2026-08-11T15:25:00.000Z',
      });
      insertMessage('session-2', 'result', {
        timestamp: '2026-08-11T15:25:53.000Z',
        terminal: true,
      });
      expect(repository.hasTerminalResultAfter('session-1', 'msg-uuid')).toBe(false);
    });

    it('is false when the message uuid is unknown', () => {
      insertMessage('session-1', 'result', {
        timestamp: '2026-08-11T15:25:53.000Z',
        terminal: true,
      });
      expect(repository.hasTerminalResultAfter('session-1', 'no-such-uuid')).toBe(false);
    });

    it('refresh: the search index reflects the consumption timestamp, not the queued time (P2)', () => {
      createSearchIndex();
      const sdkMessage = createUserMessage('searchable body text', 'search-msg');
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, is_terminal, sdk_uuid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        'session-1',
        'user',
        null,
        JSON.stringify(sdkMessage),
        '2020-01-01T00:00:00.000Z',
        'enqueued',
        0,
        'search-msg'
      );
      const before = Date.now();
      const flipped = repository.markDeliveryConsumedByUuid('session-1', 'search-msg');
      expect(flipped).not.toBeNull();
      const after = Date.now();
      repository.flushMessageSearchIndex();
      const searchRow = db
        .prepare(
          `SELECT timestamp FROM message_search_content
            WHERE kind = 'message'
              AND source_id = (
                SELECT id FROM sdk_messages
                 WHERE session_id = 'session-1' AND sdk_uuid = 'search-msg' LIMIT 1
              )`
        )
        .get() as { timestamp: number } | undefined;
      expect(searchRow).toBeDefined();
      expect(searchRow!.timestamp).toBeGreaterThanOrEqual(before);
      expect(searchRow!.timestamp).toBeLessThanOrEqual(after);
    });

    describe('duplicate-uuid watermark rows — ordered pick across probes (A1, updated for bug-#2 fix)', () => {
      function expectDuplicateWatermarkRows(sessionId: string, uuid: string): void {
        const duplicates = db
          .prepare(`SELECT consumed_seq FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?`)
          .all(sessionId, uuid) as Array<{ consumed_seq: number | null }>;
        expect(duplicates).toHaveLength(2);
        expect(duplicates.some((row) => row.consumed_seq === null)).toBe(true);
        expect(duplicates.some((row) => row.consumed_seq !== null)).toBe(true);
      }

      it('hasTerminalResultAfter prefers the non-NULL watermark — unsequenced duplicate first (bug-#2 fix)', () => {
        const sessionId = 'session-dup-null-first';
        insertMessage(sessionId, 'user', {
          uuid: 'dup-watermark',
          timestamp: '2026-08-11T15:30:00.000Z',
          sendStatus: 'enqueued',
        });
        insertMessage(sessionId, 'user', {
          uuid: 'dup-watermark',
          timestamp: '2026-08-11T15:30:01.000Z',
        });
        insertMessage(sessionId, 'result', {
          timestamp: '2026-08-11T15:30:53.000Z',
          terminal: true,
          subtype: 'success',
        });
        expectDuplicateWatermarkRows(sessionId, 'dup-watermark');

        expect(repository.hasTerminalResultAfter(sessionId, 'dup-watermark')).toBe(true);
      });

      it('hasTerminalResultAfter prefers the non-NULL watermark — sequenced duplicate first (bug-#2 fix)', () => {
        const sessionId = 'session-dup-seq-first';
        insertMessage(sessionId, 'user', {
          uuid: 'dup-watermark',
          timestamp: '2026-08-11T15:31:00.000Z',
        });
        insertMessage(sessionId, 'user', {
          uuid: 'dup-watermark',
          timestamp: '2026-08-11T15:31:01.000Z',
          sendStatus: 'enqueued',
        });
        insertMessage(sessionId, 'result', {
          timestamp: '2026-08-11T15:31:53.000Z',
          terminal: true,
          subtype: 'success',
        });
        expectDuplicateWatermarkRows(sessionId, 'dup-watermark');

        expect(repository.hasTerminalResultAfter(sessionId, 'dup-watermark')).toBe(true);
      });

      it('getErrorTerminalResultSubtypeAfter returns the subtype regardless of duplicate order (bug-#2 fix)', () => {
        const sessionId = 'session-dup-error';
        insertMessage(sessionId, 'user', {
          uuid: 'dup-watermark',
          timestamp: '2026-08-11T15:32:00.000Z',
          sendStatus: 'enqueued',
        });
        insertMessage(sessionId, 'user', {
          uuid: 'dup-watermark',
          timestamp: '2026-08-11T15:32:01.000Z',
        });
        insertMessage(sessionId, 'result', {
          timestamp: '2026-08-11T15:32:53.000Z',
          terminal: true,
          subtype: 'error_max_budget_usd',
        });
        expectDuplicateWatermarkRows(sessionId, 'dup-watermark');

        expect(repository.getErrorTerminalResultSubtypeAfter(sessionId, 'dup-watermark')).toBe(
          'error_max_budget_usd'
        );
      });
    });

    describe('delivery_turn_end markers (result-less terminal paths, P2)', () => {
      it('recordDeliveryTurnEnd then hasDeliveryTurnEnd round-trips', () => {
        expect(repository.hasDeliveryTurnEnd('session-1', 'm1')).toBe(false);
        repository.recordDeliveryTurnEnd('session-1', 'm1', '2026-08-11T16:00:00.000Z');
        expect(repository.hasDeliveryTurnEnd('session-1', 'm1')).toBe(true);
        expect(repository.hasDeliveryTurnEnd('session-1', 'm2')).toBe(false);
        expect(repository.hasDeliveryTurnEnd('session-2', 'm1')).toBe(false);
      });

      it('recordDeliveryTurnEnd is idempotent (INSERT OR REPLACE by (session, message))', () => {
        repository.recordDeliveryTurnEnd('session-1', 'm1', 't1');
        repository.recordDeliveryTurnEnd('session-1', 'm1', 't2');
        const rows = db
          .prepare(
            `SELECT ended_at FROM delivery_turn_end WHERE session_id='session-1' AND message_uuid='m1'`
          )
          .all();
        expect(rows).toHaveLength(1);
        expect(rows[0].ended_at).toBe('t2');
      });

      it('rewind (deleteMessagesAtAndAfter) clears markers for rewound UUIDs (P2)', () => {
        repository.recordDeliveryTurnEnd('session-1', 'rewound-uuid', 't1');
        expect(repository.hasDeliveryTurnEnd('session-1', 'rewound-uuid')).toBe(true);
        db.prepare(
          `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          crypto.randomUUID(),
          'session-1',
          'user',
          '{}',
          '2026-08-11T16:00:00.000Z',
          'consumed',
          'rewound-uuid'
        );
        repository.deleteMessagesAtAndAfter('session-1', Date.parse('2026-08-11T16:00:00.000Z'));
        expect(repository.hasDeliveryTurnEnd('session-1', 'rewound-uuid')).toBe(false);
      });
    });
  });

  describe('classifyReclaimTermination — crash-window reclaim decision (task #946)', () => {
    function bumpSeq(): number {
      return (
        db
          .prepare(
            `UPDATE delivery_consumed_seq SET next_seq = next_seq + 1 WHERE singleton = 1
             RETURNING next_seq`
          )
          .get() as { next_seq: number }
      ).next_seq;
    }

    function insertConsumedUser(uuid: string, at: string): void {
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, is_terminal, sdk_uuid, consumed_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        'session-1',
        'user',
        null,
        '{}',
        at,
        'consumed',
        0,
        uuid,
        bumpSeq()
      );
    }

    function insertTerminalResult(at: string, subtype: string, uuid?: string): void {
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, is_terminal, sdk_uuid, consumed_seq)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`
      ).run(
        crypto.randomUUID(),
        'session-1',
        'result',
        subtype,
        '{}',
        at,
        1,
        uuid ?? null,
        bumpSeq()
      );
    }

    function decisionFor(uuid: string): ReturnType<typeof classifyReclaimTermination> {
      return classifyReclaimTermination({
        successResult: repository.hasTerminalResultAfter('session-1', uuid),
        markerExists: repository.hasDeliveryTurnEnd('session-1', uuid),
        terminalIdleInFlight: false,
      });
    }

    it('pure matrix: only a SUCCESS result terminates; a bare marker redrives; idle keeps ownership', () => {
      expect(
        classifyReclaimTermination({
          successResult: true,
          markerExists: false,
          terminalIdleInFlight: false,
        })
      ).toBe('terminated');
      expect(
        classifyReclaimTermination({
          successResult: true,
          markerExists: true,
          terminalIdleInFlight: false,
        })
      ).toBe('terminated');
      expect(
        classifyReclaimTermination({
          successResult: false,
          markerExists: true,
          terminalIdleInFlight: false,
        })
      ).toBe('redrive');
      expect(
        classifyReclaimTermination({
          successResult: false,
          markerExists: false,
          terminalIdleInFlight: false,
        })
      ).toBe('live');
      expect(
        classifyReclaimTermination({
          successResult: true,
          markerExists: true,
          terminalIdleInFlight: true,
        })
      ).toBe('live');
      expect(
        classifyReclaimTermination({
          successResult: true,
          markerExists: false,
          terminalIdleInFlight: true,
        })
      ).toBe('live');
      expect(
        classifyReclaimTermination({
          successResult: false,
          markerExists: true,
          terminalIdleInFlight: true,
        })
      ).toBe('live');
      expect(
        classifyReclaimTermination({
          successResult: false,
          markerExists: false,
          terminalIdleInFlight: true,
        })
      ).toBe('live');
    });

    it('CRASH WINDOW (end-to-end data flow): a consumed turn with a bare marker and NO success result is cleared and re-driven, not silently completed', () => {
      const uuid = 'msg-crash-window';
      insertConsumedUser(uuid, '2026-08-11T17:00:00.000Z');
      repository.recordDeliveryTurnEnd('session-1', uuid, '2026-08-11T17:00:42.000Z');
      expect(repository.hasTerminalResultAfter('session-1', uuid)).toBe(false);
      expect(repository.hasDeliveryTurnEnd('session-1', uuid)).toBe(true);

      expect(decisionFor(uuid)).toBe('redrive');

      repository.clearDeliveryTurnEnd('session-1', uuid);
      expect(repository.hasDeliveryTurnEnd('session-1', uuid)).toBe(false);
      expect(decisionFor(uuid)).toBe('live');
    });

    it('a consumed turn that ended in SUCCESS still terminates (no regression)', () => {
      const uuid = 'msg-succeeded';
      insertConsumedUser(uuid, '2026-08-11T17:10:00.000Z');
      insertTerminalResult('2026-08-11T17:10:53.000Z', 'success');
      repository.recordDeliveryTurnEnd('session-1', uuid, '2026-08-11T17:10:54.000Z');
      expect(decisionFor(uuid)).toBe('terminated');
    });

    it('a consumed turn whose only result is an ERROR does not terminate (retry, do not silently complete)', () => {
      const uuid = 'msg-error-result';
      insertConsumedUser(uuid, '2026-08-11T17:20:00.000Z');
      insertTerminalResult('2026-08-11T17:20:53.000Z', 'error_during_execution');
      repository.recordDeliveryTurnEnd('session-1', uuid, '2026-08-11T17:20:54.000Z');
      expect(repository.hasTerminalResultAfter('session-1', uuid)).toBe(false);
      expect(decisionFor(uuid)).toBe('redrive');
    });

    it("#3389: the backstop compact turn's terminal success cannot terminate the interrupted work delivery", () => {
      insertTerminalResult('2026-08-29T14:19:33.083Z', 'error_during_execution');
      const uuid = 'msg-3389-kickoff';
      insertConsumedUser(uuid, '2026-08-29T14:19:35.003Z');
      insertTerminalResult('2026-08-29T14:20:13.326Z', 'success', 'compact-result-3389');
      repository.recordDeliveryTurnEnd('session-1', uuid, '2026-08-29T14:20:13.400Z');
      expect(repository.hasTerminalResultAfter('session-1', uuid)).toBe(true);
      expect(decisionFor(uuid)).toBe('terminated');

      repository.markResultInternalCompactionTurn('session-1', 'compact-result-3389');

      expect(repository.hasTerminalResultAfter('session-1', uuid)).toBe(false);
      expect(decisionFor(uuid)).toBe('redrive');
    });
  });

  describe('deletePendingUserMessage', () => {
    it('should delete a deferred user message', () => {
      const id = repository.saveUserMessage(
        'session-1',
        createUserMessage('Remove me', 'uuid-remove-me'),
        'deferred'
      );

      const removed = repository.deletePendingUserMessage('session-1', id);

      expect(removed).toEqual({
        dbId: id,
        uuid: 'uuid-remove-me',
        status: 'deferred',
      });
      expect(repository.getUserMessageIdsByStatus('session-1', 'deferred')).toEqual([]);
    });

    it('should delete an enqueued user message', () => {
      const id = repository.saveUserMessage(
        'session-1',
        createUserMessage('Remove me', 'uuid-remove-me'),
        'enqueued'
      );

      const removed = repository.deletePendingUserMessage('session-1', id);

      expect(removed?.status).toBe('enqueued');
      expect(repository.getUserMessageIdsByStatus('session-1', 'enqueued')).toEqual([]);
    });

    it('should not delete consumed messages', () => {
      const id = repository.saveUserMessage('session-1', createUserMessage('Keep me'), 'consumed');

      const removed = repository.deletePendingUserMessage('session-1', id);

      expect(removed).toBeNull();
      expect(repository.getUserMessageIdsByStatus('session-1', 'consumed').length).toBe(1);
    });

    it('should not delete another session pending message', () => {
      const id = repository.saveUserMessage('session-2', createUserMessage('Keep me'), 'deferred');

      const removed = repository.deletePendingUserMessage('session-1', id);

      expect(removed).toBeNull();
      expect(repository.getUserMessageIdsByStatus('session-2', 'deferred').length).toBe(1);
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

    it('should return the earliest match across send_status buckets', async () => {
      const sessionId = 'session-dup';

      repository.saveUserMessage(
        sessionId,
        createUserMessage('Earliest failed copy', 'shared-uuid'),
        'failed'
      );

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

    it('breaks timestamp ties by earliest rowid across duplicate rows', () => {
      const sessionId = 'session-tied';
      const insert = db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
         VALUES (?, ?, 'user', ?, ?, ?, 'tied-uuid')`
      );
      insert.run(
        'tied-a',
        sessionId,
        JSON.stringify({
          type: 'user',
          uuid: 'tied-uuid',
          message: { role: 'user', content: [{ type: 'text', text: 'First copy' }] },
        }),
        '2026-08-11T15:20:00.000Z',
        'failed'
      );
      insert.run(
        'tied-b',
        sessionId,
        JSON.stringify({
          type: 'user',
          uuid: 'tied-uuid',
          message: { role: 'user', content: [{ type: 'text', text: 'Second copy' }] },
        }),
        '2026-08-11T15:20:00.000Z',
        'consumed'
      );

      const message = repository.getUserMessageByUuid(sessionId, 'tied-uuid');

      expect(message).toBeDefined();
      expect(message?.content).toBe('First copy');
    });

    it('resolves a same-millisecond uuid tie to whichever row the unordered scan returns first (A1)', () => {
      const sessionId = 'session-ms-tie';
      const tiedTimestamp = '2026-08-11T15:40:00.000Z';
      const insertTied = db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
         VALUES (?, ?, 'user', ?, ?, 'consumed', ?)`
      );
      insertTied.run(
        'tie-a',
        sessionId,
        JSON.stringify(createUserMessage('Tied copy A', 'uuid-ms-tie')),
        tiedTimestamp,
        'uuid-ms-tie'
      );
      insertTied.run(
        'tie-b',
        sessionId,
        JSON.stringify(createUserMessage('Tied copy B', 'uuid-ms-tie')),
        tiedTimestamp,
        'uuid-ms-tie'
      );

      const firstReturned = (
        db
          .prepare(
            `SELECT sdk_message, timestamp FROM sdk_messages
              WHERE session_id = ?
                AND message_type = 'user'
                AND sdk_uuid = ?`
          )
          .all(sessionId, 'uuid-ms-tie') as Array<{ sdk_message: string; timestamp: string }>
      )[0];
      const expected = (
        JSON.parse(firstReturned.sdk_message) as {
          message?: { content?: Array<{ type: string; text?: string }> };
        }
      ).message?.content?.[0]?.text;

      expect(['Tied copy A', 'Tied copy B']).toContain(expected);
      expect(repository.getUserMessageByUuid(sessionId, 'uuid-ms-tie')?.content).toBe(expected);
    });

    it('earliest-wins under distinct timestamps regardless of insertion order (A1)', () => {
      const sessionId = 'session-earliest';
      const insert = db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
         VALUES (?, ?, 'user', ?, ?, 'consumed', 'uuid-earliest')`
      );
      insert.run(
        'later-row',
        sessionId,
        JSON.stringify(createUserMessage('Later copy', 'uuid-earliest')),
        '2026-08-11T15:41:01.000Z'
      );
      insert.run(
        'earlier-row',
        sessionId,
        JSON.stringify(createUserMessage('Earlier copy', 'uuid-earliest')),
        '2026-08-11T15:41:00.000Z'
      );

      expect(repository.getUserMessageByUuid(sessionId, 'uuid-earliest')?.content).toBe(
        'Earlier copy'
      );
    });
  });

  describe('getUserMessageContentByUuid (A1)', () => {
    function insertUserContentRow(
      sessionId: string,
      uuid: string,
      content: string | Array<Record<string, string>>,
      timestamp: string
    ): void {
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
         VALUES (?, ?, 'user', ?, ?, 'consumed', ?)`
      ).run(
        crypto.randomUUID(),
        sessionId,
        JSON.stringify({ type: 'user', uuid, message: { role: 'user', content } }),
        timestamp,
        uuid
      );
    }

    it('returns string content verbatim', () => {
      insertUserContentRow(
        'session-content',
        'uuid-string',
        'Plain string',
        '2026-08-11T12:00:00.000Z'
      );

      expect(repository.getUserMessageContentByUuid('session-content', 'uuid-string')).toBe(
        'Plain string'
      );
    });

    it('returns block-array content verbatim, not a flattened first block', () => {
      const blocks = [
        { type: 'text', text: 'Block one' },
        { type: 'text', text: 'Block two' },
      ];
      insertUserContentRow('session-content', 'uuid-blocks', blocks, '2026-08-11T12:01:00.000Z');

      expect(repository.getUserMessageContentByUuid('session-content', 'uuid-blocks')).toEqual(
        blocks
      );
    });

    it('returns the earliest row when a uuid repeats under distinct timestamps', () => {
      insertUserContentRow(
        'session-content',
        'uuid-repeat',
        [{ type: 'text', text: 'Earlier copy' }],
        '2026-08-11T12:02:00.000Z'
      );
      insertUserContentRow(
        'session-content',
        'uuid-repeat',
        [{ type: 'text', text: 'Later copy' }],
        '2026-08-11T12:03:00.000Z'
      );

      expect(repository.getUserMessageContentByUuid('session-content', 'uuid-repeat')).toEqual([
        { type: 'text', text: 'Earlier copy' },
      ]);
    });

    it('returns null for unknown uuids and wrong sessions', () => {
      insertUserContentRow('session-content', 'uuid-known', 'Known', '2026-08-11T12:04:00.000Z');

      expect(repository.getUserMessageContentByUuid('session-content', 'no-such-uuid')).toBeNull();
      expect(repository.getUserMessageContentByUuid('session-other', 'uuid-known')).toBeNull();
    });

    it('returns null when the stored payload has no message.content field', () => {
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, sdk_uuid)
         VALUES ('bare-user', 'session-content', 'user', ?, '2026-08-11T12:05:00.000Z', 'uuid-bare')`
      ).run(JSON.stringify({ type: 'user', uuid: 'uuid-bare' }));

      expect(repository.getUserMessageContentByUuid('session-content', 'uuid-bare')).toBeNull();
    });
  });

  describe('getAssistantMessagesSince (A1)', () => {
    function insertAssistantProjectionRow(
      sessionId: string,
      id: string,
      timestamp: string,
      blocks: Array<Record<string, string>>,
      parentToolUseId: string | null = null
    ): void {
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, parent_tool_use_id)
         VALUES (?, ?, 'assistant', ?, ?, ?)`
      ).run(
        id,
        sessionId,
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } }),
        timestamp,
        parentToolUseId
      );
    }

    it('returns every assistant row ascending with joined text and tool-call names', () => {
      const sessionId = 'session-since-all';
      insertAssistantProjectionRow(sessionId, 'a1', '2026-08-11T11:00:00.000Z', [
        { type: 'text', text: ' Alpha' },
        { type: 'tool_use', id: 'tu-1', name: 'Read' },
        { type: 'text', text: 'Beta ' },
      ]);
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
         VALUES ('u1', ?, 'user', ?, '2026-08-11T11:00:01.000Z')`
      ).run(sessionId, JSON.stringify(createUserMessage('Not an assistant')));
      insertAssistantProjectionRow(sessionId, 'a2', '2026-08-11T11:00:02.000Z', [
        { type: 'text', text: 'Second' },
      ]);

      const rows = repository.getAssistantMessagesSince(sessionId, null);

      expect(rows.map((row) => row.id)).toEqual(['a1', 'a2']);
      expect(rows[0].text).toBe('Alpha\n\nBeta');
      expect(rows[0].toolCallNames).toEqual(['Read']);
      expect(rows[1].text).toBe('Second');
      expect(rows[1].toolCallNames).toEqual([]);
    });

    it('returns only rows strictly after the anchor timestamp — same-millisecond rows are excluded', () => {
      const sessionId = 'session-since-anchor';
      insertAssistantProjectionRow(sessionId, 'anchor', '2026-08-11T11:01:00.000Z', [
        { type: 'text', text: 'Anchor' },
      ]);
      insertAssistantProjectionRow(sessionId, 'same-ms', '2026-08-11T11:01:00.000Z', [
        { type: 'text', text: 'Same ms' },
      ]);
      insertAssistantProjectionRow(sessionId, 'later', '2026-08-11T11:01:01.000Z', [
        { type: 'text', text: 'Later' },
      ]);

      expect(
        repository.getAssistantMessagesSince(sessionId, 'anchor').map((row) => row.id)
      ).toEqual(['later']);
    });

    it('anchors on the stored timestamp, not insertion order', () => {
      const sessionId = 'session-since-order';
      insertAssistantProjectionRow(sessionId, 'mid-anchor', '2026-08-11T11:02:01.000Z', [
        { type: 'text', text: 'Mid' },
      ]);
      insertAssistantProjectionRow(sessionId, 'older-inserted-late', '2026-08-11T11:02:00.000Z', [
        { type: 'text', text: 'Older' },
      ]);
      insertAssistantProjectionRow(sessionId, 'newer', '2026-08-11T11:02:02.000Z', [
        { type: 'text', text: 'Newer' },
      ]);

      expect(
        repository.getAssistantMessagesSince(sessionId, 'mid-anchor').map((row) => row.id)
      ).toEqual(['newer']);
    });

    it('includes subagent rows — there is no parent_tool_use_id filter', () => {
      const sessionId = 'session-since-sub';
      insertAssistantProjectionRow(sessionId, 'top', '2026-08-11T11:03:00.000Z', [
        { type: 'text', text: 'Top' },
      ]);
      insertAssistantProjectionRow(
        sessionId,
        'nested',
        '2026-08-11T11:03:01.000Z',
        [{ type: 'text', text: 'Nested' }],
        'tu-9'
      );

      expect(repository.getAssistantMessagesSince(sessionId, null).map((row) => row.id)).toEqual([
        'top',
        'nested',
      ]);
    });

    it('returns an empty array when the anchor id does not exist', () => {
      const sessionId = 'session-since-missing';
      insertAssistantProjectionRow(sessionId, 'a1', '2026-08-11T11:04:00.000Z', [
        { type: 'text', text: 'Only' },
      ]);

      expect(repository.getAssistantMessagesSince(sessionId, 'no-such-id')).toEqual([]);
    });

    it('throws on a malformed assistant row — the parse is unguarded here', () => {
      const sessionId = 'session-since-malformed';
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
         VALUES ('bad-assistant', ?, 'assistant', '{not-json', '2026-08-11T11:05:00.000Z')`
      ).run(sessionId);

      expect(() => repository.getAssistantMessagesSince(sessionId, null)).toThrow();
    });
  });

  describe('uuid lookups use the sdk_uuid column index', () => {
    function queryPlan(sql: string, params: unknown[]): string {
      const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
        detail: string;
      }>;
      return rows.map((r) => r.detail).join('\n');
    }

    beforeEach(() => {
      const insert = db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin, is_renderable, is_terminal, parent_tool_use_id, task_id, sdk_uuid, replacement_metadata_normalized)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      );
      for (let i = 0; i < 50; i++) {
        insert.run(
          `u${i}`,
          's1',
          i % 5 === 0 ? 'user' : 'assistant',
          null,
          JSON.stringify({ type: 'user', uuid: `uuid-${i}` }),
          new Date(Date.now() + i).toISOString(),
          'consumed',
          null,
          1,
          0,
          null,
          null,
          `uuid-${i}`
        );
      }
      insert.run(
        'act1',
        's1',
        'hyperneo_action',
        'prompt',
        JSON.stringify({ uuid: 'action-1' }),
        new Date().toISOString(),
        null,
        null,
        1,
        0,
        null,
        null,
        'action-1'
      );
    });

    it('getMessageByStatusAndUuid seeks idx_sdk_messages_session_uuid', () => {
      const plan = queryPlan(
        `SELECT id, sdk_message, timestamp FROM sdk_messages
         WHERE session_id = ? AND send_status = ? AND sdk_uuid = ?
         ORDER BY timestamp ASC, rowid ASC LIMIT 1`,
        ['s1', 'consumed', 'uuid-5']
      );
      expect(plan).toContain('idx_sdk_messages_session_uuid');
      expect(plan).not.toContain('SCAN sdk_messages');
    });

    it('getUserMessageByUuid seeks idx_sdk_messages_session_uuid', () => {
      const plan = queryPlan(
        `SELECT sdk_message, timestamp FROM sdk_messages
         WHERE session_id = ?
           AND message_type = 'user'
           AND sdk_uuid = ?
         ORDER BY timestamp ASC, rowid ASC
         LIMIT 1`,
        ['s1', 'uuid-5']
      );
      expect(plan).toContain('idx_sdk_messages_session_uuid');
      expect(plan).not.toContain('SCAN sdk_messages');
    });

    it('updateHyperNeoActionMessageByUuid seeks idx_sdk_messages_session_uuid', () => {
      const plan = queryPlan(
        `SELECT id FROM sdk_messages
         WHERE session_id = ?
           AND message_type = 'hyperneo_action'
           AND sdk_uuid = ?`,
        ['s1', 'action-1']
      );
      expect(plan).toContain('idx_sdk_messages_session_uuid');
      expect(plan).not.toContain('SCAN sdk_messages');
    });
  });

  describe('updateHyperNeoActionMessageByUuid — behavior (A1)', () => {
    function actionMessage(uuid: string, resolved: boolean): HyperNeoActionMessage {
      return {
        type: 'hyperneo_action',
        uuid,
        session_id: 'session-action',
        action: 'sdk_resume_choice',
        resolved,
        timestamp: Date.now(),
      };
    }

    it('rewrites the stored payload for the matching session and uuid', () => {
      const rowId = repository.saveHyperNeoActionMessage(
        'session-action',
        actionMessage('action-a', false)
      );
      expect(repository.hasUnresolvedHyperNeoAction('session-action', 'sdk_resume_choice')).toBe(
        true
      );

      repository.updateHyperNeoActionMessageByUuid('session-action', 'action-a', {
        ...actionMessage('action-a', true),
        chosenOption: 'start_fresh',
      });

      expect(repository.hasUnresolvedHyperNeoAction('session-action', 'sdk_resume_choice')).toBe(
        false
      );
      const stored = JSON.parse(
        (
          db.prepare(`SELECT sdk_message FROM sdk_messages WHERE id = ?`).get(rowId) as {
            sdk_message: string;
          }
        ).sdk_message
      ) as HyperNeoActionMessage;
      expect(stored.resolved).toBe(true);
      expect(stored.chosenOption).toBe('start_fresh');
    });

    it('is a quiet no-op when the uuid or session does not match', () => {
      const rowId = repository.saveHyperNeoActionMessage(
        'session-action',
        actionMessage('action-b', false)
      );

      repository.updateHyperNeoActionMessageByUuid(
        'session-action',
        'missing-uuid',
        actionMessage('missing-uuid', true)
      );
      repository.updateHyperNeoActionMessageByUuid(
        'session-other',
        'action-b',
        actionMessage('action-b', true)
      );

      const stored = JSON.parse(
        (
          db.prepare(`SELECT sdk_message FROM sdk_messages WHERE id = ?`).get(rowId) as {
            sdk_message: string;
          }
        ).sdk_message
      ) as HyperNeoActionMessage;
      expect(stored.resolved).toBe(false);
    });

    it('reschedules the search index for a matched row and not for a miss', () => {
      createSearchIndex();
      const rowId = repository.saveHyperNeoActionMessage(
        'session-action',
        actionMessage('action-c', false)
      );
      repository.flushMessageSearchIndex();
      const pendingCount = () =>
        (
          db
            .prepare(`SELECT COUNT(*) AS n FROM message_search_pending WHERE message_id = ?`)
            .get(rowId) as { n: number }
        ).n;
      expect(pendingCount()).toBe(0);

      repository.updateHyperNeoActionMessageByUuid(
        'session-action',
        'action-c',
        actionMessage('action-c', true)
      );
      expect(pendingCount()).toBe(1);

      repository.flushMessageSearchIndex();
      repository.updateHyperNeoActionMessageByUuid(
        'session-action',
        'missing-uuid',
        actionMessage('missing-uuid', true)
      );
      expect(pendingCount()).toBe(0);
    });
  });

  describe('malformed sdk_message rows — per-reader policy table (A1)', () => {
    function insertMalformedRow(opts: {
      sessionId: string;
      id: string;
      type: string;
      subtype?: string | null;
      timestamp: string;
      sdkUuid?: string | null;
      parentToolUseId?: string | null;
    }): void {
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, sdk_uuid, parent_tool_use_id)
         VALUES (?, ?, ?, ?, '{not-json', ?, ?, ?)`
      ).run(
        opts.id,
        opts.sessionId,
        opts.type,
        opts.subtype ?? null,
        opts.timestamp,
        opts.sdkUuid ?? null,
        opts.parentToolUseId ?? null
      );
    }

    function insertWellFormedRow(
      sessionId: string,
      id: string,
      type: string,
      sdkMessage: SDKMessage,
      timestamp: string
    ): void {
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
         VALUES (?, ?, ?, ?, ?)`
      ).run(id, sessionId, type, JSON.stringify(sdkMessage), timestamp);
    }

    it('synthesizes type=unknown: pagination top-level and subagent fan-out, background task metadata, and the inflate paths', () => {
      insertMalformedRow({
        sessionId: 's-synth-top',
        id: 'bad-top',
        type: 'assistant',
        timestamp: '2026-08-11T12:00:00.000Z',
      });
      const paginated = repository.getSDKMessages('s-synth-top');
      expect(paginated.messages).toHaveLength(1);
      expect(paginated.messages[0].type).toBe('unknown');
      expect((paginated.messages[0] as { rawContent?: string }).rawContent).toBe('{not-json');

      repository.saveSDKMessage('s-synth-sub', createAssistantMessage('Top', 'tu-bad'));
      insertMalformedRow({
        sessionId: 's-synth-sub',
        id: 'bad-sub',
        type: 'assistant',
        timestamp: '2026-08-11T12:01:00.000Z',
        parentToolUseId: 'tu-bad',
      });
      const fanned = repository.getSDKMessages('s-synth-sub');
      expect(fanned.messages).toHaveLength(2);
      expect(fanned.messages[1].type).toBe('unknown');
      expect((fanned.messages[1] as { rawContent?: string }).rawContent).toBe('{not-json');

      insertMalformedRow({
        sessionId: 's-synth-bg',
        id: 'bad-meta',
        type: 'system',
        subtype: 'task_started',
        timestamp: '2026-08-11T12:02:00.000Z',
      });
      const background = repository.getBackgroundTaskMessages('s-synth-bg');
      expect(background).toHaveLength(1);
      expect(background[0].type).toBe('unknown');
      expect((background[0] as { rawContent?: string }).rawContent).toBe('{not-json');

      insertMalformedRow({
        sessionId: 's-synth-last',
        id: 'bad-last',
        type: 'system',
        subtype: 'task_progress',
        timestamp: '2026-08-11T12:03:00.000Z',
      });
      const last = repository.getLastSDKMessage('s-synth-last');
      expect(last?.type).toBe('unknown');
      expect((last as { rawContent?: string } | null)?.rawContent).toBe('{not-json');
      expect((last as { dbId?: string } | null)?.dbId).toBe('bad-last');
    });

    it('skips the row: getRenderableTextMessages omits malformed rows and keeps filling from later rows', () => {
      insertWellFormedRow(
        's-skip',
        'good-old',
        'user',
        createUserMessage('Older good'),
        '2026-08-11T12:04:00.000Z'
      );
      insertMalformedRow({
        sessionId: 's-skip',
        id: 'bad-middle',
        type: 'assistant',
        timestamp: '2026-08-11T12:04:01.000Z',
      });
      insertWellFormedRow(
        's-skip',
        'good-new',
        'assistant',
        createAssistantMessage('Newer good'),
        '2026-08-11T12:04:02.000Z'
      );

      const texts = repository.getRenderableTextMessages('s-skip', 2);

      expect(texts.map((row) => row.text)).toEqual(['Older good', 'Newer good']);
    });

    it('throws: getSDKMessagesByType and getUserMessages parse unguarded', () => {
      insertMalformedRow({
        sessionId: 's-throw',
        id: 'bad-user',
        type: 'user',
        timestamp: '2026-08-11T12:05:00.000Z',
        sdkUuid: 'bad-user-uuid',
      });

      expect(() => repository.getSDKMessagesByType('s-throw', 'user')).toThrow();
      expect(() => repository.getUserMessages('s-throw')).toThrow();
    });

    it('returns null: getUserMessageContentByUuid and getDeliveryContent swallow the parse failure', () => {
      insertMalformedRow({
        sessionId: 's-null',
        id: 'bad-content',
        type: 'user',
        timestamp: '2026-08-11T12:06:00.000Z',
        sdkUuid: 'bad-content-uuid',
      });

      expect(repository.getUserMessageContentByUuid('s-null', 'bad-content-uuid')).toBeNull();
      expect(repository.getDeliveryContent('s-null', 'bad-content-uuid')).toBeNull();
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

      expect((messages[0] as { origin?: string }).origin).toBeUndefined();
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
    function searchAfterFlush(params: MessageSearchParams): MessageSearchResponse {
      repository.flushMessageSearchIndex();
      return repository.searchMessages(params);
    }

    it('returns scoped matches with snippets', () => {
      createSearchIndex();
      repository.saveSDKMessage('session-1', createUserMessage('alpha regression bug'));
      repository.saveSDKMessage('session-2', createUserMessage('alpha unrelated'));

      const result = searchAfterFlush({ query: 'alpha', sessionId: 'session-1' });

      expect(result.results.length).toBe(1);
      expect(result.results[0].sessionId).toBe('session-1');
      expect(result.results[0].snippet).toContain('<mark>alpha</mark>');
    });

    it('ignores search terms shorter than three characters', () => {
      createSearchIndex();
      repository.saveSDKMessage('session-1', createUserMessage('ui marker'));

      const result = searchAfterFlush({ query: 'ui' });

      expect(result.results).toEqual([]);
    });

    it('returns cross-session matches when no session filter is provided', () => {
      createSearchIndex();
      repository.saveSDKMessage('session-1', createUserMessage('global comet marker'));
      repository.saveSDKMessage('session-2', createUserMessage('global comet marker'));

      const result = searchAfterFlush({ query: 'comet' });

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

      const result = searchAfterFlush({
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

      const result = searchAfterFlush({ query: 'type marker' });

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

      const result = searchAfterFlush({ query: 'policy marker' });

      expect(result.results.map((row) => row.sessionId).sort()).toEqual([
        'session-1',
        'space:space-1:task:task-1:exec:exec-1',
      ]);
    });

    it('filters stale session and task retention rows at search time', () => {
      createSearchIndex();
      createSearchPolicyTables();
      const oldSessionTime = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
      const oldTaskTime = Date.now() - 45 * 24 * 60 * 60 * 1000;
      insertSession('old-session', { status: 'active', lastActiveAt: new Date().toISOString() });
      insertSession('space:space-1:task:old-task:exec:exec-1', {
        context: { spaceId: 'space-1', taskId: 'old-task' },
      });
      db.prepare(
        `INSERT INTO space_tasks (id, space_id, task_number, status, completed_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
      ).run('old-task', 'space-1', 1, 'done', Date.now(), Date.now());
      repository.saveSDKMessage('old-session', createUserMessage('stale runtime session marker'));
      repository.saveSDKMessage(
        'space:space-1:task:old-task:exec:exec-1',
        createUserMessage('stale runtime task marker')
      );
      db.prepare(`UPDATE sessions SET status = 'ended', last_active_at = ? WHERE id = ?`).run(
        oldSessionTime,
        'old-session'
      );
      db.prepare(`UPDATE space_tasks SET completed_at = ?, updated_at = ? WHERE id = ?`).run(
        oldTaskTime,
        oldTaskTime,
        'old-task'
      );

      const result = searchAfterFlush({ query: 'stale runtime' });

      expect(result.results).toEqual([]);
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

      const result = searchAfterFlush({ query: 'retention marker' });

      expect(result.results.map((row) => row.sessionId)).toEqual([
        'space:space-1:task:recent:exec:exec-1',
      ]);
    });

    it('returns task search rows from indexed titles and descriptions', () => {
      createSearchIndex();
      db.prepare(
        `INSERT INTO message_search_content (
					kind, source_id, task_id, space_id, task_number, title, body, timestamp
				) VALUES ('task', ?, ?, ?, ?, ?, ?, ?)`
      ).run('task-1', 'task-1', 'space-1', 12, 'Orion title', 'Task description', Date.now());

      const titleResult = searchAfterFlush({ query: 'orion' });
      const bodyResult = searchAfterFlush({ query: 'description' });

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

    it('removes fallback-retracted messages from search index', () => {
      createSearchIndex();
      repository.saveSDKMessage(
        'session-1',
        createUserMessage('refused searchable marker', 'refused-uuid')
      );

      expect(searchAfterFlush({ query: 'refused searchable' }).results).toHaveLength(1);
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'model_refusal_fallback',
        uuid: 'fallback-notice',
        retracted_message_uuids: ['refused-uuid'],
        session_id: 'session-1',
      } as unknown as SDKMessage);

      expect(searchAfterFlush({ query: 'refused searchable' }).results).toEqual([]);
    });

    it('keeps search rows for retraction arrays outside model refusal fallback messages', () => {
      createSearchIndex();
      repository.saveSDKMessage(
        'session-1',
        createUserMessage('orphan retraction marker', 'orphan-uuid')
      );

      expect(searchAfterFlush({ query: 'orphan retraction' }).results).toHaveLength(1);
      repository.saveSDKMessage('session-1', {
        type: 'assistant',
        uuid: 'non-fallback-carrier',
        retracted_message_uuids: ['orphan-uuid'],
        message: { role: 'assistant', content: [{ type: 'text', text: 'carrier text' }] },
      } as unknown as SDKMessage);

      expect(db.prepare(`SELECT COUNT(*) AS count FROM sdk_message_replacements`).get()).toEqual({
        count: 0,
      });
      expect(searchAfterFlush({ query: 'orphan retraction' }).results).toHaveLength(1);
    });

    it('keeps fallback-retracted messages out during search index rebuild', () => {
      createSearchIndex();
      repository.saveSDKMessage(
        'session-1',
        createUserMessage('rebuild hidden marker', 'hidden-uuid')
      );
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'model_refusal_fallback',
        uuid: 'fallback-notice',
        retracted_message_uuids: ['hidden-uuid'],
        session_id: 'session-1',
      } as unknown as SDKMessage);

      const hiddenRow = db
        .prepare(`SELECT id FROM sdk_messages WHERE json_extract(sdk_message, '$.uuid') = ?`)
        .get('hidden-uuid') as { id: string };
      repository.updateMessageTimestamp(hiddenRow.id);

      expect(searchAfterFlush({ query: 'rebuild hidden' }).results).toEqual([]);
    });

    it('removes superseded messages from search index', () => {
      createSearchIndex();
      repository.saveSDKMessage(
        'session-1',
        createUserMessage('superseded searchable marker', 'superseded-uuid')
      );

      expect(searchAfterFlush({ query: 'superseded searchable' }).results).toHaveLength(1);
      repository.saveSDKMessage('session-1', {
        type: 'assistant',
        uuid: 'replacement-uuid',
        supersedes: ['superseded-uuid'],
        message: { role: 'assistant', content: [{ type: 'text', text: 'replacement marker' }] },
      } as unknown as SDKMessage);

      expect(searchAfterFlush({ query: 'superseded searchable' }).results).toEqual([]);
    });

    it('removes deleted messages from search index', () => {
      createSearchIndex();
      const before = Date.now() - 1000;
      repository.saveSDKMessage('session-1', createUserMessage('temporary rollback marker'));

      expect(searchAfterFlush({ query: 'rollback' }).results.length).toBe(1);
      repository.deleteMessagesAfter('session-1', before);

      expect(searchAfterFlush({ query: 'rollback' }).results.length).toBe(0);
    });

    it('defers indexing until the pending queue is flushed', () => {
      createSearchIndex();
      repository.saveSDKMessage('session-1', createUserMessage('deferred window marker'));

      expect(repository.searchMessages({ query: 'deferred window' }).results).toEqual([]);

      repository.flushMessageSearchIndex();

      expect(repository.searchMessages({ query: 'deferred window' }).results).toHaveLength(1);
    });

    it('indexes pending rows left from a previous run on flush', () => {
      createSearchIndex();
      repository.saveSDKMessage('session-1', createUserMessage('recovery marker'));

      const pending = db.prepare(`SELECT message_id FROM message_search_pending`).all() as Array<{
        message_id: string;
      }>;
      expect(pending).toHaveLength(1);

      repository.flushMessageSearchIndex();

      expect(db.prepare(`SELECT COUNT(*) AS n FROM message_search_pending`).get()).toEqual({
        n: 0,
      });
      expect(repository.searchMessages({ query: 'recovery' }).results).toHaveLength(1);
    });

    it('retains pending rows that fail to index and retries on a later flush', () => {
      createSearchIndex();
      repository.saveSDKMessage('session-1', createUserMessage('retry marker'));

      db.exec(`DROP TABLE message_search_fts`);

      repository.flushMessageSearchIndex();
      expect(db.prepare(`SELECT COUNT(*) AS n FROM message_search_pending`).get()).toEqual({
        n: 1,
      });

      db.exec(
        `CREATE VIRTUAL TABLE message_search_fts USING fts5(
					title,
					body,
					content='message_search_content',
					content_rowid='id',
					detail=column,
					tokenize = 'unicode61'
				)`
      );

      repository.flushMessageSearchIndex();

      expect(repository.searchMessages({ query: 'retry marker' }).results).toHaveLength(1);
    });

    it('coalesces repeated schedules of the same message', () => {
      createSearchIndex();
      const id = repository.saveUserMessage(
        'session-1',
        createUserMessage('coalesced marker'),
        'consumed'
      );
      repository.updateMessageTimestamp(id, Date.now() - 5_000);
      repository.updateMessageStatus([id], 'consumed');

      const pending = db.prepare(`SELECT message_id FROM message_search_pending`).all() as Array<{
        message_id: string;
      }>;
      expect(pending).toHaveLength(1);

      repository.flushMessageSearchIndex();

      expect(repository.searchMessages({ query: 'coalesced' }).results).toHaveLength(1);
    });

    it('processes at most limit pending rows per flush', () => {
      createSearchIndex();
      repository.saveUserMessage('session-1', createUserMessage('bounded marker a'), 'consumed');
      repository.saveUserMessage('session-1', createUserMessage('bounded marker b'), 'consumed');
      expect(db.prepare(`SELECT COUNT(*) AS n FROM message_search_pending`).get()).toEqual({
        n: 2,
      });

      expect(repository.flushMessageSearchIndex(1)).toBe(1);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM message_search_pending`).get()).toEqual({
        n: 1,
      });

      repository.flushMessageSearchIndex();
      expect(db.prepare(`SELECT COUNT(*) AS n FROM message_search_pending`).get()).toEqual({
        n: 0,
      });
    });

    it('indexes synchronously when the pending queue table is absent', () => {
      createSearchIndex();
      db.exec(`DROP TABLE message_search_pending`);
      repository.saveSDKMessage('session-1', createUserMessage('sync fallback marker'));

      expect(repository.searchMessages({ query: 'sync fallback' }).results).toHaveLength(1);
    });

    it('applies supersession when the replacement is still pending', () => {
      createSearchIndex();
      repository.saveSDKMessage(
        'session-1',
        createUserMessage('interleave superseded', 'interleave-uuid')
      );
      repository.saveSDKMessage('session-1', {
        type: 'assistant',
        uuid: 'interleave-replacement',
        supersedes: ['interleave-uuid'],
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'interleave replacement text' }],
        },
      } as unknown as SDKMessage);

      repository.flushMessageSearchIndex();

      expect(repository.searchMessages({ query: 'interleave superseded' }).results).toEqual([]);
      expect(repository.searchMessages({ query: 'interleave replacement' }).results).toHaveLength(
        1
      );
    });

    describe('flush boundary — delete-then-decide ordering and malformed payload outcomes (C1)', () => {
      function contentRowCount(id: string): number {
        return (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM message_search_content WHERE kind = 'message' AND source_id = ?`
            )
            .get(id) as { n: number }
        ).n;
      }

      function pendingCount(): number {
        return (
          db.prepare(`SELECT COUNT(*) AS n FROM message_search_pending`).get() as { n: number }
        ).n;
      }

      it('deletes the old search row for a row that became ineligible — the DELETE runs before the admission gates, so nothing is re-inserted', () => {
        createSearchIndex();
        createSearchPolicyTables();
        insertSession('session-1', { status: 'active' });
        const id = repository.saveUserMessage(
          'session-1',
          createUserMessage('archived flush marker'),
          'consumed'
        );
        expect(searchAfterFlush({ query: 'archived flush marker' }).results).toHaveLength(1);
        expect(contentRowCount(id)).toBe(1);

        db.prepare(`UPDATE sessions SET status = 'archived' WHERE id = 'session-1'`).run();
        repository.updateMessageTimestamp(id);

        repository.flushMessageSearchIndex();

        expect(contentRowCount(id)).toBe(0);
        expect(pendingCount()).toBe(0);
      });

      it('a JSON-valid null payload throws in body extraction — the flush transaction rolls back, the indexed row survives, and the pending entry is retained for retry', () => {
        createSearchIndex();
        const id = repository.saveUserMessage(
          'session-1',
          createUserMessage('null payload marker'),
          'consumed'
        );
        expect(searchAfterFlush({ query: 'null payload marker' }).results).toHaveLength(1);
        expect(contentRowCount(id)).toBe(1);

        db.prepare(`UPDATE sdk_messages SET sdk_message = 'null' WHERE id = ?`).run(id);
        repository.updateMessageTimestamp(id);

        repository.flushMessageSearchIndex();

        expect(pendingCount()).toBe(1);
        expect(contentRowCount(id)).toBe(1);

        db.prepare(`UPDATE sdk_messages SET sdk_message = ? WHERE id = ?`).run(
          JSON.stringify(createUserMessage('null payload repaired', `repaired-${id}`)),
          id
        );
        repository.flushMessageSearchIndex();

        expect(pendingCount()).toBe(0);
        expect(repository.searchMessages({ query: 'null payload repaired' }).results).toHaveLength(
          1
        );
      });

      it('a syntactically invalid payload parse-catches before the DELETE — the pending entry is cleared and stale indexed content is kept with no retry', () => {
        createSearchIndex();
        const id = repository.saveUserMessage(
          'session-1',
          createUserMessage('stale content marker'),
          'consumed'
        );
        expect(searchAfterFlush({ query: 'stale content' }).results).toHaveLength(1);
        expect(contentRowCount(id)).toBe(1);

        db.prepare(`UPDATE sdk_messages SET sdk_message = '{not-json' WHERE id = ?`).run(id);
        repository.updateMessageTimestamp(id);

        repository.flushMessageSearchIndex();

        expect(pendingCount()).toBe(0);
        expect(contentRowCount(id)).toBe(1);
        expect(repository.searchMessages({ query: 'stale content' }).results).toHaveLength(1);
      });
    });
  });

  describe('conversation_turn_index — anchor gated on sendStatus (#2338)', () => {
    const resultMessage = {
      type: 'result',
      subtype: 'success',
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      total_cost_usd: 0,
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
        total_tokens: 2,
      },
    } as unknown as SDKMessage;

    function linkTaskSession(sessionId: string, taskId: string): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          type TEXT,
          session_context TEXT,
          room_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.roomId') END) VIRTUAL,
          space_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.spaceId') END) VIRTUAL,
          task_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.taskId') END) VIRTUAL
        )
      `);
      db.prepare(
        `INSERT INTO sessions (id, type, session_context) VALUES (?, 'space_task_agent', ?)`
      ).run(sessionId, JSON.stringify({ taskId }));
    }

    function turnOf(id: string): number | null {
      const row = db
        .prepare(`SELECT conversation_turn_index AS t FROM sdk_messages WHERE id = ?`)
        .get(id) as { t: number | null } | undefined;
      return row?.t ?? null;
    }

    function resultId(): string {
      return (
        db.prepare(`SELECT id FROM sdk_messages WHERE message_type = 'result'`).get() as {
          id: string;
        }
      ).id;
    }

    it('keeps the in-flight result under the original prompt when a message is queued mid-turn', () => {
      linkTaskSession('session-1', 'task-1');
      const u1 = repository.saveUserMessage('session-1', createUserMessage('go'), 'consumed');
      repository.saveSDKMessage('session-1', createAssistantMessage('working'));
      const u2 = repository.saveUserMessage(
        'session-1',
        createUserMessage('also this'),
        'enqueued'
      );
      repository.saveSDKMessage('session-1', resultMessage);
      const r1 = resultId();

      expect(turnOf(u1)).toBe(1);
      expect(turnOf(r1)).toBe(1);
      expect(turnOf(u2)).toBe(1);

      repository.updateMessageStatus([u2], 'consumed');
      expect(turnOf(u2)).toBe(2);
      expect(turnOf(r1)).toBe(1);
    });

    it('assigns sequential turns when multiple queued messages are consumed in order', () => {
      linkTaskSession('session-1', 'task-1');
      repository.saveUserMessage('session-1', createUserMessage('go'), 'consumed');
      const u2 = repository.saveUserMessage('session-1', createUserMessage('two'), 'enqueued');
      const u3 = repository.saveUserMessage('session-1', createUserMessage('three'), 'enqueued');

      repository.updateMessageStatus([u2, u3], 'consumed');

      expect(turnOf(u2)).toBe(2);
      expect(turnOf(u3)).toBe(3);
    });

    it('assigns ONE shared turn to a batched flush consumed together (sharedTurn)', () => {
      linkTaskSession('session-1', 'task-1');
      repository.saveUserMessage('session-1', createUserMessage('go'), 'consumed');
      const u2 = repository.saveUserMessage('session-1', createUserMessage('two'), 'enqueued');
      const u3 = repository.saveUserMessage('session-1', createUserMessage('three'), 'enqueued');
      const u4 = repository.saveUserMessage('session-1', createUserMessage('four'), 'enqueued');

      repository.updateMessageStatus([u2, u3, u4], 'consumed', { sharedTurn: true });

      expect(turnOf(u2)).toBe(2);
      expect(turnOf(u3)).toBe(2);
      expect(turnOf(u4)).toBe(2);
      const u5 = repository.saveUserMessage('session-1', createUserMessage('five'), 'enqueued');
      repository.updateMessageStatus([u5], 'consumed');
      expect(turnOf(u5)).toBe(3);
    });

    it('does not re-bump the turn when an already-consumed row is flipped to failed (recovery path)', () => {
      linkTaskSession('session-1', 'task-1');
      const u1 = repository.saveUserMessage('session-1', createUserMessage('first'), 'consumed');
      const u2 = repository.saveUserMessage('session-1', createUserMessage('second'), 'consumed');
      expect(turnOf(u1)).toBe(1);
      expect(turnOf(u2)).toBe(2);

      repository.updateMessageStatus([u1], 'failed');

      expect(turnOf(u1)).toBe(1);
      expect(turnOf(u2)).toBe(2);
    });

    it('assigns a turn when a queued message fails delivery (enqueued→failed)', () => {
      linkTaskSession('session-1', 'task-1');
      repository.saveUserMessage('session-1', createUserMessage('go'), 'consumed');
      const u2 = repository.saveUserMessage('session-1', createUserMessage('lost'), 'enqueued');

      repository.updateMessageStatus([u2], 'failed');

      expect(turnOf(u2)).toBe(2);
    });

    it("keeps each session's non-anchor rows on that session's own turn across interleaved sessions (#2338)", () => {
      linkTaskSession('sess-A', 'task-1');
      linkTaskSession('sess-B', 'task-1');
      repository.saveUserMessage('sess-A', createUserMessage('A-prompt'), 'consumed');
      repository.saveUserMessage('sess-B', createUserMessage('B-prompt'), 'consumed');
      repository.saveSDKMessage('sess-A', createAssistantMessage('A-answer'));
      repository.saveSDKMessage('sess-B', createAssistantMessage('B-answer'));

      const latestAssistantTurn = (sid: string): number | null =>
        (
          db
            .prepare(
              `SELECT conversation_turn_index AS t FROM sdk_messages
                WHERE session_id = ? AND message_type = 'assistant'
                ORDER BY rowid DESC LIMIT 1`
            )
            .get(sid) as { t: number | null }
        ).t;

      expect(latestAssistantTurn('sess-A')).toBe(1);
      expect(latestAssistantTurn('sess-B')).toBe(2);
    });

    it('aligns the timestamp with the new turn when a queued row is promoted on consume/fail (#2338)', () => {
      linkTaskSession('session-1', 'task-1');
      repository.saveUserMessage('session-1', createUserMessage('go'), 'consumed');
      const u2 = 'u2-old-ts';
      db.prepare(
        `INSERT INTO sdk_messages (
           id, session_id, message_type, message_subtype, sdk_message, timestamp,
           send_status, origin, is_renderable, is_terminal, task_id,
           conversation_turn_index, sdk_uuid, replacement_metadata_normalized
         ) VALUES (?, 'session-1', 'user', NULL, '{}', '2020-01-01T00:00:00.000Z',
                   'enqueued', 'human', 1, 0, 'task-1', NULL, NULL, 1)`
      ).run(u2);

      repository.updateMessageStatus([u2], 'failed');

      const ts = (
        db.prepare(`SELECT timestamp FROM sdk_messages WHERE id = ?`).get(u2) as {
          timestamp: string;
        }
      ).timestamp;
      expect(ts).not.toBe('2020-01-01T00:00:00.000Z');
      expect(new Date(ts).getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());
    });
  });

  describe('schema introspection caching (perf E1)', () => {
    function wrapIntrospectionCounter(db: Database) {
      const originalPrepare = db.prepare.bind(db);
      let count = 0;
      (
        db as unknown as {
          prepare: (sql: string, ...args: unknown[]) => unknown;
        }
      ).prepare = (sql: string, ...args: unknown[]) => {
        if (
          sql.includes('sqlite_master') ||
          sql.includes('PRAGMA table_info') ||
          sql.includes('PRAGMA table_xinfo')
        )
          count++;
        return originalPrepare(sql, ...args);
      };
      return {
        reset: () => {
          count = 0;
        },
        count: () => count,
      };
    }

    function resultMessage(): SDKMessage {
      return {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        duration_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        usage: {},
      } as unknown as SDKMessage;
    }

    it('performs zero schema-introspection queries on steady-state saves', () => {
      createSearchIndex();
      createSearchPolicyTables();
      insertSession('session-1');
      db.prepare(
        `INSERT INTO space_tasks (id, space_id, task_number, status, completed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('task-1', 'space-1', 1, 'in_progress', null, Date.now());

      const counter = wrapIntrospectionCounter(db);
      repository.saveSDKMessage('session-1', createUserMessage('warmup user'));
      repository.saveSDKMessage('session-1', resultMessage());

      expect(counter.count()).toBeGreaterThan(0);
      counter.reset();
      repository.saveSDKMessage('session-1', createUserMessage('steady user'));
      repository.saveSDKMessage('session-1', createAssistantMessage('steady assistant'));
      repository.saveSDKMessage('session-1', resultMessage());

      expect(counter.count()).toBe(0);

      repository.flushMessageSearchIndex();

      const bodies = db
        .prepare(
          `SELECT body FROM message_search_content WHERE kind = 'message' ORDER BY timestamp`
        )
        .all() as Array<{ body: string }>;
      expect(bodies.some((row) => row.body.includes('steady user'))).toBe(true);
      expect(bodies.some((row) => row.body.includes('steady assistant'))).toBe(true);
    });
  });
});
