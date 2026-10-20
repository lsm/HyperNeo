import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { HyperNeoActionMessage } from '@hyperneo/shared';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { Database } from '../../../../src/storage/sqlite-compat';
import { deriveSdkMessageColumns } from '../../../../src/storage/sdk-message-columns';
import {
  backfillSdkMessageColumns,
  runMigration413,
} from '../../../../src/storage/schema/m413-sdk-message-columns';

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
  test('derivation preserves scalar flags, background keys and SQLite whitespace semantics', () => {
    expect(
      deriveSdkMessageColumns(
        {
          inputKind: 'human',
          isReplay: false,
          isSynthetic: true,
          is_error: 1,
          internal_compaction_turn: 1,
          recovery_intercepted: 0,
          recovery_billing_terminal: false,
          level: 'info',
          resolved: false,
          task_id: '',
          tool_use_id: 'tool',
          hook_id: 'hook',
          message: { content: [{ type: 'tool_result' }, { type: 'text', text: '   ' }] },
        },
        'fallback'
      )
    ).toEqual({
      input_kind: 'human',
      is_replay: 0,
      is_synthetic: 1,
      is_error: 1,
      internal_compaction_turn: 1,
      recovery_intercepted: 0,
      recovery_billing_terminal: 0,
      info_level: 1,
      resolved: 0,
      bg_task_id: '',
      bg_tool_use_id: 'tool',
      hook_id: 'hook',
      first_block_type: 'tool_result',
      has_tool_result: 1,
      tool_result_only: 1,
    });
    expect(deriveSdkMessageColumns({}, 'fallback').bg_task_id).toBe('fallback');
    expect(deriveSdkMessageColumns({ message: { content: 'plain string' } }).has_tool_result).toBe(
      0
    );
  });
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

describe('SDK message column backfill', () => {
  const insert = (id: string, body: string) =>
    db
      .prepare(
        "INSERT INTO sdk_messages (id,session_id,message_type,sdk_message,timestamp,task_id) VALUES (?,'s1','user',?,'2026-10-20T00:00:00Z','fallback')"
      )
      .run(id, body);
  const progress = (line: string) =>
    JSON.parse(line.slice(line.indexOf('{'))) as {
      rows: number;
      bytes: number;
      malformed: number;
      through: number;
    };

  test('bounds chunks by body bytes, keeps oversized results whole and leaves malformed JSON unchanged', async () => {
    const bodies = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', content: 't'.repeat(i === 9 ? 5 * 1024 * 1024 : 700_000) },
          ],
        },
      })
    );
    bodies.forEach((body, i) => insert(`body-${i}`, body));
    insert('malformed', '{broken');
    const chunks: ReturnType<typeof progress>[] = [];
    await backfillSdkMessageColumns(db, (line) => chunks.push(progress(line)));
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.bytes <= 4 * 1024 * 1024 || chunk.rows === 1)).toBe(true);
    expect(chunks.reduce((sum, chunk) => sum + chunk.malformed, 0)).toBe(1);
    for (const [i, body] of bodies.entries())
      expect(
        db
          .prepare(
            'SELECT sdk_message,has_tool_result,tool_result_only,bg_task_id FROM sdk_messages WHERE id = ?'
          )
          .get(`body-${i}`)
      ).toEqual({
        sdk_message: body,
        has_tool_result: 1,
        tool_result_only: 1,
        bg_task_id: 'fallback',
      });
    expect(
      db
        .prepare(
          "SELECT sdk_message,input_kind,info_level,has_tool_result FROM sdk_messages WHERE id = 'malformed'"
        )
        .get()
    ).toEqual({
      sdk_message: '{broken',
      input_kind: null,
      info_level: null,
      has_tool_result: null,
    });
  });

  test('counts UTF-8 body bytes when splitting chunks', async () => {
    const body = JSON.stringify({
      message: { content: [{ type: 'text', text: '界'.repeat(1_200_000) }] },
    });
    insert('unicode-a', body);
    insert('unicode-b', body);
    const chunks: ReturnType<typeof progress>[] = [];
    await backfillSdkMessageColumns(db, (line) => chunks.push(progress(line)));
    expect(chunks.map((chunk) => chunk.rows)).toEqual([1, 1]);
    expect(chunks.map((chunk) => chunk.bytes)).toEqual([
      Buffer.byteLength(body),
      Buffer.byteLength(body),
    ]);
    expect(
      db.prepare('SELECT sdk_message FROM sdk_messages WHERE id = ?').get('unicode-b')
    ).toEqual({ sdk_message: body });
  });

  test('commits a checkpoint per chunk and resumes after interruption without reprocessing completed rows', async () => {
    db.transaction(() => {
      for (let i = 0; i < 515; i++)
        insert(`row-${i}`, JSON.stringify({ inputKind: 'task', isReplay: false }));
    })();
    await expect(
      backfillSdkMessageColumns(db, () => {
        throw new Error('synthetic restart');
      })
    ).rejects.toThrow('synthetic restart');
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM sdk_messages WHERE input_kind = ?').get('task')
    ).toEqual({ n: 512 });
    runMigration413(db);
    const chunks: ReturnType<typeof progress>[] = [];
    await backfillSdkMessageColumns(db, (line) => chunks.push(progress(line)));
    expect(chunks.map((chunk) => chunk.rows)).toEqual([3]);
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM sdk_messages WHERE input_kind = ? AND is_replay = 0')
        .get('task')
    ).toEqual({ n: 515 });
    await backfillSdkMessageColumns(db, () => {
      throw new Error('finished backfill ran again');
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM migration_markers WHERE key GLOB 'sdk_message_columns_backfill:*'"
        )
        .get()
    ).toEqual({ n: 0 });
  });
});
