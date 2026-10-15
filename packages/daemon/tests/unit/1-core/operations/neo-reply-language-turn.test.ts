import { describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
import {
  detectNeoReplyLanguage,
  readNeoTurnLanguage,
  withNeoReplyLanguage,
} from '../../../../src/lib/neo/reply-language.ts';

const prompt = (content: unknown) => ({ type: 'user', message: { role: 'user', content } });

describe('detectNeoReplyLanguage', () => {
  test.each([
    ["what's open on HyperNeo right now?", 'English'],
    ['dev', null],
    ['Why does it fail with 无法连接到服务器 when I start it?', 'English'],
    ['现在有卡片还在运行吗？', 'Chinese'],
    ['把 lsm/HyperNeo#12 的 CI 修好', 'Chinese'],
    ['このPRを確認して', 'Japanese'],
    ['이 PR 확인해 줘', 'Korean'],
    ['https://github.com/lsm/HyperNeo/pull/12', null],
    ['看一下 packages/daemon/src/lib/neo/reply-language.ts', 'Chinese'],
    ['```ts\nconst readLanguage = detect(text)\n```\n这段对吗', 'Chinese'],
    ['Kannst du bitte die Liste der offenen Karten prüfen', null],
    ['that list is wrong, please correct it', 'English'],
  ] as const)('%j reads as %s', (text, language) => {
    expect(detectNeoReplyLanguage(text)).toBe(language);
  });
});

describe('readNeoTurnLanguage', () => {
  test('follows a continuation to the human message it answers, else the latest human message', () => {
    const stored: Record<string, SDKMessage[]> = {
      h1: [prompt([{ type: 'text', text: 'that list is wrong, please correct it' }]) as SDKMessage],
    };
    let latest: SDKMessage | null = null;
    const reads = {
      resolveAskOrigin: (input: { sessionId: string; messageId: string }) =>
        input.messageId === 'orphan' ? null : { sessionId: 'root', messageId: 'h1' },
      getPrompts: (_sessionId: string, messageId: string) => stored[messageId] ?? [],
      latestHumanPrompt: () => latest,
    };
    expect(readNeoTurnLanguage({ sessionId: 'root', messageId: 'neo-trigger:x' }, reads)).toBe(
      'English'
    );
    expect(readNeoTurnLanguage({ sessionId: 'root', messageId: 'orphan' }, reads)).toBeNull();
    latest = prompt('现在有卡片还在运行吗？') as SDKMessage;
    expect(readNeoTurnLanguage({ sessionId: 'root', messageId: 'orphan' }, reads)).toBe('Chinese');
  });
});

describe('withNeoReplyLanguage', () => {
  test('appends the turn language to text and block prompts, and leaves others alone', () => {
    const text = withNeoReplyLanguage(prompt('现在有卡片还在运行吗？'), 'Chinese');
    expect(text.message.content).toContain(
      '现在有卡片还在运行吗？\n\nReply language for this turn: Chinese'
    );
    const blocks = withNeoReplyLanguage(prompt([{ type: 'text', text: 'dev' }]), 'English');
    expect(blocks.message.content).toEqual([
      { type: 'text', text: 'dev' },
      { type: 'text', text: expect.stringContaining('Write everything for the human in English') },
    ]);
    const plain = prompt('dev');
    expect(withNeoReplyLanguage(plain, null)).toBe(plain);
  });
});

describe('latestHumanPrompt', () => {
  test('reads the newest human message of a session, skipping daemon inputs', async () => {
    const db = await createTestDb();
    db.createSession(createTestSession('root'));
    const messages = db.getSDKMessageRepo();
    const save = (uuid: string, inputKind: string, content: string) =>
      messages.saveSDKMessage('root', {
        type: 'user',
        uuid,
        session_id: 'root',
        parent_tool_use_id: null,
        inputKind,
        message: { role: 'user', content },
      } as unknown as SDKMessage);
    expect(messages.latestHumanPrompt('root')).toBeNull();
    save('h1', 'human', 'first');
    await new Promise((resolve) => setTimeout(resolve, 5));
    save('h2', 'human', '现在有卡片还在运行吗？');
    await new Promise((resolve) => setTimeout(resolve, 5));
    save('n1', 'system', 'Notification trigger');
    expect(messages.latestHumanPrompt('root')).toMatchObject({
      message: { content: '现在有卡片还在运行吗？' },
    });
    db.close();
  });
});
