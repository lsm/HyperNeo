import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { HyperNeoActionMessage } from '@hyperneo/shared';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { Database } from '../../../../src/storage/sqlite-compat';

let db: Database;
let repo: SDKMessageRepository;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.exec('PRAGMA foreign_keys = OFF');
  repo = new SDKMessageRepository(db);
});
afterEach(() => db.close());

describe('SDK message derived metadata writes', () => {
  test('all fifteen columns are available without moving the stored body', () => {
    const names = (
      db.prepare("PRAGMA table_xinfo('sdk_messages')").all() as { name: string }[]
    ).map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'sdk_message',
        'input_kind',
        'is_replay',
        'is_synthetic',
        'is_error',
        'internal_compaction_turn',
        'recovery_intercepted',
        'recovery_billing_terminal',
        'info_level',
        'resolved',
        'bg_task_id',
        'bg_tool_use_id',
        'hook_id',
        'first_block_type',
        'has_tool_result',
        'tool_result_only',
      ])
    );
  });

  test.each(['sdk', 'user'] as const)(
    '%s insertion keeps full tool results and derives mixed text accurately',
    (writer) => {
      const message = {
        type: 'user',
        uuid: writer,
        inputKind: 'task',
        isReplay: false,
        isSynthetic: true,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool', content: 'z'.repeat(700_000) },
            { type: 'text', text: '\n' },
          ],
        },
      } as unknown as SDKMessage;
      if (writer === 'sdk') expect(repo.saveSDKMessage('s1', message)).toBe(true);
      else repo.saveUserMessage('s1', message, 'enqueued');
      const row = db
        .prepare(
          'SELECT sdk_message, input_kind, is_replay, is_synthetic, first_block_type, has_tool_result, tool_result_only FROM sdk_messages WHERE sdk_uuid = ?'
        )
        .get(writer) as { sdk_message: string };
      expect(row).toMatchObject({
        input_kind: 'task',
        is_replay: 0,
        is_synthetic: 1,
        first_block_type: 'tool_result',
        has_tool_result: 1,
        tool_result_only: 0,
      });
      expect(JSON.parse(row.sdk_message)).toEqual(message);
    }
  );

  test('result stamps keep JSON and derived flags in agreement', () => {
    repo.saveSDKMessage(
      's1',
      {
        type: 'result',
        uuid: 'result',
        subtype: 'success',
        is_error: false,
        result: 'kept',
      } as unknown as SDKMessage,
      undefined,
      { stampInternalCompactionTurn: true }
    );
    repo.markResultRecoveryIntercepted('s1', 'result', true);
    repo.markResultInternalCompactionTurn('s1', 'result');
    const row = db
      .prepare(
        'SELECT sdk_message, internal_compaction_turn, recovery_intercepted, recovery_billing_terminal FROM sdk_messages WHERE sdk_uuid = ?'
      )
      .get('result') as { sdk_message: string };
    expect(row).toMatchObject({
      internal_compaction_turn: 1,
      recovery_intercepted: 1,
      recovery_billing_terminal: 1,
    });
    expect(JSON.parse(row.sdk_message)).toMatchObject({
      result: 'kept',
      internal_compaction_turn: 1,
      recovery_intercepted: 1,
      recovery_billing_terminal: 1,
    });
  });

  test('mailbox normalization updates the derived input kind and synthetic flag with the body', () => {
    repo.saveUserMessage(
      's1',
      {
        type: 'user',
        uuid: 'mail',
        message: { role: 'user', content: 'keep this input' },
      } as unknown as SDKMessage,
      'enqueued',
      'system'
    );
    expect(repo.normalizeDeliveryMessageForMailbox('s1', 'mail')).toBe(true);
    expect(
      db.prepare("SELECT input_kind, is_synthetic FROM sdk_messages WHERE sdk_uuid = 'mail'").get()
    ).toEqual({ input_kind: 'task', is_synthetic: 1 });
  });

  test('action insertion and both action update paths maintain resolved metadata', () => {
    const action: HyperNeoActionMessage = {
      type: 'hyperneo_action',
      uuid: 'action',
      session_id: 's1',
      action: 'sdk_resume_choice',
      resolved: false,
      timestamp: Date.now(),
    };
    const id = repo.saveHyperNeoActionMessage('s1', action);
    const resolved = () => db.prepare('SELECT resolved FROM sdk_messages WHERE id = ?').get(id);
    expect(resolved()).toEqual({ resolved: 0 });
    repo.updateHyperNeoActionMessage(id, { ...action, resolved: true });
    expect(resolved()).toEqual({ resolved: 1 });
    repo.updateHyperNeoActionMessageByUuid('s1', 'action', action);
    expect(resolved()).toEqual({ resolved: 0 });
  });
});
