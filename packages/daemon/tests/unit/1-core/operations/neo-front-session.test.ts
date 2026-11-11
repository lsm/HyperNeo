import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createNeoService } from '../../helpers/neo-service.ts';
import { createNeoFrontHandler } from '../../../../src/lib/neo/front-job.ts';
import { neoIntakeMessage } from '../../../../src/lib/neo/intake.ts';
import { neoDerivedId } from '../../../../src/lib/neo/derived-id.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database.ts';
vi.mock('../../../../src/lib/provider-service.ts', () => ({
  getProviderService: () => ({ getIsolatedEnvForModel: async () => ({}) }),
}));
vi.mock('../../../../src/lib/agent/sdk-cli-resolver.ts', () => ({
  awaitSDKCliPath: async () => '/synthetic/claude',
  isRunningUnderBun: () => false,
}));
let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
const conversation = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversation}`;
const sdkId = '30000000-0000-4000-8000-000000000001';
beforeEach(async () => {
  db = await createTestDb();
  await db.createSession(createTestSession(root));
  service = createNeoService(
    db,
    {
      createSession: async (input: {
        sessionId: string;
        title: string;
        workspacePath: string;
        config: object;
      }) =>
        db.createSession({
          ...createTestSession(input.sessionId),
          title: input.title,
          workspacePath: input.workspacePath,
          config: { ...createTestSession(input.sessionId).config, ...input.config },
        }),
    } as unknown as SessionManager,
    { event: vi.fn() } as unknown as MessageHub,
    await createTestInternalEventBus()
  );
  service.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  service.repo.conversationId();
  await db.updateGlobalSettings({
    neo: {
      front: {
        enabled: true,
        model: { model: 'fixture', provider: 'glm', thinkingLevel: 'think24k' },
      },
    },
  });
  vi.mocked(query)
    .mockClear()
    .mockImplementation(async function* (options) {
      if (typeof options.prompt !== 'string')
        for await (const _input of options.prompt) {
        }
      yield { type: 'system', subtype: 'init', session_id: sdkId };
      yield {
        type: 'assistant',
        uuid: crypto.randomUUID(),
        session_id: sdkId,
        parent_tool_use_id: null,
        message: {
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          model: 'fixture',
          content: [{ type: 'text', text: JSON.stringify({ kind: 'chat', text: 'Hello again.' }) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield { type: 'result', subtype: 'success' };
    } as unknown as typeof query);
});
afterEach(async () => {
  await service.dispose();
  db.close();
});
test('switch on runs the extra message in the same SDK conversation and records visible history', async () => {
  const handler = createNeoFrontHandler(service);
  const ids = ['20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002'];
  for (const requestId of ids) {
    await service.asks.acceptPrompt(
      conversation,
      neoIntakeMessage({ sessionId: root, requestId, content: 'Hello again' }),
      'manual',
      db.getSDKMessageRepo(),
      db.getJobQueueRepo()
    );
    const job = db
      .getJobQueueRepo()
      .listJobs({ queue: 'neo.front' })
      .find((job) => job.payload.messageId === requestId)!;
    expect(await handler(job)).toMatchObject({ delivered: true });
  }
  const frontId = neoDerivedId(`front-session:${conversation}`);
  expect(db.getSession(frontId)).toMatchObject({ title: '前端', sdkSessionId: sdkId });
  expect(vi.mocked(query).mock.calls[1][0].options?.resume).toBe(sdkId);
  expect(db.getSDKMessageRepo().getUserMessages(frontId)).toHaveLength(2);
  expect(
    db
      .getDatabase()
      .prepare(
        "SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id=? AND message_type='assistant'"
      )
      .get(frontId)
  ).toEqual({ n: 2 });
  expect(service.publications.list(conversation)?.map((item) => item.replyTo?.[0])).toEqual(ids);
});
