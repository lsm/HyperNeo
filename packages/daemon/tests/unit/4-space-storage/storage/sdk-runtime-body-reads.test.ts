import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { NAMED_QUERY_REGISTRY } from '../../../../src/lib/live-query/registry';
import { BACKGROUND_TASK_METADATA_SQL } from '../../../../src/lib/live-query/queries/messages';
import {
  readHyperneoLastResult,
  readHyperneoInputs,
  readHyperneoExchange,
} from '../../../../src/lib/drivers/hyperneo-adapter';
import { verifyPromptContent } from '../../../../src/lib/agent/message-delivery-outbox';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { ensureTaskMessageRows } from '../../../../src/storage/schema/task-message-rows';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

let db: Database;
let repo: SDKMessageRepository;
const prompt = {
  type: 'user',
  uuid: 'input',
  inputKind: 'human',
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'text', text: '完整报告'.repeat(4000) }] },
} as SDKMessage;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec(`INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata,session_context)
    VALUES ('s','Synthetic','/synthetic',datetime('now'),datetime('now'),'active','{}','{}','{"taskId":"t"}');
    INSERT INTO spaces(id,slug,name,workspace_path,status,created_at,updated_at) VALUES ('p','p','Proof','/synthetic','archived',1,1);
    INSERT INTO space_tasks(id,space_id,task_number,title,status,created_at,updated_at) VALUES ('t','p',1,'Proof','in_progress',1,1)`);
  repo = new SDKMessageRepository(db);
  repo.saveUserMessage('s', prompt, 'consumed');
  for (const message of [
    {
      type: 'assistant',
      uuid: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'complete reply' },
          { type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: '/synthetic/a' } },
        ],
      },
    },
    {
      type: 'assistant',
      uuid: 'child',
      parent_tool_use_id: 'tool',
      message: { role: 'assistant', content: [{ type: 'text', text: 'child' }] },
    },
    {
      type: 'user',
      uuid: 'tool-result',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool', content: '完整工具结果'.repeat(100000) },
        ],
      },
    },
    { type: 'system', uuid: 'start', subtype: 'task_started', task_id: 'bg' },
    {
      type: 'system',
      uuid: 'progress',
      subtype: 'task_progress',
      task_id: 'bg',
      tool_use_id: 'bg-tool',
      summary: 'progress',
    },
  ])
    repo.saveSDKMessage('s', message as SDKMessage);
  db.exec(
    "UPDATE sdk_messages SET task_id='t',timestamp=strftime('%Y-%m-%dT%H:%M:%fZ','2026-10-20','+'||rowid||' seconds')"
  );
  ensureTaskMessageRows(db, 't');
  repo.saveSDKMessage('result-session', {
    type: 'result',
    uuid: 'result',
    subtype: 'success',
    result: 'final report',
    is_error: false,
  } as SDKMessage);
});
afterEach(() => db.close());

function reads() {
  const feeds: Record<string, unknown> = {};
  for (const [name, params] of [
    ['messages.bySession', ['s', 200]],
    ['messages.bySession.compact', ['s', 200]],
    ['spaceTaskMessages.byTask', ['t']],
    ['spaceTaskMessages.byTask.compact', ['t']],
    ['spaceTaskActiveTurn.byTask', ['t']],
  ] as [string, (string | number)[]][]) {
    const query = NAMED_QUERY_REGISTRY.get(name)!;
    let rows = db.prepare(query.sql).all(...params) as Record<string, unknown>[];
    if (query.expandRows) rows = query.expandRows(rows, params, db);
    feeds[name] = rows.map(query.mapRow ?? ((row) => row));
  }
  return {
    feeds,
    background: db.prepare(BACKGROUND_TASK_METADATA_SQL).all(...Array(7).fill('s')),
    result: readHyperneoLastResult(db, 'result-session'),
    inputs: readHyperneoInputs(db, 's'),
    exchange: readHyperneoExchange(db, 's', 0),
  };
}

describe('SDK runtime body reads', () => {
  test.each(['side-only', 'mixed', 'legacy-only'])(
    '%s retains full feed and adapter output',
    (mode) => {
      const before = reads();
      expect(before.result?.reply).toBe('final report');
      expect(before.feeds['messages.bySession']).not.toEqual([]);
      if (mode !== 'side-only')
        db.exec(`DELETE FROM sdk_message_bodies ${mode === 'mixed' ? 'WHERE seq%2=0' : ''}`);
      db.exec(
        "UPDATE sdk_messages SET sdk_message='' WHERE rowid IN (SELECT seq FROM sdk_message_bodies)"
      );
      expect(reads()).toEqual(before);
      expect(() =>
        verifyPromptContent({ db, sessionId: 's', messageUuid: 'input', message: prompt })
      ).not.toThrow();
      expect(() =>
        verifyPromptContent({
          db,
          sessionId: 's',
          messageUuid: 'input',
          message: { ...prompt, message: { role: 'user', content: 'different' } } as SDKMessage,
        })
      ).toThrow();
    }
  );

  test('lazy projection repair and result updates survive a blank legacy body', () => {
    const before = db
      .prepare('SELECT * FROM task_message_rows WHERE task_id=? ORDER BY seq')
      .all('t');
    db.exec("UPDATE sdk_messages SET sdk_message=''; DELETE FROM task_message_rows");
    ensureTaskMessageRows(db, 't');
    expect(
      db.prepare('SELECT * FROM task_message_rows WHERE task_id=? ORDER BY seq').all('t')
    ).toEqual(before);
    repo.markResultRecoveryIntercepted('result-session', 'result', true);
    repo.markResultInternalCompactionTurn('result-session', 'result');
    expect(repo.getMessageByUuid('result-session', 'result')).toMatchObject({
      result: 'final report',
      recovery_intercepted: 1,
      recovery_billing_terminal: 1,
      internal_compaction_turn: 1,
    });
  });
});
