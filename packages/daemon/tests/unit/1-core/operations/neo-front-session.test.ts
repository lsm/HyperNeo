import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createNeoService } from '../../helpers/neo-service.ts';
import { createNeoFrontHandler } from '../../../../src/lib/neo/front-job.ts';
import { neoIntakeMessage } from '../../../../src/lib/neo/intake.ts';
import { fileNeoSessions } from '../../../../src/lib/neo/folder.ts';
import { frontSession } from '../../../../src/lib/neo/front-session.ts';
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
  await db.createSession({ ...createTestSession(root), workspacePath: '/synthetic/Neo' });
  service = createNeoService(
    db,
    {
      createSession: async (input: {
        sessionId: string;
        title: string;
        workspacePath: string;
        executionProjectPath?: string;
        config: object;
      }) =>
        db.createSession({
          ...createTestSession(input.sessionId),
          title: input.title,
          workspacePath: input.workspacePath,
          metadata: {
            ...createTestSession(input.sessionId).metadata,
            executionProjectPath: input.executionProjectPath,
          },
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
    .mockImplementation(async function* (options: Parameters<typeof query>[0]) {
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
      yield {
        type: 'result',
        subtype: 'success',
        uuid: crypto.randomUUID(),
        session_id: sdkId,
        duration_ms: 1,
        is_error: false,
      };
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
  expect(db.getSession(frontId)).toMatchObject({
    title: 'Convo',
    sdkSessionId: sdkId,
    workspacePath: service.userFolder,
    metadata: { executionProjectPath: '/synthetic/Neo' },
  });
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
  expect(
    db
      .getDatabase()
      .prepare(
        "SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id=? AND message_type='result' AND is_terminal=1"
      )
      .get(frontId)
  ).toEqual({ n: 2 });
});

test('repairs the existing front title and Neo project grouping without losing its SDK identity', async () => {
  await db.updateSession(root, {
    metadata: { ...db.getSession(root)!.metadata, executionProjectPath: '/synthetic/Neo-project' },
  });
  const id = neoDerivedId(`front-session:${conversation}`);
  await db.createSession({
    ...createTestSession(id),
    title: 'Old front',
    sdkSessionId: sdkId,
    metadata: { ...createTestSession(id).metadata, messageCount: 7 },
  });
  const session = await frontSession(
    service,
    { conversationId: conversation } as Parameters<typeof frontSession>[1],
    { model: 'fixture', provider: 'glm', thinkingLevel: 'think24k' }
  );
  expect(session).toMatchObject({
    id,
    title: 'Convo',
    workspacePath: service.userFolder,
    sdkSessionId: sdkId,
    metadata: { executionProjectPath: '/synthetic/Neo-project', messageCount: 7 },
  });
});

test('a deleted Convo is recreated under the Neo project and still publishes its reply', async () => {
  const handler = createNeoFrontHandler(service);
  const requestId = '20000000-0000-4000-8000-000000000010';
  await service.asks.acceptPrompt(
    conversation,
    neoIntakeMessage({ sessionId: root, requestId, content: 'Hello again' }),
    'manual',
    db.getSDKMessageRepo(),
    db.getJobQueueRepo()
  );
  const job = () =>
    db
      .getJobQueueRepo()
      .listJobs({ queue: 'neo.front' })
      .find((job) => job.payload.messageId === requestId)!;
  expect(await handler(job())).toMatchObject({ delivered: true });
  const frontId = neoDerivedId(`front-session:${conversation}`);
  await db.deleteSession(frontId);
  expect(db.getSession(frontId)).toBeNull();
  const second = '20000000-0000-4000-8000-000000000011';
  await service.asks.acceptPrompt(
    conversation,
    neoIntakeMessage({ sessionId: root, requestId: second, content: 'Hello after deletion' }),
    'manual',
    db.getSDKMessageRepo(),
    db.getJobQueueRepo()
  );
  const next = db
    .getJobQueueRepo()
    .listJobs({ queue: 'neo.front' })
    .find((job) => job.payload.messageId === second)!;
  expect(await handler(next)).toMatchObject({ delivered: true });
  expect(db.getSession(frontId)).toMatchObject({
    title: 'Convo',
    metadata: { executionProjectPath: '/synthetic/Neo' },
  });
  expect(db.getSession(frontId)?.sdkSessionId).toBe(sdkId);
  expect(vi.mocked(query).mock.calls.at(-1)?.[0].options?.resume).toBeUndefined();
  expect(service.publications.list(conversation)?.map((item) => item.replyTo?.[0])).toEqual([
    requestId,
    second,
  ]);
});

test('an archived Convo is recreated instead of reused', async () => {
  const id = neoDerivedId(`front-session:${conversation}`);
  await db.createSession({
    ...createTestSession(id),
    title: 'Convo',
    workspacePath: service.userFolder,
    status: 'archived',
    archivedAt: new Date().toISOString(),
  });
  const session = await frontSession(
    service,
    { conversationId: conversation } as Parameters<typeof frontSession>[1],
    { model: 'fixture', provider: 'glm', thinkingLevel: 'think24k' }
  );
  expect(session).toMatchObject({ id, title: 'Convo', status: 'active' });
  expect(session.archivedAt).toBeUndefined();
});

test('a failed Convo creation errors the job instead of completing silently', async () => {
  const handler = createNeoFrontHandler(service);
  const requestId = '20000000-0000-4000-8000-000000000012';
  await service.asks.acceptPrompt(
    conversation,
    neoIntakeMessage({ sessionId: root, requestId, content: 'Hello again' }),
    'manual',
    db.getSDKMessageRepo(),
    db.getJobQueueRepo()
  );
  vi.spyOn(service.sessions, 'createSession').mockRejectedValueOnce(
    new Error('Synthetic Convo creation failure')
  );
  const job = db
    .getJobQueueRepo()
    .listJobs({ queue: 'neo.front' })
    .find((job) => job.payload.messageId === requestId)!;
  await expect(handler(job)).rejects.toThrow('Synthetic Convo creation failure');
  expect(
    db.getSDKMessageRepo().getUserMessages(neoDerivedId(`front-session:${conversation}`))
  ).toHaveLength(0);
});

test('an SDK startup failure records a failed terminal turn instead of a Stopped gap', async () => {
  const ask = {
    conversationId: conversation,
    requestId: crypto.randomUUID(),
    askOrigin: { sessionId: root },
    content: 'Hello',
  };
  vi.mocked(query).mockImplementation(async function* (options: Parameters<typeof query>[0]) {
    if (typeof options.prompt !== 'string')
      for await (const _input of options.prompt) {
      }
    throw new Error('Synthetic SDK startup failure');
  } as unknown as typeof query);
  const { runNeoFrontModel } = await import('../../../../src/lib/neo/front-model.ts');
  await expect(
    runNeoFrontModel(service, ask as Parameters<typeof runNeoFrontModel>[1], {
      model: 'fixture',
      provider: 'glm',
      thinkingLevel: 'off',
    })
  ).rejects.toThrow('Synthetic SDK startup failure');
  const id = neoDerivedId(`front-session:${conversation}`);
  expect(
    db
      .getDatabase()
      .prepare(
        "SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id=? AND message_type='result' AND is_terminal=1 AND is_error=1"
      )
      .get(id)
  ).toEqual({ n: 1 });
});

test('startup files an already existing Convo beside Neo without a model turn', async () => {
  const id = neoDerivedId(`front-session:${conversation}`);
  await db.createSession({
    ...createTestSession(id),
    title: 'Old front',
    workspacePath: service.userFolder,
    sdkSessionId: sdkId,
  });
  await fileNeoSessions(db, service.repo, '/synthetic/Neo');
  expect(db.getSession(id)).toMatchObject({
    title: 'Convo',
    workspacePath: service.userFolder,
    sdkSessionId: sdkId,
    metadata: { executionProjectPath: '/synthetic/Neo' },
  });
  expect(query).not.toHaveBeenCalled();
});
