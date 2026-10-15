import { describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
import {
  detectNeoReplyLanguage,
  isNeoReplyLanguageInput,
  readNeoTurnLanguage,
  withNeoReplyLanguage,
} from '../../../../src/lib/neo/reply-language.ts';

const prompt = (content: unknown) => ({ type: 'user', message: { role: 'user', content } });

describe('detectNeoReplyLanguage', () => {
  test.each([
    ["what's open on HyperNeo right now?", 'English'],
    ['dev', null],
    ['请帮我 fix this bug', 'Chinese'],
    ['in Ordnung', null],
    ['fix it', 'English'],
    ['修复#12的问题', 'Chinese'],
    ['Why does it fail with 无法连接到服务器 when I start it?', 'English'],
    ['现在有卡片还在运行吗？', 'Chinese'],
    ['把 lsm/HyperNeo#12 的 CI 修好', 'Chinese'],
    ['このPRを確認して', 'Japanese'],
    ['이 PR 확인해 줘', 'Korean'],
    ['https://github.com/lsm/HyperNeo/pull/12', null],
    ['看一下 packages/daemon/src/lib/neo/reply-language.ts', 'Chinese'],
    ['```ts\nconst readLanguage = detect(text)\n```\n这段对吗', 'Chinese'],
    [
      'Kannst du bitte die Liste der offenen Karten prüfen',
      'the language of "Kannst du bitte die Liste der offenen Karten prüfen"',
    ],
    ['that list is wrong, please correct it', 'English'],
  ] as const)('%j reads as %s', (text, language) => {
    expect(detectNeoReplyLanguage(text)).toBe(language);
  });
});

describe('detectNeoReplyLanguage on a long paste', () => {
  test('reads only the head of a long spaceless paragraph, quickly', () => {
    const started = performance.now();
    expect(detectNeoReplyLanguage(`${'中'.repeat(100_000)}/a.ts`)).toBe('Chinese');
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('readNeoTurnLanguage', () => {
  test('follows a continuation to the human message it answers; only an unresolved input falls back to the latest one', () => {
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
    stored.h1 = [prompt('dev') as SDKMessage];
    expect(
      readNeoTurnLanguage({ sessionId: 'root', messageId: 'neo-trigger:x' }, reads)
    ).toBeNull();
  });
});

describe('isNeoReplyLanguageInput', () => {
  test('stamps human and note inputs, never daemon control prompts or slash commands', () => {
    expect(isNeoReplyLanguageInput(false, 'what is running?')).toBe(true);
    expect(isNeoReplyLanguageInput(false, undefined)).toBe(true);
    expect(isNeoReplyLanguageInput(true, 'continue')).toBe(false);
    expect(isNeoReplyLanguageInput(false, '/compact')).toBe(false);
    expect(isNeoReplyLanguageInput(false, ' /clear')).toBe(false);
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
