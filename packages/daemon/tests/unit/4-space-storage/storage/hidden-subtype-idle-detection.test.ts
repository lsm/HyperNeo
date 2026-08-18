import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { classifyLastMessageForIdleAgent } from '../../../../src/lib/space/runtime/last-message-classifier';
import type { SDKMessage } from '@hyperneo/shared/sdk';

const HIDDEN_SUBTYPES = [
  'session_state_changed',
  'commands_changed',
  'task_started',
  'task_progress',
  'task_updated',
  'mirror_error',
  'elicitation_complete',
] as const;

const PROGRESS_SUBTYPES = ['task_started', 'task_progress', 'task_updated'] as const;

describe('hidden-subtype SQL filters — idle detection + SessionInfoPanel', () => {
  let db: Database;
  let repository: SDKMessageRepository;

  function user(text: string): SDKMessage {
    return {
      type: 'user',
      uuid: crypto.randomUUID(),
      message: { role: 'user', content: [{ type: 'text', text }] },
    } as unknown as SDKMessage;
  }

  function assistantEndTurn(text: string): SDKMessage {
    return {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
    } as unknown as SDKMessage;
  }

  function assistantWithToolUse(toolUseId: string): SDKMessage {
    return {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running a tool' },
          { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'true' } },
        ],
      },
    } as unknown as SDKMessage;
  }

  function result(): SDKMessage {
    return {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done',
      duration_ms: 10,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {},
    } as unknown as SDKMessage;
  }

  function hiddenState(subtype: string): SDKMessage {
    return { type: 'system', subtype, uuid: crypto.randomUUID() } as unknown as SDKMessage;
  }

  function thinkingTokens(): SDKMessage {
    return {
      type: 'system',
      subtype: 'thinking_tokens',
      uuid: crypto.randomUUID(),
    } as unknown as SDKMessage;
  }

  function modelRefusalFallback(): SDKMessage {
    return {
      type: 'system',
      subtype: 'model_refusal_fallback',
      uuid: crypto.randomUUID(),
      trigger: 'refusal',
      original_model: 'opus',
      fallback_model: 'sonnet',
    } as unknown as SDKMessage;
  }

  function progress(subtype: string, taskId: string, toolUseId?: string): SDKMessage {
    return {
      type: 'system',
      subtype,
      uuid: crypto.randomUUID(),
      task_id: taskId,
      ...(toolUseId ? { tool_use_id: toolUseId } : {}),
    } as unknown as SDKMessage;
  }

  function taskNotification(taskId: string, status: string): SDKMessage {
    return {
      type: 'system',
      subtype: 'task_notification',
      uuid: crypto.randomUUID(),
      task_id: taskId,
      status,
    } as unknown as SDKMessage;
  }

  function subtypeOf(message: unknown): string | undefined {
    return (message as { subtype?: string } | null | undefined)?.subtype;
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
				PRIMARY KEY (source_message_id, target_uuid, kind)
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

  describe('idle detection — getLastSDKMessage retains task progress signals', () => {
    it('returns a task_progress row as the last message (progress subtypes are not filtered out)', () => {
      repository.saveSDKMessage('session-1', result());
      repository.saveSDKMessage('session-1', hiddenState('session_state_changed'));
      repository.saveSDKMessage('session-1', modelRefusalFallback());
      repository.saveSDKMessage('session-1', progress('task_progress', 'task-1'));

      const last = repository.getLastSDKMessage('session-1');

      expect(last?.type).toBe('system');
      expect(subtypeOf(last)).toBe('task_progress');

      expect(classifyLastMessageForIdleAgent(last)).toEqual(
        expect.objectContaining({ terminal: false })
      );
    });

    it('returns the newest retained row regardless of subtype ordering', () => {
      repository.saveSDKMessage('session-1', progress('task_progress', 'task-1'));
      repository.saveSDKMessage('session-1', result());

      const last = repository.getLastSDKMessage('session-1');
      expect(last?.type).toBe('result');
      expect(classifyLastMessageForIdleAgent(last)).toEqual(
        expect.objectContaining({ terminal: true })
      );
    });

    it('skips state-only hidden subtypes and model_refusal_fallback when finding the last message', () => {
      repository.saveSDKMessage('session-1', result());
      for (const subtype of [
        'session_state_changed',
        'commands_changed',
        'mirror_error',
        'elicitation_complete',
      ]) {
        repository.saveSDKMessage('session-1', hiddenState(subtype));
      }
      repository.saveSDKMessage('session-1', modelRefusalFallback());

      const last = repository.getLastSDKMessage('session-1');
      expect(last?.type).toBe('result');
    });

    it('keeps every progress subtype visible to idle detection across a mixed history', () => {
      for (const subtype of PROGRESS_SUBTYPES) {
        db.exec('DELETE FROM sdk_messages');
        repository.saveSDKMessage('session-1', result());
        repository.saveSDKMessage('session-1', progress(subtype, 'task-1'));

        const last = repository.getLastSDKMessage('session-1');
        expect(subtypeOf(last)).toBe(subtype);
        expect(classifyLastMessageForIdleAgent(last)).toEqual(
          expect.objectContaining({ terminal: false })
        );
      }
    });
  });

  describe('SessionInfoPanel data loading — getBackgroundTaskMessages', () => {
    it('surfaces task metadata for the panel even though pagination hides those rows', () => {
      repository.saveSDKMessage('session-1', user('Visible user turn'));
      repository.saveSDKMessage('session-1', assistantWithToolUse('toolu_1'));
      repository.saveSDKMessage('session-1', progress('task_started', 'task-1', 'toolu_1'));
      repository.saveSDKMessage('session-1', progress('task_updated', 'task-1'));
      repository.saveSDKMessage('session-1', progress('task_progress', 'task-1', 'toolu_1'));
      repository.saveSDKMessage('session-1', taskNotification('task-1', 'completed'));

      const page = repository.getSDKMessages('session-1', 100);
      const pageSubtypes = page.messages.map(subtypeOf).filter((s): s is string => !!s);
      for (const subtype of ['task_started', 'task_updated', 'task_progress']) {
        expect(pageSubtypes).not.toContain(subtype);
      }

      const meta = repository.getBackgroundTaskMessages('session-1');
      const metaSubtypes = meta.map(subtypeOf).filter((s): s is string => !!s);
      expect(metaSubtypes).toContain('task_started');
      expect(metaSubtypes).toContain('task_updated');
      expect(metaSubtypes).toContain('task_progress');
      expect(metaSubtypes).toContain('task_notification');
    });

    it('returns the latest task_progress per task alongside the task start', () => {
      repository.saveSDKMessage('session-1', progress('task_started', 'task-1', 'toolu_1'));
      for (let i = 0; i < 5; i++) {
        repository.saveSDKMessage('session-1', progress('task_progress', 'task-1', 'toolu_1'));
      }

      const meta = repository.getBackgroundTaskMessages('session-1');
      const started = meta.filter((m) => subtypeOf(m) === 'task_started');
      const progressRows = meta.filter((m) => subtypeOf(m) === 'task_progress');
      expect(started).toHaveLength(1);
      expect(progressRows).toHaveLength(1);
    });
  });

  describe('visible transcript integrity — pagination excludes every hidden subtype', () => {
    it('counts only visible rows and excludes all hidden subtypes + thinking_tokens', () => {
      repository.saveSDKMessage('session-1', user('u1'));
      repository.saveSDKMessage('session-1', assistantEndTurn('a1'));
      repository.saveSDKMessage('session-1', result());
      for (const subtype of HIDDEN_SUBTYPES) {
        repository.saveSDKMessage('session-1', hiddenState(subtype));
      }
      repository.saveSDKMessage('session-1', thinkingTokens());

      expect(repository.getSDKMessageCount('session-1')).toBe(3);

      const page = repository.getSDKMessages('session-1', 100);
      const pageSubtypes = page.messages.map(subtypeOf).filter((s): s is string => !!s);
      for (const subtype of [...HIDDEN_SUBTYPES, 'thinking_tokens']) {
        expect(pageSubtypes).not.toContain(subtype);
      }
    });
  });
});
