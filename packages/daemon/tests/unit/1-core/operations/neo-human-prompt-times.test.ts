import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const root = 'neo:root';
const other = 'neo:other';
let db: Awaited<ReturnType<typeof createTestDb>>;

const prompt = (sessionId: string, uuid: string, at: number, inputKind?: string) => {
  db.getSDKMessageRepo().saveSDKMessage(sessionId, {
    type: 'user',
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    ...(inputKind ? { inputKind } : {}),
    message: { role: 'user', content: uuid },
  } as unknown as SDKUserMessage);
  db.getDatabase()
    .prepare('UPDATE sdk_messages SET timestamp = ? WHERE session_id = ? AND sdk_uuid = ?')
    .run(new Date(at).toISOString(), sessionId, uuid);
};

beforeEach(async () => {
  db = await createTestDb();
  await db.createSession(createTestSession(root));
  await db.createSession(createTestSession(other));
});
afterEach(() => db.close());

describe('Neo human prompt times from stored prompts', () => {
  test('a waiting reminder reads the asked time of the human message it answers', () => {
    prompt(root, 'ask-1', 1_000, 'human');
    prompt(root, 'note-1', 2_000);
    expect(db.getSDKMessageRepo().getHumanPrompt(root, 'ask-1')?.at).toBe(1_000);
    expect(db.getSDKMessageRepo().getHumanPrompt(root, 'note-1')).toBeNull();
  });

  test('the continue gate reads the last human prompt of the asking session only', () => {
    prompt(root, 'ask-1', 1_000, 'human');
    prompt(root, 'ask-2', 3_000, 'human');
    prompt(root, 'tool-result', 4_000);
    prompt(root, 'system-note', 5_000, 'system');
    prompt(other, 'elsewhere', 9_000, 'human');
    expect(db.getSDKMessageRepo().lastHumanPromptAt(root)).toBe(3_000);
  });

  test('the nightly quiet check reads the last human prompt in the root session, or none', () => {
    expect(db.getSDKMessageRepo().lastHumanPromptAt(root)).toBeNull();
    prompt(other, 'elsewhere', 9_000, 'human');
    expect(db.getSDKMessageRepo().lastHumanPromptAt(root)).toBeNull();
    prompt(root, 'ask-1', 2_000, 'human');
    expect(db.getSDKMessageRepo().lastHumanPromptAt(root)).toBe(2_000);
  });
});
