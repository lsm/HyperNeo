/**
 * SDK Message Repository Tests
 *
 * Tests for SDK message CRUD operations, pagination, and query mode tracking.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  SDKMessageRepository,
  type SendStatus,
} from '../../../../src/storage/repositories/sdk-message-repository';
import { classifyReclaimTermination } from '../../../../src/lib/agent/message-delivery';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { HyperNeoActionMessage } from '@hyperneo/shared';

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
				PRIMARY KEY (kind, source_id)
			);
			CREATE VIRTUAL TABLE message_search_fts USING fts5(
				title,
				body,
				content='message_search_content',
				content_rowid='rowid',
				detail=column,
				tokenize = 'unicode61'
			);
			CREATE TRIGGER message_search_content_ai
			AFTER INSERT ON message_search_content BEGIN
				INSERT INTO message_search_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
			END;
			CREATE TRIGGER message_search_content_ad
			AFTER DELETE ON message_search_content BEGIN
				INSERT INTO message_search_fts(message_search_fts, rowid, title, body)
				VALUES ('delete', old.rowid, old.title, old.body);
			END;
			CREATE TRIGGER message_search_content_au
			AFTER UPDATE OF title, body ON message_search_content BEGIN
				INSERT INTO message_search_fts(message_search_fts, rowid, title, body)
				VALUES ('delete', old.rowid, old.title, old.body);
				INSERT INTO message_search_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
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

    it('includes same-timestamp rows at the before cursor (inclusive boundary)', () => {
      // 'older' at T-1d; 'a' and 'b' share timestamp T (a same-ms burst like
      // hook phases). saveSDKMessage stamps real time, so set timestamps directly.
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

      // before = T (the boundary/oldest-shown cursor). An inclusive boundary
      // surfaces the same-ms sibling 'b' (and 'a', which the client dedups by
      // id) plus the older row — instead of permanently skipping rows at T.
      const { messages } = repository.getSDKMessages('session-1', 100, Tms);
      const texts = messages.map(
        (m) =>
          (m as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]?.text
      );
      expect(texts).toContain('b');
      expect(texts).toContain('older');
    });

    it('advances through more-than-limit same-timestamp rows via the rowid cursor', () => {
      // 5 messages sharing one timestamp T, paginated with limit 3. A
      // timestamp-only cursor would return the same newest 3 every page (client
      // dedups them, never reaching rows 1-2). The (timestamp, rowid) cursor
      // must reach the older same-ms rows.
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

      // Page 2 uses the oldest page-1 row's (timestamp, rowid) as the cursor.
      const page2 = repository.getSDKMessages('session-1', 3, Tms, undefined, oldest.rowid);
      const page2Texts = page2.messages.map(
        (m) =>
          (m as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]?.text
      );
      // The two older same-ms rows (inserted first) are now reachable.
      expect(page2Texts).toContain('same-0');
      expect(page2Texts).toContain('same-1');
      // None of page 1's rows leak into page 2.
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

      // Order-independent: back-to-back saves can share a millisecond, which
      // makes `getSDKMessages`' timestamp-DESC ordering nondeterministic
      // between the user row and the task_notification row.
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
      // Order-independent: back-to-back saves can share a millisecond, which
      // makes `getSDKMessages`' timestamp-DESC ordering nondeterministic
      // between the user and assistant rows.
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

      // Only top-level assistant and subagent response should be returned (thinking_tokens filtered)
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
      // hook_started/hook_progress are no longer globally hidden (chat-visible
      // hook events now); task_* are hidden but kept as progress signals via
      // LAST_MESSAGE_PROGRESS_SUBTYPES, so they're not skipped here. Sample the
      // remaining hidden non-progress subtypes.
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
    // These tests use a sessions table that carries `visible_message_count`,
    // unlike the suite-wide setup (which has no sessions table at all and so
    // exercises the no-op guard).
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

    /** Same predicate the former spaceSessions.bySpace subquery used — drift check. */
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
      // Back to a non-visible status removes it again.
      badgeRepo.updateMessageStatus([id], 'enqueued');
      expect(badgeCount()).toBe(0);
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
      // Simulates scripts/recover-messages.ts: a raw INSERT into sdk_messages
      // that skips the maintained counter, then a repair via the shared public
      // recompute entry point (so the script reuses the predicate, not a copy).
      const insertRaw = badgeDb.prepare(
        `INSERT INTO sdk_messages
           (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, parent_tool_use_id)
         VALUES (?, ?, ?, ?, ?, ?, 'consumed', NULL)`
      );
      insertRaw.run('raw-1', SID, 'assistant', null, '{}', '2026-01-01T00:00:00Z');
      insertRaw.run('raw-2', SID, 'user', null, '{}', '2026-01-01T00:00:01Z');
      // The bypass insert left the counter stale at 0.
      expect(badgeCount()).toBe(0);
      // Returns true because the value actually changed; counter now matches.
      expect(badgeRepo.recomputeVisibleMessageCount(SID)).toBe(true);
      expect(badgeCount()).toBe(2);
      expect(badgeCount()).toBe(freshBadgeCount());
      // A second recompute is a no-op (returns false, value unchanged).
      expect(badgeRepo.recomputeVisibleMessageCount(SID)).toBe(false);
    });

    it('stays consistent with a fresh COUNT(*) across a mixed sequence', () => {
      // Anti-drift: a representative mix of inserts, a status flip, a hidden
      // subtype, and a partial rewind — the maintained counter must equal a
      // freshly computed badge count throughout.
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
      // Rewind from the 3rd-oldest row onward.
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
      // Must not throw and must not try to UPDATE a non-existent sessions table.
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

  describe('markDeliveryConsumedByUuid (task #861 item 12 — synchronous consumed-flip)', () => {
    it('flips an enqueued row to consumed and returns its db id', () => {
      const id = repository.saveUserMessage(
        'session-1',
        createUserMessage('consume me', 'uuid-consume'),
        'enqueued'
      );

      const flipped = repository.markDeliveryConsumedByUuid('session-1', 'uuid-consume');

      expect(flipped).toBe(id);
      expect(repository.getMessagesByStatus('session-1', 'enqueued').length).toBe(0);
      expect(repository.getMessagesByStatus('session-1', 'consumed').length).toBe(1);
    });

    it('is idempotent: a second call returns null (already consumed, no double-flip)', () => {
      repository.saveUserMessage(
        'session-1',
        createUserMessage('once only', 'uuid-once'),
        'enqueued'
      );

      expect(repository.markDeliveryConsumedByUuid('session-1', 'uuid-once')).not.toBeNull();
      // Already consumed — no-op, returns null so the caller skips the broadcast.
      expect(repository.markDeliveryConsumedByUuid('session-1', 'uuid-once')).toBeNull();
    });

    it('does not flip a deferred row (not a consume candidate)', () => {
      repository.saveUserMessage(
        'session-1',
        createUserMessage('still deferred', 'uuid-def'),
        'deferred'
      );
      expect(repository.markDeliveryConsumedByUuid('session-1', 'uuid-def')).toBeNull();
      expect(repository.getMessagesByStatus('session-1', 'deferred').length).toBe(1);
    });

    it('returns null when the uuid is unknown', () => {
      expect(repository.markDeliveryConsumedByUuid('session-1', 'no-such-uuid')).toBeNull();
    });

    it('markDeliveryConsumedByUuids flips kickoff + members in one atomic call', () => {
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
        'uuid-kick', // duplicate — must not double-flip
      ]);

      expect(flipped.sort()).toEqual([kickoffId, memberId].sort());
      expect(repository.getMessagesByStatus('session-1', 'enqueued').length).toBe(0);
      expect(repository.getMessagesByStatus('session-1', 'consumed').length).toBe(2);
      // The deferred member is not a consume candidate — stays deferred.
      expect(repository.getMessagesByStatus('session-1', 'deferred').length).toBe(1);
    });

    it('markDeliveryFailedByUuidInclusive does NOT fail a deferred row (user hold survives dead-letter)', () => {
      repository.saveUserMessage(
        'session-1',
        createUserMessage('excluded member', 'uuid-excl'),
        'deferred'
      );
      // A dead-lettered batch must not terminalize a member the user deferred
      // out of the prompt before delivery.
      expect(repository.markDeliveryFailedByUuidInclusive('session-1', 'uuid-excl')).toBeNull();
      expect(repository.getMessagesByStatus('session-1', 'deferred').length).toBe(1);
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
      expect(repository.getMessagesByStatus('session-1', 'enqueued').length).toBe(1);
      expect(repository.getMessagesByStatus('session-1', 'consumed').length).toBe(0);
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
      expect(repository.getMessagesByStatus('session-1', 'submitted').length).toBe(1);
      expect(repository.getMessagesByStatus('session-1', 'failed').length).toBe(1);
    });

    it('returns null when the uuid is unknown', () => {
      expect(repository.markDeliveryRetryableByUuid('session-1', 'no-such-uuid')).toBeNull();
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
      }
    ): void {
      // Stamp the shared monotonic counter for consumed user rows AND terminal
      // results (mirrors saveSDKMessage/markDeliveryConsumedByUuid), so
      // hasTerminalResultAfter compares counter-to-counter. NULL otherwise.
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
        // hasTerminalResultAfter counts only `subtype = 'success'` results, so a
        // terminal result without an explicit subtype defaults to success (the
        // common case); tests that exercise error results pass subtype explicitly.
        opts.subtype ?? (type === 'result' && opts.terminal ? 'success' : null),
        '{}',
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
      // The SDK persists error results WITHOUT emitting session.error — the
      // bridge uses this lookup to classify budget exhaustion as terminal.
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
      // Retries do not restamp the user row's consumed_seq, so error results
      // from every attempt are in range — an initial retryable error followed
      // by a terminal one must classify terminal, not keep the oldest subtype.
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
      // A subagent result carries a non-null parent_tool_use_id. If the daemon
      // crashes after the subagent finishes but before the outer turn ends, that
      // nested result must NOT be accepted as proof the whole delivery turn
      // terminated — recovery would wrongly complete the owning job.
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
      // A nested result (subagent) persisted after consumption.
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
        'tool-use-123' // nested under a subagent tool_use
      );
      expect(repository.hasTerminalResultAfter('session-1', 'outer-msg')).toBe(false);
    });

    it('treats a missing consumption watermark (migrated row) as unknown/live, not completed (P1)', () => {
      // On an upgrade, in-flight consumed rows have NULL consumed_seq. Falling
      // back to insertion rowid could match the PREVIOUS turn's result and
      // wrongly complete the job. NULL must mean "unknown" → don't complete.
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
        null // migrated before the column existed
      );
      // A terminal result after it, but its consumption boundary is unknown.
      insertMessage('session-1', 'result', {
        timestamp: '2026-08-11T15:21:00.000Z',
        terminal: true,
      });
      expect(repository.hasTerminalResultAfter('session-1', 'migrated-msg')).toBe(false);
    });

    it('is true when a terminal result shares the consumption millisecond but inserts after (P2 tiebreak)', () => {
      // An immediate error/interrupt can persist its terminal result in the SAME
      // millisecond as the consumed timestamp. The strict `>` on timestamps would
      // miss it (equal strings); the rowid tiebreak (result inserts after the
      // message's row) must still detect the turn ended.
      insertMessage('session-1', 'user', {
        uuid: 'tie-msg',
        timestamp: '2026-08-11T15:25:00.000Z',
        sendStatus: 'enqueued',
      });
      const flipped = repository.markDeliveryConsumedByUuid('session-1', 'tie-msg');
      expect(flipped).not.toBeNull();
      // Reuse the exact consumed timestamp so the two rows tie on the millisecond.
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
      // A message queued while turn T1 ran keeps its original persistence time;
      // T1 ends with a terminal result AFTER that but BEFORE the message is
      // consumed as the start of T2. After consumption the boundary must be the
      // consumption moment so the previous turn's result is excluded.
      insertMessage('session-1', 'user', {
        uuid: 'queued-msg',
        timestamp: '2026-08-11T15:20:00.000Z',
        sendStatus: 'enqueued',
      });
      insertMessage('session-1', 'result', {
        timestamp: '2026-08-11T15:21:00.000Z',
        terminal: true,
      });
      // T2 consumes the message — the consumed-flip aligns the row to T_consumed.
      const flipped = repository.markDeliveryConsumedByUuid('session-1', 'queued-msg');
      expect(flipped).not.toBeNull();
      // The prior result (15:21) is now before consumption → excluded; T2 hasn't
      // ended → false (the reclaimed job must resume T2, not complete as done).
      expect(repository.hasTerminalResultAfter('session-1', 'queued-msg')).toBe(false);
    });

    it('aligns the timestamp for a NON-RENDERABLE consumed message too (P1)', () => {
      // A non-renderable user row (e.g. a tool-result response) is excluded from
      // turn-index assignment but must still be aligned to T_consumed — otherwise
      // a queued-then-promoted non-renderable message keeps its original time and
      // matches the PREVIOUS turn's terminal result on a stale re-claim, losing
      // the response. See Codex (PR #2463, P1).
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
        0 // non-renderable
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
      // Aligned to ~T_consumed, not the 15:20 queued time.
      expect(Date.parse(ts)).toBeGreaterThan(Date.parse('2026-08-11T15:22:00.000Z'));
      // The 15:21 prior result is now before consumption → the turn is NOT ended.
      expect(repository.hasTerminalResultAfter('session-1', 'nr-msg')).toBe(false);
    });

    it('orders by the CONSUMPTION watermark, not the message rowid — a prior-turn result sharing the ms is excluded (P2)', () => {
      // A message queued during turn A and consumed as turn B keeps its ORIGINAL
      // rowid (insertion order). If A's result lands in the same millisecond as
      // B's consumption, a rowid tiebreak would sort A's result AFTER the
      // message's consumption and wrongly complete B's job. The consumption
      // watermark (consumed_seq = MAX(rowid)+1) must exclude A's result.
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, is_terminal, sdk_uuid, is_renderable)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        'session-1',
        'user',
        null,
        '{}',
        '2026-08-11T15:20:00.000Z', // queued during turn A
        'enqueued',
        0,
        'promoted-msg',
        1
      );
      // Turn A's result, persisted AFTER the message was queued but in the same
      // millisecond as B's consumption below.
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
      // A's result (rowid < consumed_seq) is NOT after the consumption → false.
      expect(repository.hasTerminalResultAfter('session-1', 'promoted-msg')).toBe(false);
      // Turn B's own terminal result (persisted after consumption, rowid >= seq)
      // IS detected.
      insertMessage('session-1', 'result', {
        timestamp: '2026-08-11T15:31:00.000Z',
        terminal: true,
      });
      expect(repository.hasTerminalResultAfter('session-1', 'promoted-msg')).toBe(true);
    });

    it('uses a genuinely monotonic counter — a terminal result stamped after multiple consumes is detected for all (P2)', () => {
      // consumed_seq and terminal-result seq both come from the shared
      // delivery_consumed_seq counter, so ordering is independent of SQLite
      // rowid reuse (a deleted max rowid can be reused by a later insert).
      // Consume two steers without intervening inserts, then stamp a terminal
      // result: it must be detected for both (its counter value is higher).
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
      // Consume both — each draws an increasing counter value.
      repository.markDeliveryConsumedByUuid('s', 'm1');
      repository.markDeliveryConsumedByUuid('s', 'm2');
      // A terminal result stamped AFTER both consumptions (higher counter) is
      // detected for both.
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
      // The consumed message's own turn ends normally.
      insertMessage('session-1', 'result', {
        timestamp: new Date(Date.now() + 60_000).toISOString(),
        terminal: true,
      });
      expect(repository.hasTerminalResultAfter('session-1', 'own-turn-msg')).toBe(true);
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
      // `updateMessageStatus` upserts the search row AFTER aligning the row to
      // T_consumed (same transaction), so message_search must order this
      // non-task message by its consumption moment, not when it was queued.
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
        '2020-01-01T00:00:00.000Z', // old queued time
        'enqueued',
        0,
        'search-msg'
      );
      const before = Date.now();
      const flipped = repository.markDeliveryConsumedByUuid('session-1', 'search-msg');
      expect(flipped).not.toBeNull();
      const after = Date.now();
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
      // T_consumed (~now), not the 2020 queued time.
      expect(searchRow!.timestamp).toBeGreaterThanOrEqual(before);
      expect(searchRow!.timestamp).toBeLessThanOrEqual(after);
    });

    describe('delivery_turn_end markers (result-less terminal paths, P2)', () => {
      it('recordDeliveryTurnEnd then hasDeliveryTurnEnd round-trips', () => {
        expect(repository.hasDeliveryTurnEnd('session-1', 'm1')).toBe(false);
        repository.recordDeliveryTurnEnd('session-1', 'm1', '2026-08-11T16:00:00.000Z');
        expect(repository.hasDeliveryTurnEnd('session-1', 'm1')).toBe(true);
        // Scoped by session + message.
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
        // A long-horizon inbox retry can re-persist the same UUID after a rewind;
        // a stale marker must not survive to mark the new turn as already ended.
        repository.recordDeliveryTurnEnd('session-1', 'rewound-uuid', 't1');
        expect(repository.hasDeliveryTurnEnd('session-1', 'rewound-uuid')).toBe(true);
        // Seed a message at the rewind boundary so deleteMessagesAtAndAfter has a row.
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
    // Mirrors saveSDKMessage/markDeliveryConsumedByUuid: stamp the shared
    // monotonic counter for consumed user rows and terminal results so
    // hasTerminalResultAfter orders them counter-to-counter.
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

    function insertTerminalResult(at: string, subtype: string): void {
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, is_terminal, sdk_uuid, consumed_seq)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`
      ).run(crypto.randomUUID(), 'session-1', 'result', subtype, '{}', at, 1, bumpSeq());
    }

    // The decision the bridge makes at the top of a consumed reclaim, given the
    // durable repo signals. This is the exact composition agent-session.ts wires
    // up in reclaimTurnAlreadySucceeded.
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
      // A success result wins even if a marker also exists.
      expect(
        classifyReclaimTermination({
          successResult: true,
          markerExists: true,
          terminalIdleInFlight: false,
        })
      ).toBe('terminated');
      // THE CRASH WINDOW: a bare marker (no success result) must NOT terminate.
      expect(
        classifyReclaimTermination({
          successResult: false,
          markerExists: true,
          terminalIdleInFlight: false,
        })
      ).toBe('redrive');
      // Nothing ended → drive normally.
      expect(
        classifyReclaimTermination({
          successResult: false,
          markerExists: false,
          terminalIdleInFlight: false,
        })
      ).toBe('live');
      // A terminal-idle drain keeps durable turn ownership even with a success
      // result / marker (mirrors the original hasSettledTurnTermination guard).
      // Covers all remaining idleInFlight=true combos: the drain short-circuits
      // to 'live' before success/marker are even consulted.
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
      // Setup: the kickoff was consumed, the turn ended via a result-less path
      // (query error / interrupt) so the idle waiter recorded a bare marker, and
      // the daemon then exited BEFORE the producedResult/retry decision ran.
      const uuid = 'msg-crash-window';
      insertConsumedUser(uuid, '2026-08-11T17:00:00.000Z');
      repository.recordDeliveryTurnEnd('session-1', uuid, '2026-08-11T17:00:42.000Z');
      // No success result exists.
      expect(repository.hasTerminalResultAfter('session-1', uuid)).toBe(false);
      expect(repository.hasDeliveryTurnEnd('session-1', uuid)).toBe(true);

      // Pre-fix this was 'terminated' (silent complete). Now it must redrive.
      expect(decisionFor(uuid)).toBe('redrive');

      // The bridge clears the stale marker on the redrive decision so a re-crash
      // cannot loop on turn_terminated...
      repository.clearDeliveryTurnEnd('session-1', uuid);
      expect(repository.hasDeliveryTurnEnd('session-1', uuid)).toBe(false);
      // ...and with the marker gone the reclaim now drives normally (the
      // producedResult/stall-retry path decides the retry/dead-letter outcome).
      expect(decisionFor(uuid)).toBe('live');
    });

    it('a consumed turn that ended in SUCCESS still terminates (no regression)', () => {
      const uuid = 'msg-succeeded';
      insertConsumedUser(uuid, '2026-08-11T17:10:00.000Z');
      insertTerminalResult('2026-08-11T17:10:53.000Z', 'success');
      // A marker may also exist (the idle waiter fires on every turn end); the
      // success result still wins → terminate (silent complete is correct here).
      repository.recordDeliveryTurnEnd('session-1', uuid, '2026-08-11T17:10:54.000Z');
      expect(decisionFor(uuid)).toBe('terminated');
    });

    it('a consumed turn whose only result is an ERROR does not terminate (retry, do not silently complete)', () => {
      // An error result is NOT success (hasTerminalResultAfter filters subtype).
      // Even with a marker, this must redrive so the failure surfaces/retries.
      const uuid = 'msg-error-result';
      insertConsumedUser(uuid, '2026-08-11T17:20:00.000Z');
      insertTerminalResult('2026-08-11T17:20:53.000Z', 'error_during_execution');
      repository.recordDeliveryTurnEnd('session-1', uuid, '2026-08-11T17:20:54.000Z');
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
      expect(repository.getMessagesByStatus('session-1', 'deferred')).toEqual([]);
    });

    it('should delete an enqueued user message', () => {
      const id = repository.saveUserMessage(
        'session-1',
        createUserMessage('Remove me', 'uuid-remove-me'),
        'enqueued'
      );

      const removed = repository.deletePendingUserMessage('session-1', id);

      expect(removed?.status).toBe('enqueued');
      expect(repository.getMessagesByStatus('session-1', 'enqueued')).toEqual([]);
    });

    it('should not delete consumed messages', () => {
      const id = repository.saveUserMessage('session-1', createUserMessage('Keep me'), 'consumed');

      const removed = repository.deletePendingUserMessage('session-1', id);

      expect(removed).toBeNull();
      expect(repository.getMessagesByStatus('session-1', 'consumed').length).toBe(1);
    });

    it('should not delete another session pending message', () => {
      const id = repository.saveUserMessage('session-2', createUserMessage('Keep me'), 'deferred');

      const removed = repository.deletePendingUserMessage('session-1', id);

      expect(removed).toBeNull();
      expect(repository.getMessagesByStatus('session-2', 'deferred').length).toBe(1);
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
    // session and scanned in JS — O(N) per lookup. The current impl seeks
    // idx_sdk_messages_session_uuid (session_id, sdk_uuid) directly; sdk_uuid
    // is populated at INSERT time, so the column seek matches the old
    // json_extract form without the per-row JSON parse.
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

  // The three uuid lookups must seek the (session_id, sdk_uuid) column index
  // rather than scanning the session partition or parsing JSON per row. These
  // EXPLAIN assertions guard against regressing to a json_extract / non-sargable
  // form. The inline schema above includes idx_sdk_messages_session_uuid to
  // mirror the post-M163 production schema.
  describe('uuid lookups use the sdk_uuid column index', () => {
    function queryPlan(sql: string, params: unknown[]): string {
      const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
        detail: string;
      }>;
      return rows.map((r) => r.detail).join('\n');
    }

    beforeEach(() => {
      // Seed a realistic mix in one session so the planner has stats and
      // prefers the selective (session_id, sdk_uuid) seek over a partition walk.
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
         WHERE session_id = ? AND send_status = ? AND sdk_uuid = ? LIMIT 1`,
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
           AND sdk_uuid = ?`,
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

      const result = repository.searchMessages({ query: 'stale runtime' });

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

      const result = repository.searchMessages({ query: 'retention marker' });

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

    it('removes fallback-retracted messages from search index', () => {
      createSearchIndex();
      repository.saveSDKMessage(
        'session-1',
        createUserMessage('refused searchable marker', 'refused-uuid')
      );

      expect(repository.searchMessages({ query: 'refused searchable' }).results).toHaveLength(1);
      repository.saveSDKMessage('session-1', {
        type: 'system',
        subtype: 'model_refusal_fallback',
        uuid: 'fallback-notice',
        retracted_message_uuids: ['refused-uuid'],
        session_id: 'session-1',
      } as unknown as SDKMessage);

      expect(repository.searchMessages({ query: 'refused searchable' }).results).toEqual([]);
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

      expect(repository.searchMessages({ query: 'rebuild hidden' }).results).toEqual([]);
    });

    it('removes superseded messages from search index', () => {
      createSearchIndex();
      repository.saveSDKMessage(
        'session-1',
        createUserMessage('superseded searchable marker', 'superseded-uuid')
      );

      expect(repository.searchMessages({ query: 'superseded searchable' }).results).toHaveLength(1);
      repository.saveSDKMessage('session-1', {
        type: 'assistant',
        uuid: 'replacement-uuid',
        supersedes: ['superseded-uuid'],
        message: { role: 'assistant', content: [{ type: 'text', text: 'replacement marker' }] },
      } as unknown as SDKMessage);

      expect(repository.searchMessages({ query: 'superseded searchable' }).results).toEqual([]);
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
      // Only the columns resolveTaskIdForSession reads. Created locally (not in
      // the shared beforeEach) so the sessions join in searchMessages — which
      // expects the full production sessions shape — is unaffected.
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          type TEXT,
          session_context TEXT
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

    // Reproduces the P1: a user message typed while the agent is mid-turn must
    // NOT open a new conversation turn at enqueue, or the in-flight prompt's
    // result inherits the queued message's turn and renders under it.
    it('keeps the in-flight result under the original prompt when a message is queued mid-turn', () => {
      linkTaskSession('session-1', 'task-1');
      const u1 = repository.saveUserMessage('session-1', createUserMessage('go'), 'consumed');
      repository.saveSDKMessage('session-1', createAssistantMessage('working'));
      // User types mid-flight → enqueued, not consumed yet.
      const u2 = repository.saveUserMessage(
        'session-1',
        createUserMessage('also this'),
        'enqueued'
      );
      // U1's turn finishes with a result.
      repository.saveSDKMessage('session-1', resultMessage);
      const r1 = resultId();

      // Before consume: U2 did NOT open a turn, so the result stays in turn 1
      // (U1's turn) — not misattributed to U2.
      expect(turnOf(u1)).toBe(1);
      expect(turnOf(r1)).toBe(1);
      expect(turnOf(u2)).toBe(1);

      // SDK yields U2 → it becomes an anchor and opens turn 2; U1's result stays
      // grouped under turn 1.
      repository.updateMessageStatus([u2], 'consumed');
      expect(turnOf(u2)).toBe(2);
      expect(turnOf(r1)).toBe(1);
    });

    it('assigns sequential turns when multiple queued messages are consumed in order', () => {
      linkTaskSession('session-1', 'task-1');
      repository.saveUserMessage('session-1', createUserMessage('go'), 'consumed'); // turn 1
      const u2 = repository.saveUserMessage('session-1', createUserMessage('two'), 'enqueued');
      const u3 = repository.saveUserMessage('session-1', createUserMessage('three'), 'enqueued');

      repository.updateMessageStatus([u2, u3], 'consumed');

      expect(turnOf(u2)).toBe(2);
      expect(turnOf(u3)).toBe(3);
    });

    // A batched queue flush is ONE provider prompt: sharedTurn assigns every
    // member the SAME turn index instead of N artificial MAX+1 turns (which
    // would burn the compact feed's recent-turn allowance and attach the
    // response to the last artificial turn).
    it('assigns ONE shared turn to a batched flush consumed together (sharedTurn)', () => {
      linkTaskSession('session-1', 'task-1');
      repository.saveUserMessage('session-1', createUserMessage('go'), 'consumed'); // turn 1
      const u2 = repository.saveUserMessage('session-1', createUserMessage('two'), 'enqueued');
      const u3 = repository.saveUserMessage('session-1', createUserMessage('three'), 'enqueued');
      const u4 = repository.saveUserMessage('session-1', createUserMessage('four'), 'enqueued');

      repository.updateMessageStatus([u2, u3, u4], 'consumed', { sharedTurn: true });

      expect(turnOf(u2)).toBe(2);
      expect(turnOf(u3)).toBe(2);
      expect(turnOf(u4)).toBe(2);
      // The next ordinary anchor continues after the shared turn.
      const u5 = repository.saveUserMessage('session-1', createUserMessage('five'), 'enqueued');
      repository.updateMessageStatus([u5], 'consumed');
      expect(turnOf(u5)).toBe(3);
    });

    // recoverOrphanedConsumedMessages flips already-consumed (already-anchored)
    // user rows to 'failed'. That consumed→failed transition must NOT reassign a
    // turn, or those rows get scattered to new high turn numbers and break
    // grouping on multi-session tasks.
    it('does not re-bump the turn when an already-consumed row is flipped to failed (recovery path)', () => {
      linkTaskSession('session-1', 'task-1');
      const u1 = repository.saveUserMessage('session-1', createUserMessage('first'), 'consumed');
      const u2 = repository.saveUserMessage('session-1', createUserMessage('second'), 'consumed');
      expect(turnOf(u1)).toBe(1);
      expect(turnOf(u2)).toBe(2);

      // Recovery flips the already-consumed u1 to 'failed'. Its turn must stay 1.
      repository.updateMessageStatus([u1], 'failed');

      expect(turnOf(u1)).toBe(1);
      expect(turnOf(u2)).toBe(2);
    });

    // A queued message that genuinely fails delivery (enqueued→failed) is a new
    // visible anchor and SHOULD get a turn.
    it('assigns a turn when a queued message fails delivery (enqueued→failed)', () => {
      linkTaskSession('session-1', 'task-1');
      repository.saveUserMessage('session-1', createUserMessage('go'), 'consumed'); // turn 1
      const u2 = repository.saveUserMessage('session-1', createUserMessage('lost'), 'enqueued');

      repository.updateMessageStatus([u2], 'failed');

      expect(turnOf(u2)).toBe(2);
    });

    it("keeps each session's non-anchor rows on that session's own turn across interleaved sessions (#2338)", () => {
      linkTaskSession('sess-A', 'task-1');
      linkTaskSession('sess-B', 'task-1');
      // A opens turn 1 (global), B opens turn 2 (global), then each streams an
      // answer. A non-anchor row must inherit its OWN session's turn, not the
      // task-wide max — otherwise A's answer lands on B's turn and is orphaned
      // from A's anchor in the (sessionId, turnIndex) partitioning.
      repository.saveUserMessage('sess-A', createUserMessage('A-prompt'), 'consumed'); // turn 1
      repository.saveUserMessage('sess-B', createUserMessage('B-prompt'), 'consumed'); // turn 2
      repository.saveSDKMessage('sess-A', createAssistantMessage('A-answer')); // non-anchor
      repository.saveSDKMessage('sess-B', createAssistantMessage('B-answer')); // non-anchor

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

      expect(latestAssistantTurn('sess-A')).toBe(1); // A's answer on A's turn, NOT 2
      expect(latestAssistantTurn('sess-B')).toBe(2);
    });

    it('aligns the timestamp with the new turn when a queued row is promoted on consume/fail (#2338)', () => {
      linkTaskSession('session-1', 'task-1');
      repository.saveUserMessage('session-1', createUserMessage('go'), 'consumed'); // turn 1
      // Enqueued row with a deliberately old timestamp (typed mid-run).
      const u2 = 'u2-old-ts';
      db.prepare(
        `INSERT INTO sdk_messages (
           id, session_id, message_type, message_subtype, sdk_message, timestamp,
           send_status, origin, is_renderable, is_terminal, task_id,
           conversation_turn_index, sdk_uuid, replacement_metadata_normalized
         ) VALUES (?, 'session-1', 'user', NULL, '{}', '2020-01-01T00:00:00.000Z',
                   'enqueued', 'human', 1, 0, 'task-1', NULL, NULL, 1)`
      ).run(u2);

      // Any promote path (here: enqueued→failed, e.g. markEnqueuedMessageFailed)
      // must move the timestamp off the stale typed time so createdAt order
      // agrees with the reassigned turn.
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
});
