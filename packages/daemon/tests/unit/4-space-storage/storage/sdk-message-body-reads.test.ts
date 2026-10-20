import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

let db: Database;
let repo: SDKMessageRepository;
let human: string;
let queued: string;
const text = '完整报告'.repeat(4000);
const result = '完整工具结果'.repeat(100000);

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.exec('PRAGMA foreign_keys=OFF');
  repo = new SDKMessageRepository(db);
  human = repo.saveUserMessage(
    's',
    {
      type: 'user',
      uuid: 'human',
      inputKind: 'human',
      message: { role: 'user', content: [{ type: 'text', text }] },
    } as SDKMessage,
    'consumed'
  );
  queued = repo.saveUserMessage(
    's',
    {
      type: 'user',
      uuid: 'queued',
      inputKind: 'task',
      message: { role: 'user', content: 'queued text' },
    } as SDKMessage,
    'enqueued'
  );
  const messages = [
    {
      type: 'assistant',
      uuid: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text },
          { type: 'tool_use', id: 'tool', name: 'Read', input: {} },
        ],
      },
    },
    {
      type: 'assistant',
      uuid: 'child',
      parent_tool_use_id: 'tool',
      message: { role: 'assistant', content: [{ type: 'text', text: 'child reply' }] },
    },
    {
      type: 'user',
      uuid: 'tool-result',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool', content: result }],
      },
    },
    { type: 'system', subtype: 'task_started', uuid: 'started', task_id: 'background' },
    {
      type: 'system',
      subtype: 'task_progress',
      uuid: 'progress-old',
      task_id: 'background',
      tool_use_id: 'background-tool',
      description: 'old',
    },
    {
      type: 'system',
      subtype: 'task_progress',
      uuid: 'progress',
      task_id: 'background',
      tool_use_id: 'background-tool',
      description: 'latest',
    },
    { type: 'result', subtype: 'success', uuid: 'result', result: text },
  ];
  for (const message of messages)
    expect(repo.saveSDKMessage('s', message as SDKMessage)).toBe(true);
  db.exec(
    "UPDATE sdk_messages SET timestamp=strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-20', '+' || rowid || ' seconds')"
  );
});
afterEach(() => db.close());

function reads() {
  return {
    transcript: repo.getSDKMessages('s', 30),
    tail: repo.getSDKMessages('s', 2),
    renderable: repo.getRenderableTextMessages('s'),
    background: repo.getBackgroundTaskMessages('s'),
    uuid: repo.getMessageByUuid('s', 'assistant'),
    typeHead: repo.getSDKMessagesByType('s', 'system', 'task_progress', 1),
    typeTail: repo.getLatestSDKMessagesByType('s', 'system', 'task_progress', 1),
    last: repo.getLastSDKMessage('s'),
    status: repo.getUserMessagesByStatus('s', 'consumed', 1, 'desc'),
    prefix: repo.listUserMessagesByUuidPrefix('s', 'human'),
    statusUuid: repo.getMessageByStatusAndUuid('s', 'consumed', 'human'),
    statusId: repo.getMessageByStatusAndDbId('s', 'consumed', human),
    users: repo.getUserMessages('s'),
    user: repo.getUserMessageByUuid('s', 'human'),
    prompts: repo.getStoredPromptsByUuid('s', 'human'),
    human: repo.getHumanPrompt('s', 'human'),
    content: repo.getUserMessageContentByUuid('s', 'human'),
    delivery: repo.getDeliveryContent('s', 'queued'),
    assistants: repo.getAssistantMessagesSince('s', null),
    since: repo.getAssistantMessagesSince('s', human),
  };
}

describe('SDKMessageRepository body reads', () => {
  test.each(['side-only', 'legacy-only', 'mixed'])(
    '%s retains every read result and stored tool result',
    (mode) => {
      const before = reads();
      expect(before.human?.text).toBe(text);
      expect(before.typeTail).toMatchObject([{ uuid: 'progress', description: 'latest' }]);
      const originals = db.prepare('SELECT seq,sdk_message FROM sdk_messages ORDER BY seq').all();
      if (mode !== 'side-only')
        db.exec(`DELETE FROM sdk_message_bodies ${mode === 'mixed' ? 'WHERE seq % 2 = 0' : ''}`);
      db.exec(
        "UPDATE sdk_messages SET sdk_message='' WHERE rowid IN (SELECT seq FROM sdk_message_bodies)"
      );
      expect(reads()).toEqual(before);
      expect(
        db
          .prepare(`SELECT m.seq,COALESCE(b.sdk_message,m.sdk_message) AS sdk_message
      FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.rowid ORDER BY m.seq`)
          .all()
      ).toEqual(originals);
      const tool = repo.getMessageByUuid('s', 'tool-result') as {
        message: { content: { content: string }[] };
      };
      expect(tool.message.content[0].content).toBe(result);
    }
  );

  test('a side body takes precedence over a stale legacy body', () => {
    const before = reads();
    db.exec("UPDATE sdk_messages SET sdk_message='{}'");
    expect(reads()).toEqual(before);
  });

  test('search admission indexes the surviving side body after a timestamp update', () => {
    const id = repo.saveUserMessage(
      's',
      {
        type: 'user',
        uuid: 'search',
        message: { role: 'user', content: 'side admission marker' },
      } as SDKMessage,
      'consumed'
    );
    db.prepare("UPDATE sdk_messages SET sdk_message='' WHERE id=?").run(id);
    repo.updateMessageTimestamp(id);
    repo.flushMessageSearchIndex();
    expect(
      repo.searchMessages({ query: 'admission marker' }).results.map((row) => row.messageId)
    ).toContain('search');
  });

  test('delivery normalization and pending transitions read the surviving body', () => {
    const legacy = repo.saveUserMessage(
      's',
      {
        type: 'user',
        uuid: 'legacy',
        isSynthetic: true,
        message: { role: 'user', content: 'original task' },
      } as SDKMessage,
      'enqueued',
      'system'
    );
    db.exec("UPDATE sdk_messages SET sdk_message=''");
    expect(repo.normalizeDeliveryMessageForMailbox('s', 'legacy')).toBe(true);
    expect(repo.getDeliveryContent('s', 'legacy')).toMatchObject({
      content: 'original task',
      inputKind: 'task',
    });
    expect(repo.deferEnqueuedUserMessage('s', queued)).toEqual({ dbId: queued, uuid: 'queued' });
    expect(repo.deletePendingUserMessage('s', legacy, 'enqueued')).toEqual({
      dbId: legacy,
      uuid: 'legacy',
      status: 'enqueued',
    });
    expect(repo.getHumanPrompt('s', 'human')?.text).toBe(text);
  });
});
